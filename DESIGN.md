# test-osterone Studio Design System

## 1. Atmosphere & Identity

Studio is a forensic operations workspace: calm at rest, decisive when a run needs attention. It keeps the existing charcoal and acid-lime identity, but the composition is rebuilt around a horizontal workspace context and a central run rail instead of a dashboard sidebar. The signature is the **run rail**: a continuous vertical line that connects readiness, execution, evidence, and review so the operator always knows what comes next. The overall composition is a Project → Sheet → views drill-down: the Test Sheet, not the project, is the working unit, and each view — dashboard, rules, run & results, review — is scoped to whichever sheet is currently selected.

Each sheet owns its interpretation rule, refine chat, and approved baselines; the project only holds a default rule used to seed new sheets and a read-only legacy baseline fallback for pre-migration approvals. This per-sheet ownership is why every view below reads as "the selected sheet's dashboard/rules/run/review", not a project-wide screen.

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

- Shell: `100dvh` grid with four fixed rows — app header, workspace context strip (project/sheet reels), a sheet-scoped nav row (`Project › Sheet` breadcrumb + the four view tabs), and `.workspace-main`, which owns vertical scroll.
- Main content is capped at `90rem` and centered via automatic inline gutters; the scroll owner (`.workspace-main`) spans the full viewport so the scrollbar sits at the window edge. Fluid gutters use `clamp()`/`max()`.
- Desktop: the primary view-nav no longer lives in the top header; it sits in a `.sheet-nav` row below the project/sheet context strip, preceded by a `Project › Sheet` breadcrumb, so the four views read as belonging to the selected sheet. Tablet compresses labels. Mobile turns the context strip into an explicit horizontal reel and the sheet-nav into a bottom dock.
- Primary content reflows to one readable column at 375px. Only tables and named reels may scroll horizontally.
- Radius scale: `--radius-control 0.375rem`, `--radius-panel 0.75rem`, `--radius-overlay 1rem`, `--radius-round 999rem`.

## 5. Components

### Brand lockup
- **Structure**: custom CSS mark + product name + environment subtitle.
- **States**: static; the mark never acts as an unlabeled control.
- **Accessibility**: product name remains real text.

### Primary navigation
- **Structure**: a `Project › Sheet` breadcrumb followed by four labeled view tabs, one custom SVG icon family each.
- **Variants**: dashboard, rules, run, review.
- **States**: default, hover, active (`aria-current="page"`), focus.
- **Motion**: 120ms color/surface transition; no entrance animation.
- **Layout**: a sheet-scoped sub-navigation row (`.sheet-nav`) below the project/sheet context strip on desktop, bottom dock on mobile; hidden/collapsed until a sheet is selected.

### Sheet nav (breadcrumb + views)
- **Structure**: `Project › Sheet` breadcrumb + the four view tabs (dashboard, rules, run, review).
- **States**: default, hover, active tab, focus; collapsed when no sheet is selected.
- **Accessibility**: breadcrumb segments are real links/buttons; active tab exposed with `aria-current="page"`.
- **Layout**: row sits between the workspace context strip and the main content region; it is the only place the four views are surfaced.

### Workspace switcher
- **Structure**: project reel, sheet reel, contextual add/edit/remove controls.
- **States**: default, hover, selected, focus, disabled, confirm-delete.
- **Accessibility**: visible labels, icon buttons have `aria-label`, selected state exposed with `aria-pressed`.
- **Layout**: horizontal reel owns horizontal scroll; it never becomes the page scroll owner.
- **Behavior**: selecting a sheet drills into that sheet's four views (dashboard/rules/run/review); selecting a project with no sheet selected shows Project home instead.

### Welcome screen
- **Structure**: product lockup + a list of existing projects to pick from + a create-project action.
- **States**: empty (no projects yet), populated list, busy (creating).
- **Accessibility**: project list items are real buttons/links; create action is reachable by keyboard.
- **Layout**: centered empty-state layout; shown only when no project is selected.

### Project home
- **Structure**: header with project name, target, and sheet count; the project's sheets as a selectable card grid (`.sheet-card`).
- **States**: populated grid, empty (add-first-sheet CTA), hover/selected card, focus.
- **Accessibility**: each `.sheet-card` is a single actionable region with a visible name and status summary.
- **Layout**: shown when a project is selected but no sheet is selected; grid reflows to one column at 375px.

### Sheet onboarding wizard
- **Structure**: three steps — (1) source (name + Google Sheet/CSV + optional target/env override), (2) AI interpretation proposal (proposed column-mapping chips + a case preview table), (3) conversational rule refine.
- **States**: step active, step complete, step error, busy (AI proposal generating).
- **Accessibility**: step progress is exposed as text, not color alone; each step is keyboard-navigable.
- **Layout**: overlay dialog with a linear step sequence; used only for adding a new sheet — editing an existing sheet uses the single-step form.

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
