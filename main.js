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
  var BG_RATE   = 0.28;    // background travels at this share of content speed
  var REVEAL_AT = 0.86;    // fraction of the viewport an item must cross

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

    // Let the background drift across its whole height without ever
    // exposing an edge, capped at the configured rate.
    var travel = Math.max(0, bg.offsetHeight - vh);
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

  // Read the real aspect ratio of the background file so a portrait
  // source is laid out portrait instead of being cropped to a letterbox.
  (function () {
    var raw = getComputedStyle(root).getPropertyValue('--bg-img');
    var m = raw.match(/url\(\s*["']?(.*?)["']?\s*\)/);
    if (!m) return;
    var img = new Image();
    img.onload = function () {
      if (img.naturalWidth && img.naturalHeight) {
        root.style.setProperty('--bg-ar', img.naturalWidth + ' / ' + img.naturalHeight);
      }
      measure();
    };
    img.src = m[1];
  })();

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
    { id: 'bg',   label: 'BG parallax',   min: 0,    max: 0.6,  step: 0.01, val: 0.28,    fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'ease', label: 'Scroll ease',   min: 0.03, max: 0.2,  step: 0.002, val: 0.088,  fmt: function (v) { return v.toFixed(3); } }
  ];

  function byId(id) { for (var i = 0; i < knobs.length; i++) if (knobs[i].id === id) return knobs[i]; }

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
    } else if (id === 'bg') {
      BG_RATE = v;
      measure();
    } else if (id === 'ease') {
      EASE = v;
    }
  }

  function save() {
    var o = {};
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
    html += '<div class="btns"><button id="dev-copy">Copy CSS</button><button id="dev-reset">Reset</button></div>' +
      '<p class="hint">Zoom simulates a larger screen so padding reads true.</p>';
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

    dev.querySelector('#dev-copy').addEventListener('click', function (e) {
      var css = ':root{\n  --pad: ' + byId('pad').val + 'vw;\n  --maxw: ' + byId('maxw').val + 'px;\n}\n' +
        '/* main.js */ BG_RATE = ' + byId('bg').val + '; EASE = ' + byId('ease').val + ';';
      var btn = e.currentTarget;
      if (navigator.clipboard) navigator.clipboard.writeText(css);
      console.log(css);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy CSS'; }, 1200);
    });

    dev.querySelector('#dev-reset').addEventListener('click', function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      root.style.removeProperty('--pad');
      root.style.removeProperty('--maxw');
      root.style.removeProperty('--zoom');
      zoom = 1; BG_RATE = 0.28; EASE = 0.088;
      byId('pad').val = null; seedPad();
      byId('maxw').val = 1360; byId('bg').val = 0.28; byId('ease').val = 0.088; byId('zoom').val = 1;
      knobs.forEach(function (k) {
        dev.querySelector('#k-' + k.id).value = k.val;
        dev.querySelector('#v-' + k.id).textContent = k.fmt(k.val);
      });
      measure();
    });
  }

  window.addEventListener('keydown', function (e) {
    if (e.key !== 't' && e.key !== 'T') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (!dev) { seedPad(); build(); return; }
    dev.style.display = dev.style.display === 'none' ? '' : 'none';
  });
})();
