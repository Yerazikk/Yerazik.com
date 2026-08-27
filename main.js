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

  var EASE      = 0.07;    // chase strength at 60fps; lower = heavier
  var BG_RATE   = 0.28;    // ceiling on the background's share of content speed
  var REVEAL_AT = 0.86;    // fraction of the viewport an item must cross

  // The two candidate walls, in dev-toggle order (B cycles them). This is the
  // wall layer only - the cast window shadow is a separate layer above it
  // (shadows.svg, see .bg::after) and stays put whichever wall is showing.
  // Each is portrait; the background box is sized to its ratio at full stage
  // width, so the scene is shown whole rather than cropped to a middle band -
  // the extra height is what the parallax pans through. Add an entry here if
  // the artwork is replaced.
  var BG_SRC = [
    { id: 'jpg', file: 'temp.jpg',       aspect:  736 / 1308 },
    { id: 'svg', file: 'background.svg', aspect: 4881 / 8623 }
  ];
  var bgSrc = 0;
  var BG_ASPECT = BG_SRC[0].aspect;

  /* ---------- state ---------- */

  var zoom = 1;            // stage scale; 1 in production, <1 only in dev
  var target = 0, current = 0, max = 0, realMax = 0, vh = 0, bgRate = 0;
  var items = [], running = false, last = 0;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- wordmark zoom tunnel ----------

     A scroll-locked intro: the page holds completely still - content, bg,
     everything - while the wordmark punches into a hyperscale close-up. Only
     once it has fully zoomed/blurred/faded away ("exploded") does scrolling
     start actually moving the page, continuing on seamlessly from there.

     This is implemented by giving the real scrollable height an extra
     tzRange of "dead" scroll distance up front: real scroll position
     (`current`) drives the tunnel's progress directly, and the visual
     offset handed to render()/reveal() is current - tzRange, clamped to 0 -
     so nothing moves on screen until current passes tzRange, at which point
     the visual offset picks up from exactly 0 with no jump. */

  var TZ_MAX_DEFAULT = 6.5;         // dev-knob default, range [4.8, 9]
  var TZ_ARM_SCALE = 2.0;           // scale at which the cursor lets go
  var TZ_HOLD = 0.08;               // fraction of the runway held untouched
                                     // before the zoom starts at all
  var TZ_BLUR_MAX = 14;             // px, at full zoom
  var TZ_BLUR_STEP = 1;             // px - blur is a real per-pixel
                                     // convolution, not a cheap compositor
                                     // op like transform/opacity, so its
                                     // written value is quantized to whole
                                     // pixels (see frame()) instead of
                                     // rewritten at full float precision
                                     // every frame - a static filter value
                                     // is what lets the browser skip
                                     // redoing the blur on a given frame
  var TZ_RANGE_FACTOR = 0.55;       // fraction of viewport height (~55vh) -
                                     // short on purpose, so a normal scroll
                                     // gesture slides straight through it

  // Nothing happens for the first TZ_HOLD of the runway - the name stays put
  // and sharp before the effect kicks in, instead of starting to blur the
  // instant scrolling begins.
  function tzEase(t) {
    if (t <= TZ_HOLD) return 0;
    var u = (t - TZ_HOLD) / (1 - TZ_HOLD);
    return 1 - Math.pow(1 - u, 2.2);
  }

  // Stays fully opaque through almost the entire zoom - "opaque while it's
  // bigger" - and only drops in the last stretch, right as it explodes.
  function tzOpacityCurve(e) {
    return e < 0.85 ? 1 : clamp(1 - (e - 0.85) / 0.15, 0, 1);
  }

  var tzMax = TZ_MAX_DEFAULT;       // dev-knob value
  var tzRange = 0;                  // px, recomputed in measure()
  var tzScale = 1, tzBlur = 0, tzOpacity = 1;   // lerped, painted values
  var tzBlurWritten = -1;           // last quantized --tz-blur px value
  var tzArmed = false;
  var tzActive = false;             // true anywhere inside the runway - lets
                                     // the wordmark render above the nav
                                     // instead of being clipped by the mask
                                     // that normally keeps scrolled content
                                     // from peeking above it (styles.css)

  /* ---------- measure: the only place we read layout ---------- */

  function measure() {
    vh = stage.clientHeight;                 // = real viewport height / zoom
    tzRange = Math.max(1, vh * TZ_RANGE_FACTOR);

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
    realMax = max + tzRange;         // adds the frozen tunnel runway up front

    // Body carries the real scroll height; content space is scaled by zoom.
    // The extra tzRange is real scroll distance that produces no content
    // movement at all (see the tunnel comment above) - it has to be added
    // here or the last tzRange of the page would be unreachable by scrolling.
    document.body.style.height = Math.round((h + tzRange) * zoom) + 'px';

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

    target = current = clamp(window.scrollY / zoom, 0, realMax);
    var vy = clamp(current - tzRange, 0, max);
    render(vy);
    reveal(vy);
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

    // Tunnel progress off the same lerped scroll value already computed
    // above - free, no extra scroll read.
    var tzT = clamp(current / tzRange, 0, 1);
    var tzE = tzEase(tzT);

    var tzWantScale = 1 + (tzMax - 1) * tzE;
    var tzWantBlur = TZ_BLUR_MAX * tzE;
    var tzWantOpacity = tzOpacityCurve(tzE);

    // Chase the target values the same way target-cursor.js chases the
    // pointer - frame-rate independent, so a fast/jerky scroll still glides.
    var tzK = 1 - Math.pow(1 - 0.32, dt / 16.667);
    tzScale += (tzWantScale - tzScale) * tzK;
    tzBlur += (tzWantBlur - tzBlur) * tzK;
    tzOpacity += (tzWantOpacity - tzOpacity) * tzK;

    root.style.setProperty('--tz-scale', tzScale.toFixed(3));
    root.style.setProperty('--tz-opacity', tzOpacity.toFixed(3));

    // Quantized on purpose - see TZ_BLUR_STEP above. Only actually touches
    // the DOM (and triggers a re-blur) when the rounded value changes.
    var blurQ = Math.round(tzBlur / TZ_BLUR_STEP) * TZ_BLUR_STEP;
    if (blurQ !== tzBlurWritten) {
      tzBlurWritten = blurQ;
      root.style.setProperty('--tz-blur', blurQ.toFixed(0) + 'px');
    }

    var shouldArm = tzScale >= TZ_ARM_SCALE;
    if (shouldArm !== tzArmed) {
      tzArmed = shouldArm;
      document.body.classList.toggle('tunnel-armed', tzArmed);
      document.dispatchEvent(new CustomEvent('tunnel:armed', { detail: { armed: tzArmed } }));
    }

    var shouldBeActive = current < tzRange;
    if (shouldBeActive !== tzActive) {
      tzActive = shouldBeActive;
      document.body.classList.toggle('tunnel-active', tzActive);
    }

    // The page holds completely still until current passes tzRange - see
    // the tunnel comment above measure(). vy picks up from exactly 0 the
    // moment it does, so there is no jump at the handoff.
    var vy = clamp(current - tzRange, 0, max);
    render(vy);
    reveal(vy);

    if (running) requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }

  function onScroll() {
    target = clamp(window.scrollY / zoom, 0, realMax);
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
  var devMin = false;      // panel collapsed to its title bar

  var knobs = [
    { id: 'zoom', label: 'Zoom out',      min: 0.25, max: 1,    step: 0.01, val: 1,       fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { id: 'pad',  label: 'Side padding',  min: 0,    max: 14,   step: 0.1,  val: null,    fmt: function (v) { return v.toFixed(1) + 'vw'; } },
    { id: 'maxw', label: 'Column width',  min: 720,  max: 2200, step: 10,   val: 1130,    fmt: function (v) { return v + 'px'; } },
    { id: 'gap',  label: 'Project gap',   min: -420, max: 420,  step: 2,    val: null,    fmt: function (v) { return v + 'px'; } },
    { id: 'hero', label: 'Hero size',     min: 0.4,  max: 2,    step: 0.01, val: 1.16,    fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'bgz',  label: 'BG zoom',       min: 0.2,  max: 1.6,  step: 0.01, val: 1,       fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'tunnelzoom', label: 'Tunnel zoom', min: 4.8, max: 9, step: 0.1, val: TZ_MAX_DEFAULT, fmt: function (v) { return v.toFixed(1) + 'x'; } },
    { id: 'bg',   label: 'BG parallax',   min: 0,    max: 1,    step: 0.01, val: 0.28,    fmt: function (v) { return v.toFixed(2) + 'x'; } },
    { id: 'ease', label: 'Scroll ease',   min: 0.03, max: 0.2,  step: 0.002, val: 0.07,   fmt: function (v) { return v.toFixed(3); } }
  ];

  function byId(id) { for (var i = 0; i < knobs.length; i++) if (knobs[i].id === id) return knobs[i]; }

  /* ---------- plant-shadow placement: WASD to move, R to rotate ----------
     Only live while the dev panel is open. Shift makes the step fine, and
     shift+R turns the other way. The leaves keep drifting inside this. */

  var plant = { x: -24, y: 1520, r: 0 };
  var vine  = { x: 48, y: -1616, r: 379 };   // the top-right vine, on the arrows / O
  var branch = { x: 0, y: 0, r: 0 };         // the top-left branch, on YGHJ / U
  var PLANT_STEP = 8;   // px per tap (1 with shift)
  var PLANT_TURN = 1;   // deg per tap

  function applyPlant() {
    root.style.setProperty('--plant-x', plant.x + 'px');
    root.style.setProperty('--plant-y', plant.y + 'px');
    root.style.setProperty('--plant-rot', plant.r + 'deg');
    var out = dev && dev.querySelector('#v-plant');
    if (out) out.textContent = plant.x + ', ' + plant.y + ', ' + plant.r.toFixed(1) + '\u00b0';
  }

  function applyVine() {
    root.style.setProperty('--vine-x', vine.x + 'px');
    root.style.setProperty('--vine-y', vine.y + 'px');
    root.style.setProperty('--vine-rot', vine.r + 'deg');
    var out = dev && dev.querySelector('#v-vine');
    if (out) out.textContent = vine.x + ', ' + vine.y + ', ' + vine.r.toFixed(1) + '\u00b0';
  }

  function applyBranch() {
    root.style.setProperty('--branch-x', branch.x + 'px');
    root.style.setProperty('--branch-y', branch.y + 'px');
    root.style.setProperty('--branch-rot', branch.r + 'deg');
    var out = dev && dev.querySelector('#v-branch');
    if (out) out.textContent = branch.x + ', ' + branch.y + ', ' + branch.r.toFixed(1) + '\u00b0';
  }

  /* ---------- wordmark face: Z / X switch between the three ----------
     All three are tall condensed caps, loaded from the <link> in
     index.html. Each row carries its own scale and tracking, because cap
     heights differ - Six Caps needs a fifth again the size of Bebas to
     read as the same size on screen. Row 0 is what the stylesheet already
     sets, so nothing moves until you press a key. */

  var WM_FONTS = [
    { n: 'Bebas Neue',        f: '"Bebas Neue", sans-serif',            s: 1.06, ls: '.005em', w: '400' },
    { n: 'Six Caps',          f: '"Six Caps", sans-serif',              s: 1.2,  ls: '.02em',  w: '400' },
    { n: 'Big Shoulders 300', f: '"Big Shoulders Display", sans-serif', s: 1.08, ls: '0em',    w: '300' }
  ];
  var wmIdx = 0;

  function applyWm() {
    var s = WM_FONTS[wmIdx];
    root.style.setProperty('--wm-font', s.f);
    root.style.setProperty('--wm-scale', s.s);
    root.style.setProperty('--wm-ls', s.ls);
    root.style.setProperty('--wm-weight', s.w);
    var out = dev && dev.querySelector('#v-wmfont');
    if (out) out.textContent = (wmIdx + 1) + '/' + WM_FONTS.length + ' \u00b7 ' + s.n;
    measure();                       // a new face changes the hero's height
  }

  function cycleWm(d) {
    wmIdx = (wmIdx + d + WM_FONTS.length) % WM_FONTS.length;
    applyWm();
    save();
  }



  /* ---------- background source: press B to swap .svg <-> .jpg ----------
     Both files are portrait but not to quite the same ratio, so the box has
     to be remeasured, not just repainted. */

  function applyBg() {
    var src = BG_SRC[bgSrc];
    root.style.setProperty('--bg-img', 'url("' + src.file + '")');
    BG_ASPECT = src.aspect;
    var out = dev && dev.querySelector('#v-bgsrc');
    if (out) out.textContent = src.file;
    var btn = dev && dev.querySelector('#dev-bgsrc');
    if (btn) btn.textContent = 'BG: ' + src.file;
    measure();
  }

  function cycleBg() {
    bgSrc = (bgSrc + 1) % BG_SRC.length;
    applyBg();
    save();
  }

  function devOpen() { return !!dev && dev.style.display !== 'none'; }

  // Tell the rest of the page the panel is up. target-cursor.js listens and
  // hands the OS cursor back, because the sliders are unusable without it.
  function devMode(open) {
    root.classList.toggle('dev-on', open);
    document.dispatchEvent(new CustomEvent('dev:mode', { detail: { open: open } }));
  }

  function setMin(on) {
    devMin = on;
    if (!dev) return;
    dev.classList.toggle('min', on);
    var btn = dev.querySelector('#dev-min');
    if (btn) {
      btn.textContent = on ? '+' : '–';
      btn.title = on ? 'Expand' : 'Minimise';
    }
  }

  // Seed "Side padding" from whatever the stylesheet currently resolves to
  function seedPad() {
    var k = byId('pad');
    if (k.val !== null) return;
    var px = parseFloat(getComputedStyle(content).paddingLeft) || 0;
    k.val = clamp(+(px / window.innerWidth * 100).toFixed(1), k.min, k.max);
  }

  // Seed "Project gap" from whatever the stylesheet currently resolves to
  function seedGap() {
    var k = byId('gap');
    if (k.val !== null) return;
    var proj = content.querySelectorAll('.project');
    var px = proj.length > 1 ? parseFloat(getComputedStyle(proj[1]).marginTop) || 0 : 0;
    k.val = clamp(Math.round(px), k.min, k.max);
  }

  function apply(id) {
    var v = byId(id).val;
    if (id === 'zoom') {
      var keep = current;
      zoom = v;
      root.style.setProperty('--zoom', v);
      measure();
      target = current = clamp(keep, 0, realMax);
      window.scrollTo(0, Math.round(current * zoom));
      render(clamp(current - tzRange, 0, max));
    } else if (id === 'pad') {
      root.style.setProperty('--pad', v + 'vw');
      measure();
    } else if (id === 'maxw') {
      root.style.setProperty('--maxw', v + 'px');
      measure();
    } else if (id === 'gap') {
      // below zero the alternating projects slide past each other
      root.style.setProperty('--proj-gap', v + 'px');
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
    } else if (id === 'tunnelzoom') {
      tzMax = v;
    }
  }

  function save() {
    var o = { plant: plant, vine: vine, branch: branch, bgsrc: BG_SRC[bgSrc].id, wm: wmIdx, min: devMin };
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
    if (typeof o.min === 'boolean') devMin = o.min;
    if (typeof o.wm === 'number' && WM_FONTS[o.wm]) {
      wmIdx = o.wm;
      applyWm();
    }
    // stored by id, not index, so reordering BG_SRC cannot silently point an
    // old save at the wrong wall
    for (var i = 0; i < BG_SRC.length; i++) {
      if (BG_SRC[i].id === o.bgsrc) { bgSrc = i; applyBg(); break; }
    }
    if (o.plant) {
      plant.x = o.plant.x || 0; plant.y = o.plant.y || 0; plant.r = o.plant.r || 0;
      applyPlant();
    }
    if (o.vine) {
      vine.x = o.vine.x || 0; vine.y = o.vine.y || 0; vine.r = o.vine.r || 0;
      applyVine();
    }
    if (o.branch) {
      branch.x = o.branch.x || 0; branch.y = o.branch.y || 0; branch.r = o.branch.r || 0;
      applyBranch();
    }
  })();

  function build() {
    dev = document.createElement('div');
    dev.className = 'dev';

    var html = '<h3><span>Dev &middot; T to close</span>' +
      '<button id="dev-min" type="button" title="Minimise">–</button></h3>';
    for (var i = 0; i < knobs.length; i++) {
      var k = knobs[i];
      html += '<label><span class="row"><span>' + k.label + '</span><b id="v-' + k.id + '"></b></span>' +
        '<input type="range" id="k-' + k.id + '" min="' + k.min + '" max="' + k.max + '" step="' + k.step + '"></label>';
    }
    html += '<label><span class="row"><span>Plant shadow</span><b id="v-plant"></b></span></label>' +
      '<label><span class="row"><span>Vine shadow</span><b id="v-vine"></b></span></label>' +
      '<label><span class="row"><span>Branch (top-left)</span><b id="v-branch"></b></span></label>' +
      '<label><span class="row"><span>Wordmark face</span><b id="v-wmfont"></b></span></label>' +
      '<label><span class="row"><span>Background</span><b id="v-bgsrc"></b></span></label>' +
      '<div class="btns"><button id="dev-bgsrc">BG</button></div>' +
      '<div class="btns"><button id="dev-copy">Copy CSS</button><button id="dev-reset">Reset</button></div>' +
      '<details class="hint"><summary>Keys</summary>' +
      'Z / X switch the wordmark face. ' +
      'WASD moves the plant shadow, R rotates it. IJKL moves ' +
      'the top-right vine, O rotates it. YGHJ moves the top-left ' +
      'branch, U rotates it. B swaps the wall between ' +
      'temp.jpg and background.svg; the cast shadow layers over either. ' +
      'Hold shift for fine steps / the other ' +
      'way. Zoom simulates a larger screen so padding reads true.</details>';
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
    applyVine();
    applyWm();
    applyBg();

    setMin(devMin);
    dev.querySelector('#dev-min').addEventListener('click', function () {
      setMin(!devMin);
      save();
    });

    dev.querySelector('#dev-bgsrc').addEventListener('click', cycleBg);

    dev.querySelector('#dev-copy').addEventListener('click', function (e) {
      var css = ':root{\n' +
        '  --bg-img: url("' + BG_SRC[bgSrc].file + '");\n' +
        '  --wm-font: ' + WM_FONTS[wmIdx].f + ';\n' +
        '  --wm-scale: ' + WM_FONTS[wmIdx].s + ';\n' +
        '  --wm-ls: ' + WM_FONTS[wmIdx].ls + ';\n' +
        '  --wm-weight: ' + WM_FONTS[wmIdx].w + ';\n' +
        '  --pad: ' + byId('pad').val + 'vw;\n' +
        '  --maxw: ' + byId('maxw').val + 'px;\n' +
        '  --proj-gap: ' + byId('gap').val + 'px;\n' +
        '  --hero-scale: ' + byId('hero').val + ';\n' +
        '  --bg-zoom: ' + byId('bgz').val + ';\n' +
        '  --plant-x: ' + plant.x + 'px;\n' +
        '  --plant-y: ' + plant.y + 'px;\n' +
        '  --plant-rot: ' + plant.r + 'deg;\n' +
        '  --vine-x: ' + vine.x + 'px;\n' +
        '  --vine-y: ' + vine.y + 'px;\n' +
        '  --vine-rot: ' + vine.r + 'deg;\n' +
        '  --branch-x: ' + branch.x + 'px;\n' +
        '  --branch-y: ' + branch.y + 'px;\n' +
        '  --branch-rot: ' + branch.r + 'deg;\n}\n' +
        '/* main.js */ BG_RATE = ' + byId('bg').val + '; EASE = ' + byId('ease').val + ';\n' +
        '/* tunnel zoom = ' + byId('tunnelzoom').val + 'x */\n';
      var btn = e.currentTarget;
      if (navigator.clipboard) navigator.clipboard.writeText(css);
      console.log(css);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy CSS'; }, 1200);
    });

    dev.querySelector('#dev-reset').addEventListener('click', function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      ['--pad','--maxw','--proj-gap','--zoom','--hero-scale','--bg-zoom','--bg-img',
       '--wm-font','--wm-scale','--wm-ls','--wm-weight',
       '--plant-x','--plant-y','--plant-rot',
       '--vine-x','--vine-y','--vine-rot',
       '--branch-x','--branch-y','--branch-rot'].forEach(function (p) {
        root.style.removeProperty(p);
      });
      plant.x = -24; plant.y = 1520; plant.r = 0; applyPlant();
      vine.x = 48; vine.y = -1616; vine.r = 379; applyVine();
      branch.x = 0; branch.y = 0; branch.r = 0; applyBranch();
      wmIdx = 0; applyWm();
      bgSrc = 0; applyBg();
      zoom = 1; BG_RATE = 0.28; EASE = 0.07; tzMax = TZ_MAX_DEFAULT;
      byId('pad').val = null; seedPad();
      byId('gap').val = 32;
      byId('maxw').val = 1130; byId('hero').val = 1.16; byId('bgz').val = 1;
      byId('bg').val = 0.28; byId('ease').val = 0.07; byId('zoom').val = 1;
      byId('tunnelzoom').val = TZ_MAX_DEFAULT;
      knobs.forEach(function (k) {
        dev.querySelector('#k-' + k.id).value = k.val;
        dev.querySelector('#v-' + k.id).textContent = k.fmt(k.val);
      });
      measure();
    });
  }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Letters do nothing to a range slider, and focus stays on one after a
    // drag - so let them through, or WASD / IJKL go dead until you click away
    var t = e.target;
    var slider = t && t.tagName === 'INPUT' && t.type === 'range';
    if (t && !slider && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    var key = (e.key || '').toLowerCase();

    if (key === 't') {
      if (!dev) { seedPad(); seedGap(); build(); devMode(true); return; }
      dev.style.display = dev.style.display === 'none' ? '' : 'none';
      devMode(devOpen());
      return;
    }

    if (!devOpen()) return;

    var step = e.shiftKey ? 1 : PLANT_STEP;
    var turn = e.shiftKey ? -PLANT_TURN : PLANT_TURN;

    // WASD / R drive the bottom-left plant, the arrows / O the top-right
    // vine, YGHJ / U the top-left branch
    if (key === 'b') { e.preventDefault(); cycleBg(); return; }
    if (key === 'z') { e.preventDefault(); cycleWm(-1); return; }
    if (key === 'x') { e.preventDefault(); cycleWm(1);  return; }

    if      (key === 'a') plant.x -= step;
    else if (key === 'd') plant.x += step;
    else if (key === 'w') plant.y -= step;
    else if (key === 's') plant.y += step;
    else if (key === 'r') plant.r = +(plant.r + turn).toFixed(1);
    else if (key === 'arrowleft')  vine.x -= step;
    else if (key === 'arrowright') vine.x += step;
    else if (key === 'arrowup')    vine.y -= step;
    else if (key === 'arrowdown')  vine.y += step;
    else if (key === 'o') vine.r = +(vine.r + turn).toFixed(1);
    else if (key === 'g') branch.x -= step;
    else if (key === 'j') branch.x += step;
    else if (key === 'y') branch.y -= step;
    else if (key === 'h') branch.y += step;
    else if (key === 'u') branch.r = +(branch.r + turn).toFixed(1);
    else return;

    e.preventDefault();
    applyPlant();
    applyVine();
    applyBranch();
    save();
  });
})();
