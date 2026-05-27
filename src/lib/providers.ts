// Provider model, defaults, logo mapping, and 5h/weekly window selection.

import type {Usage, UsageWindow} from './usageClient.js';

export interface ProviderConfig {
    id: string;
    name: string;
    command: string;
    // Bundled icon filename (see AVAILABLE_ICONS); '' / undefined = letter glyph.
    icon?: string;
    // Account accent color "#rrggbb" — drawn as a disc behind the glyph icon
    // so multiple accounts of the same provider stay distinguishable.
    color?: string;
    // Optional per-provider overrides (free-form, stored in the providers JSON).
    pollSeconds?: number;
    warnPct?: number;
    criticalPct?: number;
    notify?: boolean;
}

export const DEFAULT_WARN_PCT = 65;
export const DEFAULT_CRITICAL_PCT = 85;

export interface IconOption {
    file: string;
    label: string;
}

// Bundled logo svgs under icons/, offered in the provider icon selector.
export const AVAILABLE_ICONS: IconOption[] = [
    {file: 'openai.svg', label: 'OpenAI'},
    {file: 'gemini.svg', label: 'Gemini'},
    {file: 'claude.svg', label: 'Claude'},
    {file: 'copilot.svg', label: 'Copilot'},
    {file: 'deepseek.svg', label: 'DeepSeek'},
    {file: 'openrouter.svg', label: 'OpenRouter'},
    {file: 'perplexity.svg', label: 'Perplexity'},
    {file: 'mistral.svg', label: 'Mistral'},
];

const ICON_FILES = new Set(AVAILABLE_ICONS.map(i => i.file));

// Accent colors cycled through when a new provider card is created.
export const DEFAULT_COLORS = [
    '#3b82f6', '#a855f7', '#10b981', '#ef4444',
    '#f59e0b', '#06b6d4', '#ec4899', '#84cc16',
];

// Fallback id/name → logo mapping for providers saved without an explicit icon.
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
 * Prefers the provider's explicitly chosen icon, then falls back to matching
 * by id and finally by normalized (lowercased) name.
 */
export function logoForProvider(config: {id?: string; name?: string; icon?: string}): string | null {
    if (config.icon && ICON_FILES.has(config.icon))
        return config.icon;
    const byId = LOGO_BY_ID[config.id?.toLowerCase?.() ?? ''];
    if (byId)
        return byId;
    const byName = LOGO_BY_ID[(config.name ?? '').toLowerCase().trim()];
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
