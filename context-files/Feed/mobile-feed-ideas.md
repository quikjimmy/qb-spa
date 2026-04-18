# Design System Specification: The Editorial Muse

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Digital Curator."** 

Moving beyond the generic "feed" layout, this system treats social media as a high-end digital editorial. We are moving away from the "app-in-a-box" aesthetic toward a sophisticated, breathing canvas. By utilizing intentional white space, rhythmic asymmetry, and a focus on high-fidelity imagery, we elevate user content from "posts" to "exhibits." This system breaks the rigid grid through overlapping elements and tonal depth, ensuring the interface feels like a premium gallery rather than a utility.

---

## 2. Colors: Tonal Depth over Borders
The palette is built on a foundation of purity, punctuated by high-energy accents.

### The Foundation
- **Primary Background (`surface-container-lowest`):** `#FFFFFF`. This is the canvas. Use it to provide maximum "pop" for photographic content.
- **Secondary Surfaces (`surface`, `surface-container-low`):** `#F6F6F6` to `#F0F1F1`. Used to create soft, logical divisions without harsh lines.

### The "No-Line" Rule
**Borders are prohibited for sectioning.** To define a boundary, use a background color shift. For example, a "Stories" tray should not have a bottom border; instead, place the tray on a `surface-container-low` background (`#F0F1F1`) while the main feed remains on `surface-container-lowest` (`#FFFFFF`). 

### Glass & Gradient Mastery
- **The Signature Gradient:** Transitioning from `primary` (#B6004F) to `tertiary-container` (#FF9742). This vibrant pink-to-orange-to-purple energy is reserved for interaction peaks: active story rings, primary CTAs, and "Like" states.
- **Glassmorphism:** For floating navigation or modals, use `surface-container-lowest` at 80% opacity with a `20px` backdrop blur. This ensures the interface feels integrated and airy.

---

## 3. Typography: The Editorial Voice
We use **Inter** exclusively, relying on its mathematical precision and neutral character to let the content lead.

- **Display (display-lg/md):** Reserved for high-impact editorial moments or profile milestones. Use `display-md` (2.75rem) with tight letter spacing (-0.02em) for a "magazine" feel.
- **Headline (headline-sm):** Used for section titles. `1.5rem` with a Semi-Bold weight.
- **Title (title-sm):** The standard for usernames and metadata headers. `1rem` Medium.
- **Body (body-md):** The workhorse for captions and comments. `0.875rem` Regular.
- **Labels (label-sm):** For timestamps and secondary metrics. `0.6875rem` Medium, uppercase with +0.05em tracking for architectural clarity.

---

## 4. Elevation & Depth: The Layering Principle
Depth is conveyed through **Tonal Layering** rather than structural lines.

- **Nesting Hierarchy:** Treat the UI as stacked sheets of fine paper. 
    - Base: `surface` (#F6F6F6)
    - Card: `surface-container-lowest` (#FFFFFF)
    - Overlays/Tooltips: Glassmorphic layers with `surface-tint`.
- **Ambient Shadows:** When an element must "float" (e.g., a floating action button), use an extra-diffused shadow: `0px 20px 40px rgba(45, 47, 47, 0.06)`. Avoid dark, heavy shadows; the goal is a soft, natural lift.
- **The "Ghost Border" Fallback:** If a UI element (like an input field) risks disappearing, use a "Ghost Border": `outline-variant` (#ACADAD) at **15% opacity**.

---

## 5. Components: Minimalist Primitives

### Buttons
- **Primary:** Filled with the Signature Gradient. White text (`on-primary`). 
- **Secondary:** `surface-container-high` (#E1E3E3) background with `on-surface` text.
- **Tertiary:** Text-only with the `primary` (#B6004F) color for high-priority actions or `secondary` for utility.

### Cards & Feed Items
- **Shape:** Use the `xl` (1.5rem / 24px) or `lg` (1rem / 16px) corner radius for image containers to match the "Soft Minimalist" aesthetic.
- **Spacing:** Forbid divider lines between posts. Use a generous `32px` vertical gap (White Space) or a subtle shift to `surface-container-low` to separate content blocks.

### Selection Chips
- Use the `full` (9999px) roundedness scale. Active states should use a subtle `primary-container` (#FF7196) tint with `on-primary-container` (#4D001D) text.

### Input Fields
- **Style:** No solid borders. Use a `surface-container-highest` (#DBDDDD) fill with a `md` (12px) corner radius. On focus, transition the background to `white` and add a 1pt "Ghost Border" at 20% opacity.

---

## 6. Do’s and Don’ts

### Do:
- **Do** use intentional asymmetry. Let a profile image slightly overlap a header background to create depth.
- **Do** prioritize "Breathing Room." If you think a section needs more space, double the padding.
- **Do** use the `primary` gradient for "Active" states (e.g., an unread story or a clicked heart).

### Don't:
- **Don't** use 1px solid black or dark grey lines. They clutter the editorial feel.
- **Don't** use high-contrast drop shadows. They make the UI feel dated and "heavy."
- **Don't** crowd the imagery. Captions should have clear margins (at least `16px`) from the edge of the image container.
- **Don't** use standard blue for links. Use the `primary-dim` (#A00045) or the signature gradient to maintain brand soul.