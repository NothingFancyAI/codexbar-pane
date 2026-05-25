// Tone palette + severity + window-label helpers.
// Palette from the "Concentric rings" design handoff (wireframes.jsx).

export type Tone = 'ok' | 'warn' | 'bad';

export const TONE_HEX: Record<Tone, string> = {
    ok: '#5b8a4a',
    warn: '#c98a1a',
    bad: '#b94a3a',
};

// Track (unfilled) ring/bar color on the dark GNOME panel & dropdown.
export const TRACK_RGBA: [number, number, number, number] = [1, 1, 1, 0.18];

/**
 * Severity for a used-percentage given per-provider thresholds.
 * pct >= critical -> bad ; pct >= warn -> warn ; else ok.
 */
export function toneFromPct(pct: number, warn = 65, critical = 85): Tone {
    if (pct >= critical)
        return 'bad';
    if (pct >= warn)
        return 'warn';
    return 'ok';
}

/**
 * Convert a "#rrggbb" hex string into cairo's [r, g, b, a] floats (0..1).
 */
export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return [r, g, b, alpha];
}

export function toneRgba(tone: Tone, alpha = 1): [number, number, number, number] {
    return hexToRgba(TONE_HEX[tone], alpha);
}

/**
 * Human label for a usage window, derived from its real duration rather than
 * hardcoded ("5 HOUR" / "DAY" / "WEEK" / "MONTH" / "{n}h" / "{n}d" fallback).
 */
export function windowLabel(seconds: number | undefined | null): string {
    if (!seconds || seconds <= 0)
        return '';
    const hours = seconds / 3600;
    if (hours <= 6)
        return `${Math.round(hours)} HOUR`;
    if (Math.abs(hours - 24) < 6)
        return 'DAY';
    if (Math.abs(hours - 168) < 24)
        return 'WEEK';
    if (Math.abs(hours - 720) < 120)
        return 'MONTH';
    if (hours < 24)
        return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
}
