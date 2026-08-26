/* ---------------------------------------------------------------
   Smooth scroll.

   The browser scrolls <body> normally; we never touch that. We just
   read scrollY and chase it with a frame-rate-independent lerp,
   painting the result as a single translate3d on the content and a
   slower one on the background. Two transforms per frame, no reads,
   no layout - that is the whole engine.

   The .stage wrapper is a "virtual viewport". At zoom 1 it is exactly
   the real viewport. Dev mode (press T) scales it down so you can see
   the page as it would look on a much larger screen, which is what
   makes the side-padding slider meaningful.
----------------------------------------------------------------*/
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var stage   = document.getElementById('stage');
  var content = document.getElementById('content');
  var bg      = document.getElementById('bg');
  if (!stage || !content || !bg) return;

  var root = document.documentElement;
  root.classList.add('js');

  /* ---------- tunables (dev mode edits these live) ---------- */

  var EASE      = 0.088;   // chase strength at 60fps; lower = heavier
  var BG_RATE   = 0.60;    // ceiling on the background's share of content speed
  var REVEAL_AT = 0.86;    // fraction of the viewport an item must cross

  // temp.jpg is portrait (736 x 1308). The background box is sized to that
  // ratio at full stage width, so the photo is shown whole rather than
  // cropped to a middle band - the extra height is what the parallax pans
  // through. Update this if the photo is replaced.
  var BG_ASPECT = 736 / 1308;

  /* ---------- state ---------- */

  var zoom = 1;            // stage scale; 1 in production, <1 only in dev
  var target = 0, current = 0, max = 0, vh = 0, bgRate = 0;
  var items = [], running = false, last = 0;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- measure: the only place we read layout ---------- */

  function measure() {
    vh = stage.clientHeight;                 // = real viewport height / zoom

    // Take the content out of its transform to read its true height
    var prev = content.style.transform;
    content.style.transform = 'none';
    var h = content.offsetHeight;

    items = [];
    var nodes = content.querySelectorAll('[data-r]');
    for (var i = 0; i < nodes.length; i++) {
      items.push({ el: nodes[i], top: nodes[i].offsetTop, shown: nodes[i].classList.contains('in') });
    }
    content.style.transform = prev;

    max = Math.max(0, h - vh);

    // Body carries the real scroll height; content space is scaled by zoom
    document.body.style.height = Math.round(h * zoom) + 'px';

    // Stand the background up at the photo's own aspect ratio (never
    // shorter than the viewport). It grows downwards, so the scene always
    // covers the stage: at the top its extra sits below the fold, and it
    // pans in as you scroll. The rate is whatever spends that height over
    // the scroll range, held under BG_RATE so it can never keep up with
    // the text - on a very wide screen that means the last sliver of the
    // photo stays out of frame.
    var bgh = Math.max(vh, stage.clientWidth / BG_ASPECT);
    bg.style.height = Math.round(bgh) + 'px';
    var travel = bgh - vh;
    bgRate = max > 0 ? Math.min(BG_RATE, travel / max) : 0;

    target = current = clamp(window.scrollY / zoom, 0, max);
    render(current);
    reveal(current);
  }

  /* ---------- paint ---------- */

  function render(y) {
    content.style.transform = 'translate3d(0,' + (-y).toFixed(2) + 'px,0)';
    bg.style.transform = 'translate3d(0,' + (-y * bgRate).toFixed(2) + 'px,0)';
  }

  function reveal(y) {
    var line = y + vh * REVEAL_AT;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.shown && it.top < line) {
        it.shown = true;
        it.el.classList.add('in');
      }
    }
  }

  /* ---------- loop ---------- */

  function frame(now) {
    var dt = last ? Math.min(now - last, 68) : 16.667;
    last = now;

    // frame-rate independent lerp: same feel at 60 / 120 / 144 Hz
    var k = 1 - Math.pow(1 - EASE, dt / 16.667);
    current += (target - current) * k;

    if (Math.abs(target - current) < 0.06) {
      current = target;
      running = false;
      last = 0;
    }

    render(current);
    reveal(current);

    if (running) requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }

  function onScroll() {
    target = clamp(window.scrollY / zoom, 0, max);
    start();
  }

  /* ---------- wiring ---------- */

  window.addEventListener('scroll', onScroll, { passive: true });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(measure, 120);
  }, { passive: true });

  // Font swap can still change content height
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  measure();
  window.addEventListener('load', measure);

  /* =================================================================
     DEV MODE - press T
     Built lazily on first keypress, so it costs nothing until used.
  ================================================================== */

  var KEY = 'yz.dev';
  var dev = null;

  var knobs = [
    { id: 'zoom', label: 'Zoom out',      min: 0.25, max: 1,    step: 0.01, val: 1,       fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { id: 'pad',  label: 'Side padding',  min: 0,    max: 14,   step: 0.1,  val: null,    fmt: function (v) { return v.toFixed(1) + 'vw'; } },
    { id: 'maxw', label: 'Column width',  min: 720,  max: 2200, step: 10,   val: 1360,    fmt: function (v) { return v + 'px'; } },
    { id: 'hero', label: 'Hero size',     min: 0.4,  max: 2,    step: 0.01, val: 1,       fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'bgz',  label: 'BG zoom',       min: 0.2,  max: 1.6,  step: 0.01, val: 1,       fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'bg',   label: 'BG parallax',   min: 0,    max: 1,    step: 0.01, val: 0.60,    fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'ease', label: 'Scroll ease',   min: 0.03, max: 0.2,  step: 0.002, val: 0.088,  fmt: function (v) { return v.toFixed(3); } }
  ];

  function byId(id) { for (var i = 0; i < knobs.length; i++) if (knobs[i].id === id) return knobs[i]; }

  /* ---------- plant-shadow placement: WASD to move, R to rotate ----------
     Only live while the dev panel is open. Shift makes the step fine, and
     shift+R turns the other way. The leaves keep drifting inside this. */

  var plant = { x: 0, y: 0, r: 0 };
  var PLANT_STEP = 8;   // px per tap (1 with shift)
  var PLANT_TURN = 1;   // deg per tap

  function applyPlant() {
    root.style.setProperty('--plant-x', plant.x + 'px');
    root.style.setProperty('--plant-y', plant.y + 'px');
    root.style.setProperty('--plant-rot', plant.r + 'deg');
    var out = dev && dev.querySelector('#v-plant');
    if (out) out.textContent = plant.x + ', ' + plant.y + ', ' + plant.r.toFixed(1) + '\u00b0';
  }

  function devOpen() { return !!dev && dev.style.display !== 'none'; }

  // Seed "Side padding" from whatever the stylesheet currently resolves to
  function seedPad() {
    var k = byId('pad');
    if (k.val !== null) return;
    var px = parseFloat(getComputedStyle(content).paddingLeft) || 0;
    k.val = clamp(+(px / window.innerWidth * 100).toFixed(1), k.min, k.max);
  }

  function apply(id) {
    var v = byId(id).val;
    if (id === 'zoom') {
      var keep = current;
      zoom = v;
      root.style.setProperty('--zoom', v);
      measure();
      target = current = clamp(keep, 0, max);
      window.scrollTo(0, Math.round(current * zoom));
      render(current);
    } else if (id === 'pad') {
      root.style.setProperty('--pad', v + 'vw');
      measure();
    } else if (id === 'maxw') {
      root.style.setProperty('--maxw', v + 'px');
      measure();
    } else if (id === 'hero') {
      root.style.setProperty('--hero-scale', v);
      measure();
    } else if (id === 'bgz') {
      root.style.setProperty('--bg-zoom', v);
    } else if (id === 'bg') {
      BG_RATE = v;
      measure();
    } else if (id === 'ease') {
      EASE = v;
    }
  }

  function save() {
    var o = { plant: plant };
    for (var i = 0; i < knobs.length; i++) if (knobs[i].id !== 'zoom') o[knobs[i].id] = knobs[i].val;
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {}
  }

  // Restore a previous tuning session (never the zoom - that is view-only)
  (function restore() {
    var o;
    try { o = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (!o) return;
    for (var id in o) {
      var k = byId(id);
      if (k && typeof o[id] === 'number') { k.val = o[id]; apply(id); }
    }
    if (o.plant) {
      plant.x = o.plant.x || 0; plant.y = o.plant.y || 0; plant.r = o.plant.r || 0;
      applyPlant();
    }
  })();

  function build() {
    dev = document.createElement('div');
    dev.className = 'dev';

    var html = '<h3>Dev &middot; T to close</h3>';
    for (var i = 0; i < knobs.length; i++) {
      var k = knobs[i];
      html += '<label><span class="row"><span>' + k.label + '</span><b id="v-' + k.id + '"></b></span>' +
        '<input type="range" id="k-' + k.id + '" min="' + k.min + '" max="' + k.max + '" step="' + k.step + '"></label>';
    }
    html += '<label><span class="row"><span>Plant shadow</span><b id="v-plant"></b></span></label>' +
      '<div class="btns"><button id="dev-copy">Copy CSS</button><button id="dev-reset">Reset</button></div>' +
      '<p class="hint">WASD moves the plant shadow, R rotates it (hold shift ' +
      'for fine steps / the other way). Zoom simulates a larger screen so ' +
      'padding reads true.</p>';
    dev.innerHTML = html;
    document.body.appendChild(dev);

    knobs.forEach(function (k) {
      var input = dev.querySelector('#k-' + k.id);
      var out = dev.querySelector('#v-' + k.id);
      input.value = k.val;
      out.textContent = k.fmt(k.val);
      input.addEventListener('input', function () {
        k.val = parseFloat(input.value);
        out.textContent = k.fmt(k.val);
        apply(k.id);
        save();
      });
    });

    applyPlant();

    dev.querySelector('#dev-copy').addEventListener('click', function (e) {
      var css = ':root{\n' +
        '  --pad: ' + byId('pad').val + 'vw;\n' +
        '  --maxw: ' + byId('maxw').val + 'px;\n' +
        '  --hero-scale: ' + byId('hero').val + ';\n' +
        '  --bg-zoom: ' + byId('bgz').val + ';\n' +
        '  --plant-x: ' + plant.x + 'px;\n' +
        '  --plant-y: ' + plant.y + 'px;\n' +
        '  --plant-rot: ' + plant.r + 'deg;\n}\n' +
        '/* main.js */ BG_RATE = ' + byId('bg').val + '; EASE = ' + byId('ease').val + ';';
      var btn = e.currentTarget;
      if (navigator.clipboard) navigator.clipboard.writeText(css);
      console.log(css);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy CSS'; }, 1200);
    });

    dev.querySelector('#dev-reset').addEventListener('click', function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      ['--pad','--maxw','--zoom','--hero-scale','--bg-zoom',
       '--plant-x','--plant-y','--plant-rot'].forEach(function (p) {
        root.style.removeProperty(p);
      });
      plant.x = plant.y = plant.r = 0; applyPlant();
      zoom = 1; BG_RATE = 0.60; EASE = 0.088;
      byId('pad').val = null; seedPad();
      byId('maxw').val = 1360; byId('hero').val = 1; byId('bgz').val = 1;
      byId('bg').val = 0.60; byId('ease').val = 0.088; byId('zoom').val = 1;
      knobs.forEach(function (k) {
        dev.querySelector('#k-' + k.id).value = k.val;
        dev.querySelector('#v-' + k.id).textContent = k.fmt(k.val);
      });
      measure();
    });
  }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    var key = (e.key || '').toLowerCase();

    if (key === 't') {
      if (!dev) { seedPad(); build(); return; }
      dev.style.display = dev.style.display === 'none' ? '' : 'none';
      return;
    }

    if (!devOpen()) return;

    var step = e.shiftKey ? 1 : PLANT_STEP;
    if      (key === 'a') plant.x -= step;
    else if (key === 'd') plant.x += step;
    else if (key === 'w') plant.y -= step;
    else if (key === 's') plant.y += step;
    else if (key === 'r') plant.r = +(plant.r + (e.shiftKey ? -PLANT_TURN : PLANT_TURN)).toFixed(1);
    else return;

    e.preventDefault();
    applyPlant();
    save();
  });
})();
