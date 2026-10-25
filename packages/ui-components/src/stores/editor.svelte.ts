/**
 * EditorStore — reactive wrapper (Svelte 5 runes) around the label document.
 *
 * The **single source of truth is a `LabelTemplate`** (see ../template). A plain
 * label is just a template whose elements all use absolute `px` placements and
 * has no params/bindings — relative/parametric features are opt-in per element.
 * The absolute-pixel `LabelDesign` the canvas and rasterizer consume is a
 * *derived* render view (`design`), recomputed by `resolveTemplate` from the
 * template + the current canvas size + parameter values. Editing gestures write
 * back to the template's placements (px stays px; mm/%/expr are re-expressed),
 * so there is no lossy translation between two formats.
 */
import {
    getElement,
    mmToPx,
    PX_PER_MM,
    newId,
    snapRotation,
    type AnyElement,
    type ElementType,
    type LabelDesign
} from 'universal-label-renderer';
import { measureElement } from 'universal-label-renderer';
import {
    anchorFx, anchorFy, anchorParts, makeAnchor,
    type Anchor, type AnchorH, type AnchorV, type Dim, type RefBox
} from 'universal-label-renderer';
import { parseExpr, isValidExpr, compileText, textBindingSource } from 'universal-label-renderer';
import { fieldNameFor } from '../lib/field-text';
import { History } from 'universal-label-renderer';
import { LabelLibrary, type DesignOrigin, type SavedLabel } from 'universal-label-renderer';
import {
    resolveTemplate, blankTemplate, createTemplateElement, contentExtentPx,
    scaleTemplatePixelGeometry,
    type LabelTemplate, type TemplateElement, type TemplateParam, type TemplateAdaptivity
} from 'universal-label-renderer';
import { placeAtPx, authoringViewOf, type DimUnit, type PctBase } from 'universal-label-renderer';
import { parseTemplate, contentLiteral, normalizeTag, TAG_LIMITS } from 'universal-label-renderer';
import type { TemplateGallery, TemplateImage } from 'universal-label-renderer';
import { constraintsFor, type Constraint, type ConstraintAxis } from 'universal-label-renderer';

/** Where along an axis a point sits: the near edge, the middle, the far edge. */
export type AxisPos = 'start' | 'center' | 'end';

/** How one coordinate of an element is positioned, as the UI presents it. */
export interface AxisRule {
    /** Which of my own edges/centre is being placed. */
    myPoint: AxisPos;
    /** What it is measured against — undefined means the label itself. */
    refElement?: string;
    /** Which edge/centre of that reference. */
    refPoint: AxisPos;
    distance: Dim;
    /** Optional second pin: fixes the opposite edge too, stretching the element. */
    stretch?: { myPoint: AxisPos; refElement?: string; refPoint: AxisPos; distance: Dim };
}

function fracOf(p: AxisPos): number { return p === 'start' ? 0 : p === 'end' ? 1 : 0.5; }

/** The axis-relevant half of an anchor, as a position. */
function posOf(a: Anchor, axis: ConstraintAxis): AxisPos {
    const parts = anchorParts(a);
    const half = axis === 'x' ? parts.h : parts.v;
    if (half === 'l' || half === 't') return 'start';
    if (half === 'r' || half === 'b') return 'end';
    return 'center';
}

/** An anchor expressing `pos` on `axis` (the other half is irrelevant here). */
function pointFor(pos: AxisPos, axis: ConstraintAxis): Anchor {
    return axis === 'x'
        ? makeAnchor(pos === 'start' ? 'l' : pos === 'end' ? 'r' : 'c', 't')
        : makeAnchor('l', pos === 'start' ? 't' : pos === 'end' ? 'b' : 'c');
}

/** Replace only the given axis's half of an anchor. */
function withAxis(a: Anchor, axis: ConstraintAxis, pos: AxisPos): Anchor {
    const parts = anchorParts(a);
    return axis === 'x'
        ? makeAnchor(pos === 'start' ? 'l' : pos === 'end' ? 'r' : 'c', parts.v)
        : makeAnchor(parts.h, pos === 'start' ? 't' : pos === 'end' ? 'b' : 'c');
}

/** Express `px` in whatever unit `like` already uses, so units survive edits. */
function sameUnit(like: Dim | undefined, px: number, pxPerMm: number, base: number): Dim {
    if (like && typeof like === 'object' && 'u' in like) {
        if (like.u === 'mm') return { u: 'mm', v: Math.round((px / pxPerMm) * 10) / 10 };
        if (like.u === '%') return { u: '%', v: base ? Math.round((px / base) * 1000) / 10 : 0, of: like.of };
    }
    return { u: 'px', v: Math.round(px) };
}
import { domMeasureText } from 'universal-label-renderer';
import { globalSettings } from './settings.svelte';
import type { InkBinding, InkSlot, PaperProfile } from 'universal-label-core';

type GeoField = 'dx' | 'dy' | 'size' | 'w' | 'h';

/** Accurate text measurer when a DOM is available (resolution + drag math). */
function measurer(): ((text: string, font: string) => number) | undefined {
    return typeof document !== 'undefined' ? domMeasureText : undefined;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }

/** Build a Dim of the given unit that resolves to `px`. */
function makeDim(unit: DimUnit, px: number, ofDefault: PctBase, W: number, H: number, pxPerMm: number): Dim {
    if (unit === 'mm') return { u: 'mm', v: round1(px / pxPerMm) };
    if (unit === '%') {
        const base = ofDefault === 'w' ? W : ofDefault === 'h' ? H : ofDefault === 'min' ? Math.min(W, H) : Math.max(W, H);
        return { u: '%', v: base ? round1((px / base) * 100) : 0, of: ofDefault };
    }
    if (unit === 'expr') { const s = String(Math.round(px)); return { e: parseExpr(s), src: s }; }
    return { u: 'px', v: Math.round(px) };
}

/** A short human label for an element, used in constraint target pickers. */
function describeElement(e: TemplateElement): string {
    const content = e.type === 'text' ? (typeof e.text === 'string' ? e.text : '{field}') : '';
    const trimmed = content.trim().split('\n')[0];
    if (trimmed) return trimmed.length > 18 ? `${trimmed.slice(0, 17)}…` : trimmed;
    return e.type;
}

/** A zero distance in the same unit the dim already uses. */
function zeroOf(dim: Dim | undefined): Dim {
    if (dim && typeof dim === 'object' && 'u' in dim) {
        return dim.u === '%' ? { u: '%', v: 0, of: dim.of } : { u: dim.u, v: 0 };
    }
    return { u: 'px', v: 0 }; // plain numbers and expressions collapse to 0 px
}

function defaultsOf(params: TemplateParam[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of params) out[p.name] = p.default;
    return out;
}

/**
 * The undoable editor document: the template plus its working canvas size.
 * The loaded paper is deliberately *not* here — it is a device setting, not part
 * of the document, so undo must not swap the tape out from under the user.
 */
interface Snap {
    template: LabelTemplate;
    widthPx: number;
    heightPx: number;
}

const DEFAULT_SYSTEM_FONTS = [
    'sans-serif', 'serif', 'monospace', 'system-ui',
    'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS',
    'Times New Roman', 'Georgia', 'Courier New', 'Impact'
];

export class EditorStore {
    /** The single source of truth. */
    template = $state<LabelTemplate>(blankTemplate());
    /** Catalogue provenance follows the open document but never affects rendering. */
    origin = $state<DesignOrigin>({ kind: 'local' });
    /** Working canvas size (px) — the size the template is resolved at for display. */
    widthPx = $state<number>(mmToPx(40));
    heightPx = $state<number>(96);
    /**
     * The media in the printer. Backed by the app-level setting, because the
     * loaded tape belongs to the *device*, not to a document — opening a label
     * or template must never silently change it.
     */
    get paper(): PaperProfile | undefined { return globalSettings.paper; }
    set paper(next: PaperProfile | undefined) {
        globalSettings.paper = next;
        globalSettings.save();
    }
    /** Parameter values used to resolve the preview (defaults while authoring). */
    params = $state<Record<string, unknown>>({});
    /**
     * Field values for batch printing, one entry per label. Working state for
     * the open template; reset when another one is opened.
     */
    batchRows = $state<Record<string, string | number | boolean>[]>([]);
    /**
     * Unprintable margins around the printable canvas, in px (set by the app
     * shell from the printer's capabilities). Only consulted when the template
     * positions against the whole media — see `adaptivity.relativeTo`.
     */
    mediaInsets = $state<{ x: number; y: number }>({ x: 0, y: 0 });
    /**
     * Slot -> colorant mappings, one entry per paper bound against.
     *
     * Working state rather than document state: which colour a slot comes out as
     * depends on the roll in the machine, so it travels with the saved label
     * alongside {@link paper} and never with the shared template.
     */
    inkBindings = $state<InkBinding[]>([]);
    /** UI flag: show the relative/parametric authoring controls. */
    authoring = $state(false);

    selectedId = $state<string | null>(null);
    zoom = $state(3);
    snapMode = $state(true);
    gridEnabled = $state(false);
    gridSize = $state(8);

    autoSave = $state(true);
    saveStatus = $state<'idle' | 'saving' | 'saved'>('idle');

    printFeedBeforeMm = $state<number | undefined>(undefined);
    printFeedAfterMm = $state<number | undefined>(undefined);
    printFeedMode = $state<'default' | 'balanced' | 'minimum' | 'custom'>('default');
    showAdvancedFeedingPreview = $state(false);
    /** Print view: one label, or the template once per batch row. */
    printMode = $state<'single' | 'batch'>('single');
    /** Labels sent so far by the running print, for progress in any panel. */
    printProgress = $state<{ done: number; total: number } | undefined>(undefined);

    systemFonts = $state<string[]>([...DEFAULT_SYSTEM_FONTS]);
    systemFontsLoaded = $state(false);

    get canLoadSystemFonts(): boolean {
        return typeof window !== 'undefined' && 'queryLocalFonts' in window;
    }

    async loadSystemFonts(): Promise<void> {
        const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family?: string }>> }).queryLocalFonts;
        if (typeof query !== 'function') return;
        try {
            const fonts = await query.call(window);
            const families = new Set<string>(DEFAULT_SYSTEM_FONTS);
            for (const f of fonts) if (f.family) families.add(f.family);
            this.systemFonts = [...families].sort((a, b) => a.localeCompare(b));
            this.systemFontsLoaded = true;
        } catch {
            // Permission denied or unsupported — keep the curated defaults.
        }
    }

    private historyVersion = $state(0);
    private history = new History<Snap>();
    private library = new LabelLibrary();
    private transformSnapshot: Snap | null = null;

    // ---- derived render view ----

    get tapeWidthMm(): number { return this.paper?.tapeWidthMm ?? this.heightPx / this.authoringDpmm; }
    /**
     * Pixels per millimetre of the canvas.
     *
     * The printhead can be narrower than the tape, so canvas height divided by
     * tape width is not a reliable resolution. The authoring resolution is.
     */
    get pxPerMm(): number { return this.authoringDpmm; }

    /** Continuous/gapless media: the tape has no fixed label length. */
    get isContinuousMedia(): boolean {
        return !this.paper || this.paper.labelLengthMm === undefined;
    }
    /** Feed exactly as much tape as the content needs (continuous media only). */
    get autoLength(): boolean {
        return this.template.adaptivity.autoLength === true && this.isContinuousMedia;
    }
    setAutoLength(on: boolean): void {
        this.commit({
            ...this.template,
            adaptivity: { ...this.template.adaptivity, autoLength: on || undefined }
        });
    }

    private resolveAt(widthPx: number, params: Record<string, unknown> = this.params): LabelDesign {
        const { design } = resolveTemplate(this.template, {
            widthPx, heightPx: this.heightPx,
            tapeWidthMm: this.tapeWidthMm,
            dpmm: this.authoringDpmm,
            labelLengthMm: this.paper?.labelLengthMm ?? widthPx / this.authoringDpmm,
            params, measureText: measurer(),
            mediaInsets: this.mediaInsets,
            cornerRadiusMm: this.paper?.borderRadiusMm
        });
        return design;
    }

    /** Whether relative placements measure against the whole media or the print area. */
    get relativeTo(): 'printable' | 'media' {
        return this.template.adaptivity.relativeTo === 'media' ? 'media' : 'printable';
    }
    setRelativeTo(mode: 'printable' | 'media'): void {
        this.commit({
            ...this.template,
            adaptivity: { ...this.template.adaptivity, relativeTo: mode === 'media' ? 'media' : undefined }
        });
    }

    /**
     * The absolute-pixel render view resolved from the template (what components
     * read as `design`).
     *
     * With auto-length on, the canvas length is the content's own extent: resolve
     * once, measure how far the content actually reaches, then resolve again at
     * that width. Two passes, no state writes — this runs inside a `$derived`.
     * (Content anchored to the right edge is inherently circular under
     * auto-length; the second pass is where it settles.)
     */
    readonly design = $derived.by<LabelDesign>(() => this.designWith(this.params));

    /**
     * The design as it would print with these field values — the same
     * resolution as {@link design}, auto-length included. Batch printing
     * resolves one of these per label.
     */
    designWith(params: Record<string, unknown>): LabelDesign {
        let design = this.resolveAt(this.widthPx, params);
        if (this.autoLength) {
            const padPx = (this.template.adaptivity.autoLengthPadMm ?? 2) * this.pxPerMm;
            const needed = Math.max(8, Math.round(contentExtentPx(design, measurer()) + padPx));
            if (needed !== this.widthPx) design = this.resolveAt(needed, params);
        }
        return { ...design, paper: this.paper, inkBindings: this.inkBindings };
    }

    /** The length actually rendered/printed (differs from `widthPx` under auto-length). */
    get effectiveWidthPx(): number { return this.design.widthPx; }

    readonly selected = $derived(getElement(this.design, this.selectedId));
    readonly selectedTemplate = $derived(
        this.selectedId !== null ? this.template.elements.find(e => e.id === this.selectedId) : undefined
    );

    /** True while authoring a template (responsive/param controls are shown). */
    get isTemplateMode(): boolean { return this.authoring; }

    /** A read view of the template's meta for the authoring panels. */
    get templateMeta(): { id: string; name: string; description?: string; params: TemplateParam[]; adaptivity: TemplateAdaptivity } | null {
        if (!this.authoring) return null;
        return {
            id: this.template.id, name: this.template.name, description: this.template.description,
            params: this.template.params, adaptivity: this.template.adaptivity
        };
    }

    /** The responsive-intent view for the selected element (derived from its placement). */
    readonly selectedAuthoring = $derived(
        this.selectedTemplate ? authoringViewOf(this.selectedTemplate, this.template.params) : undefined
    );

    get canUndo(): boolean { void this.historyVersion; return this.history.canUndo; }
    get canRedo(): boolean { void this.historyVersion; return this.history.canRedo; }

    // ---- history ----

    private snapshot(): Snap {
        return { template: this.template, widthPx: this.widthPx, heightPx: this.heightPx };
    }
    private pushHistory(): void {
        this.history.push(this.snapshot());
        this.historyVersion++;
    }
    private restore(s: Snap): void {
        this.template = s.template;
        this.widthPx = s.widthPx;
        this.heightPx = s.heightPx;
    }

    /** Replace the template, recording the previous state for undo. */
    commit(next: LabelTemplate): void {
        this.pushHistory();
        this.template = next;
    }

    private setTemplate(next: LabelTemplate, history: boolean): void {
        if (history) this.commit(next);
        else this.template = next;
    }

    private updateEl(id: string, updater: (e: TemplateElement) => TemplateElement, history: boolean): void {
        this.setTemplate({ ...this.template, elements: this.template.elements.map(e => (e.id === id ? updater(e) : e)) }, history);
    }

    // ---- geometry helpers (px <-> placement) ----

    private placeContext(te: TemplateElement) {
        const resolved = getElement(this.design, te.id);
        const b = resolved ? measureElement(resolved, measurer()) : { width: 0, height: 0 };
        let refBox: RefBox | undefined;
        if (te.place.relTo) {
            const r = getElement(this.design, te.place.relTo);
            if (r) { const rb = measureElement(r, measurer()); refBox = { x: r.x, y: r.y, w: rb.width, h: rb.height }; }
        }
        return { W: this.widthPx, H: this.heightPx, pxPerMm: this.pxPerMm, bounds: { w: b.width, h: b.height }, refBox };
    }

    /** Current resolved pixel value of a placement field (for unit switching / expr seeding). */
    private fieldPx(id: string, field: GeoField): number {
        const resolved = getElement(this.design, id);
        const te = this.template.elements.find(e => e.id === id);
        if (!resolved || !te) return 0;
        const b = measureElement(resolved, measurer());
        if (field === 'size') return resolved.type === 'text' || resolved.type === 'qr' ? resolved.size : 0;
        if (field === 'w') return resolved.type === 'barcode' || resolved.type === 'image' ? resolved.width : b.width;
        if (field === 'h') return resolved.type === 'barcode' || resolved.type === 'image' ? resolved.height : b.height;
        const ctx = this.placeContext(te);
        const base = ctx.refBox ?? { x: 0, y: 0, w: ctx.W, h: ctx.H };
        const anchor = te.place.anchor ?? 'tl';
        const origin = te.place.origin ?? anchor;
        if (field === 'dx') return resolved.x - (base.x + base.w * anchorFx(anchor)) + b.width * anchorFx(origin);
        return resolved.y - (base.y + base.h * anchorFy(anchor)) + b.height * anchorFy(origin);
    }

    /** Split a design-element patch into content/style vs geometry, then apply to the template. */
    private applyElementPatch(id: string, patch: Partial<AnyElement>, history: boolean): void {
        const te = this.template.elements.find(e => e.id === id);
        if (!te) return;
        const geo: { x?: number; y?: number; w?: number; h?: number; size?: number } = {};
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'id' || k === 'type') continue;
            // A locked axis absorbs the geometry part of the patch, so a drag
            // that moves both coordinates still moves the free one.
            if (k === 'x') { if (!te.lockX) geo.x = v as number; }
            else if (k === 'y') { if (!te.lockY) geo.y = v as number; }
            else if (k === 'width') { if (!te.lockX) geo.w = v as number; }
            else if (k === 'height') { if (!te.lockY) geo.h = v as number; }
            else if (k === 'size') geo.size = v as number;
            else rest[k] = v;
        }
        this.updateEl(id, e => {
            let next = { ...e, ...rest } as TemplateElement;
            if (Object.keys(geo).length) next = { ...next, place: placeAtPx(e.place, geo, this.placeContext(e)) };
            return next;
        }, history);
    }

    // ---- element operations ----

    addNew(type: ElementType): AnyElement {
        const previous = this.selected;
        const previousBounds = previous ? measureElement(previous, measurer()) : null;
        const el = createTemplateElement(type, this.widthPx, this.heightPx);
        this.commit({ ...this.template, elements: [...this.template.elements, el] });
        this.selectedId = el.id;
        const added = getElement(this.design, el.id) ?? { ...(el as unknown as AnyElement) };
        const addedBounds = measureElement(added, measurer());
        const gap = 8;

        // New content should appear where the user is already looking. Prefer
        // beside the current selection, then fall back to the label centre.
        let x = (this.widthPx - addedBounds.width) / 2;
        let y = (this.heightPx - addedBounds.height) / 2;
        if (previous && previousBounds) {
            const right = previous.x + previousBounds.width + gap;
            const left = previous.x - addedBounds.width - gap;
            if (right + addedBounds.width <= this.widthPx) x = right;
            else if (left >= 0) x = left;
            y = previous.y + (previousBounds.height - addedBounds.height) / 2;
        }

        // Keep ordinary elements wholly reachable. Oversized elements remain
        // centred rather than being pinned to one edge.
        x = addedBounds.width <= this.widthPx
            ? Math.min(this.widthPx - addedBounds.width, Math.max(0, x))
            : (this.widthPx - addedBounds.width) / 2;
        y = addedBounds.height <= this.heightPx
            ? Math.min(this.heightPx - addedBounds.height, Math.max(0, y))
            : (this.heightPx - addedBounds.height) / 2;
        this.applyElementPatch(el.id, { x: Math.round(x), y: Math.round(y) }, false);
        return getElement(this.design, el.id) ?? added;
    }

    updateSelected(patch: Partial<AnyElement>): void {
        if (this.selectedId !== null) this.applyElementPatch(this.selectedId, patch, true);
    }

    moveElement(id: string, patch: Partial<AnyElement>): void {
        this.applyElementPatch(id, patch, false);
    }

    deleteSelected(): void {
        if (this.selectedId === null) return;
        if (this.template.elements.find(e => e.id === this.selectedId)?.locked) return;
        this.commit({ ...this.template, elements: this.template.elements.filter(e => e.id !== this.selectedId) });
        this.selectedId = null;
    }

    // ---- ink ----

    /** Slots this design declares, beyond the implicit primary. */
    get slots(): InkSlot[] { return this.template.slots ?? []; }

    /** Put the selected element on a slot; `undefined` returns it to the primary. */
    setSelectedInk(slotId: string | undefined): void {
        if (this.selectedId === null) return;
        this.updateEl(this.selectedId, e => ({ ...e, ink: slotId }), true);
    }

    /**
     * Give the selected element its own 1-bit cutoff, or `undefined` to hand it
     * back to the document-wide one.
     */
    setSelectedThreshold(level: number | undefined): void {
        if (this.selectedId === null) return;
        const value = level === undefined ? undefined : Math.min(254, Math.max(1, Math.round(level)));
        this.updateEl(this.selectedId, e => ({ ...e, monoThreshold: value }), true);
    }

    /**
     * Declare a slot, or update one that already exists.
     *
     * Slots live on the template because an element saying `ink: 'accent'` is
     * meaningless to whoever opens the file without them.
     */
    upsertSlot(slot: InkSlot): void {
        const rest = this.slots.filter(s => s.id !== slot.id);
        this.commit({ ...this.template, slots: [...rest, slot] });
    }

    /**
     * Remove a slot, returning anything on it to the primary.
     *
     * Leaving elements pointing at a slot that no longer exists would still
     * print — the planner treats an undeclared slot as a bare one — but it would
     * print with a warning the user has no way to act on.
     */
    removeSlot(slotId: string): void {
        this.commit({
            ...this.template,
            slots: this.slots.filter(s => s.id !== slotId),
            elements: this.template.elements.map(e => (e.ink === slotId ? { ...e, ink: undefined } : e))
        });
    }

    /**
     * Point a slot at one of the loaded roll's colorants.
     *
     * Recorded per paper so that moving between rolls and back does not lose the
     * mapping. Passing `undefined` clears the choice and lets auto-binding
     * decide again.
     */
    bindSlot(paperId: string, slotId: string, inkId: string | undefined): void {
        const others = this.inkBindings.filter(b => b.paperId !== paperId);
        const current = this.inkBindings.find(b => b.paperId === paperId)?.map ?? {};
        const map = { ...current };
        if (inkId) map[slotId] = inkId; else delete map[slotId];
        this.inkBindings = Object.keys(map).length ? [...others, { paperId, map }] : others;
    }

    isLocked(id: string | null = this.selectedId): boolean {
        return !!this.template.elements.find(e => e.id === id)?.locked;
    }

    toggleLock(id: string | null = this.selectedId): void {
        if (id === null) return;
        this.updateEl(id, e => ({ ...e, locked: e.locked ? undefined : true }), true);
    }

    /** Is this one coordinate frozen against dragging/nudging? */
    axisLocked(id: string | null, axis: ConstraintAxis): boolean {
        const te = this.template.elements.find(e => e.id === id);
        return !!(axis === 'x' ? te?.lockX : te?.lockY);
    }

    toggleAxisLock(id: string | null, axis: ConstraintAxis): void {
        if (id === null) return;
        const key = axis === 'x' ? 'lockX' : 'lockY';
        this.updateEl(id, e => ({ ...e, [key]: e[key] ? undefined : true }), true);
    }

    /**
     * Move an element to a position in the paint order. Index 0 is drawn first,
     * i.e. furthest back; the last index is on top. The layer list presents this
     * reversed (front at the top), which is the convention everywhere else.
     */
    moveElementToIndex(id: string, index: number): void {
        const els = [...this.template.elements];
        const from = els.findIndex(e => e.id === id);
        if (from < 0) return;
        const to = Math.max(0, Math.min(els.length - 1, Math.round(index)));
        if (to === from) return;
        const [el] = els.splice(from, 1);
        els.splice(to, 0, el);
        this.commit({ ...this.template, elements: els });
    }

    reorderSelected(dir: 'forward' | 'backward' | 'front' | 'back'): void {
        const id = this.selectedId;
        if (id === null) return;
        const els = [...this.template.elements];
        const idx = els.findIndex(e => e.id === id);
        if (idx < 0) return;
        const [el] = els.splice(idx, 1);
        const target =
            dir === 'front' ? els.length :
            dir === 'back' ? 0 :
            dir === 'forward' ? Math.min(els.length, idx + 1) :
            Math.max(0, idx - 1);
        els.splice(target, 0, el);
        this.commit({ ...this.template, elements: els });
    }

    setRotation(id: string, deg: number): void {
        const resolved = getElement(this.design, id);
        if (!resolved || resolved.locked) return;
        this.updateEl(id, e => ({ ...e, rotation: snapRotation(resolved, deg) || undefined }), true);
    }
    rotateLive(id: string, deg: number): void {
        const resolved = getElement(this.design, id);
        if (!resolved || resolved.locked) return;
        this.updateEl(id, e => ({ ...e, rotation: snapRotation(resolved, deg) || undefined }), false);
    }

    // ---- canvas size / paper / threshold ----

    setLabelSize(widthPx: number, heightPx?: number): void {
        this.pushHistory();
        this.widthPx = Math.max(8, Math.round(widthPx));
        if (heightPx !== undefined) this.heightPx = Math.max(8, Math.round(heightPx));
        this.syncDesignedFor();
    }

    /** Reconcile the canvas height to the printer/paper (no undo step). */
    setCanvasHeight(heightPx: number): void {
        const nextH = Math.max(8, Math.round(heightPx));
        if (nextH === this.heightPx) return;
        this.heightPx = nextH;
    }

    setPaper(paper: PaperProfile | undefined): void {
        this.pushHistory();
        this.paper = paper;
        if (paper?.labelLengthMm) {
            this.widthPx = Math.max(8, Math.round(paper.labelLengthMm * this.authoringDpmm));
        }
        this.syncDesignedFor();
    }

    setThreshold(threshold: number): void {
        this.commit({ ...this.template, threshold });
    }

    /**
     * Keep the template's designed size in step with the working canvas.
     *
     * Also records the resolution it is being drawn at. Without that, "designed
     * for my printer" is unanswerable later: millimetres are the same on a 203
     * and a 300 dpi head while the dot canvas is not, so a template that never
     * stamped its dpmm can only ever claim it *renders* somewhere, not that it
     * was made for it.
     */
    private syncDesignedFor(): void {
        const designedFor = {
            tapeWidthMm: this.paper?.tapeWidthMm ?? round1(this.heightPx / this.authoringDpmm),
            labelLengthMm: this.paper?.labelLengthMm ?? round1(this.widthPx / this.authoringDpmm),
            dpmm: this.authoringDpmm
        };
        this.template = { ...this.template, adaptivity: { ...this.template.adaptivity, designedFor } };
    }

    /**
     * The device resolution the canvas is being authored at.
     *
     * Set by the app shell from the connected (or default) printer's
     * capabilities. Left alone it stays at the app's own PX_PER_MM, which is
     * what the canvas maths already assumes everywhere else.
     */
    authoringDpmm = $state<number>(PX_PER_MM);

    /**
     * Retarget the working document when the active printer density changes.
     * Millimetre and relative template geometry resolves itself; literal pixel
     * geometry is scaled once so it keeps the same physical size.
     */
    setDeviceResolution(dpmm: number): void {
        if (!Number.isFinite(dpmm) || dpmm <= 0 || Math.abs(dpmm - this.authoringDpmm) < 1e-6) return;
        const factor = dpmm / this.authoringDpmm;
        this.template = scaleTemplatePixelGeometry(this.template, factor);
        this.widthPx = Math.max(8, Math.round(this.widthPx * factor));
        this.heightPx = Math.max(8, Math.round(this.heightPx * factor));
        this.authoringDpmm = dpmm;
        this.template = {
            ...this.template,
            adaptivity: {
                ...this.template.adaptivity,
                designedFor: { ...this.template.adaptivity.designedFor, dpmm }
            }
        };
    }

    resizeCanvas(widthPx: number): void {
        this.widthPx = Math.max(8, Math.round(widthPx));
    }

    // ---- drag transform bracket ----

    beginTransform(): void { this.transformSnapshot = this.snapshot(); }
    endTransform(): void {
        const s = this.transformSnapshot;
        if (s && (s.template !== this.template || s.widthPx !== this.widthPx || s.heightPx !== this.heightPx)) {
            this.history.push(s);
            this.historyVersion++;
        }
        this.transformSnapshot = null;
    }

    undo(): void {
        if (!this.history.canUndo) return;
        const prev = this.history.undo(this.snapshot());
        if (prev) { this.restore(prev); this.historyVersion++; this.pruneSelection(); }
    }
    redo(): void {
        if (!this.history.canRedo) return;
        const next = this.history.redo(this.snapshot());
        if (next) { this.restore(next); this.historyVersion++; this.pruneSelection(); }
    }

    // ---- the library ----

    /**
     * Everything saved, templates included.
     *
     * Templates and labels share one collection; a template is identified by
     * a non-empty `template.params` array.
     */
    listSaved(): SavedLabel[] { return this.library.list(); }
    saveCurrent(): SavedLabel {
        return this.library.save(this.buildCurrentTemplate(), this.paper, this.inkBindings, this.origin);
    }
    save(): void {
        if (this.template.elements.length === 0) return;
        this.saveCurrent();
        this.saveStatus = 'saved';
    }
    saveAs(name: string): void {
        this.forkCurrent(name.trim() || this.template.name);
        this.save();
    }
    deleteSaved(id: string): void { this.library.remove(id); }
    toggleSavedFavorite(id: string): void { this.library.toggleFavorite(id); }

    /**
     * Open a template as the working document.
     *
     * The canvas is sized for the **supplied paper** when there is one — an
     * adaptive template should render on the media you actually have loaded, not
     * on whatever size its author happened to design it at. The template's
     * `designedFor` is only the fallback when no paper is selected. (The height
     * is further reconciled to the real printhead by the app shell.)
     */
    open(tpl: LabelTemplate, paper?: PaperProfile, inkBindings?: InkBinding[], origin: DesignOrigin = { kind: 'local' }): void {
        this.history.clear();
        this.historyVersion++;
        const sourceDpmm = tpl.adaptivity.designedFor.dpmm ?? PX_PER_MM;
        const retargeted = scaleTemplatePixelGeometry(tpl, this.authoringDpmm / sourceDpmm);
        this.template = {
            ...retargeted,
            adaptivity: {
                ...retargeted.adaptivity,
                designedFor: { ...retargeted.adaptivity.designedFor, dpmm: this.authoringDpmm }
            }
        };
        this.origin = origin;
        // Bindings belong to the document being opened, not to the last one —
        // carrying them over would point this template's slots at colorants
        // chosen for something else entirely.
        this.inkBindings = inkBindings ?? [];
        // `paper` is an explicit override (authoring a template at its own size);
        // otherwise the loaded media stays exactly as the user set it.
        if (paper) this.paper = paper;
        const media = this.paper;
        const df = tpl.adaptivity.designedFor;
        const tapeWidthMm = media?.tapeWidthMm ?? df.tapeWidthMm;
        const lengthMm = media?.labelLengthMm ?? df.labelLengthMm ?? 40;
        this.heightPx = Math.max(8, Math.round(tapeWidthMm * this.authoringDpmm));
        this.widthPx = Math.max(8, Math.round(lengthMm * this.authoringDpmm));
        this.params = defaultsOf(tpl.params);
        this.batchRows = [];
        this.selectedId = null;
        this.authoring = false;
    }

    newDesign(heightPx: number, widthPx = Math.round(40 * this.authoringDpmm)): void {
        this.open(blankTemplate(
            'Untitled label',
            round1(heightPx / this.authoringDpmm),
            round1(widthPx / this.authoringDpmm)
        ));
        this.heightPx = heightPx;
        this.widthPx = widthPx;
    }

    /** Open an imported template JSON blob after validating its wire format. */
    openImported(data: unknown): boolean {
        const res = parseTemplate(data);
        if (res.ok) { this.open({ ...res.template, id: newId() }); return true; }
        return false;
    }

    forkCurrent(name: string): void {
        this.template = { ...this.template, id: newId(), name };
        this.origin = { kind: 'local' };
    }

    // ---- template authoring (all mutate the template directly) ----

    /** Reveal the authoring controls (no conversion — the doc is already a template). */
    makeTemplate(name = this.template.name): void {
        this.authoring = true;
        this.syncDesignedFor();
        if (name !== this.template.name) this.template = { ...this.template, name };
    }
    editTemplate(tpl: LabelTemplate, paper?: PaperProfile, origin?: DesignOrigin): void {
        this.open(tpl, paper, undefined, origin);
        this.authoring = true;
    }
    exitTemplateMode(): void { this.authoring = false; }

    /** The current template with its designed size synced to the canvas. */
    buildCurrentTemplate(): LabelTemplate {
        return {
            ...this.template,
            adaptivity: {
                ...this.template.adaptivity,
                designedFor: {
                    tapeWidthMm: this.paper?.tapeWidthMm ?? round1(this.heightPx / this.authoringDpmm),
                    labelLengthMm: this.paper?.labelLengthMm ?? round1(this.widthPx / this.authoringDpmm),
                    dpmm: this.authoringDpmm
                }
            }
        };
    }

    /** Apply filled parameter values (consumer "customize"): shows their content, keeps relative layout. */
    applyParamValues(values: Record<string, unknown>): void {
        this.params = { ...this.params, ...values };
        for (const [k, v] of Object.entries(values)) {
            if (v !== undefined && this.template.params.some(p => p.name === k)) {
                this.updateParam(k, { default: v as string | number | boolean });
            }
        }
    }

    /** Resolve the current template at a specific (printer) size. */
    resolveTemplateAt(widthPx: number, heightPx: number, tapeWidthMm: number, labelLengthMm: number): LabelDesign {
        return resolveTemplate(this.buildCurrentTemplate(), {
            widthPx, heightPx, tapeWidthMm, labelLengthMm, params: this.params,
            measureText: measurer(), cornerRadiusMm: this.paper?.borderRadiusMm
        }).design;
    }

    // ---- responsive placement editing (operate on the selected element's place) ----

    setAnchor(id: string, anchor: Anchor): void {
        const resolved = getElement(this.design, id);
        if (!resolved) return;
        this.updateEl(id, e => {
            const oldAnchor = e.place.anchor ?? 'tl';
            const origin = (e.place.origin ?? oldAnchor) === oldAnchor ? anchor : e.place.origin;
            const place = { ...e.place, anchor, origin };
            return { ...e, place: placeAtPx(place, { x: resolved.x, y: resolved.y }, this.placeContext(e)) };
        }, true);
    }
    /**
     * Align an element on one axis. Alignment *is* anchoring: "align left" means
     * "hold the left edge, at zero distance", so this sets the anchor half for
     * that axis and zeroes the matching offset. The offset stays editable, so
     * the user can then nudge it away from the edge.
     */
    alignTo(id: string, axis: 'h' | 'v', pos: 'start' | 'center' | 'end'): void {
        const te = this.template.elements.find(e => e.id === id);
        const resolved = getElement(this.design, id);
        if (!te || !resolved) return;
        const parts = anchorParts(te.place.anchor ?? 'tl');
        const field = axis === 'h' ? 'dx' : 'dy';

        // Clicking the active alignment again releases it: the element keeps its
        // place but goes back to a plain absolute coordinate from the top-left.
        const active = this.alignmentOf(id);
        const isActive = axis === 'h'
            ? active?.h === (pos === 'start' ? 'l' : pos === 'end' ? 'r' : 'c')
            : active?.v === (pos === 'start' ? 't' : pos === 'end' ? 'b' : 'c');
        if (isActive) {
            const anchor = axis === 'h' ? makeAnchor('l', parts.v) : makeAnchor(parts.h, 't');
            const abs: Dim = { u: 'px', v: Math.round(axis === 'h' ? resolved.x : resolved.y) };
            this.updateEl(id, e => ({ ...e, place: { ...e.place, anchor, origin: anchor, [field]: abs } }), true);
            return;
        }

        const anchor = axis === 'h'
            ? makeAnchor(pos === 'start' ? 'l' : pos === 'end' ? 'r' : 'c', parts.v)
            : makeAnchor(parts.h, pos === 'start' ? 't' : pos === 'end' ? 'b' : 'c');
        this.updateEl(id, e => ({
            ...e,
            place: { ...e.place, anchor, origin: anchor, [field]: zeroOf(e.place[field]) }
        }), true);
    }

    /**
     * Which edge each axis is anchored to, for the Align toggles.
     *
     * Centre/right (and middle/bottom) are inherently *relative* anchors, so they
     * stay reported however far the element is dragged — moving something must
     * not quietly drop its relative positioning. Left/top are the neutral,
     * absolute default, so they only count as an alignment while the element is
     * actually flush against that edge.
     */
    alignmentOf(id: string | null): { h?: AnchorH; v?: AnchorV } | undefined {
        const te = id === null ? undefined : this.template.elements.find(e => e.id === id);
        if (!te || id === null) return undefined;
        const parts = anchorParts(te.place.anchor ?? 'tl');
        const flush = (field: 'dx' | 'dy') => Math.abs(this.fieldPx(id, field)) < 0.5;
        return {
            h: parts.h === 'l' ? (flush('dx') ? 'l' : undefined) : parts.h,
            v: parts.v === 't' ? (flush('dy') ? 't' : undefined) : parts.v
        };
    }

    setOrigin(id: string, origin: Anchor): void {
        const resolved = getElement(this.design, id);
        if (!resolved) return;
        this.updateEl(id, e => {
            const place = { ...e.place, origin };
            return { ...e, place: placeAtPx(place, { x: resolved.x, y: resolved.y }, this.placeContext(e)) };
        }, true);
    }

    setUnit(id: string, field: GeoField, unit: DimUnit): void {
        const px = this.fieldPx(id, field);
        const ofDefault: PctBase = field === 'dx' || field === 'w' ? 'w' : 'h';
        this.updateEl(id, e => ({ ...e, place: { ...e.place, [field]: makeDim(unit, px, ofDefault, this.widthPx, this.heightPx, this.pxPerMm) } }), true);
    }
    /** The Dim stored for a placement field, if any (px numbers included). */
    placeDim(id: string | null, field: GeoField): Dim | undefined {
        const e = this.template.elements.find(x => x.id === id);
        return e ? (e.place as Record<string, Dim | undefined>)[field] : undefined;
    }

    /**
     * Set a placement field to an exactly-typed value, in the unit it already
     * uses.
     *
     * Deliberately *not* routed through pixels. Going value → px → back re-reads
     * the element's resolved size, which the renderer may have snapped (bitmap
     * fonts land on integer scales, QR/Data Matrix on integer modules), so
     * typing `70%` would come back as `69.8%`. Snapping is right for the render
     * and for dragging — the drag path still goes through `placeAtPx` — but a
     * number the user typed should be stored verbatim.
     */
    setDimValue(id: string, field: GeoField, value: number): void {
        if (!Number.isFinite(value)) return;
        this.updateEl(id, e => {
            const current = (e.place as Record<string, Dim | undefined>)[field];
            let next: Dim;
            if (current && typeof current === 'object' && 'u' in current) {
                next = current.u === '%'
                    ? { u: '%', v: value, of: current.of }
                    : { u: current.u, v: value };
            } else {
                next = { u: 'px', v: Math.round(value) };
            }
            return { ...e, place: { ...e.place, [field]: next } };
        }, true);
    }

    setOf(id: string, field: GeoField, of: PctBase): void {
        this.updateEl(id, e => {
            const d = (e.place as Record<string, unknown>)[field];
            if (d && typeof d === 'object' && 'u' in d && (d as { u: string }).u === '%') {
                return { ...e, place: { ...e.place, [field]: { ...(d as object), of } } };
            }
            return e;
        }, true);
    }
    setExpr(id: string, field: GeoField, expr: string): void {
        this.updateEl(id, e => {
            const dim: Dim = isValidExpr(expr) ? { e: parseExpr(expr), src: expr } : { e: parseExpr('0'), src: expr };
            return { ...e, place: { ...e.place, [field]: dim } };
        }, false);
    }
    /**
     * A rect's corner radius: either a fixed number of px, or tied to the
     * label's own die-cut radius via the `corner` scope value — so a frame keeps
     * matching the sticker when the paper changes.
     */
    setShapeRadius(id: string, value: number | 'label' | undefined): void {
        this.updateEl(id, e => {
            if (e.type !== 'shape') return e;
            if (value === undefined) return { ...e, radius: undefined };
            if (value === 'label') return { ...e, radius: { e: parseExpr('corner'), src: 'corner' } };
            return { ...e, radius: { u: 'px', v: Math.max(0, Math.round(value)) } };
        }, true);
    }

    /** True when this shape's radius follows the label rather than a fixed px. */
    radiusFollowsLabel(id: string | null): boolean {
        const e = this.template.elements.find(x => x.id === id);
        const r = e?.type === 'shape' ? e.radius : undefined;
        return !!(r && typeof r === 'object' && 'e' in r);
    }

    setClamp(id: string, kind: 'min' | 'max', key: 'size' | 'w' | 'h', value: number | undefined): void {
        this.updateEl(id, e => {
            const clamp = { ...(e.place[kind] ?? {}) };
            if (value === undefined || Number.isNaN(value)) delete clamp[key];
            else clamp[key] = value;
            return { ...e, place: { ...e.place, [kind]: Object.keys(clamp).length ? clamp : undefined } };
        }, true);
    }
    setAutofit(id: string, on: boolean): void {
        this.updateEl(id, e => (e.type === 'text' ? { ...e, autofit: on || undefined } : e), true);
    }

    // ---- unified per-axis positioning ----
    //
    // One story for the user: on each axis, *my* point sits a distance from
    // *their* point, where "they" is the label or another element. Underneath
    // that maps to either the element's own placement (when measured against the
    // canvas) or a constraint (when measured against another element) — and a
    // second pin turns into the constraint pair that stretches the element.

    /** Read the current rule for one axis, whichever form it is stored in. */
    axisRule(id: string | null, axis: ConstraintAxis): AxisRule | undefined {
        const te = id === null ? undefined : this.template.elements.find(e => e.id === id);
        if (!te || id === null) return undefined;
        const cs = constraintsFor(this.template.constraints, id)[axis];
        if (cs.length > 0) {
            const [a, b] = cs;
            return {
                myPoint: posOf(a.from.point, axis),
                refElement: a.to.element,
                refPoint: posOf(a.to.point, axis),
                distance: a.distance,
                stretch: b && { myPoint: posOf(b.from.point, axis), refElement: b.to.element, refPoint: posOf(b.to.point, axis), distance: b.distance }
            };
        }
        const anchor = te.place.anchor ?? 'tl';
        const origin = te.place.origin ?? anchor;
        return {
            myPoint: posOf(origin, axis),
            refElement: te.place.relTo,
            refPoint: posOf(anchor, axis),
            distance: (axis === 'x' ? te.place.dx : te.place.dy) ?? { u: 'px', v: 0 }
        };
    }

    /**
     * Apply a change to an axis rule. The element does not move unless the
     * distance itself was edited: switching reference or anchor point
     * recalculates the distance so what you see stays put.
     */
    setAxisRule(id: string, axis: ConstraintAxis, patch: Partial<AxisRule>): void {
        const current = this.axisRule(id, axis);
        const resolved = getElement(this.design, id);
        if (!current || !resolved || this.axisLocked(id, axis)) return;
        const next: AxisRule = { ...current, ...patch };

        // Keep the element where it is unless the distance was explicitly set.
        if (patch.distance === undefined) {
            const span = this.spanOf(resolved, axis);
            const pos = axis === 'x' ? resolved.x : resolved.y;
            const ref = this.refBoxFor(next.refElement, axis);
            const mine = pos + span * fracOf(next.myPoint);
            const theirs = ref.start + ref.span * fracOf(next.refPoint);
            next.distance = sameUnit(next.distance, mine - theirs, this.pxPerMm, axis === 'x' ? this.widthPx : this.heightPx);
        }

        const useConstraints = next.refElement !== undefined || next.stretch !== undefined;
        const others = (this.template.constraints ?? []).filter(c => !(c.from.element === id && c.axis === axis));

        if (!useConstraints) {
            // Canvas-relative, single pin -> the element's own placement.
            const anchor = withAxis(this.template.elements.find(e => e.id === id)!.place.anchor ?? 'tl', axis, next.refPoint);
            const origin = withAxis(this.template.elements.find(e => e.id === id)!.place.origin ?? anchor, axis, next.myPoint);
            this.commit({
                ...this.template,
                constraints: others.length ? others : undefined,
                elements: this.template.elements.map(e => e.id === id
                    ? { ...e, place: { ...e.place, relTo: undefined, anchor, origin, [axis === 'x' ? 'dx' : 'dy']: next.distance } }
                    : e)
            });
            return;
        }

        const mk = (r: { myPoint: AxisPos; refElement?: string; refPoint: AxisPos; distance: Dim }): Constraint => ({
            id: newId(), axis,
            from: { element: id, point: pointFor(r.myPoint, axis) },
            to: r.refElement !== undefined ? { element: r.refElement, point: pointFor(r.refPoint, axis) } : { point: pointFor(r.refPoint, axis) },
            distance: r.distance
        });
        const list = [...others, mk(next)];
        if (next.stretch) list.push(mk(next.stretch));
        this.commit({ ...this.template, constraints: list });
    }

    /** Turn the "also pin the opposite edge" (stretch) rule on or off. */
    setAxisStretch(id: string, axis: ConstraintAxis, on: boolean): void {
        const rule = this.axisRule(id, axis);
        const resolved = getElement(this.design, id);
        if (!rule || !resolved) return;
        if (!on) { this.setAxisRule(id, axis, { stretch: undefined }); return; }
        // Default the second pin to the opposite edge of the same reference,
        // at the distance that keeps the element's present size.
        const opposite: AxisPos = rule.myPoint === 'end' ? 'start' : 'end';
        const span = this.spanOf(resolved, axis);
        const pos = axis === 'x' ? resolved.x : resolved.y;
        const ref = this.refBoxFor(rule.refElement, axis);
        const mine = pos + span * fracOf(opposite);
        const theirs = ref.start + ref.span * fracOf(opposite);
        this.setAxisRule(id, axis, {
            stretch: { myPoint: opposite, refElement: rule.refElement, refPoint: opposite, distance: sameUnit(rule.distance, mine - theirs, this.pxPerMm, axis === 'x' ? this.widthPx : this.heightPx) }
        });
    }

    private spanOf(el: AnyElement, axis: ConstraintAxis): number {
        const b = measureElement(el, measurer());
        return axis === 'x' ? b.width : b.height;
    }

    private refBoxFor(refElement: string | undefined, axis: ConstraintAxis): { start: number; span: number } {
        if (refElement === undefined) {
            return { start: 0, span: axis === 'x' ? this.widthPx : this.heightPx };
        }
        const r = getElement(this.design, refElement);
        if (!r) return { start: 0, span: axis === 'x' ? this.widthPx : this.heightPx };
        const b = measureElement(r, measurer());
        return axis === 'x' ? { start: r.x, span: b.width } : { start: r.y, span: b.height };
    }

    // ---- constraints ----

    /** Constraints attached to an element (both axes, in order). */
    constraintsOf(id: string | null): Constraint[] {
        return id === null ? [] : (this.template.constraints ?? []).filter(c => c.from.element === id);
    }

    /** Add a distance constraint from one of this element's anchors to a target anchor. */
    addConstraint(c: Omit<Constraint, 'id'>): string {
        const id = newId();
        this.commit({ ...this.template, constraints: [...(this.template.constraints ?? []), { ...c, id }] });
        return id;
    }

    updateConstraint(id: string, patch: Partial<Omit<Constraint, 'id'>>): void {
        this.commit({
            ...this.template,
            constraints: (this.template.constraints ?? []).map(c => (c.id === id ? { ...c, ...patch } : c))
        });
    }

    removeConstraint(id: string): void {
        const next = (this.template.constraints ?? []).filter(c => c.id !== id);
        this.commit({ ...this.template, constraints: next.length ? next : undefined });
    }

    /** Other elements this one can be measured against (for the target picker). */
    constraintTargets(id: string | null): Array<{ id: string; label: string }> {
        return this.template.elements
            .filter(e => e.id !== id)
            .map(e => ({ id: e.id, label: describeElement(e) }));
    }

    // ---- parameter bindings ----

    /** Make an element's content a user-editable field: create + bind a param seeded from its content. */
    makeEditable(id: string): string | undefined {
        const te = this.template.elements.find(e => e.id === id);
        if (!te || te.type === 'image') return undefined;
        const existing = authoringViewOf(te, this.template.params).bind;
        if (existing) return existing;
        const resolved = getElement(this.design, id);
        const def = resolved && resolved.type === 'text' ? resolved.text : resolved && (resolved.type === 'barcode' || resolved.type === 'qr') ? resolved.data : '';
        const n = this.template.params.length + 1;
        const name = `field${n}`;
        this.addParam({ name, label: `Field ${n}`, type: 'text', default: def, multiline: te.type === 'text' });
        this.bindField(id, name);
        return name;
    }

    /** Bind (or unbind) the element's content field to a parameter. */
    bindField(id: string, param: string | undefined): void {
        const resolved = getElement(this.design, id);
        const contentKey = (t: TemplateElement['type']): 'text' | 'data' | 'src' | 'name' =>
            t === 'text' ? 'text' : t === 'image' ? 'src' : t === 'symbol' ? 'name' : 'data';
        const literal = resolved ? contentLiteral(resolved) : '';
        this.updateEl(id, e => {
            const key = contentKey(e.type);
            const value = param ? { parts: [{ e: parseExpr(param) }] } : literal;
            return { ...e, [key]: value } as TemplateElement;
        }, true);
    }

    // ---- parameters ----

    addParam(param: TemplateParam): void {
        if (this.template.params.some(p => p.name === param.name)) return;
        this.template = { ...this.template, params: [...this.template.params, param] };
        this.params = { ...this.params, [param.name]: param.default };
    }
    updateParam(name: string, patch: Partial<TemplateParam>): void {
        this.template = { ...this.template, params: this.template.params.map(p => (p.name === name ? { ...p, ...patch } : p)) };
        if ('default' in patch) this.params = { ...this.params, [name]: patch.default };
    }
    /**
     * The editable source of an element's content: its text, or a code's data,
     * with field references as `{name}`. Literal braces read as `{{` / `}}`.
     */
    contentSource(id: string): string {
        const te = this.template.elements.find(e => e.id === id);
        if (!te) return '';
        if (te.type === 'text') return textBindingSource(te.text);
        if (te.type === 'barcode' || te.type === 'qr' || te.type === 'datamatrix') return textBindingSource(te.data);
        return '';
    }

    /** Set an element's content from source text; `{name}` becomes a field reference. */
    setContentSource(id: string, source: string, history = false): void {
        this.updateEl(id, e => {
            if (e.type === 'text') return { ...e, text: compileText(source) };
            if (e.type === 'barcode' || e.type === 'qr' || e.type === 'datamatrix') return { ...e, data: compileText(source) };
            return e;
        }, history);
    }

    /** Add a text field named after its label; returns its name for `{name}`. */
    addField(label: string, defaultValue: string, multiline = false): string {
        const cleanLabel = label.trim() || `Field ${this.template.params.length + 1}`;
        const name = fieldNameFor(cleanLabel, this.template.params.map(p => p.name));
        this.addParam({ name, label: cleanLabel, type: 'text', default: defaultValue, ...(multiline ? { multiline: true } : {}) });
        return name;
    }

    removeParam(name: string): void {
        this.template = {
            ...this.template,
            params: this.template.params.filter(p => p.name !== name),
            elements: this.template.elements.map(e => this.unbindIfMatches(e, name))
        };
        const { [name]: _, ...rest } = this.params;
        this.params = rest;
    }
    private unbindIfMatches(e: TemplateElement, name: string): TemplateElement {
        const view = authoringViewOf(e, this.template.params);
        if (view.bind !== name) return e;
        const key = e.type === 'text' ? 'text' : e.type === 'image' ? 'src' : 'data';
        return { ...e, [key]: '' } as TemplateElement;
    }

    setTemplateName(name: string): void { this.template = { ...this.template, name }; }
    setTemplateDescription(desc: string): void { this.template = { ...this.template, description: desc || undefined }; }
    /**
     * The terms this design is shared under.
     *
     * Only meaningful at the point of publishing — a design on your own machine
     * needs no licence — which is why the publish panel is where it is usually
     * set. Clearing it back to undefined is allowed: withdrawing a design from
     * sharing should not leave a claim about terms behind.
     */
    setLicense(license: string): void {
        this.template = {
            ...this.template,
            license: (license || undefined) as LabelTemplate['license']
        };
    }

    // ---- tags ----
    //
    // Tags live on the template, which is also what a plain label *is* — so
    // labels and templates get the same tagging with no second concept and no
    // second storage path.

    get tags(): string[] { return this.template.tags ?? []; }

    /**
     * Add a tag, normalised the same way the import gate normalises them.
     *
     * Doing it here rather than only on save means what you see in the chip is
     * what will be stored and what the library will search — a tag that quietly
     * became something else on the way to disk would never match when typed
     * back into the search box.
     */
    addTag(raw: string): void {
        const tag = normalizeTag(raw);
        if (!tag || this.tags.includes(tag)) return;
        if (this.tags.length >= TAG_LIMITS.maxTags) return;
        this.template = { ...this.template, tags: [...this.tags, tag] };
    }

    removeTag(tag: string): void {
        const next = this.tags.filter(t => t !== tag);
        this.template = { ...this.template, tags: next.length ? next : undefined };
    }

    // ---- gallery ----

    get gallery(): TemplateGallery | undefined { return this.template.gallery; }

    /**
     * Set the cover photograph.
     *
     * `src` is expected to have been through `prepareImage` already — downscaled
     * and re-encoded, which is what drops the EXIF. This does not do that work
     * itself, so that the one place it happens is the one place a file is read.
     */
    setCover(image: TemplateImage | undefined): void {
        const gallery = { ...(this.gallery ?? {}) };
        if (image) gallery.cover = image; else delete gallery.cover;
        const empty = !gallery.cover && !(gallery.shots && gallery.shots.length);
        this.template = { ...this.template, gallery: empty ? undefined : gallery };
    }

    /** Update just the caption, without re-encoding the picture. */
    setCoverAlt(alt: string): void {
        const cover = this.gallery?.cover;
        if (!cover) return;
        this.setCover({ ...cover, alt });
    }
    setSupportedRange(range: Partial<Pick<TemplateAdaptivity, 'minTapeWidthMm' | 'maxTapeWidthMm' | 'minLabelLengthMm' | 'maxLabelLengthMm'>>): void {
        this.template = { ...this.template, adaptivity: { ...this.template.adaptivity, ...range } };
    }

    private pruneSelection(): void {
        if (this.selectedId !== null && !this.template.elements.some(e => e.id === this.selectedId)) {
            this.selectedId = null;
        }
    }
}
