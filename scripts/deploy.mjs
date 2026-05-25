#!/usr/bin/env node
// Assemble the built extension into the user extensions directory.
// Mirrors the reference install.sh intent, driven by npm. Run after
// `npm run pack` (tsc + glib-compile-schemas), e.g. `npm run deploy`.

import {cpSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = 'codexbar-pane@nothingfancy.ai';
const extDir = join(homedir(), '.local/share/gnome-shell/extensions', UUID);

const require = (p, hint) => {
    if (!existsSync(join(root, p)))
        throw new Error(`Missing ${p}. ${hint}`);
};

require('dist/extension.js', 'Run "npm run build" first.');
require('schemas/gschemas.compiled', 'Run "npm run schemas" first.');

console.log(`Deploying to ${extDir}`);
rmSync(extDir, {recursive: true, force: true});
mkdirSync(extDir, {recursive: true});

// Compiled JS (extension.js, prefs.js, lib/, ui/) at the extension root.
cpSync(join(root, 'dist'), extDir, {recursive: true});

// Static assets.
for (const f of ['metadata.json', 'stylesheet.css']) {
    cpSync(join(root, f), join(extDir, f));
}
cpSync(join(root, 'icons'), join(extDir, 'icons'), {recursive: true});
cpSync(join(root, 'schemas'), join(extDir, 'schemas'), {recursive: true});

// Optional helper scripts (copied as-is when present).
for (const f of ['cookie_importer.py', 'debug_usage.py']) {
    if (existsSync(join(root, f)))
        cpSync(join(root, f), join(extDir, f));
}

console.log('Done. Reload GNOME Shell (log out/in on Wayland, Alt+F2 → r on X11),');
console.log(`then: gnome-extensions enable ${UUID}`);
