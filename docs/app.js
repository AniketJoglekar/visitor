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

  var session = { idToken: null, expiresAt: 0, scanner: null, gate: null };
  var camera = { stream: null, raf: null, canvas: null, ctx: null, running: false };
  var lastToken = { value: null, at: 0 };
  var current = null;
  var checkTimer = null;
  var scanSequence = 0;

  var IDLE_CLEAR_MS = 90 * 1000;
  var IDLE_SIGNOUT_MS = 20 * 60 * 1000;

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

  var PANES = ['paneSignin', 'paneGate', 'paneScan', 'paneVerdict'];

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

  window.handleCredentialResponse = function (response) {
    session.idToken = response.credential;
    session.expiresAt = expiryOf(response.credential);
    notice('signinError', '');
    post({ action: 'session' }).then(function (data) {
      if (!data.ok) { notice('signinError', data.error || 'Sign-in refused.'); return; }
      session.scanner = data.scanner;
      el('barWho').textContent = data.scanner.name || data.scanner.email || '';
      el('barWho').hidden = false;
      el('signOut').hidden = false;
      touchActivity();
      var saved = null;
      try { saved = localStorage.getItem('gate'); } catch (e) {}
      if (saved) el('gateSelect').value = saved;
      el('gateCancel').hidden = true;
      el('gateConfirm').textContent = 'Start scanning';
      el('gateHeading').textContent = 'Which gate?';
      show('paneGate');
    }).catch(function (err) {
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
    stopCamera();
    el('barWho').hidden = true;
    el('gateStrip').hidden = true;
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

  function post(payload) {
    if (!session.idToken || Date.now() > session.expiresAt - 30000) {
      requireSignIn('Your sign-in expired. Sign in again to keep scanning.');
      return Promise.reject(new Error('Signed out'));
    }
    payload.idToken = session.idToken;
    // text/plain keeps this a simple request, so the browser skips the CORS
    // preflight that Apps Script web apps cannot answer.
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      // Read as text first. Apps Script answers a stale, wrongly-scoped or
      // unauthorised deployment with an HTML page, and res.json() on that
      // throws a parse error that says nothing useful about the real cause.
      return res.text().then(function (body) { return { res: res, body: body }; });
    }, function () {
      throw new Error('Could not reach the server. Check the phone\u2019s network, ' +
                      'then check API_URL in config.js.');
    }).then(function (r) {
      var body = (r.body || '').trim();

      if (/^<(!doctype|html)/i.test(body) || body.indexOf('<HTML') === 0) {
        throw new Error('The API URL returned a web page instead of data. Usually ' +
                        'the deployment is out of date, its access is not set to ' +
                        '"Anyone", or config.js points at the wrong /exec URL.');
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
      if (data && data.authError) {
        requireSignIn(data.error);
        throw new Error(data.error);
      }
      return data;
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
        if (found && found.data) onCode(found.data.trim());
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

  function onCode(token) {
    var now = Date.now();
    if (token === lastToken.value && now - lastToken.at < 2500) return;
    lastToken = { value: token, at: now };

    enterCapturedState();

    var scanSeq = ++scanSequence;
    post({ action: 'scan', token: token, gate: session.gate })
      .then(function (data) {
        if (scanSeq !== scanSequence) return;   // superseded by a later scan
        leaveCapturedState();
        if (!data.ok) {
          notice('scanError', data.error || 'Could not check that pass.');
          resumeScanning();
          return;
        }
        current = { token: token, data: data };
        renderVerdict(data);
        show('paneVerdict');
        touchActivity();
      })
      .catch(function (err) {
        if (scanSeq !== scanSequence) return;
        leaveCapturedState();
        if (String(err.message) !== 'Signed out') {
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
    if (allow && !data.hasPhoto) {
      warnings.push('No photograph on file. Do not admit on this pass alone — ' +
                    'confirm with the host before letting them through.');
    }
    renderFlag(warnings.join(' '));
    renderFacts(data, visitor, allow);

    var photoBtn = el('showPhoto');
    photoBtn.hidden = !data.hasPhoto;
    photoBtn.textContent = 'Show photo';

    startMeter();
    pane.scrollTop = 0;
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
    el('showPhoto').hidden = true;
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

    var minutesLeft = Math.round((until - now) / 60000);
    el('trackRemaining').textContent = minutesLeft <= 0
      ? 'Closing now.'
      : minutesLeft < 90
        ? 'Valid for another ' + minutesLeft + ' min.'
        : 'Valid for another ' + Math.round(minutesLeft / 60) + ' hours.';
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
    if (visitor.purpose) rows.push({ label: 'Purpose', value: visitor.purpose, clamp: true });
    if (visitor.host) rows.push({ label: 'Host', value: visitor.host });
    if (visitor.hostPhone) rows.push({ label: 'Phone', value: visitor.hostPhone, tel: true });
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
        // Tappable so the gate can call the host without retyping. The server
        // has already stripped this to dialable characters only.
        var link = document.createElement('a');
        link.href = 'tel:' + String(row.value).replace(/[^0-9+]/g, '');
        link.textContent = row.value;
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

    // Capture what this request is for. The reply can arrive after the guard
    // has tapped Scan next, at which point `current` is null — reading it in
    // the callback threw, and a late reply could otherwise paint the previous
    // visitor's photo over the next one.
    var forToken = current.token;
    var forName = (current.data.visitor && current.data.visitor.name) || '';
    var stale = function () { return !current || current.token !== forToken; };

    img.hidden = true;
    img.removeAttribute('src');
    status.hidden = false;
    status.innerHTML = '<span class="spinner"></span>';
    el('photoName').textContent = forName;
    overlay.setAttribute('data-open', '');
    el('photoClose').focus();

    post({ action: 'photo', token: forToken })
      .then(function (data) {
        if (stale()) return;
        if (!data.ok) { status.textContent = data.error || 'Photograph unavailable.'; return; }
        var ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
        if (ALLOWED.indexOf(data.mime) === -1 || !/^[A-Za-z0-9+/=]+$/.test(data.data || '')) {
          status.textContent = 'Photograph rejected as unreadable. Contact GAC.';
          return;
        }
        img.onload = function () { status.hidden = true; img.hidden = false; };
        img.onerror = function () { status.textContent = 'Photograph could not be displayed.'; };
        img.alt = 'Photograph of ' + (forName || 'the visitor');
        img.src = 'data:' + data.mime + ';base64,' + data.data;
      })
      .catch(function (err) {
        if (stale()) return;
        if (String(err.message) !== 'Signed out') {
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
    if (wasOpen && !el('showPhoto').hidden) el('showPhoto').focus();
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

  function openGatePicker(isChange) {
    // Changing gate mid-shift must not require signing out — a guard who
    // picked the wrong post should be able to correct it in two taps, and the
    // gate is what the scan log records.
    el('gateCancel').hidden = !isChange;
    el('gateConfirm').textContent = isChange ? 'Use this gate' : 'Start scanning';
    el('gateHeading').textContent = isChange ? 'Change gate' : 'Which gate?';
    if (session.gate) el('gateSelect').value = session.gate;
    clearVerdict();
    show('paneGate');
  }

  function applyGate(gate) {
    session.gate = gate;
    try { localStorage.setItem('gate', gate); } catch (e) {}
    el('gateStripName').textContent = gate;
    el('gateStrip').hidden = false;
  }

  el('gateConfirm').addEventListener('click', function () {
    applyGate(el('gateSelect').value);
    lastToken = { value: null, at: 0 };
    show('paneScan');
    startCamera();
  });

  el('gateCancel').addEventListener('click', function () {
    lastToken = { value: null, at: 0 };
    show('paneScan');
    startCamera();
  });

  el('gateChange').addEventListener('click', function () {
    openGatePicker(true);
  });

  el('scanNext').addEventListener('click', function () {
    // The debounce stops one code firing twice while it is still in frame. A
    // deliberate Scan next means the guard wants the next read, which may
    // legitimately be the same visitor again.
    lastToken = { value: null, at: 0 };
    clearVerdict();
    show('paneScan');
    startCamera();
  });

  el('signOut').addEventListener('click', signOut);
  el('showPhoto').addEventListener('click', openPhoto);
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
