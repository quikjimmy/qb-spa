# Handoff: Ope Login Experience (Kin Home Ops)

## Overview
Premium, interactive login screen for the **Ope** app (Kin Home field-ops tool).
A full-bleed WebGL shader wallpaper sits behind a glass-morphic login card. The
wallpaper is a "topographic site survey" — pale blue contours over deep navy,
with a Kin-glyph cursor indicator that warps the elevation field. Clicks drop a
"pin" that pushes contours outward.

This is the user's first moment with the product each shift; it should feel
calm, alive, premium, and unmistakably _of the brand_.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes
showing intended look and behavior, **not production code to copy directly**.
Recreate these designs in the target codebase using its established patterns,
component library, and conventions (React, Vue, SwiftUI, native — whatever the
app is built in). If no framework is yet chosen, pick the one that fits the
rest of the Ope stack.

The HTML files use plain WebGL + React 18 via in-browser Babel — that's a
prototyping convenience, not a recommendation. Lift the GLSL shader source and
the visual specs; reimplement the React/HTML scaffolding idiomatically for your
stack.

## Fidelity
**High-fidelity.** Colors, typography, spacing, blur amounts, shadow values,
and shader parameters are all final. The animations and interactions are also
final — match them.

## Files in this bundle

| File | What it is |
|------|------------|
| `login-topo-reference.html` | Open in a browser — the live, full-bleed reference. Move your mouse, click. |
| `shader-base.jsx` | The WebGL host: compiles a frag shader, pumps `u_time` / `u_resolution` / `u_mouse` (eased) / `u_click` (xy + seconds since) / `u_pressed` uniforms. ~150 lines. |
| `shader-frags.jsx` | All 5 shader frag sources. **Use `FRAG_TOPO`** for production. The other 4 are kept here as reference; ignore them unless we ship variants. |
| `login-card.jsx` | The glass card overlay. Reference for layout, copy, and material. |
| `wallpaper.jsx` | Composes shader + card + chrome labels. Reference for stacking. |
| `design.md` | The full visual system: tokens, type, geometry, motion, voice. **Read this first.** |

## The Shader (the only novel piece)

The wallpaper is a single full-screen fragment shader. The complete GLSL
source is in `shader-frags.jsx` as `FRAG_TOPO`. Lift it verbatim — the math
is tuned. The shader requires the `OES_standard_derivatives` extension
(needed for `fwidth`); the host enables it before linking.

### Required uniforms

```glsl
uniform float u_time;        // seconds since mount
uniform vec2  u_resolution;  // px, includes DPR (cap DPR at 2)
uniform vec2  u_mouse;       // 0..1, EASED toward target with lerp ~0.08 per frame
uniform vec3  u_click;       // xy = last click in 0..1, z = seconds since click
uniform float u_pressed;     // 1 while pointer is held, else 0
```

**Critical**: `u_mouse` MUST ease toward the real pointer (not bind directly).
The premium feel comes from the smoothed trail. Reference impl in
`shader-base.jsx`:

```js
state.mouse[0] += (state.target[0] - state.mouse[0]) * 0.08;
state.mouse[1] += (state.target[1] - state.mouse[1]) * 0.08;
```

### Performance

- Pause `requestAnimationFrame` when `document.hidden`.
- DPR-cap at 2.
- If `prefers-reduced-motion: reduce`, render a static fallback instead — a
  pre-rendered PNG at 1px gradient, or a simple linear-gradient div in the
  brand palette. Do not run the shader.

### Reactions

| Input         | Effect |
|---------------|--------|
| Idle          | Slow ambient drift (fbm time term) — never frozen |
| Pointer move  | Cursor lifts elevation around it (gaussian bump). Kin glyph follows the cursor as the on-shader indicator. Major contours near cursor warm to amber. |
| Pointer click | Drops a sharper, decaying bump at click point. Decay constant `0.6` → fades over ~3s |
| Pointer down  | `u_pressed = 1` (currently unused by topo, but wire it for future-proofing) |

## The Login Card (overlay)

Sits centered over the shader. Single source of truth: `login-card.jsx` and
the wireframe in `design.md` § 3.

- **Width**: 380px on desktop. On narrow viewports, padding adjusts; card
  stays at min 320px.
- **Material**: `rgba(22,32,46,0.72)` (dark variant — used here because topo
  is a dark wallpaper) with `backdrop-filter: blur(22px) saturate(1.1)`.
- **Border**: 1px hairline at `rgba(255,255,255,0.08)`.
- **Radius**: 18px.
- **Shadow**: `0 30px 80px -30px rgba(0,0,0,0.45), 0 8px 30px -10px rgba(0,0,0,0.25)`.
- **Text color**: `#F4EDE4` (paper) for headings, `rgba(244,237,228,0.62)` for muted.
- **Inputs**: 42px tall, radius 10, bg `rgba(255,255,255,0.06)`, paper text.
- **Submit button**: 46px tall, radius 10, bg `#F4EDE4`, text `#16202E`, weight 600.
- **Copy** (final):
  - Eyebrow: `KIN HOME · OPE` (11px / 0.18em / uppercase / weight 600)
  - Title: `Welcome back`
  - Subtitle: `Sign in to continue your shift.`
  - Field labels: `EMAIL`, `PASSWORD` (11px / 0.08em / uppercase / weight 600)
  - Submit: `Sign in`
  - Footer: `Need access? Request an invite`

## Tokens (lift these into your design system)

```css
--kin-paper:        #F4EDE4;
--kin-paper-soft:   #EAE2D6;
--kin-ink:          #16202E;
--kin-ink-soft:     #2B384B;
--kin-mist:         #E5EAF5;
--kin-mist-deep:    #C8D2E6;
--kin-amber:        oklch(0.78 0.13 70);   /* ~ #F4BD70 */
--kin-amber-soft:   oklch(0.86 0.08 70);
```

Type stack: **Inter Tight** (400/500/600/700) for UI; **JetBrains Mono** (400/500)
for technical labels and any cursor-anchored chrome.

Radii: 10 (controls), 18 (cards), 28 (modals). 8px spacing grid.

## States to implement

| State    | Behavior |
|----------|----------|
| Idle     | Card fades in 600ms on mount. Shader runs from t=0. |
| Focus    | Input border darkens by ~50%. Caret blinks at 530ms. |
| Submit   | Button label → 3-dot loader. Card lifts 4px, shadow scales 1.2×. Shader unaffected. |
| Error    | Input border turns amber. Inline 12px message in `--kin-ink-mute` below the field. **No red.** |
| Success  | Card fades out 320ms; shader briefly accelerates (multiply time by 1.4× for 600ms) before route transition. |

Easing for all card/UI motion: `cubic-bezier(0.2, 0.8, 0.2, 1)`.
Durations: 180ms (micro), 320ms (state), 600ms (page).

## State management
- `email`, `password`, `submitting`, `error` — that's it.
- Auth flow per existing Ope auth provider (not specified here).
- Persist last-used email to localStorage; pre-fill on mount.

## Assets
- The Kin glyph appears (a) as an SVG inside the card eyebrow (see
  `KinGlyph` component in `login-card.jsx`), and (b) drawn in shader as the
  cursor indicator (signed-distance-field reconstruction in `FRAG_TOPO`).
  No external image assets — both are vector/procedural.
- Fonts: load from Google Fonts (or self-host equivalents).

## Beyond login
`design.md` § 4 lists other screens where this wallpaper system applies
(onboarding, shift start, success states). Do **not** put the shader behind
dense data screens (dashboards, tables, forms) — distracting. Use solid
`--kin-paper` or `--kin-ink-soft` there.

## Open questions to confirm with the design team
1. Reduced-motion fallback: which static gradient? (Recommend: linear-gradient
   from `#0F1722` to `#1B2940`, 160deg.)
2. Should the wallpaper acceleration on successful sign-in carry into the
   first dashboard frame, or hard-cut?
3. Does Ope have a brand-licensed copy of Inter Tight, or do we self-host
   from Google Fonts?

---

_Questions: re-open the source HTML (`login-topo-reference.html`) to feel the
real interaction. The shader source is all in `shader-frags.jsx` → `FRAG_TOPO`._
