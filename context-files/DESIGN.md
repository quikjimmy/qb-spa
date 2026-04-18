# Design System Specification: The Architectural Archive

## 1. Overview & Creative North Star
**Creative North Star: "The Architectural Archive"**
This design system rejects the clinical, "white-box" aesthetic of traditional SaaS. Instead, it draws inspiration from high-end architectural monographs and vintage editorial layouts. It is masculine, grounded, and authoritative. 

The goal is to move beyond the template look by utilizing **intentional asymmetry** and **tonal depth**. Rather than containing data within rigid boxes and borders, we treat the CRM interface as a series of layered "sheets" of fine paper and heavy stone. We prioritize "The Digital Curator" persona: a system that feels curated, not just calculated. High-contrast typography scales and overlapping surfaces break the horizontal monotony, creating a rhythm that guides the user through complex CRM workflows with a sense of calm stability.

## 2. Colors
This system follows a strict 60-30-10 distribution to ensure a balanced, premium atmosphere.

*   **Primary (60%): Stability & Depth.** Use `primary` (#182425) and `primary_container` (#2D3A3A) for sidebars, primary navigation, and heavy structural elements. This deep forest-slate provides a "safe" foundation for sensitive data.
*   **Secondary (30%): Grounded Neutrals.** Use `surface` (#FAFAF5) and `secondary_container` (#E1E1D2). These warm, soft neutrals prevent the interface from feeling cold or purely "tech."
*   **Accent (10%): The Purposeful Pop.** Use `tertiary_container` (#632300) and its variants for CTAs and status indicators. This muted terracotta provides a sophisticated focal point without the "alarmist" feel of standard red/orange.

### The "No-Line" Rule
**Explicit Instruction:** Designers are prohibited from using 1px solid borders for sectioning content. Boundaries must be defined solely through background color shifts. For example, a `surface_container_low` card sitting on a `surface` background creates a natural, sophisticated edge. 

### Surface Hierarchy & Nesting
Treat the UI as a physical stack of materials. 
*   **Base:** `surface` (The foundation).
*   **Mid-tier:** `surface_container` (Content groupings).
*   **High-tier:** `surface_container_highest` (Interactive cards or active states).
By nesting these tones, we create "depth-through-color" rather than "depth-through-lines."

### The "Glass & Gradient" Rule
To elevate the "Retro-modern" feel, use **Glassmorphism** for floating elements (like modals or filter bars). Apply a semi-transparent `surface_variant` with a 20px backdrop-blur. For main Hero actions, use a subtle radial gradient transitioning from `primary` to `primary_container` to add "soul" and professional polish.

## 3. Typography
We utilize **Inter** as our sole typeface, relying on extreme weight and scale variance to provide editorial authority.

*   **The Display Scale:** Use `display-lg` and `display-md` for high-level dashboard summaries (e.g., Total Revenue). This creates a "magazine header" feel that feels custom and expensive.
*   **The Headline Scale:** `headline-sm` should be used for section titles, always paired with generous top-padding to let the content breathe.
*   **The Body Scale:** `body-md` is the workhorse for CRM data. Use `on_surface_variant` for secondary metadata to maintain a clear hierarchy against the `on_surface` primary text.
*   **Label Precision:** `label-sm` is reserved for technical data tags and micro-copy. These should be set in uppercase with slightly increased letter-spacing (+2%) to lean into the "Retro-modern" aesthetic.

## 4. Elevation & Depth
In this design system, shadows are a last resort, not a default. We convey hierarchy through **Tonal Layering**.

*   **The Layering Principle:** Depth is achieved by stacking the surface-container tiers. Placing a `surface_container_lowest` card on a `surface_container_low` section creates a soft, natural lift.
*   **Ambient Shadows:** If a floating effect is required (e.g., a dropdown menu), shadows must be extra-diffused. Use a 30px-40px blur at 6% opacity, using the `primary` color as the shadow tint rather than pure black. This mimics natural ambient light.
*   **The "Ghost Border" Fallback:** If a border is strictly necessary for accessibility, use the `outline_variant` token at **15% opacity**. High-contrast, 100% opaque borders are strictly forbidden.
*   **Glassmorphism Depth:** Floating navigation rails should use a semi-transparent `surface` color with a backdrop blur. This allows the primary brand colors to bleed through subtly, making the layout feel integrated and "liquid."

## 5. Components

### Buttons
*   **Primary:** `primary` background with `on_primary` text. 8px (`DEFAULT`) roundness. No border.
*   **Secondary:** `secondary_container` background. 
*   **Tertiary (Accent):** `tertiary_container` with `on_tertiary_container`. Use this exclusively for "Final Actions" (Save, Submit, Upgrade).

### Input Fields
*   **Style:** Background-filled using `surface_container_highest`. 
*   **Focus State:** A 2px "Ghost Border" using the `surface_tint` at 40% opacity. 
*   **Rounding:** Strictly 8px (`DEFAULT`) to maintain the "soft-modern" look.

### Cards & Lists
*   **The Container:** Use `surface_container_low`. 
*   **The Rule:** **Forbid the use of divider lines.** Separate list items using 12px of vertical white space or a subtle hover state shift to `surface_container_high`.
*   **Header Overlap:** For a signature look, allow card headers or "chips" to slightly overlap the edge of their container, breaking the "contained" feel.

### The "Insight Rail" (Custom Component)
A vertical slide-out panel for CRM contact details. It should use `surface_bright` with a heavy backdrop-blur on the main content behind it, emphasizing focus through "blurred distance" rather than just a dark overlay.

## 6. Do's and Don'ts

### Do:
*   **Do** use the 60-30-10 rule to ensure the deep `primary` colors don't overwhelm the user.
*   **Do** use asymmetrical margins (e.g., a wider left margin than right) in report views to mimic high-end editorial design.
*   **Do** use `headline-lg` for empty states to make them feel like a conscious design choice rather than an error.

### Don't:
*   **Don't** use 1px #CCCCCC or #EEEEEE borders to separate content. Use tonal shifts.
*   **Don't** use standard "Web Blue" for links. Use `primary` with a 2px underline in `tertiary_fixed_dim`.
*   **Don't** use sharp 0px corners or hyper-round 50px corners. Stick to the **8px (`DEFAULT`)** and **16px (`lg`)** scale for consistency.
*   **Don't** crowd the interface. If a screen feels "busy," increase the background `surface` space rather than adding more dividers.