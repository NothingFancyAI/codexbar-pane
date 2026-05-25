// CodexBar Pane — concentric-rings AI subscription usage indicator.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {UsageClient} from './lib/usageClient.js';
import {loadToken} from './lib/secret.js';
import {
    ProviderConfig,
    pickWindows,
    DEFAULT_WARN_PCT,
    DEFAULT_CRITICAL_PCT,
} from './lib/providers.js';
import {toneFromPct} from './lib/tone.js';
import {CodexBarIndicator} from './ui/panelIndicator.js';
import type {WindowView} from './ui/providerRow.js';
import type {UsageWindow} from './lib/usageClient.js';

export default class CodexBarExtension extends Extension {
    private _settings: Gio.Settings | null = null;
    private _client: UsageClient | null = null;
    private _indicator: InstanceType<typeof CodexBarIndicator> | null = null;
    private _cancellable: Gio.Cancellable | null = null;

    private _providers: ProviderConfig[] = [];
    private _signalIds: number[] = [];
    private _timerIds: number[] = [];
    private _inFlight: Set<string> = new Set();
    private _notified: Map<string, boolean> = new Map();

    override enable(): void {
        this._settings = this.getSettings();
        this._client = new UsageClient();
        this._cancellable = new Gio.Cancellable();

        this._indicator = new CodexBarIndicator({
            iconsDir: `${this.path}/icons`,
            onRefresh: () => this._refreshAll(),
            onOpenPrefs: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._signalIds.push(
            this._settings.connect('changed::providers', () => this._onProvidersChanged()),
            this._settings.connect('changed::refresh-interval', () => this._setupTimers()),
            this._settings.connect('changed::display-mode', () => {
                this._indicator?.setDisplayMode(this._settings!.get_string('display-mode'));
                this._refreshAll();
            }),
        );

        this._indicator.setDisplayMode(this._settings.get_string('display-mode'));
        this._onProvidersChanged();
    }

    override disable(): void {
        this._clearTimers();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._settings) {
            for (const id of this._signalIds)
                this._settings.disconnect(id);
            this._signalIds = [];
            this._settings = null;
        }
        if (this._client) {
            this._client.destroy();
            this._client = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._providers = [];
        this._inFlight.clear();
        this._notified.clear();
    }

    private _onProvidersChanged(): void {
        this._providers = this._parseProviders();
        this._indicator?.rebuild(this._providers);
        this._refreshAll();
        this._setupTimers();
    }

    private _parseProviders(): ProviderConfig[] {
        if (!this._settings)
            return [];
        try {
            const parsed = JSON.parse(this._settings.get_string('providers'));
            if (!Array.isArray(parsed))
                return [];
            return parsed.map((p: any, i: number): ProviderConfig => ({
                id: p.id ?? `provider-${i}`,
                name: p.name ?? 'Unknown',
                command: p.command ?? '',
                useApi: !!p.useApi,
                pollSeconds: typeof p.pollSeconds === 'number' ? p.pollSeconds : undefined,
                warnPct: typeof p.warnPct === 'number' ? p.warnPct : undefined,
                criticalPct: typeof p.criticalPct === 'number' ? p.criticalPct : undefined,
                notify: p.notify !== false,
            }));
        } catch (e) {
            console.error(`codexbar-pane: failed to parse providers — ${(e as Error).message}`);
            return [];
        }
    }

    private _setupTimers(): void {
        this._clearTimers();
        if (!this._settings)
            return;
        const fallback = Math.max(1, this._settings.get_int('refresh-interval')) * 60;

        for (const provider of this._providers) {
            const seconds = provider.pollSeconds && provider.pollSeconds > 0
                ? provider.pollSeconds
                : fallback;
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this._refreshProvider(provider);
                return GLib.SOURCE_CONTINUE;
            });
            this._timerIds.push(id);
        }
    }

    private _clearTimers(): void {
        for (const id of this._timerIds)
            GLib.source_remove(id);
        this._timerIds = [];
    }

    private _refreshAll(): void {
        for (const provider of this._providers)
            this._refreshProvider(provider);
    }

    private async _refreshProvider(provider: ProviderConfig): Promise<void> {
        if (!this._client || !this._cancellable || !this._indicator)
            return;
        if (this._inFlight.has(provider.id))
            return;
        this._inFlight.add(provider.id);

        const cancellable = this._cancellable;
        this._indicator.setLoading(provider.id);

        try {
            let result;
            if (provider.useApi) {
                const token = loadToken(provider.id);
                if (!token) {
                    this._indicator.setError(provider.id, 'No token found in keyring');
                    return;
                }
                result = await this._client.fetchApi(token, cancellable);
            } else {
                if (!provider.command) {
                    this._indicator.setError(provider.id, 'No command configured');
                    return;
                }
                result = await this._client.fetchCli(provider.command, cancellable);
                if (result === null)
                    return; // cancelled
            }

            if (cancellable.is_cancelled())
                return;

            const {short, week} = pickWindows(result.usage);
            if (!short) {
                this._indicator.setError(provider.id, 'No usage data');
                return;
            }

            const warn = provider.warnPct ?? DEFAULT_WARN_PCT;
            const critical = provider.criticalPct ?? DEFAULT_CRITICAL_PCT;

            const view = (w: UsageWindow): WindowView => ({
                pct: w.usedPercent,
                tone: toneFromPct(w.usedPercent, warn, critical),
                leftLabel: w.resetDescription,
                windowSeconds: w.windowSeconds,
            });

            const shortView = view(short);
            const weekView = week ? view(week) : null;
            const isCritical = short.usedPercent >= critical;

            this._indicator.setData(provider.id, shortView, weekView, isCritical);
            this._maybeNotify(provider, isCritical);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            const message = (e as Error)?.message || String(e) || 'Unknown error';
            this._indicator?.setError(provider.id, message);
        } finally {
            this._inFlight.delete(provider.id);
        }
    }

    private _maybeNotify(provider: ProviderConfig, isCritical: boolean): void {
        const wasNotified = this._notified.get(provider.id) ?? false;
        if (isCritical && provider.notify && !wasNotified) {
            Main.notify(provider.name, '5-hour window almost out');
            this._notified.set(provider.id, true);
        } else if (!isCritical && wasNotified) {
            this._notified.set(provider.id, false);
        }
    }
}
