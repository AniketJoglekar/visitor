/* Host approvals page: approve visitors who named you, and upload event lists. */
(function () {
  'use strict';

  // guard.js normally handles both; repeated so either script alone is enough.
  if (window.top !== window.self) { window.__FRAMED__ = true; return; }
  if (window.__FRAMED__) return;
  var gate = document.getElementById('framebust');
  if (gate && gate.parentNode) gate.parentNode.removeChild(gate);

  var el = function (id) { return document.getElementById(id); };

  var session = { idToken: null, expiresAt: 0, host: null };
  var data = { visitors: [], entries: [], graceDays: 1 };
  var view = 'waiting';
  var listFilter = 'all';
  var loadSeq = 0;
  // The file as read, what could be saved from it, and — after saving — what
  // happened to each row. Held so the host can download their file back.
  var upload = null;

  var IDLE_CLEAR_MS = 5 * 60 * 1000;
  var IDLE_SIGNOUT_MS = 20 * 60 * 1000;
  var ATTEMPT_TIMEOUTS_MS = [8000, 15000, 30000];
  var NETWORK_RETRIES = 2;
  // Floors for the two actions that send email inside the request. An upload
  // part re-decides waiting requests and sends up to NOTIFY_INLINE_ON_UPLOAD
  // passes (QR and photo each); a decision sends one. The dashboard's 8-second
  // first attempt would abort them mid-send and report a failure for work
  // that then completed.
  var SLOW_ACTION_MS = { hostUpload: 30000, hostDecide: 30000 };
  // doPost() refuses bodies over 8192 characters. Chunks are sized against the
  // real serialised body, ID token included, with room to spare.
  var CHUNK_CHARS = 7200;
  var MAX_FILE_BYTES = 2 * 1024 * 1024;

  var TABS = { tWaiting: 'waiting', tUpload: 'upload', tList: 'list', tVisitors: 'visitors' };
  var VIEWS = { waiting: 'viewWaiting', upload: 'viewUpload', list: 'viewList', visitors: 'viewVisitors' };

  // -------------------------------------------------------------------------
  // Sign in (as dashboard.js)
  // -------------------------------------------------------------------------

  function configProblem() {
    if (typeof CONFIG === 'undefined' || !CONFIG) {
      return 'config.js did not load. Check it sits next to host.html and ' +
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
  }

  window.handleCredentialResponse = function (response) {
    session.idToken = response.credential;
    session.expiresAt = expiryOf(response.credential);
    notice('signinError', '');
    setSigninBusy(true);
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
    setSigninBusy(false);
    if (idleClear) { window.clearTimeout(idleClear); idleClear = null; }
    if (idleSignout) { window.clearTimeout(idleSignout); idleSignout = null; }
    session.idToken = null;
    session.host = null;
    clearData();
    el('paneMain').hidden = true;
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

  /** Removes every visitor detail from memory and the screen. */
  function clearData() {
    data = { visitors: [], entries: [], graceDays: data.graceDays };
    upload = null;
    ['waitingList', 'listRows', 'visitorsList', 'checkRanges', 'checkProblems'].forEach(function (id) {
      el(id).innerHTML = '';
    });
    ['waitingCount', 'listCount', 'visitorsCount'].forEach(function (id) { el(id).textContent = ''; });
    el('uploadCheck').hidden = true;
    el('uploadDone').hidden = true;
    el('csvFile').value = '';
  }

  // -------------------------------------------------------------------------
  // API (as dashboard.js)
  // -------------------------------------------------------------------------

  function signedOut(message) {
    var err = new Error(message);
    err.signedOut = true;
    return err;
  }

  function describeOrigin(url) {
    var text = String(url || '');
    if (text.indexOf('script.googleusercontent.com') !== -1) return 'the content hop, after the script ran';
    if (text.indexOf('script.google.com') !== -1) return 'the entry hop, before the script ran';
    return text ? text.split('/')[2] || text.substring(0, 60) : 'an unreported address';
  }

  /**
   * `retries` only for requests safe to repeat. hostUpload is one of them —
   * saving merges, so a repeat stores the same thing — but hostDecide is not:
   * a lost reply to "approve" may already have emailed the visitor.
   */
  function post(payload, retries, attemptNo) {
    if (!session.idToken || Date.now() > session.expiresAt - 30000) {
      requireSignIn('Your sign-in expired. Sign in again.');
      return Promise.reject(signedOut('Signed out'));
    }
    payload.idToken = session.idToken;
    var budget = (typeof retries === 'number') ? retries : 0;
    var attemptIndex = (typeof attemptNo === 'number') ? attemptNo : 0;
    var timeoutMs = Math.max(ATTEMPT_TIMEOUTS_MS[Math.min(attemptIndex, ATTEMPT_TIMEOUTS_MS.length - 1)],
                             SLOW_ACTION_MS[payload.action] || 0);

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var timer = controller ? window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs) : null;
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
        throw new Error('The server did not answer within ' + Math.round(timeoutMs / 1000) +
                        ' seconds. It may still have been done \u2014 press Refresh before retrying.');
      }
      throw new Error('Could not reach the server. Check the network, then API_URL in config.js.');
    }).then(function (r) {
      clearTimer();
      var body = (r.body || '').trim();
      if (/^<(!doctype|html)/i.test(body)) {
        throw new Error('Expected data, received a web page (HTTP ' + r.res.status +
                        ', from ' + describeOrigin(r.res.url) + '). The deployment may be out ' +
                        'of date, or its access not set to \u201cAnyone\u201d.');
      }
      if (!r.res.ok) throw new Error('Server returned HTTP ' + r.res.status + '.');
      if (body.charAt(0) !== '{') throw new Error('Unexpected reply from the server.');
      var reply;
      try { reply = JSON.parse(body); } catch (e) { throw new Error('Server reply was not readable.'); }
      // A throttle is final: retrying counts against the same bucket.
      if (reply && reply.ok === false && reply.rateLimited) {
        var throttled = new Error(reply.error || 'Too many requests.');
        throttled.rateLimited = true;
        throw throttled;
      }
      if (reply && reply.authError) { requireSignIn(reply.error); throw signedOut(reply.error); }
      return reply;
    }).catch(function (err) {
      if (err.signedOut || err.rateLimited || budget <= 0) throw err;
      return post(payload, budget - 1, attemptIndex + 1);
    });
  }

  function notice(id, message, good) {
    var node = el(id);
    if (!message) { node.hidden = true; node.textContent = ''; return; }
    node.className = 'notice ' + (good ? 'notice--ok' : 'notice--bad');
    node.hidden = false;
    node.textContent = message;
  }

  // -------------------------------------------------------------------------
  // Loading and rendering
  // -------------------------------------------------------------------------

  /**
   * keepNotices === true after an action: the action's own success or failure
   * message must survive the reload that follows it. Without this the reload
   * cleared mainError on success, so a refused or failed decision flashed its
   * error and left the host looking at an unchanged list with no explanation.
   * Strictly === true: Refresh is wired as a click listener and passes the
   * event, which is truthy.
   */
  function load(keepNotices) {
    var keep = keepNotices === true;
    var seq = ++loadSeq;
    el('waitingCount').innerHTML = '<span class="spinner"></span> Loading\u2026';
    return post({ action: 'hostOverview' }, NETWORK_RETRIES)
      .then(function (reply) {
        if (seq !== loadSeq) return;
        setSigninBusy(false);
        el('paneSignin').hidden = true;
        el('paneMain').hidden = false;
        if (!reply.ok) {
          el('waitingCount').textContent = '';
          notice('mainError', reply.error || 'Could not load your visitors.');
          return;
        }
        session.host = reply.host;
        el('barWho').textContent = reply.host || '';
        el('barWho').hidden = false;
        el('signOut').hidden = false;
        if (!keep) notice('mainError', '');
        data = { visitors: reply.visitors || [], entries: reply.entries || [],
                 graceDays: typeof reply.graceDays === 'number' ? reply.graceDays : 1 };
        render();
        touchActivity();
      })
      .catch(function (err) {
        if (seq !== loadSeq) return;
        setSigninBusy(false);
        el('waitingCount').textContent = '';
        if (!err.signedOut) {
          el('paneSignin').hidden = true;
          el('paneMain').hidden = false;
          notice('mainError', err.message || 'Could not load your visitors.');
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

  /** A yyyy-MM-dd list date for people. Formatted as UTC: it is a date, not an instant. */
  function day(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    try {
      return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric',
                                               timeZone: 'UTC' }).format(d);
    } catch (e) { return iso; }
  }

  function approvalWords(text) {
    var t = String(text || '');
    if (/^Approved by list/.test(t)) return 'Approved by your list';
    if (/^Approved by host/.test(t)) return 'Approved by you';
    if (/^Declined by host/.test(t)) return 'Declined by you';
    if (/^Declined: dates/.test(t)) return 'Declined: dates outside your list';
    return '';
  }

  function waiting() {
    return data.visitors.filter(function (v) { return v.filedBy === 'visitor' && v.state === 'pending'; });
  }

  function render() {
    Object.keys(TABS).forEach(function (id) {
      el(id).setAttribute('aria-pressed', String(TABS[id] === view));
    });
    Object.keys(VIEWS).forEach(function (k) { el(VIEWS[k]).hidden = k !== view; });
    var n = waiting().length;
    el('tWaiting').textContent = 'Waiting for you' + (n ? ' (' + n + ')' : '');
    renderWaiting();
    renderList();
    renderVisitors();
  }

  function rowShell(name, metaText, whenText) {
    var row = document.createElement('div');
    row.className = 'row';
    var left = document.createElement('div');
    var nameEl = document.createElement('div');
    nameEl.className = 'row__name';
    nameEl.textContent = name;
    left.appendChild(nameEl);
    if (metaText) {
      var meta = document.createElement('div');
      meta.className = 'row__meta';
      meta.textContent = metaText;
      left.appendChild(meta);
    }
    if (whenText) {
      var w = document.createElement('div');
      w.className = 'row__when';
      w.textContent = whenText;
      left.appendChild(w);
    }
    var side = document.createElement('div');
    side.className = 'row__side';
    row.appendChild(left);
    row.appendChild(side);
    return { row: row, side: side };
  }

  function pill(state, text) {
    var p = document.createElement('span');
    p.className = 'pill pill--' + state;
    p.textContent = text || state;
    return p;
  }

  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.className = 'act' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', function () { onClick(b); });
    return b;
  }

  function renderWaiting() {
    var box = el('waitingList');
    box.innerHTML = '';
    var rows = waiting();
    el('waitingCount').textContent = rows.length
      ? rows.length + ' request(s) waiting for you.'
      : 'Nothing is waiting for you.';
    rows.forEach(function (v) {
      var r = rowShell(v.visitor || '(no name)',
        [v.visitorEmail, v.affiliation].filter(Boolean).join(' \u2014 '),
        when(v.validFrom) + '  to  ' + when(v.validUntil));
      r.side.appendChild(button('Approve', 'act--approve', function (b) { decide(v, 'approve', b); }));
      r.side.appendChild(button('Decline', 'act--disapprove', function (b) { decide(v, 'decline', b); }));
      box.appendChild(r.row);
    });
  }

  function renderList() {
    var box = el('listRows');
    box.innerHTML = '';
    var all = data.entries;
    var rows = listFilter === 'missing' ? all.filter(function (e) { return !e.submitted; }) : all;
    var missing = all.filter(function (e) { return !e.submitted; }).length;
    el('listCount').textContent = all.length
      ? all.length + ' on your list; ' + missing + ' not submitted yet.'
      : 'Your list is empty. Use Upload a list to add people.';
    rows.forEach(function (e) {
      var r = rowShell(e.email, null, day(e.from) + '  to  ' + day(e.to));
      r.side.appendChild(e.submitted ? pill('submitted', 'Submitted') : pill('waiting', 'Not submitted yet'));
      r.side.appendChild(button('Remove', '', function (b) { removeEntry(e, b); }));
      box.appendChild(r.row);
    });
  }

  function renderVisitors() {
    var box = el('visitorsList');
    box.innerHTML = '';
    el('visitorsCount').textContent = data.visitors.length + ' visitor(s).';
    data.visitors.forEach(function (v) {
      var bits = [v.visitorEmail, v.affiliation,
                  v.filedBy === 'visitor' ? 'Requested by the visitor' : 'Registered by you',
                  approvalWords(v.approval)].filter(Boolean);
      var r = rowShell(v.visitor || '(no name)', bits.join(' \u2014 '),
                       when(v.validFrom) + '  to  ' + when(v.validUntil));
      r.side.appendChild(pill(v.state));
      box.appendChild(r.row);
    });
  }

  function decide(v, decision, btn) {
    if (decision === 'decline' &&
        !window.confirm('Decline the request from ' + (v.visitor || 'this visitor') + '?\n\n' +
                        'They will be emailed that you did not approve it.')) {
      return;
    }
    btn.disabled = true;
    btn.textContent = decision === 'approve' ? 'Approving\u2026' : 'Declining\u2026';
    notice('mainOk', ''); notice('mainError', '');
    // Not retried: a lost reply may still have emailed the visitor, and the
    // server refuses a second decision anyway. Refresh shows the truth.
    post({ action: 'hostDecide', passId: v.passId, decision: decision })
      .then(function (reply) {
        if (!reply.ok) { notice('mainError', reply.error || 'That did not work.'); load(true); return; }
        notice('mainOk', (decision === 'approve' ? 'Approved ' : 'Declined ') +
                         (v.visitor || 'the request') +
                         (decision === 'approve' ? '. Their pass has been emailed to them.' : '.'), true);
        load(true);
      })
      .catch(function (err) {
        if (!err.signedOut) notice('mainError', err.message || 'That did not work.');
        load(true);
      });
  }

  function removeEntry(e, btn) {
    if (!window.confirm('Remove ' + e.email + ' from your list?\n\nA pass already issued to them ' +
                        'stays valid. Ask GAC if it needs revoking.')) {
      return;
    }
    btn.disabled = true;
    notice('mainOk', ''); notice('mainError', '');
    post({ action: 'hostRemove', email: e.email })
      .then(function (reply) {
        if (!reply.ok) { notice('mainError', reply.error || 'Could not remove that address.'); load(true); return; }
        notice('mainOk', 'Removed ' + e.email + ' from your list.', true);
        load(true);
      })
      .catch(function (err) {
        if (!err.signedOut) notice('mainError', err.message || 'Could not remove that address.');
        load(true);
      });
  }

  // -------------------------------------------------------------------------
  // CSV
  // -------------------------------------------------------------------------

  function count(text, ch) { return text.split(ch).length - 1; }

  /**
   * RFC 4180, plus what Excel actually writes: a UTF-8 byte-order mark, CRLF,
   * and in some locales a semicolon or tab instead of a comma — detected from
   * the header row.
   */
  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/, 1)[0] || '';
    var delim = ',';
    var best = count(first, ',');
    if (count(first, ';') > best) { delim = ';'; best = count(first, ';'); }
    if (count(first, '\t') > best) { delim = '\t'; }

    var rows = [], row = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"' && field === '') {
        inQuotes = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\r') {
        // CR of a CRLF; the LF ends the row.
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return { rows: rows, delim: delim };
  }

  function toCsv(rows, delim) {
    return rows.map(function (r) {
      return r.map(function (v) {
        var s = String(v === null || v === undefined ? '' : v);
        return (/["\r\n]/.test(s) || s.indexOf(delim) !== -1) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(delim);
    }).join('\r\n') + '\r\n';
  }

  /**
   * Anything this page writes into a CSV that the host did not write
   * themselves — visitor names, statuses — is kept from running as a formula
   * when the file is opened in Excel. The host's own cells are passed back as
   * they were: it is their file.
   */
  function csvSafe(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function isoFrom(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (!(y >= 2000 && y <= 2100)) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return y + '-' + pad(m) + '-' + pad(d);
  }

  /**
   * yyyy-mm-dd, or DAY FIRST (03-04-2026 is 3 April), or 3 Apr 2026. Nothing
   * is guessed: month-first is never tried, a two-digit year is refused, and
   * an impossible date is refused. The check screen then shows every range
   * read, spelled out, before anything is saved.
   */
  function parseDate(text) {
    var t = String(text || '').trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '');
    var m;
    if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(t))) return isoFrom(m[1], m[2], m[3]);
    if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(t))) return isoFrom(m[3], m[2], m[1]);
    if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{4})$/.exec(t))) {
      var mi = MONTHS.indexOf(m[2].substring(0, 3).toLowerCase());
      return mi === -1 ? null : isoFrom(m[3], mi + 1, m[1]);
    }
    return null;
  }

  function findColumn(header, test) {
    for (var i = 0; i < header.length; i++) if (test(header[i])) return i;
    return -1;
  }

  /** Reads a file into what can be saved, and a problem per row that cannot. */
  function readUpload(text, fileName) {
    var parsed = parseCsv(text);
    var rows = parsed.rows;
    var header = (rows[0] || []).map(function (h) { return String(h).trim().toLowerCase(); });
    var cols = {
      email: findColumn(header, function (h) { return /e-?mail/.test(h); }),
      from: findColumn(header, function (h) { return /^(from|start|arrival)\b/.test(h); }),
      to: findColumn(header, function (h) { return /^(to|until|end|departure)\b/.test(h); })
    };
    var result = { fileName: fileName, rows: rows, delim: parsed.delim, entries: [], problems: [],
                   status: [] };
    if (cols.email === -1 || cols.from === -1 || cols.to === -1) {
      result.fatal = 'Could not find the Email, From and To columns. The first row of the file ' +
                     'must name them.';
      return result;
    }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r.some(function (c) { return String(c).trim(); })) continue;   // blank row
      var email = String(r[cols.email] || '').trim();
      var fromText = String(r[cols.from] || '').trim();
      var toText = String(r[cols.to] || '').trim();
      var from = parseDate(fromText);
      var to = parseDate(toText);
      var problem = null;
      if (/[*?]/.test(email)) problem = 'wildcards are not accepted \u2014 list each person';
      else if (!/^[^@\s,;<>]+@[^@\s.,;<>]+(\.[^@\s.,;<>]+)+$/.test(email)) problem = 'not a single email address';
      else if (!from) problem = 'could not read the From date "' + fromText + '"';
      else if (!to) problem = 'could not read the To date "' + toText + '"';
      else if (from > to) problem = 'From is after To';
      if (problem) {
        result.problems.push('Row ' + (i + 1) + ': ' + problem);
        result.status[i] = 'Not saved: ' + problem;
      } else {
        result.entries.push({ row: i, email: email, from: from, to: to });
      }
    }
    if (!result.entries.length && !result.problems.length) result.fatal = 'The file has no rows below its header.';
    return result;
  }

  function showCheck() {
    el('uploadDone').hidden = true;
    var box = el('uploadCheck');
    box.hidden = false;
    var ranges = el('checkRanges');
    var problems = el('checkProblems');
    ranges.innerHTML = '';
    problems.innerHTML = '';
    if (upload.fatal) {
      el('checkTitle').textContent = upload.fatal;
      el('checkGrace').textContent = '';
      problems.hidden = true;
      el('saveList').hidden = true;
      return;
    }
    el('saveList').hidden = !upload.entries.length;
    el('checkTitle').textContent = 'Read ' + upload.entries.length + ' address(es) from ' +
      upload.fileName + (upload.problems.length ? '; ' + upload.problems.length +
      ' row(s) cannot be saved' : '') + '. Check the dates, then save.';
    el('checkGrace').textContent = 'Each visitor may arrive up to ' + data.graceDays +
      ' day(s) before their range starts and leave up to ' + data.graceDays + ' day(s) after it ends.';

    var groups = {};
    upload.entries.forEach(function (e) {
      var k = e.from + '|' + e.to;
      groups[k] = (groups[k] || 0) + 1;
    });
    Object.keys(groups).sort().forEach(function (k) {
      var li = document.createElement('li');
      var p = k.split('|');
      li.textContent = day(p[0]) + ' to ' + day(p[1]) + ': ' + groups[k] + ' address(es)';
      ranges.appendChild(li);
    });
    problems.hidden = !upload.problems.length;
    upload.problems.slice(0, 50).forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;
      problems.appendChild(li);
    });
    if (upload.problems.length > 50) {
      var more = document.createElement('li');
      more.textContent = '\u2026 and ' + (upload.problems.length - 50) + ' more';
      problems.appendChild(more);
    }
  }

  /** Splits entries into requests whose serialised body stays under the limit. */
  function chunk(entries) {
    var base = JSON.stringify({ action: 'hostUpload', source: upload.fileName, entries: [],
                                idToken: session.idToken || '' }).length;
    var out = [], cur = [], size = base;
    entries.forEach(function (e) {
      var s = JSON.stringify({ email: e.email, from: e.from, to: e.to }).length + 1;
      if (cur.length && size + s > CHUNK_CHARS) { out.push(cur); cur = []; size = base; }
      cur.push(e);
      size += s;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  function outcomeWords(r) {
    if (r.error) return 'Not saved: ' + r.error;
    var o = r.outcome || 'saved';
    var words = o === 'approved' ? 'Saved; approved, pass emailed'
              : o === 'no request yet' ? 'Saved; no request from them yet'
              : 'Saved; ' + o;
    return words + (r.note ? ' (' + r.note + ')' : '');
  }

  function saveList() {
    var parts = chunk(upload.entries);
    var btn = el('saveList');
    btn.disabled = true;
    el('cancelList').disabled = true;
    notice('mainOk', ''); notice('mainError', '');
    var done = 0, saved = 0, failedAt = null;

    function next() {
      if (done >= parts.length) return Promise.resolve();
      btn.textContent = 'Saving ' + (done + 1) + ' of ' + parts.length + '\u2026';
      var part = parts[done];
      return post({ action: 'hostUpload', source: upload.fileName,
                    entries: part.map(function (e) { return { email: e.email, from: e.from, to: e.to }; }) },
                  NETWORK_RETRIES)
        .then(function (reply) {
          if (!reply.ok) throw new Error(reply.error || 'The server refused that part of the list.');
          part.forEach(function (e, i) {
            var r = (reply.results || [])[i] || { error: 'no answer for this row' };
            upload.status[e.row] = outcomeWords(r);
            if (r.saved) saved++;
          });
          done++;
          return next();
        });
    }

    next().catch(function (err) {
      failedAt = done;
      if (!err.signedOut) {
        notice('mainError', (err.message || 'Saving failed.') + '\n\nParts 1 to ' + done + ' of ' +
               parts.length + ' were saved; the rest were not. Upload the file again \u2014 ' +
               'saving is safe to repeat.');
      }
    }).then(function () {
      btn.disabled = false;
      el('cancelList').disabled = false;
      btn.textContent = 'Save list';
      if (!session.idToken) return;
      el('uploadCheck').hidden = true;
      el('uploadDone').hidden = false;
      el('doneTitle').textContent = failedAt === null
        ? 'Saved ' + saved + ' address(es).'
        : 'Saved ' + saved + ' address(es) before stopping.';
      el('doneDetail').textContent = 'Download your file to see what happened to each row. ' +
        'Anyone on it who has not filled in the form yet will be approved when they do.';
      load(true);
    });
  }

  function download(name, text) {
    // The byte-order mark makes Excel read the file as UTF-8, so names with
    // accents survive the round trip.
    var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function downloadResult() {
    if (!upload) return;
    var out = upload.rows.map(function (r, i) {
      if (i === 0) return r.concat(['Result']);
      return r.concat([csvSafe(upload.status[i] || '')]);
    });
    var base = String(upload.fileName || 'list.csv').replace(/\.csv$/i, '');
    download(base + '-results.csv', toCsv(out, upload.delim));
  }

  function downloadVisitors() {
    var rows = [['Visitor', 'Email', 'Affiliation', 'From', 'Until', 'Status', 'Requested by', 'Approval']];
    data.visitors.forEach(function (v) {
      rows.push([v.visitor, v.visitorEmail, v.affiliation, when(v.validFrom), when(v.validUntil),
                 v.state, v.filedBy === 'visitor' ? 'the visitor' : 'you',
                 approvalWords(v.approval)].map(csvSafe));
    });
    download('my-visitors.csv', toCsv(rows, ','));
  }

  function downloadTemplate() {
    download('visitor-list-template.csv',
             toCsv([['Email', 'From', 'To'], ['name@example.com', '2026-04-03', '2026-04-05']], ','));
  }

  function onFile() {
    var file = el('csvFile').files && el('csvFile').files[0];
    notice('mainError', '');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      notice('mainError', 'That file is larger than 2 MB. Check it is the right one \u2014 a list of ' +
             'a few thousand addresses is far smaller.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      upload = readUpload(String(reader.result || ''), file.name || 'list.csv');
      showCheck();
      touchActivity();
    };
    reader.onerror = function () { notice('mainError', 'Could not read that file.'); };
    reader.readAsText(file);
  }

  // -------------------------------------------------------------------------
  // Idle handling (as dashboard.js: this page shows visitors' contact details)
  // -------------------------------------------------------------------------

  var idleClear = null;
  var idleSignout = null;

  function clearFromScreen() {
    if (el('paneMain').hidden) return;
    clearData();
    el('waitingCount').textContent = 'Screen cleared while idle. Press Refresh to reload.';
    notice('mainOk', '');
    notice('mainError', '');
  }

  function touchActivity() {
    if (idleClear) window.clearTimeout(idleClear);
    if (idleSignout) window.clearTimeout(idleSignout);
    if (!session.idToken) return;
    idleClear = window.setTimeout(clearFromScreen, IDLE_CLEAR_MS);
    idleSignout = window.setTimeout(signOut, IDLE_SIGNOUT_MS);
  }

  ['click', 'touchstart', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, touchActivity, { passive: true });
  });

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  Object.keys(TABS).forEach(function (id) {
    el(id).addEventListener('click', function () { view = TABS[id]; render(); });
  });
  el('lAll').addEventListener('click', function () {
    listFilter = 'all';
    el('lAll').setAttribute('aria-pressed', 'true');
    el('lMissing').setAttribute('aria-pressed', 'false');
    renderList();
  });
  el('lMissing').addEventListener('click', function () {
    listFilter = 'missing';
    el('lAll').setAttribute('aria-pressed', 'false');
    el('lMissing').setAttribute('aria-pressed', 'true');
    renderList();
  });
  el('refresh').addEventListener('click', load);
  el('signOut').addEventListener('click', signOut);
  el('csvFile').addEventListener('change', onFile);
  el('saveList').addEventListener('click', saveList);
  el('cancelList').addEventListener('click', function () {
    upload = null;
    el('uploadCheck').hidden = true;
    el('csvFile').value = '';
  });
  el('downloadResult').addEventListener('click', downloadResult);
  el('downloadVisitors').addEventListener('click', downloadVisitors);
  el('template').addEventListener('click', downloadTemplate);

  initGoogle();
})();
