// Top-bar indicator: a row of concentric-ring glyphs (one per provider) plus a
// dropdown listing every provider with 5-hour + weekly bars. Critical providers
// pulse; hovering a glyph shows a floating tooltip.

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Tone} from '../lib/tone.js';
import {ProviderConfig, logoForProvider} from '../lib/providers.js';
import {RingGlyph} from './ringGlyph.js';
import {ProviderRow, WindowView} from './providerRow.js';
import {Tooltip, TooltipLine} from './tooltip.js';

const PANEL_GLYPH_SIZE = 22;
const PULSE_NAME = 'codexbar-pulse';

export interface IndicatorOptions {
    iconsDir: string;
    onRefresh: () => void;
    onOpenPrefs: () => void;
}

interface ProviderEntry {
    config: ProviderConfig;
    panelGlyph: RingGlyph;
    row: ProviderRow;
    separator: St.Widget;
    pulsing: boolean;
    tooltipTitle: string;
    tooltipLines: TooltipLine[];
}

export class CodexBarIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    private _opts!: IndicatorOptions;
    private _panelBox!: St.BoxLayout;
    private _rowsBox!: St.BoxLayout;
    private _emptyLabel!: St.Label;
    private _titleLabel!: St.Label;
    private _tooltip!: Tooltip;
    private _entries: Map<string, ProviderEntry> = new Map();
    private _displayMode = 'used';

    constructor(opts: IndicatorOptions) {
        super(0.0, 'CodexBar Pane', false);
        this._opts = opts;

        this._panelBox = new St.BoxLayout({
            style_class: 'codexbar-panel-glyphs',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._tooltip = new Tooltip();
        this._buildMenu();
    }

    private _buildMenu(): void {
        const menu = this.menu as any;
        menu.box.add_style_class_name('codexbar-popup');

        // Header: title + refresh + open-prefs.
        const header = new St.BoxLayout({style_class: 'codexbar-header'});
        this._titleLabel = new St.Label({
            text: 'AI Subscriptions',
            style_class: 'codexbar-header-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._titleLabel);

        const refreshBtn = new St.Button({
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}),
            style_class: 'codexbar-header-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshBtn.connect('clicked', () => this._opts.onRefresh());
        header.add_child(refreshBtn);

        const prefsBtn = new St.Button({
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 16}),
            style_class: 'codexbar-header-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        prefsBtn.connect('clicked', () => {
            menu.close();
            this._opts.onOpenPrefs();
        });
        header.add_child(prefsBtn);
        menu.box.add_child(header);

        // Legend.
        const legend = new St.Label({
            text: '◉ 5 HOUR  ·  ◌ WEEK',
            style_class: 'codexbar-legend',
        });
        menu.box.add_child(legend);

        // Rows container.
        this._rowsBox = new St.BoxLayout({vertical: true, x_expand: true});
        menu.box.add_child(this._rowsBox);

        this._emptyLabel = new St.Label({
            text: 'No providers configured. Open settings to add one.',
            style_class: 'codexbar-empty',
            visible: false,
        });
        menu.box.add_child(this._emptyLabel);
    }

    setDisplayMode(mode: string): void {
        this._displayMode = mode;
    }

    /** Recreate panel glyphs and dropdown rows for the given providers. */
    rebuild(providers: ProviderConfig[]): void {
        this._clearEntries();

        for (const config of providers) {
            const logo = logoForProvider(config);
            const gicon = logo
                ? Gio.icon_new_for_string(`${this._opts.iconsDir}/${logo}`)
                : null;
            const discColor = config.color || null;

            const panelGlyph = new RingGlyph({
                size: PANEL_GLYPH_SIZE,
                onDark: true,
                gicon,
                letter: config.name,
                discColor,
                reactive: true,
            });
            this._wireTooltip(config.id, panelGlyph);
            this._panelBox.add_child(panelGlyph);

            const row = new ProviderRow({
                name: config.name,
                gicon: logo ? Gio.icon_new_for_string(`${this._opts.iconsDir}/${logo}`) : null,
                letter: config.name,
                discColor,
            });
            this._rowsBox.add_child(row.actor);

            const separator = new St.Widget({style_class: 'codexbar-sep', x_expand: true});
            this._rowsBox.add_child(separator);

            this._entries.set(config.id, {
                config,
                panelGlyph,
                row,
                separator,
                pulsing: false,
                tooltipTitle: config.name,
                tooltipLines: [{label: 'loading', value: '…'}],
            });
        }

        // With no providers, show a single default icon so the indicator stays
        // visible and clickable (the menu offers "open settings").
        if (providers.length === 0) {
            const defaultIcon = new St.Icon({
                gicon: Gio.icon_new_for_string(`${this._opts.iconsDir}/ai_usage.png`),
                icon_size: PANEL_GLYPH_SIZE,
                style_class: 'codexbar-default-icon',
            });
            this._panelBox.add_child(defaultIcon);
        }

        this._refreshSeparators();
        this._emptyLabel.visible = providers.length === 0;
    }

    private _wireTooltip(id: string, glyph: RingGlyph): void {
        glyph.connect('enter-event', () => {
            const entry = this._entries.get(id);
            if (entry)
                this._tooltip.show(glyph, entry.tooltipTitle, entry.tooltipLines);
            return Clutter.EVENT_PROPAGATE;
        });
        glyph.connect('leave-event', () => {
            this._tooltip.hide();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    setLoading(id: string): void {
        const entry = this._entries.get(id);
        if (!entry)
            return;
        entry.row.setLoading();
        entry.panelGlyph.setRings(null, null);
        this._stopPulse(entry);
        entry.tooltipLines = [{label: 'status', value: 'Loading…'}];
    }

    setError(id: string, message: string): void {
        const entry = this._entries.get(id);
        if (!entry)
            return;
        entry.row.setError(message);
        entry.panelGlyph.setRings(null, null);
        this._stopPulse(entry);
        entry.tooltipLines = [{label: 'error', value: message, tone: 'bad'}];
    }

    /** Push fresh data. `critical` drives the panel pulse. */
    setData(id: string, short: WindowView, week: WindowView | null, critical: boolean): void {
        const entry = this._entries.get(id);
        if (!entry)
            return;

        entry.row.setData(short, week, this._displayMode);
        entry.panelGlyph.setRings(
            {pct: short.pct, tone: short.tone},
            week ? {pct: week.pct, tone: week.tone} : null,
        );

        const lines: TooltipLine[] = [{
            label: '5 hour',
            value: `${Math.round(short.pct)}%${short.leftLabel ? ` · ${short.leftLabel}` : ''}`,
            tone: short.tone,
        }];
        if (week) {
            lines.push({
                label: '1 week',
                value: `${Math.round(week.pct)}%${week.leftLabel ? ` · ${week.leftLabel}` : ''}`,
                tone: week.tone,
                week: true,
            });
        }
        entry.tooltipLines = lines;

        if (critical)
            this._startPulse(entry);
        else
            this._stopPulse(entry);
    }

    private _startPulse(entry: ProviderEntry): void {
        if (entry.pulsing)
            return;
        entry.pulsing = true;
        const transition = new Clutter.PropertyTransition({property_name: 'opacity'});
        transition.set_from(255);
        transition.set_to(90);
        transition.set_duration(900);
        transition.set_auto_reverse(true);
        transition.set_repeat_count(-1);
        transition.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_QUAD);
        entry.panelGlyph.add_transition(PULSE_NAME, transition);
    }

    private _stopPulse(entry: ProviderEntry): void {
        if (!entry.pulsing)
            return;
        entry.pulsing = false;
        entry.panelGlyph.remove_transition(PULSE_NAME);
        entry.panelGlyph.set_opacity(255);
    }

    private _refreshSeparators(): void {
        const entries = [...this._entries.values()];
        entries.forEach((entry, i) => {
            entry.separator.visible = i < entries.length - 1;
        });
    }

    private _clearEntries(): void {
        for (const entry of this._entries.values()) {
            this._stopPulse(entry);
            entry.row.destroy();
            entry.separator.destroy();
            entry.panelGlyph.destroy();
        }
        this._entries.clear();
        this._panelBox.destroy_all_children();
        this._rowsBox.destroy_all_children();
    }

    override destroy(): void {
        for (const entry of this._entries.values())
            this._stopPulse(entry);
        this._entries.clear();
        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null as any;
        }
        super.destroy();
    }
}

// Re-export for the extension's tone typing convenience.
export type {Tone};
