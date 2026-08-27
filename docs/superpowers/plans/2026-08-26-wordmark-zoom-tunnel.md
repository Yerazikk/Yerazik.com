# Wordmark Zoom Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** As the visitor scrolls away from the top of the page, the "Yerazik" wordmark punches into a hyperscale close-up (4.8x-9x, dev-tunable) with blur/fade, instead of just sliding up with the rest of the hero, and the custom target-cursor bracket stops treating it as a target once it's mid-zoom. Two visual variants (`warp` / `snap`), cycled at runtime with a key for side-by-side comparison.

**Architecture:** `main.js`'s existing scroll render loop (already reading `scrollY` and lerping it every frame for the parallax) grows a second derived value — tunnel progress — which it eases, then chases frame-to-frame with the same `lerpK` technique `target-cursor.js` already uses for cursor motion, and writes out as three CSS custom properties on `.wordmark` (`--tz-scale`, `--tz-blur`, `--tz-opacity`) plus a `body.tunnel-armed` class once the effect passes the ~2x-scale mark. `styles.css` paints those properties with a plain `transform`/`filter`/`opacity` rule — no logic in CSS. `target-cursor.js` listens for the arm/disarm transition via a custom event (mirroring the existing `dev:mode` event it already listens to) and excludes/unlatches `.wordmark` accordingly.

**Tech Stack:** Vanilla JS (no build step, no framework, no test runner — this repo is a static zero-dependency site), plain CSS custom properties.

## Global Constraints

- Zero dependencies, no build step — every change is plain `.js`/`.css`, matching the header comment in `styles.css:1-4` ("Yerazik - static, zero-dependency. Everything animatable is transform/opacity only, so nothing here can trigger layout.").
- No test framework exists in this repo — verification is manual, in a real browser, against the running static site. Every task's "test" steps are explicit manual browser/DevTools checks, not automated tests.
- Effect and the new `F` key must be no-ops under `prefers-reduced-motion: reduce`, matching the existing bail-outs in `main.js:18` and `target-cursor.js:98`.
- Dev-panel additions (new knob, new key) must follow the existing patterns exactly: knob shape `{ id, label, min, max, step, val, fmt }` (`main.js:174-183`), persisted through the existing `save()`/`restore()` pair (`main.js:345-382`), new key handled in the existing `keydown` listener (`main.js:495-545`).
- Tunnel zoom range: dev-tunable, min `4.8`, max `9` (the multiplier `.wordmark` reaches at full progress).
- `TUNNEL_RANGE` (px of scroll over which progress goes 0→1): `0.45 * window.innerHeight`, recomputed on resize alongside the existing `measure()` recalculation.
- Arm/disarm the cursor exclusion at the point eased progress implies scale ≥ `2.0` (independent of the configured max — reached earlier when max is higher).

---

## File Structure

- **Modify `main.js`** — add tunnel state (progress, eased value, lerped output), the `TZ_VARIANTS` easing table, the `F` key handler, the `tunnelzoom` dev knob, persistence for both in `save()`/`restore()`/`build()`/reset, and the per-frame write of `--tz-scale` / `--tz-blur` / `--tz-opacity` plus the `tunnel-armed` class + `tunnel:armed` custom event dispatch. This is the single source of truth for progress, easing, and the lerp chase, matching where the equivalent scroll-lerp logic already lives.
- **Modify `styles.css`** — add the `.wordmark` paint rule consuming the three custom properties, transform-origin, and `will-change`; add the `prefers-reduced-motion` exclusion for the new properties alongside the existing reduced-motion block (`styles.css:1062-1074`).
- **Modify `target-cursor.js`** — listen for `tunnel:armed`, track a `wordmarkLocked` flag, filter `.wordmark` out of `selector()`'s result while locked, and force `unlatch()` immediately if `.wordmark` is the live target when the lock engages.

No new files — this is three small, tightly-coupled edits to files that already own exactly this kind of per-frame state.

---

## Task 1: Tunnel progress, easing, dev knob and variant cycling in `main.js`

**Files:**
- Modify: `main.js` (scroll loop, dev knobs array, key handler, save/restore, reset button)
- Test: manual, in-browser (no test runner in this repo)

**Interfaces:**
- Consumes: `EASE`/`lerpK`-style frame-rate-independent chase already implemented inline in `main.js`'s `frame()` (`main.js:115-133`); `root` (`document.documentElement`, `main.js:25`); `clamp()` (`main.js:54`); `KEY`/`save()`/`restore()`/`knobs`/`byId()` (`main.js:170-382`).
- Produces (for Task 2 and Task 3 to consume):
  - CSS custom properties on `document.documentElement`, updated every frame while relevant: `--tz-scale` (unitless number, e.g. `"3.42"`), `--tz-blur` (px string, e.g. `"6.10px"`), `--tz-opacity` (unitless 0-1 string, e.g. `"0.71"`).
  - `document.body.classList` toggle: `tunnel-armed`.
  - `document.dispatchEvent(new CustomEvent('tunnel:armed', { detail: { armed: <bool> } }))`, fired only on transition (not every frame).

- [ ] **Step 1: Add tunnel state and the variant easing table**

In `main.js`, directly below the existing `var zoom = 1, target = 0, current = 0, max = 0, vh = 0, bgRate = 0;` block (`main.js:51`), add:

```javascript
  /* ---------- wordmark zoom tunnel ----------
     Scroll-linked hyperscale close-up on the wordmark. Two variants, cycled
     with F for side-by-side comparison; neither is picked as final yet. */

  var TZ_MAX_DEFAULT = 6.5;         // dev-knob default, range [4.8, 9]
  var TZ_ARM_SCALE = 2.0;           // scale at which the cursor lets go

  var TZ_VARIANTS = [
    {
      id: 'warp',
      // fast ease-out: most of the punch-in happens early
      ease: function (t) { return 1 - Math.pow(1 - t, 3); },
      blurMax: 18,                  // px, at eased-t = 1
      // opacity starts dropping almost immediately
      opacity: function (e) { return clamp(1 - e * 1.15, 0, 1); }
    },
    {
      id: 'snap',
      // gentler, more even climb
      ease: function (t) { return 1 - Math.pow(1 - t, 1.6); },
      blurMax: 22,
      // stays sharp until 80% progress, then cuts hard
      opacity: function (e) { return e < 0.8 ? 1 : clamp(1 - (e - 0.8) / 0.2, 0, 1); }
    }
  ];
  var tzIdx = 0;                    // which TZ_VARIANTS entry is active
  var TZ_RANGE_FACTOR = 0.45;       // fraction of viewport height

  var tzMax = TZ_MAX_DEFAULT;       // dev-knob value
  var tzRange = 0;                  // px, recomputed in measure()
  var tzScale = 1, tzBlur = 0, tzOpacity = 1;   // lerped, painted values
  var tzArmed = false;
```

- [ ] **Step 2: Compute `tzRange` in `measure()`**

In `measure()` (`main.js:58-93`), immediately after the existing `vh = stage.clientHeight;` line, add:

```javascript
    tzRange = Math.max(1, vh * TZ_RANGE_FACTOR);
```

- [ ] **Step 3: Drive the tunnel each frame inside `frame()`**

In `frame()` (`main.js:115-133`), the function already computes `current` (the lerped scroll position) before calling `render(current)`. Add the tunnel update right after the existing lerp block and before `render(current);` / `reveal(current);`:

```javascript
    // Tunnel progress off the same lerped scroll value already computed
    // above - free, no extra scroll read.
    var tzT = clamp(current / tzRange, 0, 1);
    var variant = TZ_VARIANTS[tzIdx];
    var tzE = variant.ease(tzT);

    var tzWantScale = 1 + (tzMax - 1) * tzE;
    var tzWantBlur = variant.blurMax * tzE;
    var tzWantOpacity = variant.opacity(tzE);

    // Chase the target values the same way target-cursor.js chases the
    // pointer - frame-rate independent, so a fast/jerky scroll still glides.
    var tzK = 1 - Math.pow(1 - 0.22, dt / 16.667);
    tzScale += (tzWantScale - tzScale) * tzK;
    tzBlur += (tzWantBlur - tzBlur) * tzK;
    tzOpacity += (tzWantOpacity - tzOpacity) * tzK;

    root.style.setProperty('--tz-scale', tzScale.toFixed(3));
    root.style.setProperty('--tz-blur', tzBlur.toFixed(2) + 'px');
    root.style.setProperty('--tz-opacity', tzOpacity.toFixed(3));

    var shouldArm = tzScale >= TZ_ARM_SCALE;
    if (shouldArm !== tzArmed) {
      tzArmed = shouldArm;
      document.body.classList.toggle('tunnel-armed', tzArmed);
      document.dispatchEvent(new CustomEvent('tunnel:armed', { detail: { armed: tzArmed } }));
    }
```

`dt` is already in scope in `frame()` (`main.js:116`), so no new parameter is needed.

- [ ] **Step 4: Keep the tunnel loop alive independent of the scroll-idle short-circuit**

`frame()` currently sets `running = false` and stops requesting new frames once `Math.abs(target - current) < 0.06` (`main.js:123-127`). That's fine for the tunnel too — once scroll settles, `current` stops changing, so `tzScale`/`tzBlur`/`tzOpacity` naturally converge and stop needing updates. No change required here; this step is just confirming the existing early-exit remains correct for the new values (it does, because they're derived purely from `current`, which is the value that condition is already gating on).

- [ ] **Step 5: Add the `tunnelzoom` dev knob**

In the `knobs` array (`main.js:174-183`), add a new entry after the `'bgz'` entry:

```javascript
    { id: 'tunnelzoom', label: 'Tunnel zoom', min: 4.8, max: 9, step: 0.1, val: TZ_MAX_DEFAULT, fmt: function (v) { return v.toFixed(1) + 'x'; } },
```

- [ ] **Step 6: Wire the knob into `apply()`**

In `apply()` (`main.js:312-343`), add a branch before the closing `}`:

```javascript
    } else if (id === 'tunnelzoom') {
      tzMax = v;
    }
```

- [ ] **Step 7: Add variant cycling and its readout to the dev panel markup**

In `build()` (`main.js:384-493`), the `html` string currently ends its per-knob loop and then appends rows for plant/vine/branch/wordmark-face/background (`main.js:395-400`). Add a variant row in that same block, right after the "Wordmark face" row:

```javascript
      '<label><span class="row"><span>Tunnel variant</span><b id="v-tzvariant"></b></span></label>' +
```

After `applyBg();` near the end of `build()` (`main.js:429`), add:

```javascript
    applyTzVariant();
```

- [ ] **Step 8: Add `applyTzVariant()` next to the other `apply*` helpers**

Place this next to `applyWm()` (`main.js:235-244`):

```javascript
  function applyTzVariant() {
    var v = TZ_VARIANTS[tzIdx];
    var out = dev && dev.querySelector('#v-tzvariant');
    if (out) out.textContent = (tzIdx + 1) + '/' + TZ_VARIANTS.length + ' \u00b7 ' + v.id;
  }

  function cycleTzVariant() {
    tzIdx = (tzIdx + 1) % TZ_VARIANTS.length;
    applyTzVariant();
    save();
  }
```

- [ ] **Step 9: Bind the `F` key**

In the `keydown` listener (`main.js:495-545`), add a branch alongside the existing `z`/`x`/`b` single-letter handlers (right after the `if (key === 'x') { ... }` block, `main.js:521`):

```javascript
    if (key === 'f') { e.preventDefault(); cycleTzVariant(); return; }
```

- [ ] **Step 10: Persist `tzIdx` through `save()`/`restore()`**

In `save()` (`main.js:345-349`), add `tz: tzIdx` to the saved object literal:

```javascript
    var o = { plant: plant, vine: vine, branch: branch, bgsrc: BG_SRC[bgSrc].id, wm: wmIdx, tz: tzIdx, min: devMin };
```

In `restore()` (`main.js:352-382`), add this branch alongside the existing `if (typeof o.wm === 'number' ...)` block:

```javascript
    if (typeof o.tz === 'number' && TZ_VARIANTS[o.tz]) {
      tzIdx = o.tz;
    }
```

(No `applyTzVariant()` call needed here — `dev` doesn't exist yet at `restore()` time, same reason `wmIdx` restoration there doesn't touch the DOM either... actually check: the existing code *does* call `applyWm()` inside `restore()`. Match that pattern instead for consistency — replace the branch above with:)

```javascript
    if (typeof o.tz === 'number' && TZ_VARIANTS[o.tz]) {
      tzIdx = o.tz;
      applyTzVariant();
    }
```

`applyTzVariant()` already null-guards on `dev` being unset, so this is safe to call before the panel is built.

- [ ] **Step 11: Add reset support**

In the `#dev-reset` click handler (`main.js:468-492`), add after the `bgSrc = 0; applyBg();` line:

```javascript
      tzIdx = 0; applyTzVariant();
```

and add `byId('tunnelzoom').val = TZ_MAX_DEFAULT;` alongside the other `byId(...).val = ...` reset lines, then include `'tunnelzoom'` in the final `knobs.forEach` sync loop — that loop already iterates all of `knobs`, so no change needed there since the new knob is already in the array.

Also add `tzMax = TZ_MAX_DEFAULT;` next to the existing `zoom = 1; BG_RATE = 0.28; EASE = 0.07;` reset line (`main.js:482`).

- [ ] **Step 12: Add the copy-CSS output for the new knob**

In the `#dev-copy` click handler (`main.js:439-466`), add a line to the `css` template string alongside the other knob values:

```javascript
        '  /* tunnel zoom = ' + byId('tunnelzoom').val + 'x, variant = ' + TZ_VARIANTS[tzIdx].id + ' */\n' +
```

- [ ] **Step 13: Manual verification — dev panel and variant cycling**

Serve the site locally:

```bash
cd "C:/Users/tenta/OneDrive/Documents/Github/yerazik.com" && python -m http.server 8000
```

Open `http://localhost:8000/` in a real browser (not `file://`, so the Google Fonts `<link>` and `fetchpriority` preload behave normally).

Checks:
1. Press `T` to open the dev panel. Confirm a "Tunnel zoom" slider appears between "BG zoom" and "BG parallax", ranging 4.8x–9.0x, default reading `6.5x`.
2. Drag it; confirm the readout updates (e.g. `7.2x`) live.
3. Press `F` (with focus not inside a text input/slider). Confirm a "Tunnel variant" row appears/updates, cycling `1/2 · warp` → `2/2 · snap` → back to `1/2 · warp`.
4. Reload the page. Confirm the slider value and variant both persisted (localStorage `yz.dev`).
5. Open DevTools → Elements → `<html>` → Styles/Computed, scroll the page down slowly from the very top. Confirm `--tz-scale` climbs from `1` toward the configured max, `--tz-opacity` falls toward `0`, and `--tz-blur` rises, all read on `:root`'s inline style attribute (visible in the Elements panel as the page scrolls).
6. Scroll back to the top. Confirm all three properties ease back down toward `1` / `0` / `0` respectively (not an instant snap — should visibly glide over a few frames).
7. In DevTools, enable "Emulate CSS prefers-reduced-motion: reduce" (Rendering tab). Reload. Confirm `main.js` bails out at its top-level check (`main.js:18`) exactly as it does today — i.e. this task changes nothing about that existing behavior, since all new code lives inside the same guarded IIFE.

- [ ] **Step 14: Commit**

```bash
cd "C:/Users/tenta/OneDrive/Documents/Github/yerazik.com" && git add main.js && git commit -m "$(cat <<'EOF'
Add wordmark zoom tunnel progress, dev knob and variant cycling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Paint the effect on `.wordmark` in `styles.css`

**Files:**
- Modify: `styles.css` (`.wordmark` rule, reduced-motion block)
- Test: manual, in-browser

**Interfaces:**
- Consumes: `--tz-scale`, `--tz-blur`, `--tz-opacity` custom properties written by Task 1, defaulting via CSS `var(..., <fallback>)` so the rule is inert before `main.js` has run a single frame.

- [ ] **Step 1: Add the paint rule**

In `styles.css`, inside the existing `.wordmark{ ... }` rule (`styles.css:556-574`), add these three declarations at the end of the block, before the closing `}`:

```css
  transform-origin:center center;
  transform:scale(var(--tz-scale, 1));
  filter:blur(var(--tz-blur, 0px));
  opacity:var(--tz-opacity, 1);
  will-change:transform, filter, opacity;
```

- [ ] **Step 2: Exclude the new properties from the reduced-motion block**

In the existing `@media (prefers-reduced-motion:reduce){ ... }` block (`styles.css:1062-1074`), add a rule pinning the wordmark to its resting state, since `main.js` won't be writing the custom properties at all in that mode (it bails out before the tunnel code ever runs) but a manual CSS override makes the intent explicit and future-proof against someone calling `setProperty` from elsewhere later:

```css
  .wordmark{ transform:none !important; filter:none !important; opacity:1 !important; }
```

- [ ] **Step 3: Manual verification**

With the same `http://localhost:8000/` server running from Task 1:

1. Load the page fresh. Confirm the wordmark looks completely unchanged at rest (scale 1, no blur, full opacity) — this rule must be invisible until scroll starts.
2. Scroll down slowly from the top. Confirm the wordmark visibly grows from its normal size, blurs, and fades, converging toward invisible by the time you've scrolled roughly half the viewport height (`0.45 * innerHeight`).
3. Confirm the growth is centered on the wordmark (not drifting toward a corner) — a symptom of a missing/wrong `transform-origin`.
4. Switch the dev-panel variant (`F`) between `warp` and `snap` mid-test; confirm the two feel visibly different (warp: blurs and fades fast and early; snap: stays sharp longer, then cuts near the end of the range) while scrolling the same distance.
5. Confirm no visible layout shift or jank — Chrome DevTools Performance panel, record a scroll: only `Composite Layers`/`Paint` should show for the wordmark, no `Layout` entries attributable to it (the `will-change` + transform/opacity/filter combination stays off the main layout pass, consistent with the file's existing "transform/opacity only" rule, `styles.css:1-4`).
6. Re-check the reduced-motion emulation from Task 1 Step 13.7: with it enabled, scroll the page — confirm the wordmark does not move, blur, or fade at all.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/tenta/OneDrive/Documents/Github/yerazik.com" && git add styles.css && git commit -m "$(cat <<'EOF'
Paint the wordmark zoom tunnel effect from its CSS custom properties

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Stop the target-cursor bracket from targeting the exploding wordmark

**Files:**
- Modify: `target-cursor.js` (`selector()`, latch state, event listener)
- Test: manual, in-browser

**Interfaces:**
- Consumes: `tunnel:armed` `CustomEvent` dispatched by `main.js` (Task 1 Step 3), `detail.armed: boolean`.
- Produces: no new exports — this is a self-contained behavioral change inside the existing IIFE.

- [ ] **Step 1: Add the lock flag and a wordmark-excluding selector**

In `target-cursor.js`, near the existing `TARGET_SEL` / `selector()` definitions (`target-cursor.js:65-70`), replace:

```javascript
  var TARGET_SEL = '.project, .wordmark, .cta, .nav a';
  var GRAVITY_RADIUS = 100;  // px outside the box where the pull begins
  var GRAVITY_STICK  = CONFIG.gravityStick;

  function selector() { return TARGET_SEL; }
  function radius()   { return GRAVITY_RADIUS; }
  function stick()    { return GRAVITY_STICK; }
```

with:

```javascript
  var TARGET_SEL = '.project, .wordmark, .cta, .nav a';
  var TARGET_SEL_NO_WORDMARK = '.project, .cta, .nav a';
  var GRAVITY_RADIUS = 100;  // px outside the box where the pull begins
  var GRAVITY_STICK  = CONFIG.gravityStick;

  // Set once main.js reports the wordmark has zoomed past ~2x during the
  // scroll tunnel effect (styles.css .wordmark, main.js TZ_ARM_SCALE) - the
  // bracket has no business chasing type that large.
  var wordmarkLocked = false;

  function selector() { return wordmarkLocked ? TARGET_SEL_NO_WORDMARK : TARGET_SEL; }
  function radius()   { return GRAVITY_RADIUS; }
  function stick()    { return GRAVITY_STICK; }
```

- [ ] **Step 2: Listen for the arm/disarm event and force-release the wordmark**

Near the existing `document.addEventListener('dev:mode', ...)` listener (`target-cursor.js:356-358`), add:

```javascript
  document.addEventListener('tunnel:armed', function (e) {
    wordmarkLocked = !!(e.detail && e.detail.armed);
    if (wordmarkLocked && target && target.classList.contains('wordmark')) {
      unlatch();
    }
  });
```

`unlatch()` is already defined above this point in the file (`target-cursor.js:186-198`) and is safe to call unconditionally — it no-ops if nothing is latched, though the surrounding `if` here only calls it when something is.

- [ ] **Step 3: Manual verification**

With the same local server running:

1. Load the page. Move the mouse near/onto "Yerazik" at the top — confirm the bracket still latches onto it exactly as before (unchanged at rest, since `wordmarkLocked` starts `false`).
2. With the pointer resting on/near the wordmark, scroll down slowly. Confirm that once the wordmark has visibly grown past roughly 2x its resting size, the bracket detaches (springs back to its idle spinning state, per the existing `unlatch()` release animation) even though the pointer hasn't moved off it — this is the forced release from Step 2.
3. Continue scrolling further with the pointer still hovering where the (now much larger, fading) wordmark is. Confirm the bracket does not re-latch onto it while scrolled past that point, even if the pointer is directly over its bounding box — this is `selector()` excluding it via `TARGET_SEL_NO_WORDMARK`.
4. Scroll back up to the top. Once back below the ~2x threshold, hover the wordmark again — confirm the bracket latches onto it normally again (the lock is reversible, `main.js` will have dispatched a second `tunnel:armed` event with `armed:false`).
5. Confirm every other cursor target (`.project`, `.cta`, `.nav a`) is unaffected throughout — hover a project card while the wordmark is in its exploded state and confirm normal latch behavior.
6. Re-run the `prefers-reduced-motion: reduce` emulation check: with it enabled, `main.js` never runs its tunnel code or dispatches `tunnel:armed` (it bails out before reaching that code, per Task 1), and separately `target-cursor.js` itself already bails out entirely under that media query (`target-cursor.js:98`) — confirm the cursor script doesn't even load/run visibly (no bracket at all), which is existing, unchanged behavior.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/tenta/OneDrive/Documents/Github/yerazik.com" && git add target-cursor.js && git commit -m "$(cat <<'EOF'
Release and exclude the wordmark from the target-cursor once it tunnel-zooms past 2x

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Tunnel progress off existing scroll read (Task 1 Steps 1-3) ✓; dev-tunable 4.8-9x knob (Task 1 Steps 5-6, 11-13) ✓; two easing-curve variants with runtime `F`-key A/B toggle and persistence (Task 1 Steps 1, 7-10) ✓; Apple-style two-layer smoothing — eased progress curve *and* frame-to-frame lerp of the painted values (Task 1 Step 3) ✓; transform/filter/opacity-only painting via CSS custom properties (Task 2) ✓; cursor exclusion/force-release at the 2x mark, reversible (Task 3) ✓; reduced-motion no-op (Task 1 Step 13.7, Task 2 Steps 2-3, Task 3 Step 3.6) ✓; out-of-scope items (picking a winner, touching `[data-r]` reveal/background parallax/other cursor targets) untouched by any task ✓.
- **Placeholder scan:** no TBD/TODO markers; every step has literal code or literal manual-check instructions.
- **Type consistency:** `tzIdx`/`TZ_VARIANTS`/`tzMax`/`tzScale`/`tzBlur`/`tzOpacity`/`tzArmed` are defined once in Task 1 Step 1 and referenced identically in every later step within Task 1; `--tz-scale`/`--tz-blur`/`--tz-opacity` are the same three names across Task 1 (producer) and Task 2 (consumer); `tunnel:armed` / `detail.armed` is the same event name and payload shape across Task 1 (producer) and Task 3 (consumer); `TARGET_SEL_NO_WORDMARK` and `wordmarkLocked` are defined and used only within Task 3, consistently.
