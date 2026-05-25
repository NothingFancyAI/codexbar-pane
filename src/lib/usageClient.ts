// Usage data client. Two sources, one normalized shape:
//   • API providers (e.g. Codex) — HTTP via libsoup, ported from usageApi.js.
//   • CLI providers — spawn the configured command (codexbar) and parse JSON,
//     ported from the subprocess path in the reference extension.js.
// Both feed the same recursive window discovery + normalization.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API_BASE_URL = 'https://chatgpt.com';
const SUMMARY_ENDPOINT = '/backend-api/wham/usage';
const ME_ENDPOINT = '/backend-api/me';
const SESSION_ENDPOINT = '/api/auth/session';

const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
}

export class UsageApiError extends Error {
    statusCode: number;
    payload: unknown;

    constructor(message: string, opts: {statusCode?: number; payload?: unknown} = {}) {
        super(message);
        this.name = 'UsageApiError';
        this.statusCode = opts.statusCode ?? 0;
        this.payload = opts.payload ?? null;
    }

    get isAuthError(): boolean {
        return this.statusCode === 401 || this.statusCode === 403;
    }
}

export class UsageClient {
    private _session: Soup.Session | null;

    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 30;
    }

    destroy(): void {
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    // ---- API providers (Codex) -------------------------------------------

    async fetchApi(cookies: string, cancellable: Gio.Cancellable): Promise<NormalizedUsage> {
        let sessionData: any;
        try {
            sessionData = await this._getJson(SESSION_ENDPOINT, cookies, cancellable);
        } catch (e) {
            throw new UsageApiError(`Failed to retrieve access token: ${(e as Error).message}`);
        }

        if (!sessionData || !sessionData.accessToken) {
            throw new UsageApiError(
                'Failed to retrieve access token from session. Cookies might be invalid.',
            );
        }

        const usagePayload: any = await this._getJsonWithAuth(
            SUMMARY_ENDPOINT, sessionData.accessToken, cancellable,
        );

        if (!usagePayload.email) {
            try {
                const meData: any = await this._getJsonWithAuth(
                    ME_ENDPOINT, sessionData.accessToken, cancellable,
                );
                if (meData?.email)
                    usagePayload.email = meData.email;
            } catch {
                // Silent fallback — email is non-essential.
            }
        }

        return this.normalizeSummary(usagePayload);
    }

    private async _getJson(path: string, cookies: string, cancellable: Gio.Cancellable): Promise<unknown> {
        if (!cookies)
            throw new UsageApiError('Authentication cookies are required.');

        const message = Soup.Message.new('GET', `${API_BASE_URL}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Cookie', cookies);
        headers.append('Referer', 'https://chatgpt.com/');
        headers.append('User-Agent', USER_AGENT);

        const match = cookies.match(/oai-did=([^;]+)/);
        if (match)
            headers.append('oai-device-id', match[1]);

        return this._executeRequest(message, cancellable);
    }

    private async _getJsonWithAuth(path: string, accessToken: string, cancellable: Gio.Cancellable): Promise<unknown> {
        const message = Soup.Message.new('GET', `${API_BASE_URL}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Authorization', `Bearer ${accessToken}`);
        headers.append('Referer', 'https://chatgpt.com/');
        headers.append('User-Agent', USER_AGENT);

        return this._executeRequest(message, cancellable);
    }

    private async _executeRequest(message: Soup.Message, cancellable: Gio.Cancellable): Promise<unknown> {
        const session = this._session;
        if (!session)
            throw new UsageApiError('Client destroyed.');

        let bytes: GLib.Bytes;
        try {
            bytes = await new Promise<GLib.Bytes>((resolve, reject) => {
                session.send_and_read_async(
                    message, GLib.PRIORITY_DEFAULT, cancellable,
                    (_s: Soup.Session | null, res: Gio.AsyncResult) => {
                        try {
                            resolve(session.send_and_read_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
        } catch (error) {
            throw new UsageApiError((error as Error).message || String(error));
        }

        const statusCode = message.get_status() as unknown as number;
        const body = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());

        let payload: any = null;
        try {
            payload = body ? JSON.parse(body) : null;
        } catch (error) {
            if (statusCode >= 400)
                throw new UsageApiError(`HTTP ${statusCode}: ${body.substring(0, 100)}`, {statusCode});
            throw new UsageApiError(`Invalid JSON: ${(error as Error).message}`, {statusCode});
        }

        if (statusCode < 200 || statusCode >= 300) {
            let messageText =
                payload?.message || payload?.error?.message || payload?.error || `HTTP ${statusCode}`;
            if (typeof messageText === 'object')
                messageText = JSON.stringify(messageText);
            throw new UsageApiError(messageText, {statusCode, payload});
        }

        return payload;
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
            resetDescription: formatReset(w.reset_after_seconds),
            windowSeconds: w.window_seconds,
        } : null;

        return {
            usage: {
                accountEmail: payload?.email || payload?.accountEmail || undefined,
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
