// Usage data client. CLI providers spawn the configured command (codexbar)
// and parse its JSON output, feeding a recursive window discovery +
// normalization step that yields one normalized shape.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Common install locations for the codexbar CLI.
const CLI_PATHS = [
    '/home/linuxbrew/.linuxbrew/bin/codexbar',
    `${GLib.get_home_dir()}/.local/bin/codexbar`,
    '/usr/local/bin/codexbar',
    '/usr/bin/codexbar',
];

/** A single normalized usage window/tier. */
export interface UsageWindow {
    usedPercent: number;
    resetDescription: string;
    windowSeconds: number;
}

/** Normalized usage, smallest window first (primary). */
export interface Usage {
    accountEmail?: string;
    updatedAt?: string;
    primary: UsageWindow | null;
    secondary: UsageWindow | null;
    tertiary: UsageWindow | null;
    quaternary: UsageWindow | null;
}

export interface NormalizedUsage {
    usage: Usage;
}

interface RawWindow {
    used: number;
    limit: number;
    percent: number;
    window_seconds: number;
    reset_after_seconds: number;
    // Pre-formatted reset text supplied by the source (codexbar), used when
    // reset_after_seconds is unavailable/zero.
    reset_description?: string;
}

export class UsageApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageApiError';
    }
}

export class UsageClient {
    destroy(): void {
        // No long-lived resources to release; kept for lifecycle symmetry.
    }

    // ---- CLI providers (codexbar) ----------------------------------------

    /**
     * Run the configured CLI command, parse its JSON output, and normalize it.
     * Returns null when the call was cancelled.
     */
    async fetchCli(command: string, cancellable: Gio.Cancellable): Promise<NormalizedUsage | null> {
        if (!command)
            throw new UsageApiError('No command configured.');

        const finalCommand = this._resolveCommand(command);

        const proc = Gio.Subprocess.new(
            ['bash', '-c', finalCommand],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        const [stdout, stderr] = await new Promise<[string, string]>((resolve, reject) => {
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    const [, out, err] = p!.communicate_utf8_finish(res);
                    resolve([out ?? '', err ?? '']);
                } catch (e) {
                    if ((e as any).matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        resolve(['', '']);
                    else
                        reject(e);
                }
            });
        });

        if (cancellable.is_cancelled())
            return null;

        const trimmedOut = stdout.trim();
        const trimmedErr = stderr.trim();

        if (trimmedOut && (trimmedOut.startsWith('[') || trimmedOut.startsWith('{'))) {
            let parsed: any;
            try {
                parsed = JSON.parse(trimmedOut);
            } catch (e) {
                throw new UsageApiError(`JSON error: ${(e as Error).message}`);
            }
            const payload = Array.isArray(parsed) ? parsed[0] : parsed;
            return this.normalizeSummary(payload);
        }

        if (trimmedErr)
            throw new UsageApiError(`CLI error: ${trimmedErr.split('\n')[0]}`);
        if (trimmedOut)
            throw new UsageApiError('Output is not valid JSON.');
        throw new UsageApiError('No output from command.');
    }

    /** Substitute a bare "codexbar" prefix with the first existing absolute path. */
    private _resolveCommand(command: string): string {
        if (!command.startsWith('codexbar') || command.startsWith('/'))
            return command;

        let executable = CLI_PATHS[0];
        for (const path of CLI_PATHS) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                executable = path;
                break;
            }
        }
        return command.replace('codexbar', executable);
    }

    // ---- normalization ----------------------------------------------------

    normalizeSummary(payload: any): NormalizedUsage {
        const windows = this.extractWindows(payload);
        const sorted = windows.sort((a, b) => (a.window_seconds || 0) - (b.window_seconds || 0));

        const formatReset = (seconds: number): string => {
            if (!seconds)
                return '';
            if (seconds < 60)
                return `Resets in ${Math.round(seconds)}s`;
            if (seconds < 3600)
                return `Resets in ${Math.round(seconds / 60)}m`;
            if (seconds < 86400)
                return `Resets in ${Math.round(seconds / 3600)}h`;
            return `Resets in ${Math.round(seconds / 86400)}d`;
        };

        const mapWindow = (w: RawWindow | undefined): UsageWindow | null => w ? {
            usedPercent: w.percent * 100,
            resetDescription: formatReset(w.reset_after_seconds) || w.reset_description || '',
            windowSeconds: w.window_seconds,
        } : null;

        return {
            usage: {
                accountEmail: payload?.email || payload?.accountEmail
                    || payload?.usage?.accountEmail || payload?.usage?.identity?.accountEmail || undefined,
                updatedAt: new Date().toISOString(),
                primary: mapWindow(sorted[0]),
                secondary: mapWindow(sorted[1]),
                tertiary: mapWindow(sorted[2]),
                quaternary: mapWindow(sorted[3]),
            },
        };
    }

    /** Recursively discover usage windows from any JSON structure. */
    extractWindows(payload: any): RawWindow[] {
        const windows: RawWindow[] = [];
        const seen = new Set<object>();

        const collect = (obj: any): void => {
            if (!obj || typeof obj !== 'object' || seen.has(obj))
                return;
            seen.add(obj);

            // Direct used_percent (OpenAI free plans).
            if (obj.used_percent !== undefined) {
                const percent = parseFloat(obj.used_percent) / 100;
                if (!isNaN(percent)) {
                    windows.push({
                        used: percent,
                        limit: 1,
                        percent,
                        window_seconds: obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || 0,
                        reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0,
                    });
                }
            }

            // codexbar window shape: usedPercent (0-100), windowMinutes,
            // resetsAt (ISO timestamp) and/or a human resetDescription.
            if (obj.usedPercent !== undefined && (obj.windowMinutes !== undefined || obj.windowSeconds !== undefined)) {
                const percent = parseFloat(obj.usedPercent) / 100;
                if (!isNaN(percent)) {
                    const windowSeconds = obj.windowSeconds !== undefined
                        ? parseFloat(obj.windowSeconds)
                        : parseFloat(obj.windowMinutes) * 60;
                    let resetAfter = 0;
                    if (obj.resetsAt) {
                        const ms = Date.parse(obj.resetsAt) - Date.now();
                        if (!isNaN(ms) && ms > 0)
                            resetAfter = ms / 1000;
                    }
                    windows.push({
                        used: percent,
                        limit: 1,
                        percent,
                        window_seconds: windowSeconds || 0,
                        reset_after_seconds: resetAfter,
                        reset_description: obj.resetDescription || undefined,
                    });
                }
            }

            // used/limit (or remaining/total) pairs.
            let usedValue = obj.used ?? obj.usage ?? obj.count ?? obj.current_usage;
            const limitValue = obj.limit ?? obj.cap ?? obj.max ?? obj.usage_limit ?? obj.total;

            if (usedValue === undefined && obj.remaining !== undefined && limitValue !== undefined)
                usedValue = parseFloat(limitValue) - parseFloat(obj.remaining);

            if (usedValue !== undefined && limitValue !== undefined) {
                const used = parseFloat(usedValue);
                const limit = parseFloat(limitValue);
                if (!isNaN(used) && !isNaN(limit) && limit > 0) {
                    windows.push({
                        used,
                        limit,
                        percent: used / limit,
                        window_seconds: obj.window_seconds || obj.duration_seconds || 0,
                        reset_after_seconds: obj.reset_after_seconds || 0,
                    });
                }
            }

            for (const key in obj)
                collect(obj[key]);
        };

        collect(payload);

        // De-duplicate windows by (window_seconds, percent).
        return windows.filter((w, index, self) =>
            index === self.findIndex(t =>
                t.window_seconds === w.window_seconds && t.percent === w.percent));
    }
}
