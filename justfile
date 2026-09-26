# CodexBar Pane — GNOME Shell extension + Waybar module tasks
# Run `just` to list recipes.

uuid := "codexbar-pane@nothingfancy.ai"
ext-dir := env_var('HOME') / ".local/share/gnome-shell/extensions" / uuid
waybar-dir := env_var('HOME') / ".local/share/codexbar-pane"
waybar-bin := env_var('HOME') / ".local/bin/codexbar-waybar"

# List available recipes
default:
    @just --list

# Install npm dev dependencies (@girs ambient types)
deps:
    npm install

# Compile TypeScript (src/ → dist/)
build:
    npm run build

# Compile the GSettings schema
schemas:
    npm run schemas

# Syntax-check the built entry points
check:
    npm run check

# Build + schemas (no copy)
pack:
    npm run pack

# Build, compile schemas, and copy into the user extensions dir
deploy:
    npm run deploy

# Fresh build from clean deps, then deploy
install: deps deploy

# Remove build artifacts and compiled schema
clean:
    rm -rf dist schemas/gschemas.compiled

# Enable the extension (after a shell reload)
enable:
    gnome-extensions enable {{uuid}}

# Disable the extension
disable:
    gnome-extensions disable {{uuid}}

# Show the extension's state as GNOME Shell sees it
info:
    gnome-extensions info {{uuid}}

# Open the per-provider preferences window
prefs:
    gnome-extensions prefs {{uuid}}

# Remove the deployed extension from the user extensions dir
uninstall:
    rm -rf "{{ext-dir}}"

# Follow the GNOME Shell log (extension output + errors)
logs:
    journalctl -f -o cat /usr/bin/gnome-shell

# Restart GNOME Shell — X11 only; on Wayland log out and back in
restart-shell:
    @echo "Wayland: log out and back in. X11: Alt+F2 → r → Enter."

# Deploy, then print the reload + enable reminder
reload: deploy
    @echo "Reload GNOME Shell (Wayland: log out/in · X11: Alt+F2 → r),"
    @echo "then: just enable"

# Build and install the Waybar backend as `codexbar-waybar` on PATH
waybar-install: build
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf "{{waybar-dir}}"
    mkdir -p "{{waybar-dir}}" "$(dirname "{{waybar-bin}}")"
    cp -r dist/lib dist/waybar.js "{{waybar-dir}}/"
    printf '#!/bin/sh\nexec gjs -m "%s/waybar.js" "$@"\n' "{{waybar-dir}}" > "{{waybar-bin}}"
    chmod 0755 "{{waybar-bin}}"
    echo "Installed {{waybar-bin}}"

# Remove the installed Waybar backend
waybar-uninstall:
    rm -rf "{{waybar-dir}}" "{{waybar-bin}}"
