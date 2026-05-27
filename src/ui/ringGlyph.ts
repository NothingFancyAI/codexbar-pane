// Concentric-ring glyph: a thick outer ring (5-hour window) and a thinner
// inner ring (weekly window), with the provider's logo (or a letter) centered.

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Cairo from 'gi://cairo';

import {Tone, toneRgba, hexToRgba, TRACK_RGBA} from '../lib/tone.js';

// GJS implements cairo methods natively; @girs types the context only as a
// foreign struct, so we describe the subset we use here.
interface CairoContext {
    setLineWidth(width: number): void;
    setLineCap(cap: number): void;
    setSourceRGBA(r: number, g: number, b: number, a: number): void;
    arc(cx: number, cy: number, r: number, angle1: number, angle2: number): void;
    stroke(): void;
    fill(): void;
    $dispose(): void;
}

export interface RingValue {
    pct: number;
    tone: Tone;
}

export interface RingGlyphOptions {
    size?: number;        // diameter of the centered icon area
    onDark?: boolean;     // panel (dark) vs dropdown — affects track alpha
    gicon?: Gio.Icon | null;
    letter?: string;      // fallback identity when no logo
    discColor?: string | null; // account accent disc "#rrggbb" behind the icon
    reactive?: boolean;   // enable hover events (panel glyphs)
}

const OUTER_STROKE = 2.5;
const INNER_STROKE = 1.25;

export class RingGlyph extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    private _size: number;
    private _discColor: string | null;
    private _outer: RingValue | null = null;
    private _inner: RingValue | null = null;
    private _area!: St.DrawingArea;

    constructor(opts: RingGlyphOptions = {}) {
        const size = opts.size ?? 22;
        const pad = 6;
        const w = size + pad * 2;

        super({
            style_class: 'codexbar-ring-glyph',
            layout_manager: new Clutter.BinLayout(),
            width: w,
            height: w,
            reactive: opts.reactive ?? false,
            track_hover: opts.reactive ?? false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._size = size;
        this._discColor = opts.discColor ?? null;

        const trackAlpha = opts.onDark === false ? 0.12 : TRACK_RGBA[3];

        this._area = new St.DrawingArea({
            width: w,
            height: w,
            x_expand: true,
            y_expand: true,
        });
        this._area.connect('repaint', () => this._repaint(trackAlpha));
        this.add_child(this._area);

        // Centered identity: logo if available, else first-letter label.
        if (opts.gicon) {
            const icon = new St.Icon({
                gicon: opts.gicon,
                icon_size: Math.round(size * 0.62),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(icon);
        } else if (opts.letter) {
            const label = new St.Label({
                text: opts.letter.substring(0, 1).toUpperCase(),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-weight: bold; font-size: ${Math.round(size * 0.5)}px;`,
            });
            label.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
            this.add_child(label);
        }
    }

    /**
     * Update ring values. Pass inner = null to hide the weekly ring entirely
     * (single-window providers).
     */
    setRings(outer: RingValue | null, inner: RingValue | null): void {
        this._outer = outer;
        this._inner = inner;
        this._area.queue_repaint();
    }

    private _repaint(trackAlpha: number): void {
        const cr = this._area.get_context() as unknown as CairoContext;
        const [w, h] = this._area.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;

        // Account accent disc behind the icon (identity color). Sits inside the
        // inner ring so it never collides with the severity arcs.
        if (this._discColor) {
            const [dr, dg, db] = hexToRgba(this._discColor);
            cr.setSourceRGBA(dr, dg, db, 1);
            cr.arc(cx, cy, this._size * 0.5, 0, 2 * Math.PI);
            cr.fill();
        }

        // Outer ring (5-hour) — always draw the track so the glyph reads even
        // before data arrives.
        this._drawRing(cr, cx, cy, w / 2 - 1.5, this._outer, OUTER_STROKE, trackAlpha);
        // Inner ring (weekly) — only when a second window exists.
        if (this._inner)
            this._drawRing(cr, cx, cy, w / 2 - 5.5, this._inner, INNER_STROKE, trackAlpha);

        cr.$dispose();
    }

    private _drawRing(
        cr: CairoContext,
        cx: number,
        cy: number,
        r: number,
        value: RingValue | null,
        stroke: number,
        trackAlpha: number,
    ): void {
        cr.setLineWidth(stroke);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Track (full circle).
        cr.setSourceRGBA(TRACK_RGBA[0], TRACK_RGBA[1], TRACK_RGBA[2], trackAlpha);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();

        // Progress arc — from top (-π/2) clockwise by used%.
        if (value && value.pct > 0) {
            const [pr, pg, pb, pa] = toneRgba(value.tone);
            cr.setSourceRGBA(pr, pg, pb, pa);
            const start = -Math.PI / 2;
            const end = start + 2 * Math.PI * Math.min(100, value.pct) / 100;
            cr.arc(cx, cy, r, start, end);
            cr.stroke();
        }
    }
}
