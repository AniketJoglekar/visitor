/* Gate scanner for the IIT Tirupati visitor pass system. */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  var session = { idToken: null, expiresAt: 0, scanner: null, gate: null };
  var camera = { stream: null, raf: null, canvas: null, ctx: null, running: false };
  var lastToken = { value: null, at: 0 };
  var current = null;

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
      el('signOut').hidden = false;
      if (data.scanner.gate) el('gateSelect').value = data.scanner.gate;
      var saved = localStorage.getItem('gate');
      if (saved) el('gateSelect').value = saved;
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

  function initGoogle() {
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
    current = null;
    lastToken = { value: null, at: 0 };
    closePhoto();
    stopCamera();
    el('barGate').hidden = true;
    el('signOut').hidden = true;
    el('verdictFacts').innerHTML = '';
    el('verdictName').textContent = '';
    el('verdictReason').textContent = '';
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
      if (!res.ok) throw new Error('Server returned ' + res.status);
      return res.json();
    }).then(function (data) {
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

  function onCode(token) {
    var now = Date.now();
    if (token === lastToken.value && now - lastToken.at < 2500) return;
    lastToken = { value: token, at: now };

    camera.running = false;
    if (camera.raf) { cancelAnimationFrame(camera.raf); camera.raf = null; }
    el('scanHint').innerHTML = '<span class="spinner"></span> Checking\u2026';

    post({ action: 'scan', token: token, gate: session.gate })
      .then(function (data) {
        if (!data.ok) {
          notice('scanError', data.error || 'Could not check that pass.');
          resumeScanning();
          return;
        }
        current = { token: token, data: data };
        renderVerdict(data);
        show('paneVerdict');
      })
      .catch(function (err) {
        if (String(err.message) !== 'Signed out') {
          notice('scanError', 'No answer from the server. Check the network and try again.');
          resumeScanning();
        }
      });
  }

  function resumeScanning() {
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
    el('verdictReason').textContent = allow
      ? (visitor.type ? visitor.type : '')
      : (data.reason || 'This pass is not valid.');

    renderTrack(allow, visitor, data.now);
    renderFlag(data.warning);
    renderFacts(data, visitor, allow);

    var photoBtn = el('showPhoto');
    photoBtn.hidden = !data.hasPhoto;
    photoBtn.textContent = 'Show photo';

    pane.scrollTop = 0;
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

    var rows = [];
    if (visitor.organisation) rows.push(['Organisation', visitor.organisation, false]);
    if (!allow && visitor.type) rows.push(['Type', visitor.type, false]);
    if (visitor.purpose) rows.push(['Purpose', visitor.purpose, false]);
    if (visitor.host) rows.push(['Host', visitor.host, false]);
    if (!allow && visitor.validFromText) {
      rows.push(['Window', visitor.validFromText + ' \u2192 ' + visitor.validUntilText, false]);
    }
    if (data.scanCount) rows.push(['Entries', String(data.scanCount), false]);
    if (data.passId) rows.push(['Pass', data.passId, true]);

    rows.forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      if (row[2]) dd.className = 'mono';
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

    img.hidden = true;
    img.removeAttribute('src');
    status.hidden = false;
    status.innerHTML = '<span class="spinner"></span>';
    el('photoName').textContent = (current.data.visitor && current.data.visitor.name) || '';
    overlay.setAttribute('data-open', '');
    el('photoClose').focus();

    post({ action: 'photo', token: current.token })
      .then(function (data) {
        if (!data.ok) { status.textContent = data.error || 'Photograph unavailable.'; return; }
        var ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
        if (ALLOWED.indexOf(data.mime) === -1 || !/^[A-Za-z0-9+/=]+$/.test(data.data || '')) {
          status.textContent = 'Photograph rejected as unreadable. Contact GAC.';
          return;
        }
        img.onload = function () { status.hidden = true; img.hidden = false; };
        img.onerror = function () { status.textContent = 'Photograph could not be displayed.'; };
        img.alt = 'Photograph of ' + ((current.data.visitor && current.data.visitor.name) || 'the visitor');
        img.src = 'data:' + data.mime + ';base64,' + data.data;
      })
      .catch(function (err) {
        if (String(err.message) !== 'Signed out') status.textContent = 'Photograph could not be loaded.';
      });
  }

  function closePhoto() {
    var overlay = el('photoOverlay');
    overlay.removeAttribute('data-open');
    var img = el('photoImg');
    img.hidden = true;
    img.removeAttribute('src');
    el('showPhoto').focus();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  el('gateConfirm').addEventListener('click', function () {
    session.gate = el('gateSelect').value;
    localStorage.setItem('gate', session.gate);
    var bar = el('barGate');
    bar.hidden = false;
    bar.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = session.gate;
    bar.appendChild(strong);
    bar.appendChild(document.createTextNode(
      session.scanner ? session.scanner.name : ''));
    show('paneScan');
    startCamera();
  });

  el('scanNext').addEventListener('click', function () {
    current = null;
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

  initGoogle();
})();
