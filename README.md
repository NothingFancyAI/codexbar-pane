# CodexBar Pane — GNOME Shell extension (TypeScript)

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
  prefs.ts              # per-provider settings cards (Adwaita)
  lib/
    tone.ts             # tone palette, toneFromPct, windowLabel
    providers.ts        # provider model, defaults, logo map, pickWindows()
    usageClient.ts      # CLI subprocess + libsoup API + JSON normalization
    secret.ts           # keyring tokens (gi://Secret)
  ui/
    ringGlyph.ts        # concentric-ring St.DrawingArea widget
    panelIndicator.ts   # panel glyphs + dropdown + pulse + tooltip
    providerRow.ts      # one dropdown row (5h + weekly bars)
    tooltip.ts          # floating hover tooltip
icons/                  # provider logos (svg); fallback = first letter
schemas/                # gschema (compiled by `npm run schemas`)
metadata.json, stylesheet.css
```

The proven CLI/parsing/keyring logic is ported from `codexbar-gnome/`
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

Each provider is a card: Name, Command (or Codex session-cookie token stored in
the keyring), Poll every (seconds; 0 = use the global interval), Warn at,
Critical at, and Notify on critical. Global Refresh interval + Display mode
(used / remaining) are at the top.
