// Provider model, defaults, logo mapping, and 5h/weekly window selection.

import type {Usage, UsageWindow} from './usageClient.js';

export interface ProviderConfig {
    id: string;
    name: string;
    command: string;
    useApi: boolean;
    // Optional per-provider overrides (free-form, stored in the providers JSON).
    pollSeconds?: number;
    warnPct?: number;
    criticalPct?: number;
    notify?: boolean;
}

export interface ProviderDefault {
    id: string;
    name: string;
    useApi: boolean;
    defaultCommand: string;
}

// Carried over from the reference prefs.js.
export const PREDEFINED_PROVIDERS: ProviderDefault[] = [
    {id: 'codex', name: 'Codex', useApi: true, defaultCommand: ''},
    {id: 'gemini', name: 'Gemini', useApi: false, defaultCommand: 'codexbar --provider gemini --source api --format json'},
    {id: 'deepseek', name: 'DeepSeek', useApi: false, defaultCommand: 'codexbar --provider deepseek --source api --format json'},
    {id: 'copilot', name: 'Copilot', useApi: false, defaultCommand: 'codexbar --provider copilot --source api --format json'},
    {id: 'openrouter', name: 'OpenRouter', useApi: false, defaultCommand: 'codexbar --provider openrouter --source api --format json'},
    {id: 'perplexity', name: 'Perplexity', useApi: false, defaultCommand: 'codexbar --provider perplexity --source api --format json'},
    {id: 'mistral', name: 'Mistral', useApi: false, defaultCommand: 'codexbar --provider mistral --source api --format json'},
];

export const DEFAULT_WARN_PCT = 65;
export const DEFAULT_CRITICAL_PCT = 85;

// Map provider id (or normalized name) to a bundled logo svg under icons/.
const LOGO_BY_ID: Record<string, string> = {
    codex: 'openai.svg',
    openai: 'openai.svg',
    gemini: 'gemini.svg',
    claude: 'claude.svg',
    anthropic: 'claude.svg',
    copilot: 'copilot.svg',
    deepseek: 'deepseek.svg',
    openrouter: 'openrouter.svg',
    perplexity: 'perplexity.svg',
    mistral: 'mistral.svg',
};

/**
 * Return the bundled logo filename for a provider, or null if none matches.
 * Matched first by id, then by normalized (lowercased) name.
 */
export function logoForProvider(id: string, name: string): string | null {
    const byId = LOGO_BY_ID[id?.toLowerCase?.() ?? ''];
    if (byId)
        return byId;
    const byName = LOGO_BY_ID[(name ?? '').toLowerCase().trim()];
    return byName ?? null;
}

export interface PickedWindows {
    // outer ring / primary bar — the short (≈5h) window.
    short: UsageWindow | null;
    // inner ring / secondary bar — the weekly window (null if only one window).
    week: UsageWindow | null;
}

const WEEK_SECONDS = 604800;

/**
 * Choose the short (≈5h) and weekly windows from a normalized usage object.
 *  - short = tier with the smallest windowSeconds.
 *  - week  = remaining tier whose windowSeconds is closest to one week
 *            (falls back to the largest). null when only one window exists.
 */
export function pickWindows(usage: Usage | null | undefined): PickedWindows {
    if (!usage)
        return {short: null, week: null};

    const tiers = ([usage.primary, usage.secondary, usage.tertiary, usage.quaternary]
        .filter(t => t != null)) as UsageWindow[];

    if (tiers.length === 0)
        return {short: null, week: null};

    const byWindow = [...tiers].sort(
        (a, b) => (a.windowSeconds || 0) - (b.windowSeconds || 0),
    );
    const short = byWindow[0];

    if (tiers.length === 1)
        return {short, week: null};

    const rest = byWindow.slice(1);
    const week = rest.reduce((best, t) =>
        Math.abs((t.windowSeconds || 0) - WEEK_SECONDS) <
        Math.abs((best.windowSeconds || 0) - WEEK_SECONDS)
            ? t : best,
    rest[rest.length - 1]);

    return {short, week};
}
