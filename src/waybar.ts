// Waybar custom-module backend: `gjs -m waybar.js <provider-id>` prints one
// Waybar JSON line for that provider — 5-hour and weekly percentages as
// tone-colored Pango text, a bar tooltip, and a severity class. Providers come
// from $XDG_CONFIG_HOME/codexbar-pane/providers.json (the same shape as the
// extension's `providers` setting).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {UsageClient} from './lib/usageClient.js';
import type {UsageWindow} from './lib/usageClient.js';
import {DEFAULT_CRITICAL_PCT, DEFAULT_WARN_PCT, pickWindows} from './lib/providers.js';
import type {ProviderConfig} from './lib/providers.js';
import {Tone, toneFromPct, windowLabel} from './lib/tone.js';

// Brighter than the extension's ring palette: these are text on a near-black
// bar, so each clears 4.5:1 contrast against it.
const TEXT_HEX: Record<Tone, string> = {
    ok: '#8ff0a4',
    warn: '#f6d32d',
    bad: '#ff7b63',
};

const TONE_CLASS: Record<Tone, string> = {ok: 'ok', warn: 'warn', bad: 'critical'};
const TONE_RANK: Record<Tone, number> = {ok: 0, warn: 1, bad: 2};

const BAR_CELLS = 10;

interface WaybarOutput {
    text: string;
    tooltip: string;
    class: string[];
    percentage?: number;
}

const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'codexbar-pane', 'providers.json']);
const STATE_DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'codexbar-pane']);

function escape(text: string): string {
    return GLib.markup_escape_text(text, -1);
}

function span(color: string | undefined, text: string): string {
    return color ? `<span foreground="${color}">${escape(text)}</span>` : escape(text);
}

function loadProvider(id: string): ProviderConfig {
    const [, bytes] = GLib.file_get_contents(CONFIG_PATH);
    const providers = JSON.parse(new TextDecoder().decode(bytes)) as ProviderConfig[];
    const provider = providers.find(p => p.id === id);
    if (!provider)
        throw new Error(`No provider "${id}" in ${CONFIG_PATH}`);
    return provider;
}

function badge(provider: ProviderConfig): string {
    return span(provider.color, provider.label || provider.name.charAt(0));
}

function bar(pct: number): string {
    const filled = Math.round(Math.min(Math.max(pct, 0), 100) / 100 * BAR_CELLS);
    return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

function tooltipLine(w: UsageWindow, tone: Tone): string {
    const label = windowLabel(w.windowSeconds).padEnd(6);
    const pct = `${Math.round(w.usedPercent)}%`.padStart(4);
    const line = `<tt>${escape(label)} ${span(TEXT_HEX[tone], bar(w.usedPercent))} ${escape(pct)}</tt>`;
    return w.resetDescription ? `${line}  ${escape(w.resetDescription)}` : line;
}

/** Notify once per climb into critical; the marker file clears on recovery. */
function trackCritical(provider: ProviderConfig, critical: boolean, detail: string): void {
    const marker = Gio.File.new_for_path(GLib.build_filenamev([STATE_DIR, `${provider.id}.critical`]));
    if (!critical) {
        try {
            marker.delete(null);
        } catch {
            // Already clear.
        }
        return;
    }
    if (marker.query_exists(null) || !provider.notify)
        return;
    GLib.mkdir_with_parents(STATE_DIR, 0o700);
    marker.replace_contents(new TextEncoder().encode(detail), null, false, Gio.FileCreateFlags.NONE, null);
    Gio.Subprocess.new(
        ['notify-send', '--app-name=CodexBar', '--urgency=critical', provider.name, detail],
        Gio.SubprocessFlags.NONE,
    );
}

function errorOutput(provider: ProviderConfig | null, message: string): WaybarOutput {
    const name = provider ? `<b>${escape(provider.name)}</b>\n` : '';
    return {
        text: `${provider ? badge(provider) : '?'}${span(TEXT_HEX.bad, '!')}`,
        tooltip: `${name}${escape(message)}`,
        class: ['error'],
    };
}

/** Fetch one provider's usage and render it; throws on any fetch failure. */
async function fetchOutput(provider: ProviderConfig): Promise<WaybarOutput> {
    const result = await new UsageClient().fetchCli(provider.command, new Gio.Cancellable());
    const {short, week} = pickWindows(result?.usage);
    if (!short)
        throw new Error('No usage data');

    const warn = provider.warnPct ?? DEFAULT_WARN_PCT;
    const critical = provider.criticalPct ?? DEFAULT_CRITICAL_PCT;
    const windows = [short, week].filter((w): w is UsageWindow => w !== null);
    const tones = windows.map(w => toneFromPct(w.usedPercent, warn, critical));
    const worst = tones.reduce((a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a));

    const numbers = windows.map((w, i) => span(TEXT_HEX[tones[i]], `${Math.round(w.usedPercent)}`));
    const header = `<b>${escape(provider.name)}</b>${
        result?.usage.accountEmail ? `  ${escape(result.usage.accountEmail)}` : ''}`;

    const hot = windows.filter((_, i) => tones[i] === 'bad')
        .map(w => `${windowLabel(w.windowSeconds).toLowerCase()} window at ${Math.round(w.usedPercent)}%`);
    trackCritical(provider, hot.length > 0, hot.join(', '));

    return {
        text: `${badge(provider)} ${numbers.join('<span alpha="60%">·</span>')}`,
        tooltip: [header, ...windows.map((w, i) => tooltipLine(w, tones[i]))].join('\n'),
        class: [TONE_CLASS[worst]],
        percentage: Math.round(short.usedPercent),
    };
}

// Waybar re-runs a module on its interval, on every click and on the refresh
// signal, and provider usage endpoints rate-limit (Claude's OAuth one within
// minutes). So each provider keeps its last reading in STATE_DIR: a fetch runs
// only when the reading is older than its spacing and no other fetch holds the
// lock, and a failed fetch keeps showing the last good numbers, marked stale.
const FETCH_SPACING_MS = 20_000;
const ERROR_BACKOFF_MS = 120_000;
const MAX_STALE_MS = 30 * 60_000;
const LOCK_TIMEOUT_MS = 120_000;

interface Reading {
    attemptAt: number;
    goodAt?: number;
    good?: WaybarOutput;
    error?: string;
}

function stateFile(id: string, suffix: string): Gio.File {
    return Gio.File.new_for_path(GLib.build_filenamev([STATE_DIR, `${id}.${suffix}`]));
}

function readReading(id: string): Reading | null {
    try {
        const [, bytes] = stateFile(id, 'json').load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes)) as Reading;
    } catch {
        return null;
    }
}

function writeReading(id: string, reading: Reading): void {
    GLib.mkdir_with_parents(STATE_DIR, 0o700);
    stateFile(id, 'json').replace_contents(
        new TextEncoder().encode(JSON.stringify(reading)), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

/** Take the provider's fetch lock; a lock older than LOCK_TIMEOUT_MS is abandoned and reclaimed. */
function acquireLock(id: string): Gio.File | null {
    GLib.mkdir_with_parents(STATE_DIR, 0o700);
    const lock = stateFile(id, 'lock');
    try {
        lock.create(Gio.FileCreateFlags.NONE, null).close(null);
        return lock;
    } catch {
        try {
            const mtime = lock.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
                .get_modification_date_time()!.to_unix() * 1000;
            if (Date.now() - mtime < LOCK_TIMEOUT_MS)
                return null;
            lock.delete(null);
            lock.create(Gio.FileCreateFlags.NONE, null).close(null);
            return lock;
        } catch {
            return null;
        }
    }
}

function ageText(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    return minutes < 1 ? 'just now' : `${minutes}m ago`;
}

function present(provider: ProviderConfig, reading: Reading | null): WaybarOutput {
    if (!reading)
        return {text: `${badge(provider)} ${span(undefined, '…')}`, tooltip: `<b>${escape(provider.name)}</b>\nLoading…`, class: ['loading']};
    if (!reading.error)
        return reading.good!;
    const age = Date.now() - (reading.goodAt ?? 0);
    if (!reading.good || age > MAX_STALE_MS)
        return errorOutput(provider, reading.error);
    return {
        ...reading.good,
        tooltip: `${reading.good.tooltip}\n<i>${escape(reading.error)}\nShowing the reading from ${ageText(age)}.</i>`,
        class: [...reading.good.class, 'stale'],
    };
}

async function render(id: string): Promise<WaybarOutput> {
    let provider: ProviderConfig;
    try {
        provider = loadProvider(id);
    } catch (e) {
        return errorOutput(null, (e as Error)?.message || String(e));
    }

    const cached = readReading(id);
    const spacing = cached?.error ? ERROR_BACKOFF_MS : FETCH_SPACING_MS;
    if (cached && Date.now() - cached.attemptAt < spacing)
        return present(provider, cached);

    const lock = acquireLock(id);
    if (!lock)
        return present(provider, cached);

    const attemptAt = Date.now();
    let reading: Reading;
    try {
        const good = await fetchOutput(provider);
        reading = {attemptAt, goodAt: attemptAt, good};
    } catch (e) {
        reading = {...cached, attemptAt, error: (e as Error)?.message || String(e)};
    }
    try {
        writeReading(id, reading);
    } finally {
        lock.delete(null);
    }
    return present(provider, reading);
}

const [id] = System.programArgs;
if (!id) {
    printerr('usage: codexbar-waybar <provider-id>');
    System.exit(2);
}
// \u-escape non-ASCII so the line survives print() under any locale; Waybar
// often runs without LANG, where GJS would write the bar glyphs as '?'.
print(JSON.stringify(await render(id))
    .replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
