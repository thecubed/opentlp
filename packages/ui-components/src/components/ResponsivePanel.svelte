<script lang="ts">
    /**
     * Responsive layout editor for the selected element — shown only in template
     * author mode. Lets the author pick an anchor and express each offset/size
     * as px / mm / % / a safe expression, with clamps. (Fields in content are
     * edited in the content box itself.) The design's pixels stay the source of truth; entering a value
     * here converts back to pixels and moves the element, so the canvas always
     * shows exactly what the designed size will print.
     */
    import type { EditorStore } from '../stores/editor.svelte';
    import { PX_PER_MM, sizeFieldsFor } from 'universal-label-renderer';
    import { anchorFx, anchorFy, anchorParts } from 'universal-label-renderer';
    import type { PctBase } from 'universal-label-renderer';
    import { isValidExpr } from 'universal-label-renderer';
    import { measureElement } from 'universal-label-renderer';
    import { domMeasureText } from 'universal-label-renderer';

    interface Props {
        editor: EditorStore;
        /**
         * Which slice of the layout controls to render. They live in one
         * component (the px⇄unit math is shared) but are placed separately in
         * the properties panel so each sits with the thing it affects.
         */
        section: 'position' | 'size' | 'limits';
    }
    let { editor, section }: Props = $props();

    const el = $derived(editor.selected);
    const a = $derived(editor.selectedAuthoring);

    const W = $derived(editor.design.widthPx);
    const H = $derived(editor.design.heightPx);
    const pxPerMm = $derived(
        editor.design.paper?.tapeWidthMm ? H / editor.design.paper.tapeWidthMm : PX_PER_MM
    );
    const bounds = $derived(el ? measureElement(el, domMeasureText) : { width: 0, height: 0 });

    type Field = 'dx' | 'dy' | 'size' | 'w' | 'h';

    function baseOf(of: PctBase): number {
        return of === 'w' ? W : of === 'h' ? H : of === 'min' ? Math.min(W, H) : Math.max(W, H);
    }

    function fieldPx(field: Field): number {
        if (!el || !a) return 0;
        const fx = anchorFx(a.anchor), fy = anchorFy(a.anchor);
        const ofx = anchorFx(a.origin), ofy = anchorFy(a.origin);
        if (field === 'dx') return el.x - W * fx + bounds.width * ofx;
        if (field === 'dy') return el.y - H * fy + bounds.height * ofy;
        // Read whichever field this element actually carries. Listing the types
        // by hand is what left symbols (and Data Matrix) reading 0 here, so the
        // % they typed resolved against nothing.
        const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
        if (field === 'size') return num((el as { size?: number }).size, 0);
        if (field === 'w') return num((el as { width?: number }).width, bounds.width);
        return num((el as { height?: number }).height, bounds.height);
    }

    function choiceOf(field: Field) {
        return a ? (a as unknown as Record<Field, { unit: string; of?: PctBase; expr?: string } | undefined>)[field] : undefined;
    }

    /**
     * Show what is stored, not what was rendered.
     *
     * Deriving the number back from the resolved pixels means showing the
     * *snapped* size — a typed 70% reappears as 69.8% because the renderer
     * landed the glyphs on an integer font scale. The stored Dim is the user's
     * intent; only fall back to measuring when there is no Dim to read (a plain
     * px number, or a field the element does not carry).
     */
    function displayValue(field: Field): number {
        const c = choiceOf(field);
        const stored = el ? editor.placeDim(el.id, field) : undefined;
        if (stored && typeof stored === 'object' && 'u' in stored && stored.u === (c?.unit ?? 'px')) {
            return stored.v;
        }
        const px = fieldPx(field);
        if (!c) return Math.round(px);
        if (c.unit === 'mm') return Math.round((px / pxPerMm) * 10) / 10;
        if (c.unit === '%') { const b = baseOf(c.of ?? 'w'); return b ? Math.round((px / b) * 1000) / 10 : 0; }
        return Math.round(px);
    }

    /**
     * Write the typed number straight into the stored Dim, keeping its unit.
     * Converting to px here and letting the element re-express it is what used
     * to turn 70% into 69.8%.
     */
    function setValue(field: Field, num: number): void {
        if (!el || !Number.isFinite(num)) return;
        editor.setDimValue(el.id, field, num);
    }

    /** Name the distance after the edge it is measured from. */
    function distanceLabel(axis: 'h' | 'v'): string {
        const anchor = a?.anchor ?? 'tl';
        const p = anchorParts(anchor);
        if (axis === 'h') return p.h === 'l' ? 'From left' : p.h === 'r' ? 'From right' : 'Offset X';
        return p.v === 't' ? 'From top' : p.v === 'b' ? 'From bottom' : 'Offset Y';
    }

    function sizeFields(): readonly ('size' | 'w' | 'h')[] {
        return el ? sizeFieldsFor(el.type) : [];
    }

</script>

{#if el && a && section === 'position'}
    <!-- Distance from whichever edge/centre the Align row anchored to. The
         anchor itself is chosen there — this is just how far off it sits. -->
    {@render dimRow('dx', distanceLabel('h'))}
    {@render dimRow('dy', distanceLabel('v'))}
{/if}

{#if el && a && section === 'size'}
    <!-- Size controls adapt to what's selected: a glyph size for text/QR,
         width + height for barcodes and images. -->
    {#each sizeFields() as f (f)}
        {@render dimRow(f, f === 'size' ? 'Size' : f === 'w' ? 'Width' : 'Height')}
    {/each}

{/if}

{#if el && a && section === 'limits' && sizeFields().length > 0}
    <div class="row">
        <span class="lbl">Limits</span>
        <div class="clamps">
            {#each sizeFields() as f (f)}
                <label class="clamp">min {f}
                    <input type="number" min="0" value={a.min?.[f] ?? ''} placeholder="—"
                        onchange={e => editor.setClamp(el.id, 'min', f, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
                </label>
                <label class="clamp">max {f}
                    <input type="number" min="0" value={a.max?.[f] ?? ''} placeholder="—"
                        onchange={e => editor.setClamp(el.id, 'max', f, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
                </label>
            {/each}
        </div>
    </div>

{/if}

{#snippet dimRow(field: Field, label: string)}
    {@const c = choiceOf(field)}
    <div class="row">
        <span class="lbl">{label}</span>
        <div class="dim-ctl">
            {#if c?.unit === 'expr'}
                <input class="expr" class:bad={!isValidExpr(String(c.expr ?? ''))} type="text" value={c.expr ?? ''}
                    placeholder="e.g. W - 4*mm"
                    oninput={e => editor.setExpr(el!.id, field, e.currentTarget.value)} />
            {:else}
                <input class="num" type="number" step={c?.unit === 'mm' || c?.unit === '%' ? 0.1 : 1} value={displayValue(field)}
                    onchange={e => setValue(field, Number(e.currentTarget.value))} />
            {/if}
            <select class="unit" value={c?.unit ?? 'px'} onchange={e => editor.setUnit(el!.id, field, e.currentTarget.value as 'px' | 'mm' | '%' | 'expr')}>
                <option value="px">px</option>
                <option value="mm">mm</option>
                <option value="%">%</option>
                <option value="expr">ƒx</option>
            </select>
            {#if c?.unit === '%'}
                <select class="of" value={c.of ?? 'w'} onchange={e => editor.setOf(el!.id, field, e.currentTarget.value as PctBase)}>
                    <option value="w">of width</option>
                    <option value="h">of height</option>
                    <option value="min">of min</option>
                    <option value="max">of max</option>
                </select>
            {/if}
        </div>
    </div>
{/snippet}

<style>
    /* These rows sit inline in the properties panel, so they match its layout
       (label column + controls) rather than looking like a bolted-on card. */
    .row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .lbl {
        min-width: 64px;
        color: var(--muted);
        font-size: 13px;
    }
    .dim-ctl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; max-width: 100%; }
    .num { width: 72px; }
    .expr { flex: 1; min-width: 120px; font-family: ui-monospace, monospace; font-size: 12px; }
    .expr.bad { border-color: var(--danger); box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 25%, transparent); }
    .unit { width: 58px; padding: 6px 6px; }
    .of { padding: 6px 6px; }
    .clamps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; min-width: 0; max-width: 100%; }
    .clamp { display: flex; min-width: 0; flex-direction: column; gap: 2px; font-size: 11px; color: var(--muted); }
    .clamp input { width: 100%; min-width: 0; box-sizing: border-box; }
    @media (max-width: 420px) {
        .row { min-width: 0; }
        .lbl { flex: 0 0 100%; min-width: 0; }
        .dim-ctl,
        .clamps { width: 100%; }
        .num,
        .expr { flex: 1 1 110px; min-width: 0; }
        .of { flex: 1 1 100%; min-width: 0; }
    }
</style>
