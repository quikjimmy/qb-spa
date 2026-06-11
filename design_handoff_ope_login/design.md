# Ope · Visual Direction (handoff to claude-code)

> Design language for the **Ope** app (Kin Home Ops). Authored as a companion
> to the five interactive shader wallpapers in `Ope login wallpapers.html`.
> Pick one shader as the canonical wallpaper; the rest of this document
> applies regardless.

---

## 1 · Brand foundation

Ope is a tool for field operators at Kin Home. The login is the user's first
moment with the product each shift — it should feel premium, calm, alive,
and unmistakably _of the brand_. The mark (geometric house glyph) and the
bold KIN HOME wordmark anchor everything.

### Tokens

```css
:root {
  /* Neutrals (warm, paper-toned) */
  --kin-paper:        #F4EDE4;   /* primary background, off-white */
  --kin-paper-soft:   #EAE2D6;   /* secondary surface */
  --kin-paper-deep:   #D9CFBF;   /* hairlines on paper */

  /* Ink */
  --kin-ink:          #16202E;   /* primary text, primary buttons */
  --kin-ink-soft:     #2B384B;   /* secondary surfaces in dark mode */
  --kin-ink-mute:     rgba(22, 32, 46, 0.55);

  /* Cool accent (existing input field tone) */
  --kin-mist:         #E5EAF5;   /* input backgrounds, subtle chips */
  --kin-mist-deep:    #C8D2E6;

  /* Accents — single warm hue, used sparingly */
  --kin-amber:        oklch(0.78 0.13 70);   /* ~ #F4BD70 */
  --kin-amber-soft:   oklch(0.86 0.08 70);
}
```

**Usage rule**: paper + ink make 95% of the surface area. Mist is for inputs
and quiet UI tints. Amber appears only as a focal accent — interactive
state, the "near cursor" highlight, alerts. Never as decoration.

### Typography

| Role            | Family                | Weight | Notes                              |
|-----------------|-----------------------|--------|-------------------------------------|
| Display / H1    | Inter Tight           | 700    | -0.02em tracking, used at 28–48px  |
| UI / body       | Inter Tight           | 400/500| 14–16px                            |
| Labels / chips  | Inter Tight           | 600    | 11px, 0.08em uppercase             |
| Technical       | JetBrains Mono        | 400/500| Timestamps, codes, IDs, the chrome over wallpapers |

Avoid Inter (the regular cut) — Inter Tight reads as more architectural and
matches the heavy weight in the wordmark.

### Geometry

- **Corner radius**: 10 (inputs, buttons), 18 (cards), 28 (modals). Never pills.
- **Stroke**: 1px hairlines using `rgba(22,32,46,0.06)` on paper, `rgba(255,255,255,0.08)` on ink.
- **Grid**: 8px base, 4px for tight clusters.
- **Hard edges**: the brand mark has no curves. Lean into orthogonal layouts;
  decorative diagonals only at 30°, 45°, or 60° (the chevron angle).

---

## 2 · The wallpaper system

The login wallpaper is a **WebGL shader** that reacts to pointer position
and clicks. It sits behind a glass-morphic login card. Five directions exist
in the prototype; descriptions below so a developer can pick or extend.

| ID         | Name                  | Mood                         | Pointer reaction                                 | Click reaction              |
|------------|-----------------------|------------------------------|--------------------------------------------------|-----------------------------|
| `mercury`  | Liquid Mercury        | Dark, fluid, premium         | Cursor pulls a sheen + warm specular highlight   | Concentric ripple           |
| `topo`     | Topographic           | Dark, technical, cartographic| Cursor lifts elevation; amber crosshair tracks   | Drops a "pin" that bumps contours |
| `caustics` | Warm Caustics         | Light, optimistic, paper-lit | Cursor IS the lamp — caustics intensify          | Bright bloom                |
| `grid`     | Architectural Grid    | Light, branded, rhythmic     | Tile nearest cursor warms to amber               | Wave pulses through tiles   |
| `crystal`  | Crystal Facets        | Light, jewel-like            | Nearest facet glows; cursor adds gloss highlight | Shatters facets outward     |

### Recommended canonical pairing

- **Login & high-ceremony moments** (sign-in, password reset, "shift complete"
  hand-off, onboarding splash): use a **dark** shader (`mercury` or `topo`).
  These read as premium and let the warm card surface pop.
- **In-app moments** (empty states, success confirmations, "tap to continue"
  micro-screens): use a **light** shader (`grid` or `caustics`) — keeps
  cognitive temperature low while still feeling alive.

### Implementation contract

The shader host accepts these uniforms (already in the prototype):

```glsl
uniform float u_time;        // seconds since mount
uniform vec2  u_resolution;  // px, includes DPR
uniform vec2  u_mouse;       // 0..1, eased toward target with ~0.08 lerp
uniform vec3  u_click;       // xy = last click in 0..1, z = seconds since
uniform float u_pressed;     // 1.0 while pointer is down
```

- Mouse must ease (don't bind directly) — premium feel comes from the trail.
- Always include a slow ambient motion (fbm time term ~0.04–0.3) so the
  wallpaper is never frozen, even when idle.
- Click effects must decay within ~2 seconds — they're punctuation, not state.
- DPR-cap at 2 to avoid melting low-end laptops.

### Performance budget

- Single full-screen fragment shader, ≤ 256 ALU ops per pixel.
- Pause rendering when the document is `hidden`.
- Replace shader with a static gradient screenshot if `prefers-reduced-motion`
  is set.

---

## 3 · Login card (overlay over the shader)

The card on top of the wallpaper is the only interactive surface at sign-in.
Keep it tight.

```
┌─ glass card, 380×auto, radius 18, blur 22px ─────────┐
│  ▲ KIN HOME · OPE          (11px / 0.18em / uppercase)│
│                                                       │
│  Welcome back               (30px / 700 / -0.02em)    │
│  Sign in to continue your shift.   (14px / mute)      │
│                                                       │
│  EMAIL                                                │
│  ┌───────────────────────────────────────────────┐    │
│  │ james@kinhome.com                             │    │
│  └───────────────────────────────────────────────┘    │
│  PASSWORD                                             │
│  ┌───────────────────────────────────────────────┐    │
│  │ ••••••••••••                                  │    │
│  └───────────────────────────────────────────────┘    │
│                                                       │
│  ┌─ Sign in ────────────────────────────────────┐     │
│  │       (46px tall, ink bg, paper text)        │     │
│  └──────────────────────────────────────────────┘     │
│                                                       │
│  Need access? Request an invite     (12px / mute)     │
└───────────────────────────────────────────────────────┘
```

- **Material**: `rgba(255,253,250,0.82)` with `backdrop-filter: blur(22px) saturate(1.1)`.
  Over a dark shader, swap to `rgba(22,32,46,0.72)` and invert text/button colors.
- **Shadow**: `0 30px 80px -30px rgba(0,0,0,0.45), 0 8px 30px -10px rgba(0,0,0,0.25)`.
- **Border**: 1px hairline at 6% ink (light) or 8% paper (dark).
- **Adapts to wallpaper**: pick `tone="light"` or `tone="dark"` based on the
  chosen shader's avg luminance.

### Card states

- **Idle**: card floats, shader runs. Subtle 600ms fade-in on mount.
- **Hover input**: hairline stroke on the input darkens by ~50%; caret blink at 530ms.
- **Submit**: button label swaps to a 3-dot loader, ink bg slightly desaturates,
  card lifts 4px with a 1.2× shadow.
- **Error**: input row stroke turns to amber; small inline message below the field
  in 12px ink-mute. No red — amber carries enough warning weight.

---

## 4 · Beyond login (where else this system applies)

The wallpaper isn't decoration; it's a **stage**. Use it sparingly on screens
where the user is _between actions_ — never behind dense data.

| Screen                      | Treatment                                                |
|-----------------------------|----------------------------------------------------------|
| Login / lock                | Full-bleed shader + glass card                           |
| Onboarding (first 3 steps)  | Full-bleed shader, card scrolls vertically               |
| Shift start ("Good morning")| Static screenshot of `mercury` for 600ms, then animates  |
| Shift complete              | `caustics` light bloom triggered on completion           |
| Empty states                | Quarter-screen `grid` panel, paper card overlay          |
| Error / 500                 | `mercury` dark, amber accent in card                     |
| Auth / 2FA                  | Same as login                                            |

In dense workspace screens (dashboards, task lists, forms), the shader
**must not** appear behind content — it's distracting. Use solid `--kin-paper`
or `--kin-ink-soft` instead, with the brand glyph as a small static header
mark.

---

## 5 · Motion principles

- **Easing**: cubic-bezier(0.2, 0.8, 0.2, 1) for UI; pointer follow uses
  exponential ease (lerp 0.08).
- **Durations**: 180ms (micro), 320ms (state changes), 600ms (page transitions).
- **No bouncing.** Ope is for working professionals; springs feel toy-like.
- **One motion at a time** in any 200ms window — if the shader is reacting
  to a click, the card should not also animate.

---

## 6 · Voice

Concise, warm, declarative. Address the user as a teammate, not a customer.

- ✅ "Welcome back."
- ✅ "Sign in to continue your shift."
- ✅ "Need access? Request an invite."
- ❌ "Hello there! 👋 Please sign in below to access your account."

Time of day is fair game ("Good morning, James"). Project status is fair game
("3 sites on your route today"). Marketing fluff isn't.

---

## 7 · Open questions / next decisions

1. **Pick a canonical shader** for production login (recommend `mercury`).
2. Decide whether to ship 2 (light + dark) variants or just one.
3. Confirm font licensing for Inter Tight + JetBrains Mono.
4. Do we want the wallpaper to remember the user's last cursor path between
   sessions? (Cute but probably overkill.)
5. Reduced-motion fallback: which static gradient is canonical?

---

_Companion artifact: `Ope login wallpapers.html` — open and click into any
artboard to feel the interactions. Source shaders live in `shaders/shader-frags.jsx`._
