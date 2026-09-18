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
  var camera = { stream: null, raf: null, canvas: null, ctx: null, running: false };
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

  var IDLE_CLEAR_MS = 90 * 1000;
  var IDLE_SIGNOUT_MS = 20 * 60 * 1000;

  // Apps Script routinely takes 2-4 seconds per request and a cold script can
  // take longer, so this is generous. It exists to put a bound on a hang, not
  // to police latency.
  var REQUEST_TIMEOUT_MS = 30 * 1000;

  // Two retries after the first attempt. Each carries the same request ID, so
  // the server replays its stored verdict rather than admitting the visitor
  // again. Three lost replies in a row is a real outage, not a blip.
  var SCAN_RETRIES = 2;

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

  var PANES = ['paneSignin', 'paneScan', 'paneVerdict'];

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
      show('paneScan');
      startCamera();
    }).catch(function (err) {
      setSigninBusy(false);
      notice('signinError', String(err.message || err));
    });
  };

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
  function post(payload, retries) {
    if (!session.idToken || Date.now() > session.expiresAt - 30000) {
      requireSignIn('Your sign-in expired. Sign in again to keep scanning.');
      return Promise.reject(signedOut('Signed out'));
    }
    payload.idToken = session.idToken;

    var budget = (typeof retries === 'number') ? retries : 0;

    // A hung request used to hang the gate with no upper bound and no feedback,
    // so "it takes forever" was indistinguishable from "it failed".
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var timer = controller ? window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS) : null;
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
                        Math.round(REQUEST_TIMEOUT_MS / 1000) + ' seconds. The request ' +
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
      if (err.signedOut || budget <= 0) throw err;
      return post(payload, budget - 1);
    });
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  function startCamera() {
    notice('scanError', '');
    leaveCapturedState();
    el('scanHint').textContent = 'Hold the visitor\u2019s QR code inside the frame.';

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

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    }).then(function (stream) {
      camera.stream = stream;
      var video = el('video');
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      return video.play();
    }).then(function () {
      camera.running = true;
      if (!camera.canvas) {
        camera.canvas = document.createElement('canvas');
        camera.ctx = camera.canvas.getContext('2d', { willReadFrequently: true });
      }
      tick();
    }).catch(function (err) {
      var message = (err && err.name === 'NotAllowedError')
        ? 'Camera access was blocked. Allow the camera in your browser settings, then reload.'
        : 'Camera could not start: ' + (err && err.message ? err.message : err);
      notice('scanError', message);
    });
  }

  function stopCamera() {
    camera.running = false;
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

  function onCode(token) {
    var now = Date.now();
    if (token === lastToken.value && now - lastToken.at < 2500) return;
    lastToken = { value: token, at: now };

    enterCapturedState();

    var scanSeq = ++scanSequence;
    // One ID for the whole attempt, reused by every retry. Apps Script loses
    // replies routinely — the script completes and the phone gets nothing — so
    // without a retry the guard was told to go and read a spreadsheet, and with
    // a naive retry the sheet gained a second admission for one visitor.
    var requestId = newRequestId();

    // In parallel, not after the verdict. This is the difference between the
    // guard waiting scan+photo and waiting max(scan, photo).
    prefetchPhoto(token);

    function attempt(triesLeft) {
      return post({ action: 'scan', token: token, requestId: requestId })
        .catch(function (err) {
          if (err.signedOut || triesLeft <= 0) throw err;
          el('scanHint').textContent = 'No answer yet \u2014 asking again\u2026';
          return attempt(triesLeft - 1);
        });
    }

    attempt(SCAN_RETRIES)
      .then(function (data) {
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
        if (data.result !== 'ALLOW' && data.result !== 'DENY') {
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
          notice('scanError', 'The server sent an incomplete reply (' + shapeFault +
                 '). Do not admit on this \u2014 the scan may already have been recorded. ' +
                 'Rescan, and report this if it repeats.\n\nReceived: ' +
                 describeReply(data));
          resumeScanning();
          return;
        }

        renderVerdict(data);
        show('paneVerdict');
        touchActivity();
      })
      .catch(function (err) {
        if (scanSeq !== scanSequence) return;
        leaveCapturedState();
        if (!err.signedOut) {
          notice('scanError', err.message || 'The scan could not be checked.');
          resumeScanning();
        }
      });
  }

  function resumeScanning() {
    leaveCapturedState();
    el('scanHint').textContent = 'Hold the visitor\u2019s QR code inside the frame.';
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
    if (data.replayed) {
      warnings.push('This is the answer to an earlier attempt that did not come ' +
                    'back. It has not been counted as a second entry.');
    }
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
        note.textContent = err.message && err.message.length < 40 ? err.message : 'Photo unavailable';
      });
  }

  /** Fetches once per pass; the full-screen view reuses the same bytes. */
  function fetchPhoto(token) {
    for (var i = 0; i < photoCache.length; i++) {
      if (photoCache[i].token === token) {
        var hit = photoCache.splice(i, 1)[0];
        photoCache.push(hit);                       // most recently used last
        return hit.promise;
      }
    }
    var promise = post({ action: 'photo', token: token }, NETWORK_RETRIES)
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || 'Photograph unavailable.');
        var ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
        if (ALLOWED.indexOf(data.mime) === -1 || !/^[A-Za-z0-9+/=]+$/.test(data.data || '')) {
          throw new Error('Photograph rejected as unreadable.');
        }
        return 'data:' + data.mime + ';base64,' + data.data;
      })
      .catch(function (err) {
        // A failure must not be cached, or one bad fetch would poison the
        // photograph for that pass until sign-out.
        photoCache = photoCache.filter(function (e) { return e.token !== token; });
        throw err;
      });

    photoCache.push({ token: token, promise: promise });
    while (photoCache.length > PHOTO_CACHE_MAX) photoCache.shift();
    return promise;
  }

  /**
   * Starts the photograph fetch at the same moment as the scan, rather than
   * after the verdict has rendered. The photo endpoint verifies the token
   * itself, so it does not depend on the scan's answer — running them in
   * sequence simply added a whole round trip before the face appeared. On a
   * refusal the fetch is wasted, which costs one request and no extra time.
   */
  function prefetchPhoto(token) {
    try {
      fetchPhoto(token).catch(function () { /* surfaced later by showInlinePhoto */ });
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

  el('scanNext').addEventListener('click', function () {
    // Deliberately NOT clearing lastToken here. The pass is normally still in
    // front of the camera, and clearing it re-read the same code on the next
    // frame and put the same verdict straight back on screen. tick() clears it
    // as soon as the code leaves the frame instead.
    clearVerdict();
    show('paneScan');
    startCamera();
  });

  el('signOut').addEventListener('click', signOut);
  el('verdictPhoto').addEventListener('click', openPhoto);
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
