// One provider row in the dropdown: ring glyph + 5-hour primary bar + an
// indented, smaller weekly secondary bar, with time-left in the tone color.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';

import {Tone, TONE_HEX, windowLabel} from '../lib/tone.js';
import {RingGlyph} from './ringGlyph.js';

export interface WindowView {
    pct: number;
    tone: Tone;
    leftLabel: string;       // resetDescription / time-left, rendered in tone
    windowSeconds: number;
}

export interface ProviderRowOptions {
    name: string;
    gicon?: Gio.Icon | null;
    letter?: string;
}

const PRIMARY_BAR_W = 150;
const PRIMARY_BAR_H = 9;
const SECONDARY_BAR_W = 110;
const SECONDARY_BAR_H = 4;

export class ProviderRow {
    readonly actor: St.BoxLayout;
    readonly glyph: RingGlyph;

    private _pct: St.Label;
    private _status: St.Label;

    private _primaryBox: St.BoxLayout;
    private _primaryLabel: St.Label;
    private _primaryFill: St.Widget;
    private _primaryLeft: St.Label;

    private _secondaryBox: St.BoxLayout;
    private _secondaryLabel: St.Label;
    private _secondaryFill: St.Widget;
    private _secondaryLeft: St.Label;

    constructor(opts: ProviderRowOptions) {
        this.actor = new St.BoxLayout({
            style_class: 'codexbar-row',
            x_expand: true,
        });

        this.glyph = new RingGlyph({
            size: 26,
            onDark: false,
            gicon: opts.gicon ?? null,
            letter: opts.letter ?? opts.name,
        });
        const glyphWrap = new St.Bin({
            style_class: 'codexbar-row-glyph',
            child: this.glyph,
            y_align: Clutter.ActorAlign.START,
        });
        this.actor.add_child(glyphWrap);

        const right = new St.BoxLayout({vertical: true, x_expand: true});
        this.actor.add_child(right);

        // Header: name + right-aligned "{5h%} · {week%}".
        const header = new St.BoxLayout({x_expand: true});
        const name = new St.Label({
            text: opts.name,
            style_class: 'codexbar-row-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pct = new St.Label({
            style_class: 'codexbar-row-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(name);
        header.add_child(this._pct);
        right.add_child(header);

        // Primary (5-hour) bar.
        [this._primaryBox, this._primaryLabel, this._primaryFill, this._primaryLeft] =
            this._buildBarRow(false);
        right.add_child(this._primaryBox);

        // Secondary (weekly) bar — indented, smaller.
        [this._secondaryBox, this._secondaryLabel, this._secondaryFill, this._secondaryLeft] =
            this._buildBarRow(true);
        right.add_child(this._secondaryBox);

        // Loading / error status line (hidden by default).
        this._status = new St.Label({
            style_class: 'codexbar-row-status',
            visible: false,
        });
        right.add_child(this._status);
    }

    private _buildBarRow(secondary: boolean): [St.BoxLayout, St.Label, St.Widget, St.Label] {
        const box = new St.BoxLayout({
            style_class: secondary ? 'codexbar-row-secondary' : '',
            x_expand: true,
        });

        const label = new St.Label({
            style_class: secondary
                ? 'codexbar-window-label codexbar-window-label-secondary'
                : 'codexbar-window-label codexbar-window-label-primary',
            width: 46,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const track = new St.BoxLayout({
            style_class: secondary
                ? 'codexbar-bar-track codexbar-bar-track-secondary'
                : 'codexbar-bar-track codexbar-bar-track-primary',
            width: secondary ? SECONDARY_BAR_W : PRIMARY_BAR_W,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const fill = new St.Widget({
            style_class: 'codexbar-bar-fill',
            height: secondary ? SECONDARY_BAR_H : PRIMARY_BAR_H,
            x_align: Clutter.ActorAlign.START,
        });
        track.add_child(fill);

        const left = new St.Label({
            style_class: secondary
                ? 'codexbar-left codexbar-left-secondary'
                : 'codexbar-left codexbar-left-primary',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(label);
        box.add_child(track);
        box.add_child(left);
        return [box, label, fill, left];
    }

    private _setFill(fill: St.Widget, trackWidth: number, pct: number, tone: Tone): void {
        const w = Math.max(0, Math.min(trackWidth, Math.round(trackWidth * pct / 100)));
        fill.set_width(w);
        fill.set_style(`background-color: ${TONE_HEX[tone]};`);
    }

    /** Update the row from picked windows. Pass week = null to hide the weekly bar. */
    setData(short: WindowView, week: WindowView | null, displayMode: string): void {
        this._status.hide();
        this._showBars(true);

        const shortPct = Math.round(short.pct);
        const weekPct = week ? Math.round(week.pct) : null;
        const fmt = (p: number) => displayMode === 'remaining' ? 100 - p : p;
        this._pct.set_text(
            weekPct != null ? `${fmt(shortPct)}% · ${fmt(weekPct)}%` : `${fmt(shortPct)}%`,
        );

        // Glyph rings mirror the row.
        this.glyph.setRings(
            {pct: short.pct, tone: short.tone},
            week ? {pct: week.pct, tone: week.tone} : null,
        );

        this._primaryLabel.set_text(windowLabel(short.windowSeconds) || '5 HOUR');
        this._setFill(this._primaryFill, PRIMARY_BAR_W, short.pct, short.tone);
        this._primaryLeft.set_text(short.leftLabel || `${shortPct}%`);
        this._primaryLeft.set_style(`color: ${TONE_HEX[short.tone]};`);

        if (week) {
            this._secondaryBox.show();
            this._secondaryLabel.set_text(windowLabel(week.windowSeconds) || 'WEEK');
            this._setFill(this._secondaryFill, SECONDARY_BAR_W, week.pct, week.tone);
            this._secondaryLeft.set_text(week.leftLabel || `${weekPct}%`);
            this._secondaryLeft.set_style(`color: ${TONE_HEX[week.tone]};`);
        } else {
            this._secondaryBox.hide();
        }
    }

    setLoading(): void {
        this._showBars(false);
        this._status.remove_style_class_name('codexbar-row-status-error');
        this._status.set_text('Loading…');
        this._status.show();
        this._pct.set_text('');
        this.glyph.setRings(null, null);
    }

    setError(message: string): void {
        this._showBars(false);
        this._status.add_style_class_name('codexbar-row-status-error');
        this._status.set_text(message);
        this._status.show();
        this._pct.set_text('');
        this.glyph.setRings(null, null);
    }

    private _showBars(show: boolean): void {
        this._primaryBox.visible = show;
        this._secondaryBox.visible = show;
    }

    destroy(): void {
        this.actor.destroy();
    }
}
