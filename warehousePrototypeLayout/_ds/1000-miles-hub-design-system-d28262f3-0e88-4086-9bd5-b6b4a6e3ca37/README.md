# 1000 Miles Hub — Design System

Internal design system for **1000 Miles Hub**, the operations platform used by 1000 Miles Limited (B2B OEM gift & novelty manufacturer with offices in the Philippines and Yiwu, China).

**Live system:** https://hub.1000miles.site (SSO-gated — Microsoft login)
**Stack:** Next.js + Supabase, deployed on Vercel.

---

## What the Hub covers

The Hub is a single, multi-tenant workspace for several operations teams. It is **internal-only**, utilitarian, and optimised for data density over marketing polish.

| Team | What they do in the Hub |
|---|---|
| **Amazon Sellers** (BSCOOL · Popcraze · Presparo · Liladora) | Product listings, ASIN dashboards, PPC campaigns, keyword research, ACOS monitoring |
| **OEM Sales** | Vendor pricing requests, quotes, copyright clearance, sample tracking |
| **Brand Sales** | Account management, order pipelines, client comms |
| **Product Development (Nexus)** | Product concepting, spec sheets, tooling, cost rollups |
| **All teams** | Workflow cards, process guides (step tables + SVG diagrams), MCP-integrated tools |

Core UI primitives across all surfaces: **workflow cards**, **data tables with smart-search / filters**, **wizards**, **process guide documents** (numbered step tables + SVG process diagrams), **sidebar + top-header app shell**.

---

## Sources used to build this system

All source material was provided as attachments in this project — no external access was needed.

| File | What it contains |
|---|---|
| `uploads/ds-foundations.html` | Colors, type, spacing, radii, shadows, core tokens |
| `uploads/ds-components.html` | Buttons, badges, inputs, modals, toasts, alerts, tabs, wizards |
| `uploads/ds-navigation.html` | Sidebar, top bar, breadcrumbs, pagination |
| `uploads/ds-data.html` | Data tables, gallery/card views, calendar, charts, KPI tiles |
| `uploads/ds-patterns.html` | Composite patterns: full wizards (ASIN listing), hero strips, stat chips |
| `uploads/logo.png` | Wordmark (413×62, transparent) |
| `hub.1000miles.site` | Live site — SSO-gated, only login page visible to fetch |

The five `ds-*.html` files all ship the **same `:root` token block** — that block is the canonical source for `colors_and_type.css`.

---

## Files in this root

| Path | Purpose |
|---|---|
| `README.md` | This file |
| `SKILL.md` | Entry point when this system is installed as an Agent Skill |
| `colors_and_type.css` | Canonical CSS variable layer — colors, type scale, spacing, radii, shadows |
| `assets/` | Logo + any raster/vector brand assets |
| `fonts/` | Montserrat TTFs (Thin → Black, + italics) — self-hosted via `@font-face` |
| `preview/` | Design-system preview cards (one concept each) |
| `ui_kits/hub/` | High-fidelity React recreation of Hub screens |
| `slides/` | *(not created — no slide template was provided)* |

---

## CONTENT FUNDAMENTALS

The Hub is an **internal business tool for a manufacturing company**. Copy is direct, noun-forward, and assumes the reader knows the domain (ASIN, ACOS, FBA, COGS, SKU, MAP, OEM, MCP). Nothing is hand-holding — this is not a consumer app.

### Voice & tone
- **Utilitarian, professional, slightly dry.** No exclamation points. No playful copy. No marketing language.
- **Imperative and labelling.** UI labels are nouns or short verbs: "Pricing", "Keywords", "Save as Draft", "Publish Listing", "Add Vendor".
- **"You" is used sparingly**, only for direct instructions: *"Click 'Publish Listing' to go live on Amazon."* The default is objective / neutral voice: *"Sale Price", "FBA Fee (estimated)", "Auto-calculated from weight & size tier."*
- **First-person plural ("we") is avoided.** It's a tool, not a brand voice.
- **Domain jargon is expected and uppercased:** ASIN, SKU, ACOS, COGS, FBA, MAP, OEM, PPC.

### Casing
- **Title Case** for page titles, wizard step names, modal titles, buttons: *"Create New Product Listing"*, *"Save Changes"*, *"Edit Product"*.
- **Sentence case** for helper / hint text: *"10-character Amazon Standard ID"*, *"Auto-calculated from weight & size tier."*
- **UPPERCASE** for:
  - Eyebrow / overline labels in forms and cards (`.eyebrow`, `.overline` — 11px, letter-spacing .08em)
  - Table column headers (tracked, muted grey)
  - Status tags when used as badges ("LIVE", "DRAFT", "ARCHIVED")
- Brand names keep their house casing: **BSCOOL**, **Popcraze**, **Presparo**, **Liladora**, **Nexus**.

### Punctuation & formatting
- **No terminal punctuation on labels, buttons, chips, or table cells.**
- Full sentences in help text and alerts end with a period.
- Required-field marker: red asterisk (`*`).
- Progress indicators use `›` and `‹` instead of arrows (`→` / `←`) — matches live patterns: *"Next: Pricing ›"*, *"‹ Back"*.
- Currency always shown with symbol prefix + 2 decimals: `$12.99`. Percentages: `28%`.
- Step counts are spelled out: *"Step 1 of 4"*, *"Step 1 of 4 — Basic Info"* (em-dash connector).

### No emoji in copy
Emoji appear **only** as large decorative glyphs in the design-system reference pages themselves (🎨 Foundations, 🧩 Components, 📊 Data Display, 🧭 Navigation, 📋 Patterns) — **not** in the actual product UI. Product surfaces use SVG icons or unicode `›` `‹` `×` for controls. Don't sprinkle emoji in mocks.

### Examples (verbatim from the source)
- Wizard header: *"Create New Product Listing"* / *"Complete all steps to publish your product to Amazon"*
- Helper text: *"10-character Amazon Standard ID"* · *"15% of sale price for Toys & Games."* · *"Hidden keywords — max 250 bytes, no repetition."*
- Alert: *"Ready to publish — All required fields are complete. Click 'Publish Listing' to go live on Amazon."*
- Destructive modal: *"This will permanently remove **B09FL9KRY4** and all its associated data. This action cannot be undone."*
- Empty dropdown: *"Save as Draft"* (ghost button, muted colour, small size)

The vibe: **"operations runbook rendered as software"** — crisp, factual, competent.

---

## VISUAL FOUNDATIONS

The Hub sits in a specific design niche: it's clean and modern like a SaaS admin, but it's **not** playful, not illustrative, and not brand-heavy. Think Linear / Notion admin panels × Airtable × shadcn/ui — with a distinctive **teal primary**.

### Colors
- **Primary teal `#00BCD4`** is the signature. Used for: primary CTAs, active nav state (paired with `#e0f7fa` info-bg), focus rings (rgba 0,188,212,0.12), selected rows, links, the "active step" ring in steppers.
- **Primary dark `#008A9C`** is the pressed / on-tint text colour — it pairs with info-bg so text is readable on the light teal wash.
- **Violet `#7C3AED`** is a secondary accent — used sparingly for a second category of CTA (e.g. "secondary brand" buttons), calendar event colouring, and hero gradients.
- **Yellow `#FFD60A`** is a rare accent — only on `btn-accent` and highlight badges. Do not overuse.
- **Neutrals are gentle greys**, not slate-blue: pure hex whites and greys (`#fafafa` surface, `#f5f5f5` secondary, `#e5e5e5` border, `#737373` muted, `#0a0a0a` foreground). Avoid tinted greys.
- **Semantic** (success/warning/error/info) always ships in two variants: saturated colour + matching tinted-bg + border.

### Typography
- **Montserrat** is the sole typeface. Weights used: 400 (body), 500 (links / medium labels), 600 (semibold — H4–H6, buttons, nav), 700 (bold — H1–H3, badges).
- **No serif, no display face, no script.** If a swap is needed, nearest fallback is `ui-sans-serif, system-ui, sans-serif`.
- **Courier New / JetBrains Mono** appears only in table meta columns, code blocks, and hex-value labels — never in UI copy.
- Type scale is 7 display + 5 body sizes (see `colors_and_type.css`). Headings tighten letter-spacing (−1px on d2xl, −0.5 on dxl). Body text never goes below 12px in UI.

### Spacing & layout
- **4px base grid.** Tokens: 4, 8, 12, 16, 24, 32, 48.
- Card padding defaults to 16px; section gaps to 24–48px.
- Cards and tables live on a **page background of `#f0f0f0` or `#f6f6f6`** (the darker "content area" grey) — cards are pure white. This is why card edges get a `box-shadow: 0 0 0 1px rgba(0,0,0,0.08)` — to lift off the grey.
- **Max content widths are generous** (tables and wizards span full container); data density is prioritised.

### Backgrounds
- **No imagery, no illustrations, no gradients as page bgs.** The live product is flat neutrals.
- **Gradients are reserved for hero strips** — teal `#00BCD4 → #008A9C`, violet `#7C3AED → #4C1D95`, dark `#1D2939 → #0C111D` — and only in promotional / section-intro areas, not as page wallpaper.
- **No patterns, no textures, no grain, no noise.**
- **No full-bleed photography.** The only images in the system are product thumbnails inside data-table `td-img` cells (40×40 rounded square on grey fallback).

### Radii
- Scale: 4 / 8 / 10 / 14 / 20 / 26px (pill).
- **10px (md)** is the default for inputs and small surfaces.
- **14px (lg)** is the default for cards, modals, sidebar, side-panels.
- **20px (xl)** only for modals (warm, dialog feel).
- **26px pill** for badges, chips, and toc/pill tabs.
- Buttons use **8px (sm)** — visibly less rounded than cards.

### Shadows & elevation
A 4-step elevation system:
- `xs` — for app-header only
- `sm` — cards, toc, ds-tabs bar
- `md` — toasts, modals, sidebar, hover-lifted gallery cards
- `lg` — dropdowns, popovers, search dropdown
- Cards often layer **shadow-sm + a hairline 1px ring** (`box-shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)`) — this is a signature.

### Borders
- 1px solid `--color-border (#e5e5e5)` for every divider, card outline, input.
- 2px solid where emphasis is needed: table `thead` underline, stepper connector, active tab underline (primary colour).
- Destructive / success / info variants override the border colour, keep the 1px weight.

### Hover & press states
- **Buttons:** `opacity: 0.85` on hover, `transform: scale(0.97)` on active. No colour change by default.
- **Outline / ghost buttons:** hover flips to `background: var(--color-secondary)` (subtle grey fill) and keeps full opacity.
- **Nav items:** hover → `background: var(--color-surface)`; active → `background: var(--color-info-bg)` with `color: var(--color-primary-dk)`.
- **Table rows:** hover → `background: var(--color-surface)`; selected → `background: var(--color-info-bg)`.
- **Cards:** hover lifts shadow (`shadow-md`) and sometimes `transform: translateY(-1px)`.
- **Links:** no underline; colour shifts to `--color-primary-dk` on hover.

### Animation & easing
- **Short and quiet.** `transition: all .15s` is the universal duration — no cubic-bezier custom easing, just the browser default.
- `.2s ease` is used for sidebar collapse / expand — the one place where length is noticeable.
- **No bouncy, no spring, no staggered entrances.** The product does not celebrate.
- Skeletons use a simple 1.5s linear shimmer.
- Spinners use a 0.7s linear rotation.

### Transparency & blur
- **Transparency is used inside gradient heroes** — white text on a `rgba(255,255,255,0.12)` eyebrow chip.
- **No backdrop-blur effects anywhere.** Modals use a flat `rgba(0,0,0,0.45)` scrim.
- Focus rings use rgba-teal at 12% alpha.
- No glassmorphism.

### Fixed / sticky elements
- **Sidebar is fixed full-height**, collapsible (220px ↔ 56px).
- **App header is fixed at top**, 52px tall, white card w/ `shadow-xs`, sits inside the content column (not the sidebar column).
- Wizard footers are sticky — always visible on long forms.
- Modals and toasts float above.

### Imagery colour vibe
- The Hub **has almost no imagery**. When product photos appear (Amazon listings), they are shown as-is — manufacturer photography, typically bright-neutral studio shots on white backgrounds. No filter, no colour grading, no b&w treatment.

### Data density
- Tables prefer **row height 40–44px**, padding `10px 16px`. Compact but never cramped.
- Numbers are **tabular-nums, right-aligned**, in the base Montserrat (no separate mono face for numbers — matches the live CSS: `td.td-num { font-family: var(--font-family); }`).

---

## ICONOGRAPHY

The Hub uses a **pragmatic mix** — this is visible directly in the source DS files.

### What's actually in the live code
1. **Inline SVG icons**, drawn 14–16px, stroke-based, 1.5–2px stroke weight, `currentColor` fill / stroke so they theme automatically. This is the dominant pattern — seen in toolbar buttons, nav items, status chips, search bar, view switchers, chart-type buttons.
2. **Unicode glyphs** used as micro-controls when an SVG is overkill:
   - `›` `‹` — forward / back (wizard footer, breadcrumbs)
   - `×` — modal close
   - `✓` — selected view option checkmark
   - `▾` — select-dropdown chevron (as an inlined SVG data-URL)
3. **Emoji** appear **only in decorative / categorical positions**, never as functional controls:
   - 🎨 🧩 📊 🧭 📋 — section headers in the DS docs themselves (not product UI)
   - 🗑 ℹ️ — occasionally in modal / alert icon slots (substitute an SVG in real product screens)
4. **Brand wordmark** — `assets/logo.png` (413×62, transparent PNG). No separate icon-only mark in the source; the sidebar uses a **solid teal rounded square with "1000M" text inside** as a compact logo tile.

### No icon font
There is **no custom icon font** and **no embedded icon sprite** in the source DS files — all icons are hand-rolled inline SVGs. When building new screens, either:
1. Copy the exact SVG markup from `uploads/ds-components.html` / `ds-data.html` / `ds-navigation.html`, or
2. **Substitute with [Lucide Icons](https://lucide.dev) from CDN** — their visual vocabulary (outline-only, 2px stroke, 24-pixel-grid, rounded linejoins) is the closest off-the-shelf match. Load with:
   ```html
   <script src="https://unpkg.com/lucide@latest"></script>
   ```
   **⚠️ This is a substitution** — the live Hub uses custom inlined SVGs, not Lucide. Flag to the user if pixel-perfect fidelity is required.

### What to avoid
- **Filled / glyph-style icons** (Material filled, Heroicons solid) — these clash with the outline-stroke vocabulary.
- **Colourful / multi-tone icons** (Fluent, Noto) — the Hub is monochromatic; icons always inherit `currentColor`.
- **Emoji for functional UI.** Keep them in documentation only.

---

## BSCOOL BRAND CHARACTERS

**BSCOOL** (one of the four Amazon brands) has a cast of signature **fashion-illustration caricatures** — stylised full-body character art in a kids'/tween fashion-doll aesthetic, plus a **kitten mascot**. They appear on BSCOOL packaging, listing imagery, and activity-book product lines, and double as friendly account/persona avatars inside Hub surfaces.

### The cast

The girls — 13 individual **transparent PNGs** in `assets/bscool-characters/`:

`gaby` · `isabella` · `emma` · `mia` · `eva` · `clara` · `jamila` · `layla` · `charlotte` · `sofia` · `yuna` · `aria` · `dani`

The **kitten mascot** — the brand's animal companion, in 3 poses:

`kitten-cream` (sitting, beige) · `kitten-grey` (sitting, grey tabby) · `kitten-white` (waving, white)

Each is a full-figure illustration on a transparent background, trimmed to the artwork (name labels removed, neighbouring-figure fragments cleaned out).

### Source files
- `uploads/Final_all.png` — 7 girls (Jamila, Layla, Charlotte, Sofia, Yuna, Aria, Dani), native transparency, ~5077px wide (high-res).
- `uploads/Screenshot 2026-07-10 at 9.54.46.png` — 6 girls (Gaby, Isabella, Emma, Mia, Eva, Clara), on white; background knocked out via edge flood-fill (interior whites in clothing preserved).
- `uploads/kitten 1.png` · `kitten 3.png` · `kitten 5.png` — kitten poses, native transparency (only margin-trimmed).

### Usage
- **Full-body:** packaging mockups, listing hero art, marketing strips. Place on white or a light brand tint — never on a busy background. See `preview/bscool-characters.html`.
- **Avatars:** the head crops cleanly into a circle with `object-fit: cover; object-position: center top` (image sized ~150% and nudged up). Use for account personas, review chips, or product-line tiles at 32 / 44 / 64px. See `preview/bscool-avatars.html`.
- **Do not** recolour, distort aspect ratio, or add drop shadows/outlines — the art carries its own soft shading.
- These are **brand mascots, not product photography** — don't use them in the `td-img` product-thumbnail slot of a data table.

### Fidelity notes
- The 6 screenshot-sourced girls are lower resolution (~300px wide) than the 7 from `Final_all.png` (~650–900px wide). For print or large hero use, request the original transparent PNGs for Gaby, Isabella, Emma, Mia, Eva, and Clara.
- The 3 kitten poses are high-res (~1500px+ wide) and print-ready.

---

## Quick start

```html
<!-- 1. Load font + tokens -->
<link rel="stylesheet" href="colors_and_type.css">

<!-- 2. Optional: icon CDN (substitute) -->
<script src="https://unpkg.com/lucide@latest"></script>

<!-- 3. Use the vars -->
<div style="background:var(--bg2); border:1px solid var(--border); border-radius:var(--radius-lg); padding:var(--space-4);">
  <div class="eyebrow">Amazon · BSCOOL</div>
  <h3>B09FL9KRY4 — Sticker Dress Up Book</h3>
  <p>Target ACOS 28% · MAP $10.99</p>
</div>
```

---

## Caveats & substitutions

- **Montserrat is self-hosted** from `fonts/` (all 9 weights + italics, Thin → Black). The CSS `@font-face` rules resolve paths relative to `colors_and_type.css`, so copies in `ui_kits/hub/` ship their own `fonts/` sibling.
- **JetBrains Mono still loads from Google Fonts CDN** — only used for table meta columns and hex labels. Drop TTFs in `fonts/` and I'll self-host it too.
- **Icons:** there is no icon font in the source. Inline SVGs are the real source of truth. Lucide CDN / the `Icon.jsx` set is used as the closest substitute for new mocks. Flag if exact fidelity matters.
- **Slides:** no slide template was provided, so `slides/` was not created. If a deck template is added later, regenerate this folder.
- **The live Hub is SSO-gated** — actual in-product screens beyond the login page could not be inspected. Screens in `ui_kits/hub/` are reconstructed from the DS pattern library (`ds-patterns.html`) which uses the same Amazon listing / wizard / table patterns that drive real Hub pages.
