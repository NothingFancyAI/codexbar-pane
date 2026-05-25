// Lightweight floating tooltip, shown under a panel glyph on hover.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Tone, TONE_HEX} from '../lib/tone.js';

export interface TooltipLine {
    label: string;       // e.g. "5 hour"
    value: string;       // e.g. "78% · 1h 05m"
    tone?: Tone;
    week?: boolean;      // smaller/dimmer styling
}

export class Tooltip {
    private _box: St.BoxLayout;
    private _title: St.Label;
    private _lineBox: St.BoxLayout;
    private _visible = false;

    constructor() {
        this._box = new St.BoxLayout({
            style_class: 'codexbar-tooltip',
            vertical: true,
            visible: false,
            reactive: false,
        });

        this._title = new St.Label({style_class: 'codexbar-tooltip-title'});
        this._box.add_child(this._title);

        this._lineBox = new St.BoxLayout({vertical: true});
        this._box.add_child(this._lineBox);

        Main.layoutManager.uiGroup.add_child(this._box);
    }

    /** Populate and position the tooltip centered under `source`. */
    show(source: Clutter.Actor, title: string, lines: TooltipLine[]): void {
        this._title.set_text(title);
        this._lineBox.destroy_all_children();

        for (const line of lines) {
            const row = new St.BoxLayout({
                style_class: line.week ? 'codexbar-tooltip-row codexbar-tooltip-row-week' : 'codexbar-tooltip-row',
            });
            const name = new St.Label({text: line.label, x_expand: true});
            const value = new St.Label({text: line.value});
            if (line.tone)
                value.set_style(`color: ${TONE_HEX[line.tone]};`);
            row.add_child(name);
            row.add_child(value);
            this._lineBox.add_child(row);
        }

        this._box.show();
        this._visible = true;
        this._reposition(source);
    }

    private _reposition(source: Clutter.Actor): void {
        const [sx, sy] = source.get_transformed_position();
        const sw = source.width;
        const [, natW] = this._box.get_preferred_width(-1);
        const [, natH] = this._box.get_preferred_height(natW);

        let x = Math.round((sx ?? 0) + sw / 2 - natW / 2);
        const y = Math.round((sy ?? 0) + source.height + 4);

        // Clamp within the monitor that contains the source.
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            const maxX = monitor.x + monitor.width - natW - 4;
            x = Math.max(monitor.x + 4, Math.min(x, maxX));
        }
        void natH;
        this._box.set_position(x, y);
    }

    hide(): void {
        if (!this._visible)
            return;
        this._visible = false;
        this._box.hide();
    }

    destroy(): void {
        this._box.destroy();
    }
}
