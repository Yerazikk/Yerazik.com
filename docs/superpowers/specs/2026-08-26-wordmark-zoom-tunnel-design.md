# Wordmark zoom tunnel

## What

When the visitor starts scrolling away from the top of the page, the "Yerazik"
wordmark punches into a hyperscale close-up (4.8x-9x, dev-tunable) and blurs /
fades out over the first ~45vh of scroll, instead of just sliding up with the
rest of the hero. The custom target-cursor bracket stops treating the
wordmark as a target once it passes ~2x scale, and releases it if latched at
that point. Effect fully reverses if the visitor scrolls back to the top.

Two visual variants, switchable at runtime for A/B comparison, no winner
picked yet.

## Mechanics

**Progress.** `main.js`'s existing scroll render loop computes
`t = clamp(scrollY / TUNNEL_RANGE, 0, 1)`, `TUNNEL_RANGE` ~= 45vh. This piggybacks
on the scroll value already being read every frame - no new listeners.

**Apple-style smoothing - two layers of easing, not one:**
1. `t` is pushed through an easing curve before use (per variant, see below) -
   shapes *how* progress maps across the scroll range.
2. The scale/blur/opacity numbers derived from eased-`t` are then chased
   frame-to-frame with the same `lerpK` frame-rate-independent lerp already
   used for scroll position (`EASE` in `main.js`) and cursor position
   (`target-cursor.js`). This is what gives the motion weight/momentum instead
   of tracking the scrollwheel 1:1 - a fast flick or jerky trackpad scroll
   still glides smoothly toward the target values rather than snapping.

Only transform/opacity/filter are touched, same painting style as the rest of
the site (numbers computed in JS, written as CSS custom properties, no calc()
easing in CSS).

**Dev knob.** New slider in the existing dev panel (press T), "Tunnel zoom",
min 4.8 max 9, same min/max/step/val/fmt shape as the current knobs (e.g.
"Hero size"). Sets the scale `.wordmark` reaches at eased-`t` = 1. Persisted
via the existing `save()`/`restore()` localStorage roundtrip.

**Variants**, cycled with a new key (`F`, following the `Z/X` font-cycle and
`B` bg-cycle convention), persisted the same way:
- **Warp** (default): fast ease-out curve on `t`, heavy blur ramp, opacity
  drops early - reads as rocketing through a tunnel.
- **Snap**: gentler/more even ease on `t`, blur and opacity stay near-sharp
  until ~80% progress then cut hard - reads as a fast focus-pull followed by
  a cut, not a rush.

**Cursor integration.** `main.js` toggles `body.tunnel-armed` once
eased-`t` crosses the ~2x-scale point. `target-cursor.js`:
- listens for the class change (mirrors the existing `dev:mode` custom-event
  pattern already used for the dev panel/cursor handoff),
- excludes `.wordmark` from its target selector while armed,
- force-unlatches immediately if `.wordmark` is the current target when arming
  happens.
Un-arms (and the wordmark becomes targetable again) once scroll returns below
the threshold - fully reversible, no dead state.

**Accessibility.** Effect and the `F` key are both no-ops under
`prefers-reduced-motion: reduce`, matching how `main.js` and
`target-cursor.js` already bail out for that media query.

## Out of scope

- Picking a winning variant - both ship, switchable, until the site owner
  decides.
- Any change to the existing hero fade-in (`[data-r]` reveal), background
  parallax, or non-wordmark cursor targets.
