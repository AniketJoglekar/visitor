/*
 * Loaded first, before anything renders.
 *
 * The CSP in index.html cannot stop this page being framed: browsers ignore
 * frame-ancestors when CSP arrives in a <meta> tag, and GitHub Pages does not
 * let you set response headers, so neither frame-ancestors nor X-Frame-Options
 * can be delivered. That leaves a script check as the only available defence.
 *
 * Why it matters: a framed copy of the scanner lets an attacker overlay their
 * own controls on a signed-in gate session — an invisible control under
 * something the guard wants to tap, or a Sign out mid-shift so later scans land
 * under the wrong identity.
 *
 * The page ships hidden by the <style id="framebust"> rule in index.html, which
 * this file removes once it has confirmed the page is top-level. That ordering
 * matters: a script-only frame-buster does nothing if the attacker stops the
 * script running, whereas a CSS-hidden page stays hidden. The trade is that if
 * guard.js fails to load the page is blank — a loud failure, which is the right
 * direction for a security control.
 */
(function () {
  'use strict';

  function reveal() {
    var gate = document.getElementById('framebust');
    if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
  }

  if (window.top === window.self) {
    reveal();
    return;
  }

  window.__FRAMED__ = true;

  try {
    window.top.location = window.self.location;
  } catch (e) {
    // Cross-origin or sandboxed parent refused the navigation. Fall through and
    // show the notice instead of the scanner.
  }

  document.addEventListener('DOMContentLoaded', function () {
    reveal();
    document.body.textContent =
      'This page cannot run inside another site. Open it directly.';
    document.body.setAttribute('style',
      'background:#10162B;color:#E8ECF7;font:16px/1.5 system-ui,sans-serif;' +
      'padding:32px;margin:0');
  });
})();
