/* Gate scanner for the IIT Tirupati visitor pass system. */
(function () {
  'use strict';

  /*
   * guard.js normally does the frame check and removes the framebust style.
   * Repeat both here so that either script alone is sufficient: if guard.js
   * fails to load — a wrong deploy path is the usual cause — the app still
   * refuses to run framed, and the page is not left silently blank. Only if
   * both scripts are missing does nothing render, at which point nothing works
   * anyway.
   */
  if (window.top !== window.self) {
    window.__FRAMED__ = true;
    return;
  }
  if (window.__FRAMED__) return;

  var framebust = document.getElementById('framebust');
  if (framebust && framebust.parentNode) framebust.parentNode.removeChild(framebust);

  var el = function (id) { return document.getElementById(id); };

  var session = { idToken: null, expiresAt: 0, scanner: null };
  var camera = { stream: null, raf: null, canvas: null, ctx: null, running: false,
                 lastFrameAt: 0, watchdog: null, restarting: false,
                 restarts: 0, lastRestartAt: 0, starting: false, generation: 0 };

  // How long the camera may produce no frames before it is treated as dead.
  // A phone left on a desk locks its screen, and on several mobile browsers the
  // OS ends the camera track WITHOUT firing visibilitychange — so the page still
  // believes it is visible, tick() keeps looping against a dead track, and the
  // guard picks up a black or frozen viewfinder with no indication anything is
  // wrong. Nothing noticed that before.
  var CAMERA_STALL_MS = 10000;
  var CAMERA_WATCHDOG_MS = 3000;

  // Restarts are capped. Without this the watchdog would retry every 3 seconds
  // for as long as the page stayed open — and each attempt powers the camera up
  // again, so a phone that cannot hold the camera would be drained by the thing
  // meant to keep it working. After this many consecutive failures it stops and
  // asks for a tap.
  var CAMERA_MAX_RESTARTS = 3;

  // Restarts are counted within a rolling window rather than reset by the next
  // frame. Each restart briefly succeeds before the camera dies again, so
  // resetting on a frame meant the cap could never be reached by exactly the
  // failure it was built for.
  var CAMERA_RESTART_WINDOW_MS = 60000;
  var lastToken = { value: null, at: 0 };
  var current = null;
  var checkTimer = null;
  var scanSequence = 0;
  // An LRU of in-flight or settled photo fetches, keyed by pass token. Holding
  // the *promise* rather than the result is what lets the photo request start
  // in parallel with the scan: whoever asks second joins the request already
  // running instead of issuing a second one.
  var photoCache = [];
  var PHOTO_CACHE_MAX = 20;

  // How long after the scan request the photograph request starts. Long enough
  // that the two are not staged together, short enough that the face still
  // arrives with the verdict. See prefetchPhoto().
  var PHOTO_PREFETCH_OFFSET_MS = 600;

  /**
   * Running tally for this sign-in. The retry machinery hides failures so well
   * that the only evidence of them was an impression of how often an amber flag
   * appeared — and three reports gave 7%, "most", and 50% across changes that
   * did not touch request timing. Impressions cannot separate our behaviour from
   * Google's, so count instead.
   *
   * Reset on sign-in, never persisted, and shown only on the idle scan screen.
   */
  var tally = { attempts: 0, replayed: 0, photoFailed: 0, gaveUp: 0 };

  /**
   * The last failure's full diagnostic. Guards do not need it and it is long
   * enough to push the camera off a phone screen, so it never reaches the
   * notice. It is logged to the console and can be read on the device by
   * triple-tapping the scanner's name in the header.
   */
  var lastDiagnostic = null;

  /**
   * The pass a give-up left unresolved, so the Try again button can re-ask for
   * that same pass with the same request id.
   */
  var retryPending = null;

  function tallyLine() {
    if (!tally.attempts) return 'Hold the visitor\u2019s QR code inside the frame.';
    // Counts every scan attempted, including ones that gave up. Counting only
    // rendered verdicts understated the rate, because a give-up is precisely
    // the case worth counting.
    var bits = [tally.attempts + (tally.attempts === 1 ? ' scan' : ' scans')];
    if (tally.replayed) bits.push(tally.replayed + ' needed a retry');
    if (tally.photoFailed) bits.push(tally.photoFailed + ' without a photo');
    if (tally.gaveUp) bits.push(tally.gaveUp + ' gave up');
    return bits.join(' \u00b7 ');
  }

  var IDLE_CLEAR_MS = 90 * 1000;
  var IDLE_SIGNOUT_MS = 20 * 60 * 1000;

  // Apps Script routinely takes 2-4 seconds per request and a cold script can
  // take longer, so this is generous. It exists to put a bound on a hang, not
  // to police latency.
  // Escalating, not flat. The backend answers in 3-5 seconds or the reply is
  // not coming: Apps Script's content hop routinely loses or misroutes it while
  // the script itself completes and the row is already in ScanLog. Waiting 30
  // seconds before the first retry was therefore 25 seconds of watching nothing
  // happen, three times over.
  //
  // First attempt gives up quickly and asks again; a repeat is cheap because
  // the server replays its stored verdict without touching the sheet. The last
  // attempt is patient, in case the backend genuinely is slow.
  // Sized from measurement, not guesswork. A working reply is about 4.4s
  // (script ~2.4s, delivery ~2.0s). Anything still outstanding at 12s is
  // overwhelmingly likely never to arrive, and the old 30s third attempt spent
  // half the budget proving that — leaving only 2s for a fourth, which was
  // shorter than a working reply and therefore doomed before it was sent.
  //
  // Several cheap attempts beat a few patient ones here, because the dominant
  // failure is an instant 404 from the content hop rather than a slow server.
  var ATTEMPT_TIMEOUTS_MS = [8000, 10000, 12000, 12000, 12000];

  // Never start an attempt that cannot succeed. Below this there is not enough
  // of the budget left to beat a normal reply, so giving up honestly is better
  // than a request guaranteed to time out.
  var MIN_USEFUL_ATTEMPT_MS = 6000;


  // A photograph is 100-200 KB plus Drive work on a cold cache; a verdict is
  // about 1 KB. Giving both the same 8-second first attempt aborted photo
  // requests that were going to succeed, and the guard saw "the server did not
  // answer within 8 seconds" under an otherwise perfect verdict.
  var PHOTO_TIMEOUTS_MS = [15000, 25000, 30000];

  function timeoutForAttempt(n, action) {
    var table = (action === 'photo') ? PHOTO_TIMEOUTS_MS : ATTEMPT_TIMEOUTS_MS;
    return table[Math.min(n, table.length - 1)];
  }

  // Two retries after the first attempt. Each carries the same request ID, so
  // the server replays its stored verdict rather than admitting the visitor
  // again. Three lost replies in a row is a real outage, not a blip.
  // Retrying is bounded by TIME, not by a count of attempts. The server stores
  // each verdict against its request ID for CONFIG.SCAN_REPLAY_SECONDS (120) and
  // replays it for a repeat, so asking again inside that window costs a round
  // trip and cannot record a second entry.
  //
  // Past that window the stored verdict is gone and the same request ID would
  // be executed afresh — a second ScanLog row and a second entry counted for one
  // visitor. THAT is why this cannot simply retry forever. 60 seconds leaves
  // ample margin inside the 120, and the deadline is measured from the first
  // attempt, not from the last.
  var SCAN_REPLAY_WINDOW_MS = 120 * 1000;   // must match CONFIG.SCAN_REPLAY_SECONDS
  // 30 seconds, not 60. Measurement says nine of ten failures recover on the
  // second attempt and the rest rarely recover at all, so the second half of a
  // 60-second budget bought almost nothing while a visitor stood waiting. The
  // schedule still fits three attempts.
  var SCAN_RETRY_DEADLINE_MS = 30 * 1000;
  // Enforced, not merely documented. SCAN_REPLAY_WINDOW_MS previously existed
  // only as a comment that a test read with a regex — a constant no code
  // touches is a constant nobody maintains. If the deadline ever grows past the
  // window the server stores a verdict for, a late retry stops replaying and
  // starts recording a second entry, which is the defect Round 21 existed to
  // remove. Fail loudly at load rather than silently at a gate.
  if (SCAN_RETRY_DEADLINE_MS >= SCAN_REPLAY_WINDOW_MS) {
    throw new Error('Scanner misconfigured: the retry deadline (' +
      SCAN_RETRY_DEADLINE_MS + 'ms) must stay inside the server replay window (' +
      SCAN_REPLAY_WINDOW_MS + 'ms), or a retry will record a second entry.');
  }

  // Pauses between attempts, in order. Escalating so a persistent outage backs
  // off instead of hammering. A hard attempt ceiling sits alongside the time
  // deadline: a fault that fails instantly would otherwise fit hundreds of
  // requests into the window and trip RATE_LIMIT_PER_MIN.
  var RETRY_GAP_MS = [1000, 2000, 3000, 5000, 8000];
  var SCAN_MAX_ATTEMPTS = 8;

  // Retries for requests that change nothing and so are safe to repeat.
  var NETWORK_RETRIES = 2;

  /**
   * Pulls the first readable sentences out of an HTML error page so the person
   * holding the phone can see who sent it. Tags are stripped rather than
   * rendered — this goes into textContent, never innerHTML.
   */
  /**
   * Names which hop answered. Apps Script POSTs go to script.google.com, which
   * runs the script and redirects to script.googleusercontent.com, where the
   * body is actually served. Only the first hop appears in the Executions log,
   * so when a reply is wrong this is the only way to tell which end failed.
   */
  function describeOrigin(url) {
    var text = String(url || '');
    if (text.indexOf('script.googleusercontent.com') !== -1) {
      return 'script.googleusercontent.com (the content hop, after your script ran)';
    }
    if (text.indexOf('script.google.com') !== -1) {
      return 'script.google.com (the entry hop, before your script ran)';
    }
    if (!text) return 'an unreported address';
    try { return text.split('/')[2] || text.substring(0, 60); }
    catch (err) { return text.substring(0, 60); }
  }

  function firstUsefulText(html) {
    var title = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html || '');
    var stripped = String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    var head = (title ? 'Page title: ' + title[1].trim() + '. ' : '') + stripped;
    if (!head) return 'The page contained no readable text.';
    return head.length > 300 ? head.substring(0, 300) + '\u2026' : head;
  }

  /**
   * Different jsQR builds attach different things to window. 1.4.0 exposes the
   * function directly; some earlier and CDN/ESM builds expose
   * { default: fn, __esModule: true } instead, which is an object and throws
   * "window.jsQR is not a function" when called. Accept either.
   */
  function getDecoder() {
    var lib = window.jsQR;
    if (typeof lib === 'function') return lib;
    if (lib && typeof lib.default === 'function') return lib.default;
    if (typeof window.JSQR === 'function') return window.JSQR;
    return null;
  }

  // -------------------------------------------------------------------------
  // Panes
  // -------------------------------------------------------------------------

  var PANES = ['paneSignin', 'paneMode', 'paneScan', 'paneVerdict'];

  function show(id) {
    PANES.forEach(function (p) {
      var node = el(p);
      if (p === id) node.setAttribute('data-active', '');
      else node.removeAttribute('data-active');
    });
    if (id !== 'paneScan') stopCamera();
  }

  function notice(id, message) {
    var node = el(id);
    if (!message) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false;
    node.textContent = message;
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  /**
   * Shows or hides the "checking your access" state. The Google button is
   * hidden while it runs: leaving it on screen with nothing happening reads as
   * a dead button, and a slow content hop plus retries can hold this for a
   * minute. The label escalates so a long wait looks like progress rather than
   * a hang.
   */
  var signinBusyTimers = [];
  function setSigninBusy(busy) {
    signinBusyTimers.forEach(window.clearTimeout);
    signinBusyTimers = [];
    el('gsiButton').hidden = !!busy;
    el('signinBusy').hidden = !busy;
    if (!busy) return;
    el('signinBusyLabel').textContent = 'Checking your access\u2026';
    signinBusyTimers.push(window.setTimeout(function () {
      el('signinBusyLabel').textContent = 'Still checking \u2014 the server is slow to answer\u2026';
    }, 6000));
    signinBusyTimers.push(window.setTimeout(function () {
      el('signinBusyLabel').textContent = 'Taking longer than usual. Trying again\u2026';
    }, 20000));
  }

  window.handleCredentialResponse = function (response) {
    session.idToken = response.credential;
    session.expiresAt = expiryOf(response.credential);
    notice('signinError', '');
    setSigninBusy(true);
    post({ action: 'session' }, NETWORK_RETRIES).then(function (data) {
      setSigninBusy(false);
      if (!data.ok) { notice('signinError', data.error || 'Sign-in refused.'); return; }
      session.scanner = data.scanner;
      el('barWho').textContent = data.scanner.name || data.scanner.email || '';
      el('barWho').hidden = false;
      el('signOut').hidden = false;
      touchActivity();
      // The camera does not start here any more. A guard chooses a direction
      // and records a vehicle first; startCamera() runs when they press Enter.
      showModeChooser();
    }).catch(function (err) {
      setSigninBusy(false);
      notice('signinError', String(err.message || err));
    });
  };

  /**
   * The direction the guard is recording and the vehicle they noted, chosen
   * once per sign-in and sent with every scan.
   *
   * Session-scoped deliberately: a guard works one direction at a time, and
   * asking per scan would add a tap for every visitor. Cleared on sign-out, so
   * the next guard cannot inherit the previous one's choice.
   */
  var mode = { type: null, vehicle: null };

  function showModeChooser() {
    mode = { type: null, vehicle: null };
    el('modeVehicle').hidden = true;
    el('vehicleNumber').value = '';
    el('barMode').hidden = true;
    el('barMode').textContent = '';
    notice('scanError', '');
    show('paneMode');
  }

  function chooseMode(type) {
    mode.type = type;
    el('modeChosen').textContent = 'Recording ' + type.toLowerCase() +
                                   ' \u2014 change if that is wrong.';
    el('modeVehicle').hidden = false;
    el('vehicleNumber').focus();
  }

  function startScanning() {
    // Upper-cased here, not left to CSS. The field is displayed with
    // text-transform: uppercase, which changes only what is drawn — .value is
    // whatever was typed. Meanwhile autocapitalize="characters" DOES change the
    // value, but only on a mobile keyboard and never for pasted text. The
    // result was that the same plate was stored one way from a phone and
    // another from a desktop, splitting one vehicle into two when the column is
    // sorted. Normalising here makes what is stored equal what was shown, on
    // every device.
    var typed = String(el('vehicleNumber').value || '').trim().toUpperCase();
    // Blank stays blank on the wire. The server turns it into "0", so the
    // meaning of an unanswered field is decided in one place rather than two.
    mode.vehicle = typed;
    el('vehicleNumber').value = typed;

    el('barMode').textContent = mode.type +
      (typed ? ' \u00b7 ' + typed : '');
    el('barMode').hidden = false;

    show('paneScan');
    startCamera();
  }

  function expiryOf(jwt) {
    try {
      var body = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(body)).exp * 1000;
    } catch (e) {
      return Date.now() + 45 * 60 * 1000;
    }
  }

  /**
   * config.js is the one file an operator has to edit, and it is the one most
   * likely to be missing or left on its placeholders after a redeploy. Without
   * this the page loaded, threw on CONFIG.CLIENT_ID, and showed an empty
   * sign-in panel with nothing explaining why.
   */
  function configProblem() {
    if (typeof CONFIG === 'undefined' || !CONFIG) {
      return 'config.js did not load. Check it sits next to index.html and that ' +
             'the page URL ends in a slash.';
    }
    if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.indexOf('PASTE_') === 0) {
      return 'config.js still has the placeholder OAuth client ID. Fill in ' +
             'CLIENT_ID and redeploy.';
    }
    if (!CONFIG.API_URL || CONFIG.API_URL.indexOf('PASTE_') !== -1) {
      return 'config.js still has the placeholder API URL. Fill in API_URL with ' +
             'the deployment URL ending in /exec.';
    }
    return null;
  }

  function initGoogle() {
    var problem = configProblem();
    if (problem) {
      notice('signinError', problem);
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.id) {
      return window.setTimeout(initGoogle, 120);
    }
    google.accounts.id.initialize({
      client_id: CONFIG.CLIENT_ID,
      callback: window.handleCredentialResponse,
      // Gate phones are shared between shifts. Silent re-selection would log
      // one guard's scans against the previous guard's name, which quietly
      // corrupts the only audit trail this system has.
      auto_select: false,
      cancel_on_tap_outside: false
    });
    google.accounts.id.renderButton(el('gsiButton'), {
      theme: 'filled_blue', size: 'large', width: 280, text: 'signin_with'
    });
    google.accounts.id.prompt();
  }

  function requireSignIn(message) {
    session.idToken = null;
    session.expiresAt = 0;
    session.scanner = null;
    lastToken = { value: null, at: 0 };
    // A new sign-in is a new shift. Carrying the previous guard's counts over
    // would make the figure useless as evidence.
    tally = { attempts: 0, replayed: 0, photoFailed: 0, gaveUp: 0 };
    // Dropped with the rest of the session state. It can hold a raw reply
    // carrying a visitor's name, and there is no reason for it to survive into
    // the next guard's shift alongside a photo cache that does not.
    lastDiagnostic = null;
    retryPending = null;
    mode = { type: null, vehicle: null };
    el('barMode').hidden = true;
    el('barMode').textContent = '';
    el('scanRetry').hidden = true;
    clearVerdict();
    purgePhotoCache();
    stopCamera();
    el('barWho').hidden = true;
    el('signOut').hidden = true;
    leaveCapturedState();
    show('paneSignin');
    notice('signinError', message || 'Sign in again to continue.');
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.prompt();
    }
  }

  function signOut() {
    if (window.google && google.accounts && google.accounts.id) {
      // Clears Google's remembered-account hint, so the next shift is not
      // offered this guard's account.
      google.accounts.id.disableAutoSelect();
    }
    requireSignIn('Signed out. Hand the phone over, then sign in.');
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /** Error marker for "the session is over", independent of any message text. */
  function signedOut(message) {
    var err = new Error(message);
    err.signedOut = true;
    return err;
  }

  /**
   * `retries` is the number of extra attempts for actions that are safe to
   * repeat because they change nothing: session, photo. A scan is NOT safe to
   * repeat blindly — it records an entry — so it passes 0 here and runs its own
   * retry carrying a request ID the server replays against.
   *
   * Added because Apps Script's content hop returns a Drive 404 often enough
   * that a single attempt is not a working sign-in. Round 21 gave scanning a
   * retry and left sign-in without one, so a guard could be locked out at the
   * start of a shift by a fault the scanner would have shrugged off.
   */
  /**
   * Timing of the most recent reply, PER ACTION.
   *
   * This was one shared variable, which made the failure message actively
   * misleading: a scan that never got an answer was reported alongside the
   * timing of whatever last succeeded — usually the sign-in or the photograph —
   * implying the scan had been delivered in four seconds when no scan reply had
   * arrived at all. The question that matters is whether THIS action has ever
   * come back, so the timings are kept apart.
   */
  var timings = {};

  function describeTiming(action) {
    var mine = timings[action];
    var others = Object.keys(timings).filter(function (k) {
      return k !== action && timings[k] && timings[k].serverMs !== null;
    });

    var line;
    if (mine && mine.serverMs !== null) {
      line = 'Last ' + action + ' reply: script took ' +
             (mine.serverMs / 1000).toFixed(1) + 's, delivery took ' +
             (mine.deliveryMs / 1000).toFixed(1) + 's.';
    } else {
      line = 'No ' + action + ' reply has ever reached this phone in this session.';
    }

    // Naming what DID arrive is the discriminator. If photographs come back in
    // four seconds while scans never return, the fault is specific to the scan
    // request rather than to delivery in general.
    if (others.length) {
      line += ' Other requests are arriving: ' + others.map(function (k) {
        return k + ' in ' + ((timings[k].serverMs + timings[k].deliveryMs) / 1000).toFixed(1) + 's';
      }).join(', ') + '.';
    }
    return line;
  }

  function post(payload, retries, attemptNo, capMs) {
    if (!session.idToken || Date.now() > session.expiresAt - 30000) {
      requireSignIn('Your sign-in expired. Sign in again to keep scanning.');
      return Promise.reject(signedOut('Signed out'));
    }
    payload.idToken = session.idToken;

    var budget = (typeof retries === 'number') ? retries : 0;
    var attemptIndex = (typeof attemptNo === 'number') ? attemptNo : 0;
    var timeoutMs = timeoutForAttempt(attemptIndex, payload.action);
    // A caller running its own retry loop can cap this to the time it has left.
    if (typeof capMs === 'number') timeoutMs = Math.min(timeoutMs, capMs);

    // A hung request used to hang the gate with no upper bound and no feedback,
    // so "it takes forever" was indistinguishable from "it failed".
    var sentAt = Date.now();
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var timer = controller ? window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs) : null;
    var clearTimer = function () { if (timer) window.clearTimeout(timer); };

    // text/plain keeps this a simple request, so the browser skips the CORS
    // preflight that Apps Script web apps cannot answer.
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      // Read as text first. Apps Script answers a stale, wrongly-scoped or
      // unauthorised deployment with an HTML page, and res.json() on that
      // throws a parse error that says nothing useful about the real cause.
      return res.text().then(function (body) { return { res: res, body: body }; });
    }, function () {
      clearTimer();
      if (timedOut) {
        throw new Error('The server did not answer within ' +
                        Math.round(timeoutMs / 1000) + ' seconds. The request ' +
                        'may still have been processed \u2014 check the ScanLog before ' +
                        'rescanning.');
      }
      throw new Error('Could not reach the server. Check the phone\u2019s network, ' +
                      'then check API_URL in config.js.');
    }).then(function (r) {
      clearTimer();
      var body = (r.body || '').trim();

      // Do not guess at the cause. This used to assert three deployment faults
      // and throw the page away, which sent one investigation down the wrong
      // path for days. Show what arrived: a Google sign-in page, an
      // authorisation page, a Google error page and a network filter page look
      // nothing alike, and the first line of text identifies which it is.
      if (/^<(!doctype|html)/i.test(body) || body.indexOf('<HTML') === 0) {
        throw new Error('Expected data, received a web page (HTTP ' + r.res.status +
                        ', served by ' + describeOrigin(r.res.url) + ').\n\n' +
                        firstUsefulText(body) + '\n\nWorth checking in this order: the ' +
                        'deployment is out of date or archived; its access is not set to ' +
                        '\u201cAnyone\u201d; config.js points at the wrong /exec URL; the script ' +
                        'needs re-authorising (run Check configuration from the sheet menu); ' +
                        'something on the network is intercepting the request.');
      }
      if (!r.res.ok) throw new Error('Server returned HTTP ' + r.res.status + '.');
      if (body.charAt(0) !== '{') {
        throw new Error('Unexpected reply from the server (' +
                        (body ? body.substring(0, 60) : 'empty response') + ').');
      }

      var data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        throw new Error('Server reply was not readable.');
      }
      // Keep the bytes that produced this object. When a reply parses but is
      // missing fields the server always sends, the only way to tell a server
      // fault from something rewriting the response in transit is to look at
      // what actually arrived.
      try {
        Object.defineProperty(data, '__raw', { value: body, enumerable: false });
      } catch (ignored) { /* frozen or non-object reply; the checks below still run */ }

      // Split the round trip into the part the script spent and the part spent
      // getting the answer back. Until now both were one opaque number, which is
      // why "the scan is slow" could not be pinned on either side.
      var roundTripMs = Date.now() - sentAt;
      timings[payload.action] = {
        roundTripMs: roundTripMs,
        serverMs: (typeof data.serverMs === 'number') ? data.serverMs : null,
        deliveryMs: (typeof data.serverMs === 'number') ? roundTripMs - data.serverMs : null
      };
      if (data && data.authError) {
        requireSignIn(data.error);
        // Marked, not matched on text. This used to throw a plain Error whose
        // message was the server's, so callers compared it against the string
        // 'Signed out', decided it was an ordinary failure, and carried on —
        // the scanner restarted its camera on a signed-out session and replaced
        // the server's accurate message with a generic one.
        throw signedOut(data.error);
      }
      return data;
    }).catch(function (err) {
      if (err.signedOut || err.rateLimited || budget <= 0) throw err;
      return post(payload, budget - 1, attemptIndex + 1);
    });
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  function startCamera() {
    // Re-entrancy guard. getUserMedia is asynchronous, and ten call sites reach
    // this — including a large Enter button that a guard can easily double-tap
    // on a phone. Two calls landing before the first resolves acquired two
    // streams and left the first one's tracks running: an orphaned camera
    // nothing reads, draining the battery with the recording indicator lit.
    if (camera.starting) return;

    // Anything already open is released first. The same double-tap otherwise
    // overwrote camera.stream and lost the handle needed to stop it.
    if (camera.stream) {
      try { camera.stream.getTracks().forEach(function (t) { t.stop(); }); }
      catch (ignored) { /* already gone */ }
      camera.stream = null;
    }

    notice('scanError', '');
    leaveCapturedState();
    // One source for this line. It was written literally in three places, so
    // adding the session tally to two of them left the third silently winning.
    el('scanHint').textContent = tallyLine();

    camera.decode = getDecoder();
    if (!camera.decode) {
      el('scanHint').textContent = '';
      notice('scanError',
        'The QR reader did not load. Check that jsQR.js sits next to index.html ' +
        'and that the page was not opened from a cached copy.');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notice('scanError', 'This browser cannot open the camera. Use Chrome or Safari over https.');
      return;
    }

    camera.starting = true;
    // getUserMedia can resolve after stopCamera() has run — the guard signs
    // out, or the page is hidden, while the permission prompt is still open.
    // Without this the stream arrives afterwards and starts a camera nobody
    // asked for, with no handle held to stop it.
    var generation = camera.generation;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    }).then(function (stream) {
      if (generation !== camera.generation) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        camera.starting = false;
        throw new Error('__stale__');
      }
      camera.stream = stream;
      var video = el('video');
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      return video.play();
    }).then(function () {
      camera.starting = false;
      camera.running = true;
      camera.lastFrameAt = Date.now();

      // The track ending is the clean signal when a browser bothers to send it.
      // The watchdog covers the ones that do not.
      camera.stream.getTracks().forEach(function (t) {
        t.addEventListener('ended', function () {
          if (el('paneScan').hasAttribute('data-active')) camera.lastFrameAt = 0;
        });
      });
      watchCamera();

      if (!camera.canvas) {
        camera.canvas = document.createElement('canvas');
        camera.ctx = camera.canvas.getContext('2d', { willReadFrequently: true });
      }
      tick();
    }).catch(function (err) {
      // Cleared here too. Left set on a refusal, the guard could never start
      // the camera again without reloading — a worse outcome than the double
      // tap this guard exists to prevent.
      camera.starting = false;
      if (err && err.message === '__stale__') return;   // asked to stop; not a fault
      var message = (err && err.name === 'NotAllowedError')
        ? 'Camera access was blocked. Allow the camera in your browser settings, then reload.'
        : 'Camera could not start: ' + (err && err.message ? err.message : err);
      notice('scanError', message);
    });
  }

  /**
   * Restarts the camera when it has stopped producing frames.
   *
   * Deliberately driven by observed frames rather than by events. Track
   * `ended`, `visibilitychange` and `pagehide` all fire on some devices and not
   * others; a frame either arrived or it did not, and that is true everywhere.
   */
  function watchCamera() {
    if (camera.watchdog) window.clearInterval(camera.watchdog);
    camera.watchdog = window.setInterval(function () {
      if (!camera.running || camera.restarting) return;
      if (!el('paneScan').hasAttribute('data-active')) return;
      // A hidden page has no camera by design — visibilitychange already
      // stopped it. Restarting here would power the camera back up behind a
      // locked screen and drain the battery to no purpose.
      if (document.hidden) return;

      var live = !!camera.stream && camera.stream.getTracks().some(function (t) {
        return t.readyState === 'live';
      });
      // Zero means "no frame since the track ended", which is stalled by
      // definition. Reading it as falsy skipped the check entirely.
      var stalled = !camera.lastFrameAt ||
                    (Date.now() - camera.lastFrameAt > CAMERA_STALL_MS);
      if (live && !stalled) return;

      // A blip an hour apart is not a failing camera; six in a second is.
      if (Date.now() - (camera.lastRestartAt || 0) > CAMERA_RESTART_WINDOW_MS) {
        camera.restarts = 0;
      }
      camera.lastRestartAt = Date.now();
      camera.restarts = (camera.restarts || 0) + 1;
      if (camera.restarts > CAMERA_MAX_RESTARTS) {
        stopCamera();
        notice('scanError',
          'The camera keeps stopping. Tap Scan next visitor to try again, or ' +
          'reload the page.');
        return;
      }

      camera.restarting = true;
      stopCamera();
      startCamera();
      // After, not before: startCamera() clears scanError as its first action,
      // so a message set beforehand was wiped by the restart it was announcing.
      notice('scanError', 'Camera stopped \u2014 restarting it.');
      window.setTimeout(function () {
        camera.restarting = false;
        if (camera.running) notice('scanError', '');
      }, 2000);
    }, CAMERA_WATCHDOG_MS);
  }

  function stopCamera() {
    // Invalidates any getUserMedia still in flight, so its stream is discarded
    // rather than started after the fact.
    camera.generation++;
    camera.starting = false;
    camera.running = false;
    if (camera.watchdog) { window.clearInterval(camera.watchdog); camera.watchdog = null; }
    if (camera.raf) { cancelAnimationFrame(camera.raf); camera.raf = null; }
    if (camera.stream) {
      camera.stream.getTracks().forEach(function (t) { t.stop(); });
      camera.stream = null;
    }
    el('video').srcObject = null;
  }

  function tick() {
    if (!camera.running) return;
    var video = el('video');

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      var side = Math.min(video.videoWidth, video.videoHeight);
      if (side > 0) {
        var size = Math.min(side, 720);
        camera.canvas.width = size;
        camera.canvas.height = size;
        camera.ctx.drawImage(
          video,
          (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
          0, 0, size, size
        );
        camera.lastFrameAt = Date.now();
        var image = camera.ctx.getImageData(0, 0, size, size);
        var found = camera.decode(image.data, size, size, { inversionAttempts: 'dontInvert' });
        if (found && found.data) {
          onCode(found.data.trim());
        } else {
          // The code has left the frame, so the next sighting of it is a
          // deliberate new presentation and is accepted at once.
          lastToken = { value: null, at: 0 };
        }
      }
    }
    camera.raf = requestAnimationFrame(tick);
  }

  /**
   * The overlay's resting wording, taken from the markup on first use so the
   * two cannot drift apart.
   */
  var checkingNoteDefault = null;

  /**
   * Puts the "checking" overlay back to its resting state.
   *
   * The retry path writes progress into this note and nothing ever put it back,
   * so once a scan had retried, every later scan opened showing "Still asking —
   * attempt 4, 43s" beside a timer counting from zero. The guard was told a
   * fresh scan was already four attempts deep.
   *
   * Called when a NEW scan starts, not from enterCapturedState(), because the
   * retry path re-enters that state deliberately and must keep its progress.
   */
  function resetCheckingOverlay() {
    if (checkingNoteDefault === null) {
      checkingNoteDefault = el('checkingNote').textContent;
    }
    el('checkingNote').textContent = checkingNoteDefault;
  }

  function enterCapturedState() {
    camera.running = false;
    if (camera.raf) { cancelAnimationFrame(camera.raf); camera.raf = null; }
    // Blank the camera immediately. Until this existed, the guard had no cue
    // that the code had been read and kept holding the pass up.
    el('viewport').hidden = true;
    el('checking').hidden = false;
    el('scanHint').textContent = '';

    var started = Date.now();
    el('checkingTimer').textContent = '0.0s';
    if (checkTimer) window.clearInterval(checkTimer);
    checkTimer = window.setInterval(function () {
      el('checkingTimer').textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
    }, 100);
  }

  function leaveCapturedState() {
    if (checkTimer) { window.clearInterval(checkTimer); checkTimer = null; }
    el('checking').hidden = true;
    el('viewport').hidden = false;
  }

  /**
   * An opaque per-attempt identifier. The server stores its verdict under this
   * and replays it for a repeat, so a retry cannot record a second entry.
   */
  function newRequestId() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID().replace(/-/g, '');
    }
    return String(Date.now()) + '-' + Math.random().toString(36).substring(2, 12);
  }

  function onCode(token, reuseRequestId) {
    var now = Date.now();
    // The duplicate suppressor is skipped for a deliberate retry: the guard has
    // asked for this exact pass again, which is the case it exists to prevent
    // the camera doing by itself.
    if (!reuseRequestId && token === lastToken.value && now - lastToken.at < 2500) return;
    lastToken = { value: token, at: now };

    tally.attempts++;
    el('scanRetry').hidden = true;
    retryPending = null;
    resetCheckingOverlay();
    enterCapturedState();

    var scanSeq = ++scanSequence;
    // One ID for the whole attempt, reused by every retry. Apps Script loses
    // replies routinely — the script completes and the phone gets nothing — so
    // without a retry the guard was told to go and read a spreadsheet, and with
    // a naive retry the sheet gained a second admission for one visitor.
    // Reusing the id is what makes a retry free: the server replays its stored
    // verdict rather than recording a second entry.
    var requestId = reuseRequestId || newRequestId();

    // In parallel, not after the verdict. This is the difference between the
    // guard waiting scan+photo and waiting max(scan, photo).
    prefetchPhoto(token);

    var startedAt = Date.now();
    var attemptNo = 0;
    function elapsed() { return Date.now() - startedAt; }

    /**
     * Pause before the next attempt. Both retry paths use this — the one for
     * replies that never arrive and the one for replies that arrive malformed.
     * The malformed path originally retried with no pause at all, which meant a
     * reply that failed instantly fitted the whole budget into a few
     * milliseconds and hammered the server.
     */
    function afterGap(fn) {
      return new Promise(function (resolve) {
        window.setTimeout(resolve, RETRY_GAP_MS[
          Math.min(attemptNo - 1, RETRY_GAP_MS.length - 1)]);
      }).then(fn);
    }

    /**
     * Keeps asking until the replay window is nearly spent, rather than giving
     * up after a fixed number of tries. Each repeat carries the same request ID,
     * so the server replays the verdict it already reached.
     */
    function attempt() {
      attemptNo++;
      // Cap this attempt to whatever is left of the budget. Checking the
      // deadline only before starting one let a 4th attempt begin at 59s and
      // run a further 30, so a "60 second" limit produced an 82 second wait.
      var remaining = SCAN_RETRY_DEADLINE_MS - elapsed();
      return post({ action: 'scan', token: token, requestId: requestId,
                    type: mode.type, vehicle: mode.vehicle },
                  0, attemptNo - 1, remaining)
        .catch(function (err) {
          if (err.signedOut || err.rateLimited) throw err;
          if (attemptNo >= SCAN_MAX_ATTEMPTS) throw err;
          // Enough left for an attempt that could actually succeed, not merely
          // enough to start one.
          if (SCAN_RETRY_DEADLINE_MS - elapsed() < MIN_USEFUL_ATTEMPT_MS) throw err;

          el('checkingNote').textContent =
            'Still asking \u2014 attempt ' + (attemptNo + 1) + ', ' +
            Math.round(elapsed() / 1000) + 's. The pass has already been ' +
            'checked; waiting for the answer to come back.';

          return afterGap(function () {
            if (elapsed() >= SCAN_RETRY_DEADLINE_MS) throw err;
            return attempt();
          });
        });
    }

    function handle(data) {
        if (scanSeq !== scanSequence) return;   // superseded by a later scan
        leaveCapturedState();
        if (!data.ok) {
          notice('scanError', data.error || 'Could not check that pass.');
          resumeScanning();
          return;
        }
        current = { token: token, data: data };

        // A verdict is rendered only when the server actually stated one, and
        // only when it carries what the server always sends with it. deny()
        // sets `reason` unconditionally and attaches `visitor` whenever the
        // pass was found; handleScan() always sends `visitor` on ALLOW. A reply
        // missing those parsed cleanly and rendered as a bare red DENY with no
        // reason and no name — indistinguishable from a real refusal, and with
        // a correct, contradicting row already written to ScanLog.
        var shapeFault = null;
        var keys = Object.keys(data);
        if (keys.length === 1 && data.ok === true) {
          // Exactly what doGet() returns, and nothing else in the backend
          // produces it. Apps Script answers a POST with a 302 and the browser
          // converts it to a GET; that normally lands on the content host
          // holding the real answer. Landing back on /exec runs doGet instead.
          shapeFault = 'the GET endpoint answered instead of the scan \u2014 ' +
                       'Google redirected the request to the wrong place';
        } else if (data.result !== 'ALLOW' && data.result !== 'DENY') {
          shapeFault = (data.result === undefined
            ? 'no result field'
            : 'result was "' + String(data.result).substring(0, 40) + '"');
        } else if (data.result === 'DENY' && !data.reason) {
          shapeFault = 'a refusal with no reason';
        } else if (!data.visitor && data.reason !== 'Not an IIT Tirupati visitor pass.' &&
                   String(data.reason || '').indexOf('No record for this pass') !== 0) {
          shapeFault = 'a verdict with no visitor details';
        }

        if (shapeFault) {
          // Retrying is safe here and was not before Round 21: the same request
          // ID is sent again, and the server replays its stored verdict rather
          // than recording a second entry. Without that guarantee a retry would
          // have added a phantom admission every time.
          // The attempt ceiling must be checked HERE too. A malformed reply is
          // a *successful* POST, so the ceiling inside attempt()'s catch never
          // fires on this path — and with a reply that arrives quickly, the
          // deadline alone allows an unbounded loop.
          if (attemptNo < SCAN_MAX_ATTEMPTS &&
              SCAN_RETRY_DEADLINE_MS - elapsed() >= MIN_USEFUL_ATTEMPT_MS) {
            el('checkingNote').textContent =
              'Reply arrived incomplete \u2014 still asking, attempt ' +
              (attemptNo + 1) + ', ' + Math.round(elapsed() / 1000) + 's.';
            enterCapturedState();
            afterGap(function () {
              return attempt().then(handle, fail);
            });
            return;
          }
          giveUp(shapeFault + '. Received: ' + describeReply(data));
          return;
        }

        if (data.replayed) tally.replayed++;
        renderVerdict(data);
        show('paneVerdict');
        touchActivity();
    }

    /**
     * The one place this gives up, used by both exhaustion paths — a reply that
     * never arrives and a reply that arrives malformed. "The request may still
     * have been processed, check the ScanLog" was not something a guard can act
     * on with a visitor in front of them. Say what is known, and what to do.
     */
    /**
     * Gives up on this scan.
     *
     * The guard gets two lines and a button. The full diagnostic — timings,
     * tally, the raw page that came back — is kept for later rather than
     * printed: it ran to 1,225 characters, which is about 37 lines on a phone
     * and pushed the camera below the fold, so the gate became unusable at the
     * moment it was most needed.
     */
    function giveUp(detail) {
      // Counted here, not in fail(): the malformed-reply path calls this
      // directly, so counting in fail() missed every give-up caused by a reply
      // that arrived but was unusable.
      tally.gaveUp++;
      leaveCapturedState();

      lastDiagnostic =
        new Date().toISOString() + '\n' +
        'No answer after ' + Math.round(elapsed() / 1000) + 's, ' +
        attemptNo + ' attempt' + (attemptNo === 1 ? '' : 's') + '.\n' +
        describeTiming('scan') + '\n' + tallyLine() + '\n' + (detail || '');
      try { console.error('[visitor-pass] ' + lastDiagnostic); } catch (ignored) {}

      notice('scanError',
        'No answer from the server. Do not admit on this.\n' +
        'Try again below, or confirm with the host.');

      // Offer the same pass, not a fresh scan: the request id is reused, so
      // within the replay window the server returns the decision it already
      // made instead of recording a second entry.
      retryPending = { token: token, requestId: requestId };
      el('scanRetry').hidden = false;

      resumeScanning();
    }

    function fail(err) {
      if (scanSeq !== scanSequence) return;
      if (err.signedOut) { leaveCapturedState(); return; }
      if (err.rateLimited) {
        // Not a failed scan and not a pass problem. Say so plainly rather than
        // routing it through the "no answer" message, which would send a guard
        // chasing a fault that does not exist.
        leaveCapturedState();
        notice('scanError', err.message);
        resumeScanning();
        return;
      }
      giveUp(err.message || '');
    }

    attempt().then(handle, fail);
  }

  function resumeScanning() {
    // Every route back to waiting for a code passes through here — a verdict
    // dismissed, a failure given up on, a throttle. The retry path deliberately
    // does NOT, so its progress text survives while it is still trying.
    resetCheckingOverlay();
    leaveCapturedState();
    // Set last: leaveCapturedState() rewrites this, so an earlier assignment
    // was silently discarded.
    el('scanHint').textContent = tallyLine();
    if (camera.stream) { camera.running = true; tick(); }
    else startCamera();
  }

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------

  var TIME_OPTS = {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: CONFIG.TIMEZONE
  };

  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-IN', TIME_OPTS).format(new Date(iso));
    } catch (e) {
      return new Date(iso).toLocaleString();
    }
  }

  /**
   * Describes a reply that parsed but is missing fields. Shows the keys present
   * and the raw bytes, so a server fault and a rewritten response can be told
   * apart without a laptop and a debugger at the gate.
   */
  function describeReply(data) {
    var keys;
    try { keys = Object.keys(data).join(', '); } catch (err) { keys = '(unreadable)'; }
    var raw = (data && data.__raw) ? String(data.__raw) : '';
    var shown = raw.length > 240 ? raw.substring(0, 240) + '\u2026' : raw;
    return 'fields [' + keys + ']' +
           (raw ? '; ' + raw.length + ' bytes: ' + shown : '');
  }

  function renderVerdict(data) {
    var allow = data.result === 'ALLOW';
    var pane = el('paneVerdict');
    pane.classList.toggle('verdict--allow', allow);

    el('verdictWord').textContent = allow ? 'ALLOW' : 'DENY';
    var visitor = data.visitor || {};
    el('verdictName').textContent = visitor.name || '';

    el('verdictType').textContent = visitor.type || '';
    el('verdictAffil').textContent = visitor.affiliation || '';

    el('verdictReason').textContent = allow ? '' : (data.reason || 'This pass is not valid.');

    renderTrack(allow, visitor, data.now);

    // A pass with no photograph can only prove a booking exists, never that
    // this is the person it was made for. Say so rather than quietly hiding
    // the button and letting the screen read as a clean ALLOW.
    var warnings = [];
    if (data.warning) warnings.push(data.warning);
    // A replay is not shown to the guard. It means the first request's answer
    // was lost and the retry collected the decision the server had already
    // made — an internal recovery, not something they can act on, and an amber
    // flag beside a valid verdict invites hesitation over a non-problem. Still
    // counted in the tally, which is where it is actually useful.
    if (allow && !data.hasPhoto) {
      warnings.push('No photograph on file for this pass. Do not admit on it ' +
                    'alone — confirm with the host before letting them through.');
    }
    renderFlag(warnings.join(' '));
    renderFacts(data, visitor, allow);

    showInlinePhoto(data.hasPhoto);

    startMeter();
    pane.scrollTop = 0;
  }

  /**
   * Loads the photograph straight into the verdict panel. It used to sit behind
   * a button, which meant the guard could clear a visitor without ever seeing
   * the face — the one check the whole system rests on.
   */
  function showInlinePhoto(hasPhoto) {
    var tile = el('verdictPhoto');
    var img = el('verdictPhotoImg');
    var note = el('verdictPhotoNote');

    img.removeAttribute('src');
    tile.removeAttribute('data-loaded');
    // Cleared for every verdict. Left set, the next visitor's tile would be
    // styled as failed and a tap would retry their photograph instead of
    // opening it.
    tile.removeAttribute('data-failed');
    tile.setAttribute('data-empty', '');

    if (!hasPhoto || !current) {
      tile.hidden = true;
      return;
    }

    tile.hidden = false;
    note.textContent = 'Loading photo\u2026';
    img.alt = 'Photograph of ' + ((current.data.visitor && current.data.visitor.name) || 'the visitor');

    var forToken = current.token;
    fetchPhoto(forToken)
      .then(function (dataUri) {
        if (!current || current.token !== forToken) return;
        img.onload = function () {
          tile.removeAttribute('data-empty');
          tile.setAttribute('data-loaded', '');
        };
        img.onerror = function () { note.textContent = 'Photo unreadable'; };
        img.src = dataUri;
      })
      .catch(function (err) {
        if (!current || current.token !== forToken) return;
        if (err.signedOut) return;
        tally.photoFailed++;

        // The detail goes to the diagnostic, not into a tile the size of a
        // playing card. What the guard needs is a way to ask again.
        lastDiagnostic = new Date().toISOString() + '\nPhotograph: ' +
                         (err.message || 'unavailable') + '\n' +
                         describeTiming('photo');
        try { console.error('[visitor-pass] ' + lastDiagnostic); } catch (ignored) {}

        tile.setAttribute('data-failed', '');
        tile.hidden = false;
        note.textContent = 'Photo didn\u2019t load \u2014 tap to retry';
      });
  }

  /** Fetches once per pass; the full-screen view reuses the same bytes. */
  function fetchPhoto(token) {
    for (var i = 0; i < photoCache.length; i++) {
      if (photoCache[i].token !== token) continue;
      // Returned even when it failed. The prefetch and the verdict panel are
      // two consumers of ONE scan and must share one retry budget — evicting a
      // failure here made them run the budget twice over. Failed entries are
      // dropped when the guard moves on, so the next scan of the same pass
      // starts fresh.
      var hit = photoCache.splice(i, 1)[0];
      photoCache.push(hit);                         // most recently used last
      return hit.promise;
    }
    /**
     * One attempt. The payload check is deliberately inside the retry, not
     * after it: the server coerces `mime` into the allowed list and always
     * sends the image, so a reply that passes `ok` and then fails this check
     * has lost or mangled its payload in transit — the Round 19 signature. That
     * is transient and worth asking again for, and a photo fetch is a read, so
     * repeating it is free of consequence.
     */
    function attemptPhoto(triesLeft) {
      // One retry point only. An earlier version retried inside both the then
      // and the catch, so each failure branched twice and a budget of 2 turned
      // into 7 requests. The payload check throws; the catch decides.
      return post({ action: 'photo', token: token,
                    type: mode.type, vehicle: mode.vehicle }).then(function (data) {
        if (!data.ok) throw new Error(data.error || 'Photograph unavailable.');
        var ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
        var badMime = ALLOWED.indexOf(data.mime) === -1;
        var badData = !/^[A-Za-z0-9+/=]+$/.test(data.data || '');
        if (badMime || badData) {
          // The server coerces mime into the allowed list and always sends the
          // image, so a reply that passed `ok` and failed here lost its payload
          // in transit. Transient, and a photo fetch is a read, so it is safe
          // to ask again.
          throw new Error('The photograph did not arrive intact (' +
            (badMime ? 'type "' + String(data.mime).substring(0, 30) + '"' : 'type ok') + ', ' +
            (data.data === undefined ? 'no image data'
              : String(data.data).length + ' characters received') +
            '). The verdict above is still valid \u2014 confirm the face another way.');
        }
        return 'data:' + data.mime + ';base64,' + data.data;
      }).catch(function (err) {
        if (err.signedOut || triesLeft <= 0) throw err;
        return attemptPhoto(triesLeft - 1);
      });
    }

    var entry = { token: token, promise: null, failed: false };
    entry.promise = attemptPhoto(NETWORK_RETRIES).catch(function (err) {
      entry.failed = true;      // so the next lookup retries rather than reusing this
      throw err;
    });

    photoCache.push(entry);
    while (photoCache.length > PHOTO_CACHE_MAX) photoCache.shift();
    return entry.promise;
  }

  /**
   * Starts the photograph fetch at the same moment as the scan, rather than
   * after the verdict has rendered. The photo endpoint verifies the token
   * itself, so it does not depend on the scan's answer — running them in
   * sequence simply added a whole round trip before the face appeared. On a
   * refusal the fetch is wasted, which costs one request and no extra time.
   */
  function prefetchPhoto(token) {
    // Staggered, not simultaneous.
    //
    // Round 24 fired this in the same tick as the scan, which halved the time to
    // a face on screen. Field evidence since suggests a cost: most scans came
    // back flagged as replays, meaning the FIRST request of each pair was dying
    // and the retry was doing the work. Two responses staged at the same instant
    // for the same account is a plausible collision at Apps Script's content
    // hop, which is exactly where the 404s come from.
    //
    // A short offset keeps nearly all of the parallel benefit — the photo still
    // overlaps the scan, which takes seconds — while the two requests no longer
    // start together. THIS IS A HYPOTHESIS. If the amber replay flag keeps
    // appearing on most scans with this in place, it is wrong and the offset
    // should go.
    try {
      window.setTimeout(function () {
        try {
          fetchPhoto(token).catch(function () { /* surfaced later by showInlinePhoto */ });
        } catch (err) { /* never let a prefetch break a scan */ }
      }, PHOTO_PREFETCH_OFFSET_MS);
    } catch (err) { /* never let a prefetch break a scan */ }
  }

  function startMeter() {
    var meter = el('meter');
    meter.classList.remove('meter--run');
    meter.style.setProperty('--idle', (IDLE_CLEAR_MS / 1000) + 's');
    void meter.offsetWidth;           // force reflow so the animation restarts
    meter.classList.add('meter--run');
  }

  function stopMeter() {
    el('meter').classList.remove('meter--run');
  }

  /** Wipes every trace of the previous visitor from the verdict pane. */
  /**
   * Drops every cached photograph. Called where the screen must not be usable
   * by whoever picks the phone up next — sign-out, and the idle clear that B7
   * added — but deliberately NOT on "Scan next visitor", where the guard is
   * still working and re-fetching a face they saw a minute ago is pure latency.
   */
  function purgePhotoCache() {
    photoCache = [];
  }

  /**
   * Drops entries whose fetch failed, so the next scan of that pass tries
   * again. Successful entries are kept — that is the whole point of the cache.
   */
  function dropFailedPhotos() {
    photoCache = photoCache.filter(function (e) { return !e.failed; });
  }

  function clearVerdict() {
    stopMeter();
    current = null;
    closePhoto();
    el('verdictWord').textContent = '';
    el('verdictName').textContent = '';
    el('verdictType').textContent = '';
    el('verdictAffil').textContent = '';
    el('verdictReason').textContent = '';
    el('verdictFacts').innerHTML = '';
    el('verdictFlag').hidden = true;
    el('track').hidden = true;
    el('verdictPhoto').hidden = true;
    el('verdictPhoto').removeAttribute('data-failed');
    el('verdictPhotoImg').removeAttribute('src');
    setSigninBusy(false);
    el('paneVerdict').classList.remove('verdict--allow');
  }

  function renderTrack(allow, visitor, nowIso) {
    var track = el('track');
    if (!allow || !visitor.validFrom || !visitor.validUntil) { track.hidden = true; return; }

    var from = new Date(visitor.validFrom).getTime();
    var until = new Date(visitor.validUntil).getTime();
    var now = nowIso ? new Date(nowIso).getTime() : Date.now();
    if (!(until > from)) { track.hidden = true; return; }

    var ratio = Math.min(1, Math.max(0, (now - from) / (until - from)));
    track.hidden = false;
    el('trackFill').style.width = (ratio * 100).toFixed(2) + '%';
    el('trackNow').style.left = 'calc(' + (ratio * 100).toFixed(2) + '% - 1px)';
    el('trackFrom').textContent = formatTime(visitor.validFrom);
    el('trackUntil').textContent = formatTime(visitor.validUntil);

    // A pass can be allowed while outside its stated window, because the server
    // applies a silent buffer either side. Saying "valid for another 4 hours"
    // before the visit starts, or "closing now" while there is still an hour of
    // buffer left, would both be wrong. State the fact instead — the stated
    // times, never the buffer.
    var minutesLeft = Math.round((until - now) / 60000);
    var line;
    if (now < from) {
      line = 'Visit starts at ' + formatTime(visitor.validFrom) + '.';
    } else if (now > until) {
      line = 'Visit window ended at ' + formatTime(visitor.validUntil) + '.';
    } else if (minutesLeft < 90) {
      line = 'Valid for another ' + minutesLeft + ' min.';
    } else {
      line = 'Valid for another ' + Math.round(minutesLeft / 60) + ' hours.';
    }
    el('trackRemaining').textContent = line;
  }

  function renderFlag(warning) {
    el('verdictFlag').hidden = !warning;
    el('verdictFlagText').textContent = warning || '';
  }

  function renderFacts(data, visitor, allow) {
    var list = el('verdictFacts');
    list.innerHTML = '';

    // Type and affiliation are in the banner; the pass ID is a machine
    // identifier no one at a gate acts on. Both left out so the buttons stay
    // reachable without scrolling.
    var rows = [];
    // `visitor.purpose` is the wire field name, kept so the server and client
    // do not have to be renamed in lockstep. The label is what the guard reads.
    if (visitor.purpose) rows.push({ label: 'Venue', value: visitor.purpose, clamp: true });
    if (visitor.host || visitor.hostPhone) {
      rows.push({ label: 'Host', value: visitor.host || '', tel: visitor.hostPhone || '' });
    }
    if (visitor.visitorPhone) {
      rows.push({ label: 'Visitor phone', value: '', tel: visitor.visitorPhone });
    }
    if (!allow && visitor.validFrom) {
      rows.push({ label: 'Window',
                  value: formatTime(visitor.validFrom) + ' \u2192 ' +
                         formatTime(visitor.validUntil) });
    }
    if (data.scanCount) rows.push({ label: 'Entries', value: String(data.scanCount) });

    rows.forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row.label;
      var dd = document.createElement('dd');
      if (row.clamp) dd.className = 'clamp';

      if (row.tel) {
        // Name and number share one line; the number stays tappable so the gate
        // can call the host without retyping. The server has already stripped it
        // to dialable characters only.
        if (row.value) dd.appendChild(document.createTextNode(row.value + '  \u00b7  '));
        var link = document.createElement('a');
        link.href = 'tel:' + String(row.tel).replace(/[^0-9+]/g, '');
        link.textContent = row.tel;
        dd.appendChild(link);
      } else {
        dd.textContent = row.value;
      }

      list.appendChild(dt);
      list.appendChild(dd);
    });
  }

  // -------------------------------------------------------------------------
  // Photo
  // -------------------------------------------------------------------------

  function openPhoto() {
    if (!current) return;
    var overlay = el('photoOverlay');
    var img = el('photoImg');
    var status = el('photoStatus');

    var forToken = current.token;
    var forName = (current.data.visitor && current.data.visitor.name) || '';

    img.hidden = true;
    img.removeAttribute('src');
    status.hidden = false;
    status.innerHTML = '<span class="spinner"></span>';
    el('photoName').textContent = forName;
    overlay.setAttribute('data-open', '');
    el('photoClose').focus();

    fetchPhoto(forToken)
      .then(function (dataUri) {
        if (!current || current.token !== forToken) return;
        img.onload = function () { status.hidden = true; img.hidden = false; };
        img.onerror = function () { status.textContent = 'Photograph could not be displayed.'; };
        img.alt = 'Photograph of ' + (forName || 'the visitor');
        img.src = dataUri;
      })
      .catch(function (err) {
        if (!current || current.token !== forToken) return;
        if (!err.signedOut) {
          status.textContent = err.message || 'Photograph could not be loaded.';
        }
      });
  }

  function closePhoto() {
    var overlay = el('photoOverlay');
    var wasOpen = overlay.hasAttribute('data-open');
    overlay.removeAttribute('data-open');
    var img = el('photoImg');
    img.hidden = true;
    img.removeAttribute('src');
    // Only pull focus back if the overlay was actually open — clearVerdict()
    // calls this defensively and should not move focus.
    if (wasOpen && !el('verdictPhoto').hidden) el('verdictPhoto').focus();
  }

  // -------------------------------------------------------------------------
  // Idle handling
  // -------------------------------------------------------------------------

  /*
   * A verdict screen holds a name, purpose, host and a photograph, and it used
   * to stay there until someone pressed a button. A gate phone put down on a
   * desk was leaving a visitor's details on display, and an unattended signed-in
   * session is usable by whoever picks it up.
   */
  var idleClear = null;
  var idleSignout = null;

  function clearVisitorFromScreen() {
    if (!el('paneVerdict').hasAttribute('data-active')) return;
    clearVerdict();
    purgePhotoCache();
    show('paneScan');
    startCamera();
  }

  function touchActivity() {
    if (idleClear) window.clearTimeout(idleClear);
    if (idleSignout) window.clearTimeout(idleSignout);
    if (!session.idToken) return;
    idleClear = window.setTimeout(clearVisitorFromScreen, IDLE_CLEAR_MS);
    idleSignout = window.setTimeout(function () {
      signOut();
    }, IDLE_SIGNOUT_MS);
  }

  ['click', 'touchstart', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, touchActivity, { passive: true });
  });

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  el('scanRetry').addEventListener('click', function () {
    if (!retryPending) return;
    var pending = retryPending;
    el('scanRetry').hidden = true;
    notice('scanError', '');
    onCode(pending.token, pending.requestId);
  });

  /**
   * Triple-tap the scanner's name to read the last failure in full. Kept off
   * the guard's screen but reachable on the device, so a fault can be reported
   * without a laptop.
   */
  (function () {
    var taps = [];
    el('barWho').addEventListener('click', function () {
      var now = Date.now();
      taps = taps.filter(function (t) { return now - t < 1200; });
      taps.push(now);
      if (taps.length < 3) return;
      taps = [];
      notice('scanError', lastDiagnostic || 'No failure recorded this session.');
    });
  })();

  el('modeEntry').addEventListener('click', function () { chooseMode('Entry'); });
  el('modeExit').addEventListener('click', function () { chooseMode('Exit'); });
  el('modeEnter').addEventListener('click', startScanning);
  el('modeBack').addEventListener('click', showModeChooser);

  // Enter on the keyboard does what the Enter button does. A guard holding a
  // phone one-handed should not have to reach for a button they can already
  // see the keyboard covering.
  el('vehicleNumber').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); startScanning(); }
  });

  el('scanNext').addEventListener('click', function () {
    dropFailedPhotos();
    // Deliberately NOT clearing lastToken here. The pass is normally still in
    // front of the camera, and clearing it re-read the same code on the next
    // frame and put the same verdict straight back on screen. tick() clears it
    // as soon as the code leaves the frame instead.
    clearVerdict();
    show('paneScan');
    // Same wording as resumeScanning(), which this path does not use: it starts
    // the camera directly rather than resuming an existing stream.
    el('scanHint').textContent = tallyLine();
    startCamera();
  });

  el('signOut').addEventListener('click', signOut);
  el('verdictPhoto').addEventListener('click', function () {
    var tile = el('verdictPhoto');
    if (!tile.hasAttribute('data-failed')) { openPhoto(); return; }

    // Retry rather than open an overlay with nothing in it. The failed cache
    // entry has to go first, or the next request would be handed the rejection
    // that is already stored against this pass.
    tile.removeAttribute('data-failed');
    el('verdictPhotoNote').textContent = 'Loading photo\u2026';
    dropFailedPhotos();
    // The argument matters: showInlinePhoto() hides the tile and returns early
    // when it is falsy, so calling it bare made the retry silently do nothing.
    showInlinePhoto(!!(current && current.data && current.data.hasPhoto));
  });
  el('photoClose').addEventListener('click', closePhoto);
  el('photoOverlay').addEventListener('click', function (event) {
    if (event.target === el('photoOverlay') || event.target.id === 'photoImg') closePhoto();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && el('photoOverlay').hasAttribute('data-open')) closePhoto();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopCamera();
    else if (el('paneScan').hasAttribute('data-active')) startCamera();
  });

  // visibilitychange does not fire on every route out of a page — bfcache
  // navigation and some mobile browsers use pagehide. Without this the camera
  // indicator can stay lit after the guard has navigated away.
  window.addEventListener('pagehide', stopCamera);

  // Restored from bfcache after a back-navigation: visibilitychange does not
  // fire, so without this the scanner comes back with a dead camera.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted && el('paneScan').hasAttribute('data-active')) startCamera();
  });

  initGoogle();
})();
