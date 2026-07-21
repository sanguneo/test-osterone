# test-osterone Studio Design System

## 1. Atmosphere & Identity

Studio is a forensic operations workspace: calm at rest, decisive when a run needs attention. It keeps the existing charcoal and acid-lime identity, but the composition is rebuilt around a horizontal workspace context and a central run rail instead of a dashboard sidebar. The signature is the **run rail**: a continuous vertical line that connects readiness, execution, evidence, and review so the operator always knows what comes next.

## 2. Color

### Palette

| Role | Token | Dark value | Usage |
| --- | --- | --- | --- |
| Carbon/950 | `--carbon-950` | `#12151a` | Sunken controls and code |
| Carbon/900 | `--carbon-900` | `#14171c` | Canvas |
| Carbon/800 | `--carbon-800` | `#1d2127` | Raised surfaces |
| Carbon/750 | `--carbon-750` | `#232831` | Overlay and hover surfaces |
| Carbon/700 | `--carbon-700` | `#2b313a` | Structural hairlines |
| Slate/400 | `--slate-400` | `#95a0ad` | Secondary text |
| Slate/100 | `--slate-100` | `#e7ebf0` | Primary text |
| Lime/500 | `--lime-500` | `#9ee600` | Primary actions, focus, active navigation |
| Lime/950 | `--lime-950` | `#10130a` | Text on lime |
| Success/500 | `--success-500` | `#4cc06d` | Pass verdict only |
| Warning/500 | `--warning-500` | `#ffb020` | Review-needed verdict only |
| Error/500 | `--error-500` | `#ff5a52` | Fail and destructive feedback |
| Neutral-status | `--neutral-status` | `#7a8794` | Runtime error/unknown state |

Semantic aliases: `--surface-canvas`, `--surface-raised`, `--surface-overlay`, `--surface-sunken`, `--text-primary`, `--text-secondary`, `--border-subtle`, `--accent`, `--accent-ink`, `--status-pass`, `--status-review`, `--status-fail`, `--status-error`.

Rules:

- Lime means “act here”; success green means “healthy”. They never substitute for each other.
- Lime appears no more than five times in one viewport, including focus and active states.
- Status always uses a 6px dot plus a Korean text label. Color is never the only signal.
- No color outside this table. Alpha overlays and `color-mix()` may derive interactive states from these tokens.

## 3. Typography

| Level | Token | Size | Weight | Line height | Usage |
| --- | --- | --- | --- | --- | --- |
| Display | `--text-display` | `2.5rem` | 680 | 1.05 | Dashboard focal state |
| H1 | `--text-h1` | `1.75rem` | 650 | 1.15 | Page title |
| H2 | `--text-h2` | `1.125rem` | 620 | 1.3 | Section heading |
| Body | `--text-body` | `0.9375rem` | 400 | 1.55 | Default UI text |
| Small | `--text-small` | `0.8125rem` | 450 | 1.45 | Supporting detail |
| Caption | `--text-caption` | `0.75rem` | 550 | 1.35 | Metadata and compact controls |
| Micro | `--text-micro` | `0.6875rem` | 600 | 1.25 | One tracked context label |

- Body: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", sans-serif`.
- Data: `ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace`.
- Large Latin text uses tight tracking. Korean text keeps natural tracking and `word-break: keep-all`.
- Every number uses tabular numerals.

## 4. Spacing & Layout

Base unit: 4px.

| Token | Value | Usage |
| --- | --- | --- |
| `--space-1` | `0.25rem` | Icon-to-label |
| `--space-2` | `0.5rem` | Tight inline cluster |
| `--space-3` | `0.75rem` | Compact control group |
| `--space-4` | `1rem` | Component padding |
| `--space-5` | `1.25rem` | Comfortable internal gap |
| `--space-6` | `1.5rem` | Section inner padding |
| `--space-8` | `2rem` | Sibling regions |
| `--space-10` | `2.5rem` | Page sections |
| `--space-12` | `3rem` | Major regions |

- Shell: `100dvh` grid with fixed header and context strip; `.workspace-main` owns vertical scroll.
- Main content is capped at `90rem` and centered via automatic inline gutters; the scroll owner (`.workspace-main`) spans the full viewport so the scrollbar sits at the window edge. Fluid gutters use `clamp()`/`max()`.
- Desktop: top navigation plus horizontal project/sheet context. Tablet compresses labels. Mobile turns the context strip into an explicit horizontal reel and the primary navigation into a bottom dock.
- Primary content reflows to one readable column at 375px. Only tables and named reels may scroll horizontally.
- Radius scale: `--radius-control 0.375rem`, `--radius-panel 0.75rem`, `--radius-overlay 1rem`, `--radius-round 999rem`.

## 5. Components

### Brand lockup
- **Structure**: custom CSS mark + product name + environment subtitle.
- **States**: static; the mark never acts as an unlabeled control.
- **Accessibility**: product name remains real text.

### Primary navigation
- **Structure**: four labeled buttons with one custom SVG icon family.
- **Variants**: dashboard, rules, run, review.
- **States**: default, hover, active (`aria-current="page"`), focus.
- **Motion**: 120ms color/surface transition; no entrance animation.
- **Layout**: cluster on desktop, bottom dock on mobile.

### Workspace switcher
- **Structure**: project reel, sheet reel, contextual add/edit/remove controls.
- **States**: default, hover, selected, focus, disabled, confirm-delete.
- **Accessibility**: visible labels, icon buttons have `aria-label`, selected state exposed with `aria-pressed`.
- **Layout**: horizontal reel owns horizontal scroll; it never becomes the page scroll owner.

### Button
- **Variants**: primary lime, secondary tonal, tertiary text, destructive outline, icon-only.
- **States**: default, hover, pressed, focus, disabled, busy.
- **Spacing**: `--space-2`/`--space-4`; minimum 44px touch target.
- **Motion**: 120ms background/transform; pressed uses `translateY(1px)`.

### Status mark
- **Structure**: 6px semantic dot + Korean label.
- **States**: pass, fail, review, runtime error.
- **Accessibility**: text is always present; dot is decorative.

### Data surface
- **Structure**: a section header, optional controls, table/list body, state slot.
- **Variants**: work queue, preview, result, evidence.
- **States**: loading skeleton, empty with one next action, error with retry, partial with em dash, populated.
- **Layout**: table scroll owner is `.table-scroll`; no nested card grid.

### Run rail
- **Structure**: vertical track, numbered stage node, content region.
- **States**: ready, active, complete, held, error.
- **Accessibility**: stages are ordered content; state has visible text beyond color.
- **Layout**: stack; track is decorative and never changes DOM order.

### Dialog
- **Structure**: overlay, labelled panel, visible close, explicit cancel/submit actions.
- **States**: opening, idle, busy, inline error.
- **Accessibility**: Escape closes, focus is trapped, focus returns to the trigger, overlay click closes only the backdrop.
- **Motion**: opacity + transform only, 180ms in / 120ms out; reduced motion removes transform.

## 6. Motion & Interaction

| Token | Value | Usage |
| --- | --- | --- |
| `--duration-fast` | `120ms` | Hover, press, tab state |
| `--duration-standard` | `180ms` | Dialog and contextual reveal |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrance and direct manipulation |

- Motion intensity is 3: hover, focus, and dialog state only.
- Animate `transform`, `opacity`, `background-color`, `border-color`, and `color`; never layout properties.
- `prefers-reduced-motion` removes transforms and nonessential animations.

## 7. Depth & Surface

Strategy: **mixed tonal shift + hairlines**.

- Canvas, raised, and overlay levels use `--surface-canvas`, `--surface-raised`, and `--surface-overlay`.
- Structural groupings prefer spacing. Hairlines appear only where a boundary communicates scroll ownership or interaction.
- Dark surface elevation uses a low-alpha light inset edge. Only dialogs receive a layered shadow.
- Cards are reserved for truly independent evidence or state regions; they are not the default page wrapper.

## 8. Accessibility Constraints & Accepted Debt

Constraints:

- WCAG 2.2 AA minimum: 4.5:1 body text, 3:1 large text and UI boundaries.
- Every control is keyboard reachable with visible lime focus.
- Skip link targets the scroll-owning main region.
- Dialog focus trap and focus restoration are required.
- Touch targets are at least 44px on coarse pointers; mobile form text is at least 16px.
- Korean headings and body copy must not create one-character orphan lines at 375, 768, or 1280px.

Accepted debt: none.
