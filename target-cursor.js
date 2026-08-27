/* ---------------------------------------------------------------
   Target cursor - a vanilla port of the React/GSAP component.

   Same behaviour, no dependencies: a spinning bracket that snaps onto
   a whole project (card, caption, and description together), the
   wordmark, the mail button, or a nav link, lags behind the pointer
   while it sits inside (the "parallax"), and springs back on leave.
   One requestAnimationFrame loop, transforms only, no layout reads
   except a single getBoundingClientRect while a target is hot.

   That last read is deliberate. This site scrolls by translating
   .content, so a target keeps moving under a still pointer after the
   scroll events have stopped - the original component measured the
   rect once on enter, which would drift here. We remeasure the one
   hovered element per frame instead.
----------------------------------------------------------------*/
(function () {
  'use strict';

  var CONFIG = {
    spinDuration: 4.2,          // seconds per full turn while idle
    hideDefaultCursor: true,
    parallaxOn: true,           // corners lag the pointer inside a target
    hoverDuration: 0.65,        // seconds for the corners to reach the box
    cursorColor: '#ffffff',
    cursorColorOnTarget: '#B497CF',

    // The opening pose: the bracket draws itself around the wordmark instead
    // of appearing adrift mid-screen. The delay lets the hero's reveal land
    // first, so it never frames type that has not faded in yet.
    parkSelector: '.wordmark',
    parkDelay: 0.4,             // seconds

    // Gravity. A target does not wait to be hovered - it reaches out. Any
    // element whose box comes within `gravityRadius` of the pointer latches,
    // and while it holds, the bracket itself is dragged off the true pointer
    // and onto the nearest point of that box by `gravityPull` (0 = no drag,
    // 1 = the bracket sits flat on the edge). `gravityStick` is the slack a
    // held target gets in the contest against its neighbours, so the latch
    // does not flicker along the seam between two cards.
    gravity: true,
    gravityRadius: 70,          // px outside the box where the pull begins
    gravityPull: 0.5,
    gravityStick: 25,           // px of favouritism for the held target
    scanEvery: 0.06,            // seconds between proximity scans

    // The wrapper is blended with `difference`, as in the original. On this
    // cream wall a plain white cursor would be invisible, so the blend is
    // what guarantees contrast - the trade is that the two colours above are
    // inverted against whatever is behind them rather than read literally.
    // Set this to false to get the exact hexes instead.
    blend: true
  };

  var CORNER = 12;   // corner box, px - must match the CSS
  var BORDER = 3;    // its stroke width, px - must match the CSS

  /* ---------- what the bracket grabs ----------

     Always the whole project - card, caption, and description together -
     plus the wordmark, the mail button, and the nav links, which are
     grabbable regardless since they're the opening pose and the only
     other real controls on the page. */

  var TARGET_SEL = '.project, .wordmark, .cta, .nav a';
  var GRAVITY_RADIUS = 100;  // px outside the box where the pull begins
  var GRAVITY_STICK  = CONFIG.gravityStick;

  function selector() { return TARGET_SEL; }
  function radius()   { return GRAVITY_RADIUS; }
  function stick()    { return GRAVITY_STICK; }

  /* The element's own box, grown to swallow any `sel` it contains. */
  function union(el, sel) {
    var r = el.getBoundingClientRect();
    var l = r.left, t = r.top, rr = r.right, b = r.bottom;
    var kids = el.querySelectorAll(sel);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i].getBoundingClientRect();
      if (!k.width && !k.height) continue;
      if (k.left < l) l = k.left;
      if (k.top < t) t = k.top;
      if (k.right > rr) rr = k.right;
      if (k.bottom > b) b = k.bottom;
    }
    return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t };
  }

  /* A project's box includes its description, so the bracket frames the
     whole thing rather than just the picture. Everything else measures
     as itself. */
  function rectFor(el) {
    return el.classList.contains('project') ? union(el, '.detail') : el.getBoundingClientRect();
  }

  /* ---------- bail out where a custom cursor is wrong ---------- */

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var coarse = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  var touch  = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (coarse || (touch && window.innerWidth <= 768)) return;

  /* ---------- DOM ---------- */

  var wrap = document.createElement('div');
  wrap.className = 'target-cursor';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = '<span class="tc-dot"></span>' +
    '<i class="tc-corner"></i><i class="tc-corner"></i>' +
    '<i class="tc-corner"></i><i class="tc-corner"></i>';

  var root = document.documentElement;
  root.style.setProperty('--tc-color', CONFIG.cursorColor);
  root.style.setProperty('--tc-color-on', CONFIG.cursorColorOnTarget || CONFIG.cursorColor);
  if (!CONFIG.blend) wrap.style.mixBlendMode = 'normal';

  document.body.appendChild(wrap);
  if (CONFIG.hideDefaultCursor) root.classList.add('tc-hide-cursor');

  var dot = wrap.querySelector('.tc-dot');
  var corners = wrap.querySelectorAll('.tc-corner');

  /* ---------- state ----------

     The corner rest offsets are the CSS translate(-150% / 50%) of the
     original expressed in px, so the idle bracket is identical. */

  var REST = [
    [-CORNER * 1.5, -CORNER * 1.5],
    [ CORNER * 0.5, -CORNER * 1.5],
    [ CORNER * 0.5,  CORNER * 0.5],
    [-CORNER * 1.5,  CORNER * 0.5]
  ];

  var mx = window.innerWidth / 2, my = window.innerHeight / 2;   // pointer
  var px = mx, py = my;                                          // cursor
  var rot = 0, scale = 1, wantScale = 1;

  var cur = [];                       // live corner offsets, cursor-local
  var from = [];                      // where a release started from
  for (var i = 0; i < 4; i++) { cur.push(REST[i].slice()); from.push(REST[i].slice()); }

  var target = null;                  // element under the pointer, if any
  var grip = 0;                       // 0..1 ramp while latching on
  var release = -1;                   // seconds into the spring-back, -1 = idle
  var leaveHandler = null;
  var checkAt = 0;                    // countdown to the next hit test
  var running = false, last = 0;
  var suspended = false;              // dev panel open: OS cursor is back
  var moved = false;                  // the pointer has been used at least once

  /* ---------- easing / frame-rate independent lerp ---------- */

  function lerpK(per60, dt) { return 1 - Math.pow(1 - per60, dt * 60); }
  function outQuad(t)  { return 1 - (1 - t) * (1 - t); }
  function outQuart(t) { t = 1 - t; return 1 - t * t * t * t; }

  /* ---------- latch / release ---------- */

  function latch(el) {
    if (suspended) return;
    if (target === el) return;
    if (target) unlatch();

    target = el;
    grip = 0;
    release = -1;
    checkAt = CONFIG.gravity ? CONFIG.scanEvery : 0.1;
    rot = 0;                          // the bracket stops spinning, square on
    wrap.classList.add('is-on');
    el.classList.add('is-cursor');    // the element's own hook - a project
                                      // opens its detail panel off this
    document.body.classList.add('tc-focus'); // everything else blurs (styles.css)

    // Under gravity the proximity scan owns both the latch and the release -
    // a plain mouseleave would drop the target the instant the pointer
    // crossed the edge, which is the opposite of what we want out here.
    if (!CONFIG.gravity) {
      leaveHandler = function () { unlatch(); };
      el.addEventListener('mouseleave', leaveHandler);
    }
    start();
  }

  function unlatch() {
    if (!target) return;
    if (leaveHandler) target.removeEventListener('mouseleave', leaveHandler);
    leaveHandler = null;
    target.classList.remove('is-cursor');
    target = null;
    grip = 0;
    release = 0;
    for (var i = 0; i < 4; i++) { from[i][0] = cur[i][0]; from[i][1] = cur[i][1]; }
    wrap.classList.remove('is-on');
    document.body.classList.remove('tc-focus');
    start();
  }

  /* ---------- proximity ----------

     Distance from the pointer to a box, zero anywhere inside it. Twelve
     targets on this page, so a full sweep every scanEvery seconds costs
     twelve rect reads - cheaper than the elementFromPoint it replaces, and
     unlike that test it can see a card the pointer is merely near. */

  function edgeDist(r, x, y) {
    var dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
    var dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function scan() {
    var els = document.querySelectorAll(selector());
    var best = null, bestD = Infinity;

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var r = rectFor(el);
      if (!r.width && !r.height) continue;

      var d = edgeDist(r, mx, my);
      if (el === target) d -= stick();               // incumbency
      if (d < bestD) { bestD = d; best = el; }
    }

    if (best && bestD <= radius()) latch(best);
    else if (target) unlatch();
  }

  /* ---------- the loop ---------- */

  function frame(now) {
    if (suspended) { running = false; last = 0; return; }

    var dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
    last = now;

    // Proximity sweep. Runs latched or not: it is what pulls a nearby card
    // in, and what lets go once the pointer has drifted off all of them.
    if (CONFIG.gravity) {
      checkAt -= dt;
      if (checkAt <= 0) { checkAt = CONFIG.scanEvery; scan(); }
    }

    // The one layout read, and it has to happen before the chase - the pull
    // below bends the pointer the bracket is chasing. This element keeps
    // moving under the cursor while the smooth-scroll lerp is still settling.
    var box = null, aimX = mx, aimY = my;

    if (target) {
      var r = rectFor(target);
      var l = r.left - BORDER, t = r.top - BORDER;
      var rr = r.right + BORDER - CORNER, b = r.bottom + BORDER - CORNER;
      box = [[l, t], [rr, t], [rr, b], [l, b]];

      // Gravity: drag the bracket off the true pointer toward the nearest
      // point of the box, hardest at the edge and fading to nothing by the
      // rim of the radius. Inside the box the nearest point is the pointer
      // itself, so aiming is never touched where it matters.
      if (CONFIG.gravity && CONFIG.gravityPull > 0) {
        var nx = Math.min(Math.max(mx, r.left), r.right) - mx;
        var ny = Math.min(Math.max(my, r.top), r.bottom) - my;
        var d = Math.sqrt(nx * nx + ny * ny);
        if (d > 0) {
          var f = CONFIG.gravityPull * Math.max(0, 1 - d / radius());
          aimX = mx + nx * f;
          aimY = my + ny * f;
        }
      }
    }

    // pointer chase
    var k = lerpK(0.35, dt);
    px += (aimX - px) * k;
    py += (aimY - py) * k;

    // spin, only while nothing is latched
    if (!target) rot = (rot + 360 * dt / CONFIG.spinDuration) % 360;

    // click squeeze
    scale += (wantScale - scale) * lerpK(0.25, dt);

    if (target) {
      grip = Math.min(1, grip + dt / CONFIG.hoverDuration);
      var g = outQuad(grip);
      var snap = lerpK(0.5, dt);
      var pull = CONFIG.parallaxOn ? lerpK(0.22, dt) : 1;

      for (var i = 0; i < 4; i++) {
        var wantX = box[i][0] - px, wantY = box[i][1] - py;
        var f = g >= 0.999 ? pull : g * snap;
        cur[i][0] += (wantX - cur[i][0]) * f;
        cur[i][1] += (wantY - cur[i][1]) * f;
      }

      // Without gravity the pointer can still leave a target without a
      // mouseleave - the page scrolls out from under it - so re-test where
      // we actually are. With gravity the sweep above has already done this.
      if (!CONFIG.gravity) {
        checkAt -= dt;
        if (checkAt <= 0) {
          checkAt = 0.1;
          var under = document.elementFromPoint(px, py);
          if (!under || (under !== target && under.closest(selector()) !== target)) unlatch();
        }
      }
    } else if (release >= 0) {
      release += dt;
      var p = Math.min(1, release / 0.3), e = outQuart(p);
      for (var j = 0; j < 4; j++) {
        cur[j][0] = from[j][0] + (REST[j][0] - from[j][0]) * e;
        cur[j][1] = from[j][1] + (REST[j][1] - from[j][1]) * e;
      }
      if (p === 1) release = -1;
    }

    wrap.style.transform = 'translate3d(' + px.toFixed(2) + 'px,' + py.toFixed(2) +
      'px,0) rotate(' + rot.toFixed(2) + 'deg) scale(' + scale.toFixed(3) + ')';
    for (var n = 0; n < 4; n++) {
      corners[n].style.transform =
        'translate3d(' + cur[n][0].toFixed(2) + 'px,' + cur[n][1].toFixed(2) + 'px,0)';
    }

    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }

  /* ---------- dev mode ----------
     The dev panel is all sliders and buttons, and a bracket that lags the
     real pointer makes them miserable to aim. While it is open the custom
     cursor stands down completely and the OS cursor comes back. */

  function suspend(on) {
    if (suspended === on) return;
    suspended = on;
    if (on) {
      unlatch();
      wrap.classList.remove('is-live');
      wrap.style.display = 'none';
      if (CONFIG.hideDefaultCursor) root.classList.remove('tc-hide-cursor');
    } else {
      wrap.style.display = '';
      wrap.classList.add('is-live');
      if (CONFIG.hideDefaultCursor) root.classList.add('tc-hide-cursor');
      start();
    }
  }

  document.addEventListener('dev:mode', function (e) {
    suspend(!!(e.detail && e.detail.open));
  });

  /* ---------- wiring ---------- */

  window.addEventListener('mousemove', function (e) {
    if (suspended) return;
    moved = true;
    mx = e.clientX; my = e.clientY;
    if (!running) { px = mx; py = my; }
    wrap.classList.add('is-live');
    start();
  }, { passive: true });

  window.addEventListener('mouseover', function (e) {
    if (suspended) return;
    var el = e.target && e.target.closest ? e.target.closest(selector()) : null;
    if (el) latch(el);
  }, { passive: true });

  window.addEventListener('mousedown', function () {
    wantScale = 0.9;
    dot.style.transform = 'translate(-50%,-50%) scale(.7)';
  }, { passive: true });

  window.addEventListener('mouseup', function () {
    wantScale = 1;
    dot.style.transform = 'translate(-50%,-50%) scale(1)';
  }, { passive: true });

  // Pointer off the window entirely: drop any latch and fade the bracket out.
  document.addEventListener('mouseleave', function () {
    unlatch();
    wrap.classList.remove('is-live');
  });
  document.addEventListener('mouseenter', function () {
    if (!suspended) wrap.classList.add('is-live');
  });

  /* ---------- opening pose ----------
     Sit on the wordmark, corners flying in from rest, until the pointer is
     actually used - the first move drags the bracket off it, and the usual
     hit test in the loop drops the latch as it goes. If the pointer has
     already moved by the time this runs, there is nothing to pose for. */
  function park() {
    if (suspended || moved || target) return;

    var el = document.querySelector(CONFIG.parkSelector);
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;

    mx = px = r.left + r.width / 2;
    my = py = r.top + r.height / 2;
    wrap.classList.add('is-live');
    latch(el);
  }

  setTimeout(park, CONFIG.parkDelay * 1000);
})();
