/* ---------------------------------------------------------------
   Breeze.

   The wind itself is CSS now: one drift curve, one period, one phase,
   and every leaf layer on the page rides it, scaled by its own --sway.
   That is what keeps the three masses reading as one draught through
   one room rather than three plants each doing their own weather - and
   it is why the vine no longer has a rig of its own here.

   What is left is the pointer. The bottom-left mass leans a few pixels
   away from it on a heavy lerp, and nothing else on the page answers
   the cursor at all: one transform a frame, on one element, on an
   unblurred wrapper.
----------------------------------------------------------------*/
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var lean = document.querySelector('.lean');
  if (!lean) return;

  /* ---------- pointer ---------- */

  // Normalised to the viewport centre, so -1..1 on each axis.
  var px = 0, py = 0;        // where the pointer is
  var lx = 0, ly = 0;        // where the leaves think it is - trails behind

  var MASS_X = 7, MASS_Y = 5, MASS_R = 0.45;

  window.addEventListener('pointermove', function (e) {
    px = (e.clientX / window.innerWidth  - 0.5) * 2;
    py = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // A pointer that leaves the window stops steering; the lean eases home.
  window.addEventListener('pointerout', function (e) {
    if (!e.relatedTarget) { px = 0; py = 0; }
  }, { passive: true });

  /* ---------- loop ---------- */

  var last = 0;

  function frame(now) {
    var dt = last ? Math.min(now - last, 68) : 16.667;
    last = now;

    // Frame-rate independent easing, same trick the scroll engine uses.
    var k = 1 - Math.pow(1 - 0.045, dt / 16.667);
    lx += (px - lx) * k;
    ly += (py - ly) * k;

    // The mass keeps its own CSS drift; the pointer only leans it.
    lean.style.transform = 'translate3d(' + (lx * -MASS_X).toFixed(2) + 'px,' +
      (ly * -MASS_Y).toFixed(2) + 'px,0) rotate(' + (lx * MASS_R).toFixed(3) + 'deg)';

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
