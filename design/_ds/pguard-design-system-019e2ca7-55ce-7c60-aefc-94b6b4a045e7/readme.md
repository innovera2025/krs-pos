# pguard Design System

**pguard** — a real-time **security guard dispatch platform** for the Thai market (v2 of
`guard-dispatch`). A customer-side mobile app books on-demand security guards; guards receive
jobs, navigate to site, check in hourly with photo + GPS, and complete work; a web admin console
onboards guards, runs payments/refunds, and monitors live operations across the city. The product
is **bilingual TH/EN**, Thai-first.

Stack behind the UI: Rust microservices (Axum) · Flutter mobile (Riverpod) · Next.js 16 web admin ·
PostgreSQL · NATS JetStream · Redis · MinIO/R2.

This project is the **design system** extracted from that product: tokens, fonts, reusable React
primitives, an interactive web-admin UI kit, and architecture/database diagrams — everything an
agent needs to design new pguard surfaces on-brand.

---

## Sources

Built by reading the product's own repository (request access if you don't have it):

- **GitHub:** [`WeiWutichai/pguard`](https://github.com/WeiWutichai/pguard) — architecture spec
  (`CLAUDE.md`), the design-token source of truth (`apps/design-tokens/source/tokens.css`), the
  Next.js web-admin app (`apps/web-admin/` — real `components/ui/*` primitives, shell, login,
  dashboard, guards), self-hosted IBM Plex fonts (`apps/mobile/assets/fonts/`), and the
  design-foundation mockups (`docs/reviews/design-foundation/*.png`).

Explore that repo to design with higher fidelity — the component source there is the ground truth
this system recreates.

---

## Content fundamentals

How pguard writes:

- **Thai-first, bilingual.** UI ships Thai by default with an always-present TH/EN toggle. Labels
  are short Thai noun phrases: `แดชบอร์ด`, `พนักงาน รปภ.`, `กำลังทำงาน`, `รออนุมัติ`,
  `เอกสารใกล้หมดอายุ`. (`รปภ.` = security guard.)
- **Operational & calm, not salesy.** Copy states facts an operator acts on: `ภาพรวมการดำเนินงานวันนี้`,
  `เจ้าหน้าที่ขาดเช็คอิน 2 รอบ`, `5 รายการรอคืนเงิน`. No exclamation marks, no marketing adjectives.
- **Honest about gaps.** Where a designed panel has no backing data yet, the product shows a neutral
  chip + plain note (`รอ API`) rather than inventing numbers. Mirror this — never fake data in a way
  that reads as real.
- **Numbers are typeset, not decorated.** Money `฿84.2K`, ratings `4.87`, IDs `GRD-0384` / `BK-48280`,
  Buddhist-era years `2566` — all set in IBM Plex Mono with tabular figures.
- **Casing:** Thai has no case. Latin labels in the foundation are sentence/词-case; only small
  meta-labels (KPI labels, table headers, nav-group headers) are UPPERCASE + letter-spaced.
- **Voice:** addresses the operator implicitly (imperative buttons: `เพิ่มพนักงาน`, `มอบหมายงาน`,
  `เข้าสู่ระบบ`). No first person.
- **Emoji:** never. Status and meaning come from Lucide icons + the status color system.

---

## Visual foundations

**Palette.** Brand is **Deep Forest green** — anchor `--green-900 #0E3B2E` (logo, active nav,
inverse/hero panels) with a separate **interactive green** `--brand-int #1FA971` (buttons, links,
focus). A single warm **Amber** accent `--accent #F59E0B` carries the highest-emphasis CTA, tips,
and the "working" status — used sparingly. Neutrals are a **green-tinted slate** (warm grey), not
pure grey. Semantic colors (success/warning/danger/info) each pair a foreground with a tinted
background. A dedicated **guard live-status** triad — active (green) · working (amber) · offline
(red) — is the platform's signature signal and appears as avatar dots, badges, and map pins.

**Type.** IBM Plex family: **Sans Thai** for UI, **Sans** for Latin, **Mono** for numerals/IDs.
Thai-tuned rhythm — looser line-height (`--lh-base 1.62`) and a tiny positive tracking
(`--ls-thai 0.01em`) so stacked Thai vowels/tone marks never cramp. Display/H1 carry negative
tracking (−0.02em). Headings 600 weight; body 400; nothing heavier than 700.

**Spacing & radius.** 4pt spacing base. Radii are deliberately **tight** for a precise,
professional feel: cards `--r-lg 11px`, inputs/buttons `--r-md 8px`, pills `--r-full`. Touch
targets ≥ 44px.

**Elevation.** Restrained — **structure comes from hairline 1px borders, not glow.** Shadows
(`--sh-xs`…`--sh-xl`) are soft, green-tinted, and reserved for genuinely floating layers (modals,
popovers, map pins). Most surfaces are flat with a `--border` outline.

**Cards & surfaces.** The workhorse is the **Panel**: `--bg-surface` fill, 1px `--border`, 11px
radius, header row separated by a bottom hairline. KPI strips are a single bordered container with
cells divided by `border-left` (no gaps). No colored left-border accent cards, no nested heavy
shadows.

**Backgrounds.** App background is the faint `--bg-app`; content sits on white surfaces. The one
expressive surface is the **login hero**: a `155deg` deep-green gradient (`--green-800 → --green-950`)
with a subtle 42px white-hairline grid overlay and scattered translucent map-pin glyphs. No photos,
no illustration, no noise/grain elsewhere.

**Borders.** 1px `--border` for structure; 1.5px `--border-strong` on form controls; dashed
hairlines only inside dense reference diagrams.

**Motion.** Quiet and fast. Buttons transition background ~150ms and **nudge down 1px on press**
(`active:translateY(1px)`). Modals fade + scale `.96→1` over 200ms. Toggles slide 200ms. No
bounce, no spring, no infinite/decorative loops. Honor `prefers-reduced-motion`.

**Hover / press.** Hover = a step in the same hue: primary → `--brand-int-hover`, secondary/ghost →
`--bg-sunken` fill, rows → `--bg-sunken`, accent → `--accent-hover`, danger → slight opacity drop.
Press = the 1px downward nudge. Focus = a 4px `--focus-ring` glow + brand-int border on inputs.

**Transparency & blur.** Used only for the modal scrim: a green-tinted ink `rgba(8,20,15,.5)` with
`backdrop-filter: blur(3px)`. Status "ring" tokens use low-alpha brand colors for map-pin halos.
Elsewhere surfaces are opaque.

**Layout.** Web admin is a fixed **248px sidebar** (grouped nav) + a **62px topbar** (page title ·
search · bell · TH/EN · user menu) + a scrolling content column maxing ~1180px. Dashboard content
is a 2fr/1fr panel grid.

**Theming.** Full light + dark, flipped by a single `[data-theme="dark"]` attribute. Components
reference semantic aliases only (never raw palette steps), so the flip re-themes everything.

---

## Iconography

**Lucide** is the product's only icon set (real app uses `lucide-react`), drawn at **2px stroke
with rounded caps/joins** and inheriting `currentColor` — tint via text color, never recolor
inline. Sizes: ~18px in nav/buttons, 16px in KPI labels, 12–14px inline (ratings, doc status).
The **pguard mark** (`assets/pguard-mark.svg`) is a shield + location pin on the brand gradient;
the wordmark sets the leading "p" in interactive green. No emoji, no Unicode glyphs as icons, no
second icon family. In HTML cards/kits, load Lucide from the CDN
(`unpkg.com/lucide@0.460.0`) and render via `createIcons()` (static pages) or inline SVG
(`shell.jsx`'s `Icon`, for React).

See: `guidelines/brand-iconography.html`, `guidelines/brand-logo.html`.

---

## Index

**Foundations**
- `styles.css` — the single entry point consumers link (imports the token files below).
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`, `semantic.css` (light + dark aliases + base), `fonts.css` (IBM Plex via Google Fonts).
- `guidelines/*.html` — foundation specimen cards (Colors, Type, Spacing, Brand) shown in the Design System tab.
- `assets/pguard-mark.svg` — the logo mark.

**Components** (`window.PguardDesignSystem_019e2c`)
- `components/forms/` — **Button**, **Input** / **Field** / **Textarea** / **Select**, **Toggle**, **Chip**, **SearchField**
- `components/data/` — **Panel** / **PanelHead** / **PanelBody**, **Table** / **Th** / **Td** / **Tr**, **KpiGrid** / **KpiCard**, **Badge**, **Avatar**, **Tabs** / **Tab**
- `components/feedback/` — **Modal**

Each directory has `Name.jsx` + `Name.d.ts` + `Name.prompt.md` and one `@dsCard` demo HTML.

**UI kits**
- `ui_kits/web-admin/` — interactive admin console (login → dashboard → guards → live map), composing the primitives. Open `index.html`.
- `ui_kits/architecture/` — `system-map.html` (microservice architecture) + `database.html` (per-service schemas). The "diagram + database" deliverable.

**Skill**
- `SKILL.md` — makes this folder usable as a downloadable Claude Code skill.

---

## Font note

IBM Plex Sans Thai / Sans / Mono are loaded from **Google Fonts** — these are the genuine product
fonts (also self-hosted in the repo at `apps/mobile/assets/fonts/`), so no substitution was made.
If you need them bundled offline, copy the TTFs from the repo and swap `tokens/fonts.css` to
`@font-face` rules.
