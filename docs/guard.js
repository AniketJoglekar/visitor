/*
 * Loaded first, before anything renders.
 *
 * The CSP in index.html cannot stop this page being framed: browsers ignore
 * frame-ancestors when CSP arrives in a <meta> tag, and GitHub Pages does not
 * let you set response headers, so neither frame-ancestors nor X-Frame-Options
 * can be delivered. That leaves a script check as the only available defence.
 *
 * Why it matters here: a framed copy of the scanner lets an attacker overlay
 * their own controls on top of a signed-in gate session — nudging a guard into
 * revealing a visitor photograph, or into tapping Sign out mid-shift so the
 * next scans land under the wrong identity.
 */
(function () {
  'use strict';
  if (window.top === window.self) return;

  try {
    window.top.location = window.self.location;
  } catch (e) {
    // Cross-origin parent refused the navigation; fall through and blank out.
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.body.textContent =
      'This page cannot run inside another site. Open it directly.';
    document.body.setAttribute('style',
      'background:#10162B;color:#E8ECF7;font:16px/1.5 system-ui,sans-serif;padding:32px;margin:0');
  });

  // Stop the app from initialising even if the navigation above is blocked.
  window.__FRAMED__ = true;
})();
