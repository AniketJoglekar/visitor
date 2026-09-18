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
  // The server decides how many rows it returns and reports it. config.js does
  // not carry DASHBOARD_LIMIT, so reading CONFIG for it always fell through to
  // a hardcoded 300 and the "most recent only" notice fired at the wrong count
  // the moment the server's limit was changed.
  var serverLimit = 300;

  var IDLE_CLEAR_MS = 5 * 60 * 1000;
  var IDLE_SIGNOUT_MS = 20 * 60 * 1000;

  // Generous: Apps Script routinely takes 2-4 seconds and a cold script longer.
  // This bounds a hang, it does not police latency.
  var REQUEST_TIMEOUT_MS = 30 * 1000;

  // Retries for requests that change nothing and so are safe to repeat.
  var NETWORK_RETRIES = 2;

  /**
   * Pulls the first readable sentences out of an HTML error page so the reader
   * can see who sent it. Tags are stripped, never rendered — this goes into
   * textContent.
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
    // Cancel first. Without this the sign-out timer armed by the previous
    // session still fired and called signOut() again, re-prompting Google.
    if (idleClear) { window.clearTimeout(idleClear); idleClear = null; }
    if (idleSignout) { window.clearTimeout(idleSignout); idleSignout = null; }
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
 
  function signedOut(message) {
    var err = new Error(message);
    err.signedOut = true;
    return err;
  }
 
  /**
   * `retries` is extra attempts for actions that change nothing. Apps Script's
   * content hop returns a Drive 404 often enough that one attempt is not a
   * working sign-in. `setStatus` writes, so it is deliberately not retried —
   * a repeat could re-apply a change the operator has since reversed.
   */
  function post(payload, retries) {
    if (!session.idToken || Date.now() > session.expiresAt - 30000) {
      requireSignIn('Your sign-in expired. Sign in again.');
      return Promise.reject(signedOut('Signed out'));
    }
    payload.idToken = session.idToken;

    var budget = (typeof retries === 'number') ? retries : 0;

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var timer = controller ? window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS) : null;
    var clearTimer = function () { if (timer) window.clearTimeout(timer); };

    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.text().then(function (body) { return { res: res, body: body }; });
    }, function () {
      clearTimer();
      if (timedOut) {
        throw new Error('The server did not answer within ' +
                        Math.round(REQUEST_TIMEOUT_MS / 1000) + ' seconds. The request may ' +
                        'still have been processed \u2014 check the sheet before retrying.');
      }
      throw new Error('Could not reach the server. Check the network, then API_URL in config.js.');
    }).then(function (r) {
      clearTimer();
      var body = (r.body || '').trim();
      // Show what arrived rather than asserting a cause. The old message named
      // deployment faults it could not verify and discarded the page itself.
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
      if (body.charAt(0) !== '{') throw new Error('Unexpected reply from the server.');
      var data;
      try { data = JSON.parse(body); } catch (e) { throw new Error('Server reply was not readable.'); }
      if (data && data.authError) { requireSignIn(data.error); throw signedOut(data.error); }
      return data;
    }).catch(function (err) {
      if (err.signedOut || budget <= 0) throw err;
      return post(payload, budget - 1);
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
    post({ action: 'dashboard' }, NETWORK_RETRIES)
      .then(function (data) {
        if (seq !== loadSeq) return;
        if (!data.ok) {
          // Show the list pane even though there is nothing in it: listError
          // lives inside that pane, so reporting the failure without revealing
          // it left the screen looking like nothing had happened at all.
          el('paneSignin').hidden = true;
          el('paneList').hidden = false;
          el('count').textContent = '';
          notice('listError', data.error || 'Could not load passes.');
          return;
        }
        session.admin = data.admin;
        el('barWho').textContent = data.admin || '';
        el('barWho').hidden = false;
        el('signOut').hidden = false;
        el('paneSignin').hidden = true;
        el('paneList').hidden = false;
        notice('listError', '');
        if (typeof data.limit === 'number' && data.limit > 0) serverLimit = data.limit;
        passes = data.passes || [];
        render();
        touchActivity();
      })
      .catch(function (err) {
        if (seq !== loadSeq) return;
        el('count').textContent = '';
        if (!err.signedOut) {
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
      (passes.length >= serverLimit ? ' \u2014 most recent only' : '');
 
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
        if (!err.signedOut) {
          notice('listError', err.message || 'Could not change that pass.');
        }
        load();
      });
  }
 
  // -------------------------------------------------------------------------
  // Idle handling
  // -------------------------------------------------------------------------
 
  /*
   * B7 gave the scanner a visitor-details clear and an auto sign-out because an
   * unattended signed-in gate phone was leaving one visitor's details on screen.
   * The dashboard was written later and never got either, while showing far
   * more: up to DASHBOARD_LIMIT visitor names with affiliations, hosts and host
   * phone numbers, all at once, on a laptop the security head walks away from.
   * Clearing is cheap here because Refresh reloads everything.
   */
  var idleClear = null;
  var idleSignout = null;
 
  function clearListFromScreen() {
    if (el('paneList').hidden) return;
    passes = [];
    el('list').innerHTML = '';
    el('count').textContent = 'Screen cleared while idle. Press Refresh to reload.';
    notice('listOk', '');
    notice('listError', '');
  }
 
  function touchActivity() {
    if (idleClear) window.clearTimeout(idleClear);
    if (idleSignout) window.clearTimeout(idleSignout);
    if (!session.idToken) return;
    idleClear = window.setTimeout(clearListFromScreen, IDLE_CLEAR_MS);
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
