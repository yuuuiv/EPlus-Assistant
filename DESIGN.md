# Eplus Lottery Assistant Design System

## 1. Atmosphere & Identity

A quiet local operations console for a high-consequence lottery workflow. It uses dark translucent materials, a restrained teal signal color, and dense, predictable information hierarchy so that reviews, manual intervention, and network state remain calm and legible.

## 2. Color

| Role | Token | Usage |
|---|---|---|
| Canvas | `--bg` | Application background |
| Surface | `--bg-surface`, `--bg-surface-solid` | Panels and material fallbacks |
| Input | `--bg-input` | Inputs and code entry |
| Text | `--text`, `--text-muted`, `--text-subtle` | Content hierarchy |
| Accent | `--primary`, `--primary-hover`, `--primary-dim` | Safe primary actions and focus |
| Danger | `--danger`, `--danger-dim`, `--danger-hover` | Destructive actions and errors |
| Status | `--success`, `--warning`, `--info` | State indicators |
| Borders | `--border`, `--border-input`, `--border-focus` | Surface separation and focus |

All colors are defined in `src/renderer/styles.css`; components use class names and CSS variables only.

## 3. Typography

The UI uses the platform stack `Segoe UI, system-ui, -apple-system, sans-serif` with 14px body type, 12px captions, 13px control labels, 14px body/table text, and 27px page titles. Numeric metadata uses tabular figures.

## 4. Spacing & Layout

The base spacing unit is 4px. `--space-1` through `--space-8` represent 4px through 32px. The app shell is bounded to the dynamic viewport: its top bar, sidebar, and status bar stay fixed while the workspace owns vertical scrolling. At narrow widths the sidebar becomes a horizontal navigation rail.

## 5. Components

### Panel
- **Structure**: Section with a heading, optional metadata, and content.
- **Variants**: default, wide, warning.
- **States**: rest, hover, reduced-transparency fallback.
- **Accessibility**: semantic heading hierarchy and visible focus inside.
- **Motion**: short compositor-only entry/hover motion, removed in reduced-motion mode.

### Action Button
- **Structure**: native button with optional Lucide icon.
- **Variants**: primary, secondary, destructive, icon button.
- **States**: default, hover, active, focus-visible, disabled.
- **Accessibility**: native keyboard activation and visible focus ring.

### Status Badge and Timeline
- **Structure**: concise text paired with a semantic status color.
- **States**: pending, active, manual, completed, failed, cancelled.
- **Accessibility**: status remains explicit in text, not color alone.

### Detail Drawer
- **Structure**: account-specific profile, records, and results below the account list.
- **States**: loading, empty, populated, password hidden/revealed.
- **Accessibility**: password only renders after explicit action and automatically hides after five seconds.

### Sidebar Navigation
- **Structure**: account, workflow, and settings groups with labeled icon buttons.
- **States**: active, hover, active press, keyboard focus, compact horizontal rail.
- **Accessibility**: native buttons, explicit active state, labels, and tooltips.

### Workspace Panel
- **Structure**: a page heading followed by one or more `panel-card` sections in a responsive intrinsic grid.
- **States**: populated, loading, empty, and inline error message.

## 6. Motion & Interaction

Use `--ease-out` and `--transition` for direct manipulation feedback. Only `transform`, `opacity`, and `filter` animate. Button press feedback uses a 100ms scale. Panel entrances use a short stagger and transitions remain interruptible. Reduced motion removes movement but keeps opacity and color feedback.

## 7. Depth & Surface

The strategy is mixed: thin tokenized borders plus tinted shadows and translucent surfaces. At reduced transparency, panels become solid `--bg-surface-solid` surfaces without blur.

## 8. Accessibility Constraints & Accepted Debt

- WCAG 2.2 AA target with visible focus, text labels for all colored statuses, native buttons/inputs, and full keyboard reachability.
- `prefers-reduced-motion`, `prefers-reduced-transparency`, and `prefers-contrast` each have dedicated CSS fallbacks.
- No accepted design debt.
