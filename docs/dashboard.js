/* Visitor pass dashboard for the security head. */
(function () {
  'use strict';

  // guard.js normally handles both of these; repeat them so either script alone
  // is enough and a wrong deploy path does not leave a silently blank page.
  if (window.top !== window.self) { window.__FRAMED__ = true; return; }
  if (window.__FRAMED__) return;
  var gate = document.getElementById('framebust');
  if (gate && gate.parentNode) gate.parentNode.removeChild(gate);

  var el = function (id) { return document.getElementById(id); };

  var session = { idToken: null, expiresAt: 0, admin: null };
  var passes = [];
  var filter = 'all';
  var loadSeq = 0;

  var FILTERS = { fAll: 'all', fActive: 'active', fUpcoming: 'upcoming',
                  fExpired: 'expired', fRevoked: 'revoked' };

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  function configProblem() {
    if (typeof CONFIG === 'undefined' || !CONFIG) {
      return 'config.js did not load. Check it sits next to dashboard.html and ' +
             'that the page URL ends in a slash.';
    }
    if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.indexOf('PASTE_') === 0) {
      return 'config.js still has the placeholder OAuth client ID.';
    }
    if (!CONFIG.API_URL || CONFIG.API_URL.indexOf('PASTE_') !== -1) {
      return 'config.js still has the placeholder API URL.';
    }
    return null;
  }

  window.handleCredentialResponse = function (response) {
    session.idToken = response.credential;
    session.expiresAt = expiryOf(response.credential);
    notice('signinError', '');
    load();
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
    var problem = configProblem();
    if (problem) { notice('signinError', problem); return; }
    if (!window.google || !google.accounts || !google.accounts.id) {
      return window.setTimeout(initGoogle, 120);
    }
    google.accounts.id.initialize({
      client_id: CONFIG.CLIENT_ID,
      callback: window.handleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: false
    });
    google.accounts.id.renderButton(el('gsiButton'),
      { theme: 'filled_blue', size: 'large', width: 280, text: 'signin_with' });
    google.accounts.id.prompt();
  }

  function requireSignIn(message) {
    session.idToken = null;
    session.admin = null;
    passes = [];
    el('list').innerHTML = '';
    el('count').textContent = '';
    el('paneList').hidden = true;
    el('paneSignin').hidden = false;
    el('barWho').hidden = true;
    el('signOut').hidden = true;
    notice('signinError', message || 'Sign in again to continue.');
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.prompt();
  }

  function signOut() {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
    requireSignIn('Signed out.');
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  function post(payload) {
    if (!session.idToken || Date.now() > session.expiresAt - 30000) {
      requireSignIn('Your sign-in expired. Sign in again.');
      return Promise.reject(new Error('Signed out'));
    }
    payload.idToken = session.idToken;
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text().then(function (body) { return { res: res, body: body }; });
    }, function () {
      throw new Error('Could not reach the server. Check the network, then API_URL in config.js.');
    }).then(function (r) {
      var body = (r.body || '').trim();
      if (/^<(!doctype|html)/i.test(body) || body.indexOf('<HTML') === 0) {
        throw new Error('The API URL returned a web page instead of data. The ' +
                        'deployment is probably out of date or its access is not "Anyone".');
      }
      if (!r.res.ok) throw new Error('Server returned HTTP ' + r.res.status + '.');
      if (body.charAt(0) !== '{') throw new Error('Unexpected reply from the server.');
      var data;
      try { data = JSON.parse(body); } catch (e) { throw new Error('Server reply was not readable.'); }
      if (data && data.authError) { requireSignIn(data.error); throw new Error(data.error); }
      return data;
    });
  }

  // -------------------------------------------------------------------------
  // Loading and rendering
  // -------------------------------------------------------------------------

  function notice(id, message, good) {
    var node = el(id);
    if (!message) { node.hidden = true; node.textContent = ''; return; }
    node.className = 'notice ' + (good ? 'notice--ok' : 'notice--bad');
    node.hidden = false;
    node.textContent = message;
  }

  function load() {
    var seq = ++loadSeq;
    el('count').innerHTML = '<span class="spinner"></span> Loading\u2026';
    post({ action: 'dashboard' })
      .then(function (data) {
        if (seq !== loadSeq) return;
        if (!data.ok) { notice('listError', data.error || 'Could not load passes.'); return; }
        session.admin = data.admin;
        el('barWho').textContent = data.admin || '';
        el('barWho').hidden = false;
        el('signOut').hidden = false;
        el('paneSignin').hidden = true;
        el('paneList').hidden = false;
        notice('listError', '');
        passes = data.passes || [];
        render();
      })
      .catch(function (err) {
        if (seq !== loadSeq) return;
        el('count').textContent = '';
        if (String(err.message) !== 'Signed out') {
          el('paneSignin').hidden = true;
          el('paneList').hidden = false;
          notice('listError', err.message || 'Could not load passes.');
        }
      });
  }

  var TIME_OPTS = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
                    hour12: true, timeZone: (typeof CONFIG !== 'undefined' && CONFIG.TIMEZONE) || 'Asia/Kolkata' };

  function when(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('en-IN', TIME_OPTS).format(new Date(iso)); }
    catch (e) { return new Date(iso).toLocaleString(); }
  }

  function visible() {
    var q = el('search').value.trim().toLowerCase();
    return passes.filter(function (p) {
      if (filter !== 'all' && p.state !== filter) return false;
      if (!q) return true;
      return (p.visitor + ' ' + p.host + ' ' + p.affiliation + ' ' + p.type)
        .toLowerCase().indexOf(q) !== -1;
    });
  }

  function render() {
    var list = el('list');
    list.innerHTML = '';
    var rows = visible();

    el('count').textContent = rows.length + ' of ' + passes.length + ' pass(es)' +
      (passes.length >= (CONFIG.DASHBOARD_LIMIT || 300) ? ' \u2014 most recent only' : '');

    if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'count';
      empty.textContent = 'Nothing matches.';
      list.appendChild(empty);
      return;
    }

    rows.forEach(function (p) { list.appendChild(rowFor(p)); });
  }

  function rowFor(p) {
    var row = document.createElement('div');
    row.className = 'row';

    var left = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'row__name';
    name.textContent = p.visitor || '(no name)';
    left.appendChild(name);

    var meta = document.createElement('div');
    meta.className = 'row__meta';
    var bits = [];
    if (p.type) bits.push(p.type);
    if (p.affiliation) bits.push(p.affiliation);
    if (p.host) bits.push('Host: ' + p.host + (p.hostPhone ? ' \u00b7 ' + p.hostPhone : ''));
    meta.textContent = bits.join(' \u2014 ');
    left.appendChild(meta);

    var whenLine = document.createElement('div');
    whenLine.className = 'row__when';
    whenLine.textContent = when(p.validFrom) + '  \u2192  ' + when(p.validUntil) +
      (p.scans ? '   \u00b7   ' + p.scans + ' entries' : '');
    left.appendChild(whenLine);

    var side = document.createElement('div');
    side.className = 'row__side';

    var pill = document.createElement('span');
    pill.className = 'pill pill--' + p.state;
    pill.textContent = p.state;
    side.appendChild(pill);

    // One contextual action, never both: a disapproved pass can be approved,
    // anything else can be disapproved. An ERROR row is incomplete rather than
    // disapproved, so approving it would claim a validity it does not have.
    if (p.state !== 'error') {
      var toRevoked = p.state !== 'revoked';
      var btn = document.createElement('button');
      btn.className = 'act ' + (toRevoked ? 'act--disapprove' : 'act--approve');
      // The label is the operator's word; the value written to the sheet stays
      // ACTIVE / REVOKED, because that is what every gate checks.
      btn.textContent = toRevoked ? 'Disapprove' : 'Approve';
      btn.addEventListener('click', function () { change(p, toRevoked ? 'REVOKED' : 'ACTIVE', btn); });
      side.appendChild(btn);
    }

    row.appendChild(left);
    row.appendChild(side);
    return row;
  }

  function change(p, status, btn) {
    if (status === 'REVOKED' &&
        !window.confirm('Disapprove the pass for ' + (p.visitor || 'this visitor') + '?\n\n' +
                        'It stops working at every gate immediately.')) {
      return;
    }
    btn.disabled = true;
    btn.textContent = status === 'REVOKED' ? 'Disapproving\u2026' : 'Approving\u2026';
    notice('listOk', '');
    notice('listError', '');

    post({ action: 'setStatus', passId: p.passId, status: status })
      .then(function (data) {
        if (!data.ok) { notice('listError', data.error || 'Could not change that pass.'); load(); return; }
        notice('listOk', (status === 'REVOKED' ? 'Disapproved ' : 'Approved ') +
                         (p.visitor || 'the pass') + '.', true);
        load();
      })
      .catch(function (err) {
        if (String(err.message) !== 'Signed out') {
          notice('listError', err.message || 'Could not change that pass.');
        }
        load();
      });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  Object.keys(FILTERS).forEach(function (id) {
    el(id).addEventListener('click', function () {
      filter = FILTERS[id];
      Object.keys(FILTERS).forEach(function (other) {
        el(other).setAttribute('aria-pressed', String(other === id));
      });
      render();
    });
  });

  el('search').addEventListener('input', render);
  el('refresh').addEventListener('click', load);
  el('signOut').addEventListener('click', signOut);

  initGoogle();
})();
