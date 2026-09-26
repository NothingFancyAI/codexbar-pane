# CodexBar Pane — GNOME Shell extension + Waybar module (TypeScript)

AI subscription usage in the GNOME panel, "Concentric rings" design: every
provider is a ring glyph in the top bar — a thick **outer ring = the ~5-hour
window**, a thin **inner ring = the weekly window** — colored green / amber /
red by severity. The dropdown lists each provider with a primary 5-hour bar and
a smaller weekly bar; critical providers pulse, hovering a glyph shows a
tooltip, and settings are per-provider cards.

UUID `codexbar-pane@nothingfancy.ai` · GNOME Shell 45–50.

## Layout

```
src/
  extension.ts          # enable()/disable(), refresh loop, notifications
  waybar.ts             # Waybar custom-module backend (gjs, one provider per call)
  prefs.ts              # per-provider settings cards (Adwaita)
  lib/
    tone.ts             # tone palette, toneFromPct, windowLabel
    providers.ts        # provider model, icon list/map, pickWindows()
    usageClient.ts      # CLI subprocess + JSON normalization
  ui/
    ringGlyph.ts        # concentric-ring St.DrawingArea widget
    panelIndicator.ts   # panel glyphs + dropdown + pulse + tooltip
    providerRow.ts      # one dropdown row (5h + weekly bars)
    tooltip.ts          # floating hover tooltip
icons/                  # provider logos (svg); fallback = first letter
schemas/                # gschema (compiled by `npm run schemas`)
metadata.json, stylesheet.css
```

The proven CLI/parsing logic is ported from `codexbar-gnome/`
(kept as a CLI-integration reference only).

## Build & install

```sh
npm install          # dev deps (@girs ambient types, pinned to one generation)
npm run build        # tsc → dist/*.js (ESM, one .js per .ts)
npm run schemas      # glib-compile-schemas schemas/
npm run check        # node --check on the entry points
npm run deploy       # build + schemas + copy into ~/.local/share/gnome-shell/extensions/
```

> Note: the install step is `npm run deploy` (not `npm run install`, which npm
> would treat as a lifecycle hook).

After deploy, reload GNOME Shell so it discovers the extension:

- **Wayland:** log out and back in.
- **X11:** `Alt+F2`, type `r`, Enter.

Then enable and watch the log:

```sh
gnome-extensions enable codexbar-pane@nothingfancy.ai
journalctl -f -o cat /usr/bin/gnome-shell
```

## Settings

Providers are added with the **Add provider** button. Each is a card: Name,
Command (a `codexbar` CLI invocation that prints JSON usage), Icon (a bundled
logo or none), Poll every (seconds; 0 = use the global interval), Warn at,
Critical at, and Notify on critical. Global Refresh interval + Display mode
(used / remaining) are at the top.

## Waybar (Hyprland and other wlroots sessions)

GNOME Shell extensions only load inside GNOME Shell. Elsewhere the same
`lib/` code runs under `gjs` as a Waybar custom-module backend:

```sh
just waybar-install          # build → ~/.local/share/codexbar-pane + ~/.local/bin/codexbar-waybar
codexbar-waybar claude | jq  # one Waybar JSON line for provider id "claude"
```

Providers are read from `$XDG_CONFIG_HOME/codexbar-pane/providers.json` — an
array in the same shape as the extension's `providers` setting, plus an
optional `label` (the bar badge; default = first letter of `name`). Each
provider is its own `custom/*` module with `"return-type": "json"`:

- `text` — badge in the account color, then the 5-hour and weekly used
  percentages, each colored by severity.
- `tooltip` — one bar per window with its reset time, plus the account email.
- `class` — `ok` / `warn` / `critical` (worst window) or `error`; style
  `critical` to pulse.
- `percentage` — the 5-hour window.

Entering critical sends one `notify-send` per provider (when `notify` is set);
the marker in `$XDG_RUNTIME_DIR/codexbar-pane/` clears once usage drops.

On the operator's workstations the provider list and the Waybar modules are
rendered by rookery's `workstation-hyprland` role.
