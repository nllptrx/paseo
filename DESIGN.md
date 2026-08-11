---
version: alpha
name: Paseo
description: >-
  Design system for the Paseo client (iOS, Android, web, Electron desktop).
  Tokens are extracted from packages/app/src/styles/theme.ts; values below are
  the default dark theme ("Paseo", subtle teal-green tint). Light-theme
  counterparts carry the light- prefix. Six additional dark tints (zinc,
  midnight, claude, ghostty, pure black) swap surfaces and accent only.
colors:
  surface-0: "#181B1A"
  surface-1: "#1E2120"
  surface-2: "#272A29"
  surface-3: "#434645"
  surface-4: "#595B5B"
  surface-sidebar: "#141716"
  surface-sidebar-hover: "#1c1f1e"
  foreground: "#fafafa"
  foreground-muted: "#A1A5A4"
  foreground-extra-muted: "#717574"
  border: "#252B2A"
  border-accent: "#2F3534"
  accent: "#20744A"
  accent-bright: "#7ccba0"
  accent-foreground: "#ffffff"
  destructive: "#c64f43"
  destructive-foreground: "#ffffff"
  status-success: "#6cb17b"
  status-danger: "#d8847b"
  status-warning: "#c09664"
  status-merged: "#a890d5"
  status-dot-success: "#35c264"
  status-dot-danger: "#f7796d"
  status-dot-warning: "#db932e"
  status-dot-running: "#5caaf6"
  diff-addition: "#4ade80"
  diff-deletion: "#ef4444"
  light-surface-0: "#ffffff"
  light-surface-1: "#fafafa"
  light-surface-2: "#f4f4f5"
  light-surface-3: "#e4e4e7"
  light-surface-4: "#d4d4d8"
  light-surface-sidebar: "#f4f4f5"
  light-surface-sidebar-hover: "#e9e9ec"
  light-foreground: "#1a1a1e"
  light-foreground-muted: "#71717a"
  light-foreground-extra-muted: "#a1a1aa"
  light-border: "#e4e4e7"
  light-border-accent: "#ececf1"
  light-accent: "#20744A"
  light-accent-bright: "#239956"
  light-destructive: "#b04138"
  light-status-success: "#3e704a"
  light-status-danger: "#9d433b"
  light-status-warning: "#7b5d39"
  light-status-merged: "#7347af"
  light-status-dot-success: "#299f51"
  light-status-dot-danger: "#f12e2f"
  light-status-dot-warning: "#b37824"
  light-status-dot-running: "#268ae0"
  light-diff-addition: "#15803d"
  light-diff-deletion: "#b91c1c"
typography:
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 400
  body-sm:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
  caption:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
  screen-title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 400
  structural-label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 500
  section-header:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
  button-label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
  button-label-xs:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
  code:
    fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: 12px
    fontWeight: 400
rounded:
  none: 0px
  sm: 2px
  base: 4px
  md: 6px
  lg: 8px
  xl: 12px
  2xl: 16px
  full: 9999px
spacing:
  half: 2px
  1: 4px
  1-5: 6px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  12: 48px
  16: 64px
  20: 80px
  24: 96px
  32: 128px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.button-label}"
    rounded: "{rounded.lg}"
    height: 44px
    padding: "{spacing.4}"
  button-secondary:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.foreground}"
    typography: "{typography.button-label}"
    rounded: "{rounded.lg}"
    height: 44px
    padding: "{spacing.4}"
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    typography: "{typography.button-label}"
    rounded: "{rounded.lg}"
    height: 44px
    padding: "{spacing.4}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    typography: "{typography.button-label}"
    rounded: "{rounded.lg}"
    height: 44px
    padding: "{spacing.4}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    typography: "{typography.button-label}"
    rounded: "{rounded.lg}"
    height: 44px
    padding: "{spacing.4}"
  button-sm:
    typography: "{typography.button-label}"
    rounded: "{rounded.md}"
    height: 32px
    padding: "{spacing.3}"
  button-xs:
    typography: "{typography.button-label-xs}"
    rounded: "{rounded.md}"
    height: 28px
    padding: "{spacing.3}"
  card:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.lg}"
  card-row:
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    padding: "{spacing.4}"
  text-input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    height: 44px
    padding: "{spacing.4}"
  segmented-control-segment:
    typography: "{typography.button-label}"
    rounded: "{rounded.full}"
    padding: "{spacing.3}"
  status-badge:
    textColor: "{colors.status-success}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
  sidebar-item:
    textColor: "{colors.foreground-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "{spacing.2}"
---

# Paseo

## Overview

Paseo is minimal, spacious, quiet, confident. Whitespace is deliberate; nothing crowds, nothing decorates, nothing apologizes. A row, a label, a control — that is the bar. The app is calm so the user's work is not: every visual decision serves either _act on this_ or _understand this_, never _look at this_.

Consistency comes from component reuse, not from hand-matching styles across surfaces. A semantic element used in three or more places is a primitive; two surfaces doing the same semantic thing in two different ways means one of them is wrong. Design is compact-first: the small case is designed, the large case adds chrome around it.

## Colors

The color system is layer-based. Surfaces step from `surface-0` (app background) through `surface-4` (highest emphasis); the sidebar sits on its own darker pair (`surface-sidebar`, `surface-sidebar-hover`). Seven themes share one semantic vocabulary: light, plus six dark tints (Paseo teal-green — the default and the token values above — zinc, midnight, claude, ghostty, pure black). A dark tint swaps surfaces, borders, accent, and destructive; everything else is derived.

Text has three tiers. `foreground` is the thing being acted on: row titles, section headings, the selected item. `foreground-muted` is context: hints, descriptions, secondary metadata, placeholders. `foreground-extra-muted` is reserved for passive chrome that must sit behind muted text; interactive hover returns it to `foreground`.

`accent` is the one CTA per surface — a filled primary button appears at most once per page, and most pages have zero. `destructive` is a color, not a click: red appears only inside a confirmation dialog, after the user has indicated intent.

Status signals get exactly one token per meaning — `status-success`, `status-danger`, `status-warning`, `status-merged` — used by every status surface: PR state icons, CI checks, diff stats, pills, usage bars. The set is generated, not hand-picked: one lightness, one chroma fraction of the sRGB gamut, only the hue changes (success 150, danger 27, warning 70.5, merged 300). Status **dots** are the sole exception: same hues, own band at 90% of gamut chroma, because a 6pt disc with no shape or label needs loudness the icon band does not. Regenerate the whole set; never nudge one value.

Identity badges (project icons, host badges, PR avatars) draw from a fixed ten-color, theme-independent table held to one contrast band, so a color identifies rather than ranks. Diff `+`/`-` coloring stays saturated (`diff-addition`, `diff-deletion`) because there the color is the signal; a diff _stat_ next to a title is a status signal and uses the status tokens instead.

## Typography

Hierarchy is conveyed through weight and color, not size. Most labels, titles, and hints are 16px or 12px; a row's primary line versus its secondary line is `foreground` versus `foreground-muted`, same size.

Weight has three tiers, applied by role. Text that _names_ a surface or group — section labels, form field labels, modal and sheet titles, dense metadata emphasis — is `structural-label` (weight 500). Text that lives _inside_ a surface — row titles, body, button labels, badge text — is weight 400. Screen titles are lighter still: 400 on compact, 300 on desktop. Top-of-screen titles get lighter on desktop, not heavier.

The UI face is the platform system stack; monospace is used for code, diffs, and terminal content at 12px. Placeholder text is `foreground-muted` — never dimmed further, never italic.

## Layout

The spacing scale is 4px-based (2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 80, 96, 128). Values outside the scale are wrong: `padding: 20` and `gap: 10` do not exist.

Reading surfaces — settings detail, project detail, any list+detail content — sit in a centered, max-width 720px column. Working surfaces — workspace, chat — use the full width, with the composer clamped to a readable line length.

Rhythm is page → spacious, section → spacious, card → tight. Sections own their bottom margin (24px); cards inside a section sit closer; rows inside a card touch, separated only by a 1px divider. Settings rows carry 16px vertical padding; sidebar list items 8–12px. Compressing rows to fit more on screen is wrong — too many rows means more cards or sections, not smaller rows. The whitespace is the design.

Alignment is to glyphs, not boxes. A row's leading icon, title, and trailing button label share the same rails; hit areas grow outward from aligned content and never move it. Optical alignment beats arithmetic when a glyph disagrees with its bounding box.

The canonical responsive pattern is list+detail: full-screen list with a back header on compact; a 320px sidebar plus content pane on desktop. One form-factor check at the top of the screen component; the list and detail are the same components in both layouts, only the framing changes.

## Elevation & Depth

Depth comes from the surface ladder, not shadows. Elevation is a step up the surface scale: hover is `surface-1`, inputs and sheets are `surface-2`, the highest chrome is `surface-3`. Shadows exist in three quiet sizes (sm/md/lg, 2–12px offsets, 4–24px blur, 2–40% black in dark themes, 2–8% in light) and are reserved for floating layers — popovers, sheets, menus. Pane chrome uses a single 1px bottom border to separate header from content; one border, no shadow.

Borders group, separate, or rarely emphasize. A logical block of rows lives inside one card border; rows after the first carry a single top divider. Lists that are themselves the page — sidebars, agent lists — separate items with spacing and surface, never borders. A single bordered element is either a card with one row or does not need a border. `border-accent` is reserved for the outline button; inputs use `border`.

## Shapes

Radii step 2, 4, 6, 8, 12, 16px. Cards, large buttons, inputs, and sidebar items use `lg` (8px); small and tight buttons use `md` (6px); pills, dots, and segmented-control segments are `full`. Status dots are filled circles; status pills are the status token as foreground on a 10%-alpha tint of the same token with a 20%-alpha border. Disabled state is 50% opacity on the outer pressable — a disabled control is the same control, dimmer, never recolored.

## Components

The button has five variants, one job each. `primary` (accent-filled) is the single CTA on a surface. `secondary` (`surface-3`-filled) is the paired equal-weight action and the default. `outline` (transparent, `border-accent`) is the low-frequency action living on a row. `ghost` (no border, no fill) is structural chrome: back arrows, header toggles, "Load more". `destructive` appears only inside a confirmation dialog — the button on the page is `outline`. Sizes are a shared contract across control kinds: `xs` 28px / 12px label, `sm` 32px / 14px label, `md` and `lg` 44px / 14px label. A segmented control of the same size always matches a button in height, label size, and padding — never shrink a control locally to fit a context.

Pickers are chosen by option count, search need, and anchoring. A small fixed set anchored to a trigger is a dropdown menu (under ~10 options). A large or searchable list is a combobox. Right-click and long-press on a target is a context menu. A focused task — a multi-field form, a confirmation with detail — is an adaptive modal sheet: bottom sheet on compact, centered card on desktop. Destructive yes/no is a promise-based confirm dialog. Three themes is a menu; thirty hosts is a combobox; a label and a value is a sheet; "are you sure?" is a confirm.

Rows are a content column plus an optional trailing slot. A chevron in the trailing slot means navigation; a kebab menu means row actions (hover-revealed on web, always visible on touch); both may coexist, chevron last. Switches and segmented controls also sit in the trailing slot and stop press propagation to the row.

States surface at the smallest scope they affect. Loading is an inline 14px spinner beside the thing it relates to; page-level loading is one centered spinner. Empty states are short noun phrases, centered and muted, at most paired with one ghost button. Field errors are one 12px sentence under the field; page-level notices are a quiet alert block (1px tinted border, transparent background); flow-stopping failures are a system alert. Changing state must not move the layout — reserve the space the loaded state needs so spinner, skeleton, and content occupy the same box.

Copy is sentence case, no trailing periods on titles, labels, or single-clause hints. Buttons are imperative ("Save", "Restart", "Add host"); in-flight labels are present-participle with a literal three-dot ellipsis ("Saving..."). Errors describe state without editorializing: "Unable to remove host", then a concrete recovery instruction. Terminology is fixed: workspace (never "checkout"), host, project (never "repo"), provider; a session is historical, an agent is live.

## Do's and Don'ts

Do:

- Reuse the primitive. Before adding a component, assume it already exists.
- Keep one accent-filled CTA per surface, at most.
- Confirm destructive actions in a dialog before any red appears.
- Hold rows in a card to the card's two alignment rails, even when an icon is absent.
- Reserve layout space for the loaded state so nothing shifts.
- Regenerate token families (status, dots, identity) as a set with the generation rule.

Don't:

- Weight 500 on row titles, body text, button labels, or badge text — 500 is for structural labels only.
- A pressable wrapping a text to fake a button, a bare text as a section header, a raw modal for a focused task, a bespoke status pill.
- New color tokens or hardcoded hex outside the palette; status-pill alpha tints and the identity table are the documented exceptions, not a license.
- Spacing values off the scale, color changes for disabled state, placeholders dimmed beyond `foreground-muted`.
- Title case, trailing periods on labels, apologetic error copy.
- Hover-only affordances on touch platforms — hover-revealed controls stay always visible on native.
