/* ---------------------------------------------------------------
   theme-fx.js  –  dissolve transition for dark / light toggle

   When the toggle fires, the outgoing background photo is held
   in .bg-photo-over at full opacity while .bg::before swaps to
   the new photo underneath. The overlay then fades out (850 ms),
   crossing into the new state. All colour tokens cross-fade via
   CSS transitions (styles.css).
----------------------------------------------------------------*/
(function () {
  'use strict';

  var root     = document.documentElement;
  var over     = null;    /* .bg-photo-over */
  var prevUrl  = '';      /* bg URL captured just before the toggle */

  function init() {
    over = document.querySelector('.bg-photo-over');

    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      /* Capture phase: fires before theme.js's bubble listener,
         so we snapshot the outgoing photo URL in time. */
      btn.addEventListener('click', function () {
        prevUrl = root.style.getPropertyValue('--bg-img').trim();
      }, true);
    }

    /* After theme.js has swapped data-theme and applyBg() has
       updated --bg-img, run the photo crossfade. */
    document.addEventListener('theme:change', dissolve);
  }

  function dissolve() {
    if (!over || !prevUrl) return;

    /* Strip the url("…") wrapper that applyBg() adds */
    var src = prevUrl.replace(/^url\(['"]?|['"]?\)$/gi, '');
    if (!src) return;

    /* Snap overlay to the outgoing photo at full opacity */
    over.style.backgroundImage = 'url("' + src + '")';
    over.style.transition      = 'none';
    over.style.opacity         = '1';

    /* Force a paint so 'none' takes effect before we add the fade */
    over.getBoundingClientRect();

    /* Fade out → reveals the incoming photo in .bg::before */
    over.style.transition = 'opacity 850ms ease';
    over.style.opacity    = '0';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
