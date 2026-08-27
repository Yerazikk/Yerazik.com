/* ---------------------------------------------------------------
   Theme: the same room, after dark.

   Light and dark are not two colour schemes here - they are two
   photographs of one wall (temp.jpg / 404.jpg, same frame, same
   window, same plant, one shot at four in the afternoon and one at
   night). So the whole switch is a data-theme attribute on <html>:
   styles.css hangs every colour token off it, and main.js re-points
   the wall layer at the other exposure.

   This file is loaded *blocking* in <head>, before the stylesheet
   paints, because a stored dark preference resolved one frame late
   is a white flash across the whole viewport.
----------------------------------------------------------------*/
(function () {
  'use strict';

  var KEY  = 'yz.theme';
  var root = document.documentElement;

  // A page can pin itself - 404 is always after dark, there is no
  // daylight version of being lost - by shipping data-theme-lock.
  var locked = root.hasAttribute('data-theme-lock');

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; }
    catch (e) { return null; }
  }

  function systemPref() {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function get() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

  function paint(name) {
    root.setAttribute('data-theme', name);
    // The browser chrome (mobile address bar) matches the wall, not the
    // markup's original guess.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', name === 'dark' ? '#0d0f12' : '#e9e6e0');
  }

  function set(name, remember) {
    if (locked) return;
    name = name === 'dark' ? 'dark' : 'light';
    if (name === get()) return;
    paint(name);
    if (remember !== false) { try { localStorage.setItem(KEY, name); } catch (e) {} }
    document.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: name } }));
  }

  function toggle() { set(get() === 'dark' ? 'light' : 'dark'); }

  /* ---------- first paint ---------- */

  if (locked) {
    paint(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  } else {
    paint(stored() || systemPref());

    // Follow the OS only while the visitor has not made a choice of
    // their own; an explicit click outranks the system from then on.
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onSystem = function () { if (!stored()) set(systemPref(), false); };
    if (mq.addEventListener) mq.addEventListener('change', onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  }

  window.YZTheme = { get: get, set: set, toggle: toggle, locked: locked };

  /* ---------- the nav switch ---------- */

  // The button ships in the markup so it is there with no JS; it only
  // becomes interactive once this runs.
  function wire() {
    var btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;

    function label() {
      var dark = get() === 'dark';
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', dark ? 'Switch to light' : 'Switch to dark');
      btn.title = dark ? 'Lights on' : 'Lights off';
    }

    btn.hidden = false;
    label();
    btn.addEventListener('click', toggle);
    document.addEventListener('theme:change', label);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
