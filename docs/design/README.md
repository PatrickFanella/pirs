# Pirs design system

Socket / Signal, selected by the owner on November 12, 2026. This file owns the
interface rules for Pirs. The brand masters (mark, lockups, fonts, layouts) live
in SUBCULT Studio at `studio/brands/pirs/`; [`tokens.css`](tokens.css) and the
files in [`../brand/`](../brand/) are exported from there and listed with their
hashes in [`../brand/brand-export.json`](../brand/brand-export.json). Do not
edit the exported files by hand.

[`specimen.html`](specimen.html) shows every component below in both themes.
Open it locally in a browser. Its plugin names, capabilities and events are
sample data, and the page says so.

## Where Pirs has an interface

| Surface | Who draws it | State |
| --- | --- | --- |
| PDS account screens: sign-in, sign-up, authorization, account | The upstream PDS. Pirs sets the name, logo, five colours and two backgrounds through `pds.env`. | Values are ready in [PDS account screens](#pds-account-screens). An operator applies them. |
| Plugin pages on the plugin HTTP origin | The plugin. The host emits only inert, sanitized HTML. | Pirs adds no styling or branding. A page served by a plugin belongs to the account owner. |
| `GET /_pirs/status` | JSON from the bridge. | No interface. |
| Operator console: plugins, install review, events, host health | Pirs. | Not built. This document specifies it so the first implementation starts from agreed rules. |
| README and documentation | Pirs. | The README lockup uses the exported files. |

## Principles

1. **Show the boundary before the button.** Any action that grants a
   capability lists those capabilities first, as plain sentences with the exact
   identifiers beside them. Nothing installs from a single click.
2. **Name things exactly.** DIDs, NSIDs, hosts, cursors and capability names are
   set in mono and never paraphrased. If one is shortened to fit, the full value
   is one action away (copy button, title).
3. **One amber thing per view.** Amber is the core of the mark and the primary
   action. A screen with two amber buttons has a hierarchy problem.
4. **Every state has words.** Running, stopped, trapped, empty, loading and
   failed are written out. Colour and shape support the word; they never replace it.
5. **Draft stays visible.** Anything resting on the draft spec says so in the
   interface ("Draft"), the same way the README does.

## Foundations

### Themes

Dark is the default. The light theme applies when the browser asks for it, or
when the root element has `data-theme="light"`; `data-theme="dark"` forces dark.
Both themes set every role below, so components only ever use role names.

| Role (`--pirs-…`) | Dark | Light | Use |
| --- | --- | --- | --- |
| `bg` | `#1e1424` | `#f5ece6` | Page ground. |
| `surface` | `#2a1d32` | `#ffffff` | Panels, cards, dialogs. |
| `raised` | `#36263f` | `#fbf7f4` | Inputs, rows on a surface, code blocks. |
| `border` | `#4a3655` | `#e3d6dc` | Dividers. Decorative only. |
| `border-strong` | `#8a7392` | `#8e7a8c` | Input and control outlines (3:1 or more). |
| `text` | `#f5ece6` | `#1e1424` | Body and headings. |
| `text-muted` | `#bca9b8` | `#5e4a60` | Secondary text, labels, help. |
| `accent` | `#f2a541` | `#f2a541` | Primary button fill, the mark core, live cursors on dark. |
| `on-accent` | `#1e1424` | `#1e1424` | Text on an accent fill. |
| `accent-text` | `#f2a541` | `#8a4e00` | Links and amber text. Never use `accent` as text on light. |
| `accent-edge` | `#f2a541` | `#8a4e00` | Outline of the primary button and selected states. |
| `focus` | `#f2a541` | `#1e1424` | Focus ring. |
| `danger` / `warning` / `success` / `info` | `#ff8f9e` / `#f5d36b` / `#5fd3a9` / `#8db8ff` | `#b4233a` / `#7f5a00` / `#1b7356` / `#1f5fc4` | Status text, icons and tinted notices. |

Every text role reaches 4.5:1 on `bg`, `surface` and `raised` in both themes;
borders, focus and accent edges reach 3:1. The measured ratios are in Studio's
`tokens.json` (`contrast_checks`), and the Studio build fails if one drops.

Tinted backgrounds (notices, selected rows) mix a status colour into the
surface: `color-mix(in srgb, var(--pirs-info) 12%, var(--pirs-surface))` with a
border at 45%. Text on a tint stays `text`.

### Type

| Role | Style |
| --- | --- |
| Page title | Unbounded 600, 36 px, line height 1.1, tracking −2% |
| Section heading | Inter 600, 22 px, 1.25 |
| Subheading | Inter 600, 18 px, 1.35 |
| Body | Inter 400, 16 px, 1.5 |
| Small | Inter 400, 14 px, 1.45 |
| Label | JetBrains Mono 500, 12 px, upper case, tracking 8% |
| Identifier and code | JetBrains Mono 400, 14 px |

Unbounded is for the wordmark and page titles only, never below 22 px. Use the
size tokens (`--pirs-size-caption` 12 px through `--pirs-size-hero` 72 px).
Interface text is never below 12 px. Body text runs at most 72 characters wide.

### Space, shape, depth

- Spacing steps `--pirs-space-1` to `--pirs-space-9`: 4, 8, 12, 16, 24, 32, 48,
  64 and 96 px. Related things sit 8 to 12 px apart; groups 24 to 32 px.
- Radius: 8 px for inputs and tags, 12 px for rows and small cards, 22 px for
  panels and dialogs, fully round for buttons and status pills.
- Borders define surfaces. Only dialogs and menus cast a shadow
  (`0 24px 64px rgb(0 0 0 / .45)` on dark, `/ .18` on light).

### Motion

120 ms for hover and press, 200 ms for things that enter, both on
`--pirs-easing`. The only moving decoration is a new event row fading its tint
out over 200 ms. With `prefers-reduced-motion: reduce` the duration tokens drop
to 0 and spinners become a static "Working…" label.

### Icons and glyphs

- **Level glyphs** (`levels/*.svg`): the Socket ring with one segment lit for
  observe, two for serve, three for act and all four for decide. Always set the
  level name beside the glyph.
- Other icons: inline stroke SVG at 20 or 24 px, 2 px stroke, round caps,
  `currentColor`. Decorative icons get `aria-hidden="true"`; an icon-only
  button gets an `aria-label`. No emoji.

## Components

Each component lists its states. Every interactive one has a visible focus ring:
`outline: 2px solid var(--pirs-focus); outline-offset: 2px`, shown on
`:focus-visible`, never removed.

### Button

| Kind | Look | Use |
| --- | --- | --- |
| Primary | Amber fill, night text, `accent-edge` outline, pill | The one main action. |
| Secondary | Transparent, 1 px `border-strong`, `text` | Other actions, Cancel. |
| Quiet | `accent-text`, underline on hover | Inline and low-weight actions. |
| Danger | 1 px `danger` outline and text; filled only inside a confirming dialog | Stop, remove, revoke. |

Height 44 px (36 px allowed in dense tables, with 44 px of hit area). Labels are
a verb and an object: "Install plugin", "Stop static-site". States: hover
(mix 10% shell into the fill), pressed (mix 10% night), disabled
(`aria-disabled="true"`, 50% opacity, keeps focus so its reason can be read),
busy (`aria-busy="true"`, label changes to "Installing…", button stays the same
width).

### Text field

Label above (14 px, 500), 44 px input on `raised` with a 1 px `border-strong`
outline and 8 px radius, help text below in `text-muted`. Use mono for handles,
DIDs, NSIDs and hosts. Error: 2 px `danger` outline, `aria-invalid="true"`, and
a message below that starts with "Error:" and is linked by
`aria-describedby`. Validate when focus leaves the field or on submit, never
while typing.

Checkboxes, radios and switches are native controls with
`accent-color: var(--pirs-accent)` and a 44 px row.

### Level tag

Level glyph (16 px) and the level name in the label style, inside a pill with a
1 px `border-strong` outline. Not interactive.

### Status pill

A dot and a word: Running (`success`), Stopped (`text-muted`, hollow dot),
Installing (`info`), Trapped (`danger`). Trapped adds the reason on the row
("Exceeded its 1000 ms deadline"). The word is always present.

### Plugin row

Name (Inter 600, a link to the plugin page), manifest ID and version in mono,
level tags, status pill, and an icon-only actions button in `text-muted`
labelled "Actions for static-site". Minimum height 64 px. On narrow screens the tags wrap under the name.

### Capability list

One row per capability: a plain sentence ("Reads public records in
`tv.pirs.site.page`"), the capability name in mono (`records.read`) and, where
the spec assigns one, the level tag (`events.subscribe` is observe, `http.serve`
and `xrpc.serve` are serve, record and blob reads are act). `network.request`
and the key-value capabilities have no level and show no tag. Network
capabilities list every allowed host. Limits (quotas,
deadlines, response bytes) are shown with units. The list is a `<ul>`; each
row is readable on its own.

### Install review

A modal `<dialog>` titled "Install commit-webhook?", with the manifest ID and
SHA-256 (shortened, with a copy button), the capability list, any warning
notice ("Can send requests to 1 host"), then Cancel (secondary) and Install
(primary). Focus starts on the title so the list is read before a button; Escape
cancels and focus returns to the control that opened it. Install never sits
under the pointer from the previous click.

### Event stream

A table with columns Cursor (amber mono, right aligned), Time, Type, Collection
(mono NSID) and Repository (DID shortened to 8 characters each side of an
ellipsis, full value in `title` and a copy button). New rows enter at the top
with a fading tint. The stream has Pause and Resume buttons and states where it
resumed: "Resumed from cursor 1042". It is not an ARIA live region; a polite
status line announces "12 new events" at most every five seconds.

### Notice

Tinted surface with a status icon, a bold first sentence and an optional action.
`role="status"` for info and success, `role="alert"` only for a failure that
stops the current task. No coloured left border.

### Identifier block

Mono 14 px on `raised`, 8 px radius, with a copy button
(`aria-label="Copy DID"`). After copying, the button reads "Copied" for two
seconds and a polite status says the same.

### Navigation

A top bar with the small lockup, the PDS hostname in mono and a theme switch.
A side list (Overview, Plugins, Events, Settings) marks the current page with
`aria-current="page"`, a 3 px amber bar and `text` weight 600. Below 720 px it
becomes a row of tabs under the top bar. A "Skip to content" link is the first
focusable element.

## Page states

- **Empty.** The mono mark at 48 px in `border-strong`, one sentence that says
  what would be here, and one action. "No plugins are installed. Install one
  from a component and manifest file."
- **Loading.** Lists show three skeleton rows in `raised` for the expected
  shape; nothing shimmers. Buttons show their busy state. If loading takes
  more than ten seconds, say what is still being waited for.
- **Failed.** Say what failed, what still works, and what to do next, with the
  identifier involved: "Couldn't reach the plugin host. The PDS is still
  serving accounts. Check that pirs-host is running, then retry."
- **Stopped or trapped plugin.** The row stays in place with its status pill and
  reason; its actions offer Start or View log.

## Layout

Content sits in a container up to 1120 px wide with a 240 px side list and a
32 px gap. Below 720 px the side list becomes tabs and the gutters are 16 px.
Tables scroll inside their own box (`overflow-x: auto`) and never widen the
page. Dialogs are at most 560 px wide and full width minus 32 px on a phone.

## Accessibility checklist

- Text 4.5:1, large text and control outlines 3:1, in both themes (measured).
- Focus visible on every control; order follows the reading order.
- Targets at least 44 by 44 px.
- Meaning never depends on colour alone: status words, level names.
- Dialogs trap focus, close on Escape and return focus.
- Motion respects `prefers-reduced-motion`.
- Every page sets `lang`; `пирс` appears only in brand artwork.

## Copy

Write like the README: plain, exact and honest about what is a draft. Name the
thing and the verb ("Stop static-site"). Confirmations state the consequence
("static-site stops serving its routes until you start it again"). Error
messages say what happened and what to do. Never call a hook stable or a plugin
production-ready.

## PDS account screens

Add these to `pds.env` (see "Customizing the appearance" in
`UPSTREAM-README.md`). Host the images at public HTTPS URLs first.

```sh
PDS_SERVICE_NAME="Pirs"
PDS_LOGO_URL="https://<your host>/mark.svg"                       # docs/brand/mark.svg
PDS_BACKGROUND_DARK_URL="https://<your host>/pds-background-dark.svg"   # docs/brand/
PDS_BACKGROUND_LIGHT_URL="https://<your host>/pds-background-light.svg" # docs/brand/
PDS_PRIMARY_COLOR="#b46914"
PDS_ERROR_COLOR="#d8484e"
PDS_WARNING_COLOR="#9d7500"
PDS_INFO_COLOR="#0e7ed5"
PDS_SUCCESS_COLOR="#208b67"
```

The primary is a deeper amber than the brand amber on purpose. The PDS uses one
value for both colour schemes and draws it as link text on a white card in light
mode and on `#171717` in dark mode. No colour reaches 4.5:1 on both. These values
sit at the best balance, about 4.2:1 each way. Brand amber would be 2.05:1 as
link text on white. The PDS picks black text for the primary button (about
5:1). Its cards stay neutral grey; the plum appears only in the background
image. Replace the `PDS_SERVICE_NAME` with your own service's name.

## Files

| Path | What it is |
| --- | --- |
| `docs/design/README.md` | This file. Owned here. |
| `docs/design/specimen.html` | Components in both themes with sample data. Owned here. |
| `docs/design/tokens.css` | Colour, type, space, radius and motion tokens. Exported from Studio. |
| `docs/design/levels/` | Level glyphs for dark and light grounds. Exported. |
| `docs/brand/` | Marks, lockups, favicon, app icon, link preview and PDS backgrounds. Exported. |

To change a colour, size or mark, change the Studio generator
(`studio/brand-tools/pirs_socket_signal.py`), rebuild with
`python3 studio/brand-tools/site_packs.py --only pirs`, and run
`python3 studio/brand-tools/pirs_socket_signal.py --export <this checkout>`.
After editing this file or the specimen, refresh Studio's copy with
`--import-product`.
