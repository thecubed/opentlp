<script lang="ts">
    /**
     * The labels of a batch: the open template once per row, each with its own
     * field values. Rows live on the editor (`batchRows`); values a row leaves
     * out come from the current fill-in.
     *
     * Wide: one row per label, preview beside its fields. Narrow (a phone):
     * the same rows become cards, preview on top and fields stacked below.
     * The switch follows this list's own width, not the device.
     */
    import type { EditorStore } from '../stores/editor.svelte';
    import type { LabelDesign, TemplateParam } from 'universal-label-renderer';
    import { rasterizeDesign, compositePage } from 'universal-label-renderer';
    import { applyDieMask } from '../lib/paper-thumb';
    import { fillSequence, parsePastedRows, type BatchRow, type BatchValue } from '../printer/batch';
    import FieldInput from './FieldInput.svelte';
    import Icon from './Icon.svelte';

    interface Props { editor: EditorStore; }
    let { editor }: Props = $props();

    const params = $derived<TemplateParam[]>(editor.template.params);
    const rows = $derived(editor.batchRows);
    const progress = $derived(editor.printProgress);
    const printing = $derived(progress !== undefined);

    function currentValues(): BatchRow {
        const row: BatchRow = {};
        for (const p of params) row[p.name] = (editor.params[p.name] as BatchValue | undefined) ?? p.default;
        return row;
    }
    function addRow(): void {
        const last = rows[rows.length - 1];
        editor.batchRows = [...rows, last ? { ...last } : currentValues()];
    }
    function duplicate(i: number): void {
        editor.batchRows = [...rows.slice(0, i + 1), { ...rows[i] }, ...rows.slice(i + 1)];
    }
    function remove(i: number): void {
        editor.batchRows = rows.filter((_, j) => j !== i);
    }
    function setCell(i: number, name: string, value: BatchValue): void {
        editor.batchRows = rows.map((row, j) => (j === i ? { ...row, [name]: value } : row));
    }
    function numberColumn(e: Event & { currentTarget: HTMLSelectElement }): void {
        const name = e.currentTarget.value;
        e.currentTarget.value = '';
        if (name) editor.batchRows = fillSequence(rows, name);
    }
    const numberable = $derived(params.filter(p => p.type === 'text' || p.type === 'number'));

    // ---- paste ----
    let pasting = $state(false);
    let pasteText = $state('');
    const pasted = $derived(pasteText.trim() ? parsePastedRows(pasteText, params) : undefined);
    const pasteSummary = $derived.by(() => {
        if (!pasted) return '';
        const labelOf = (name: string) => params.find(p => p.name === name)?.label ?? name;
        const used = [...new Set(pasted.columns.filter((c): c is string => Boolean(c)))].map(labelOf);
        const ignored = pasted.columns.filter(c => !c).length;
        return `${pasted.rows.length} label${pasted.rows.length === 1 ? '' : 's'}`
            + (used.length ? ` · ${pasted.hadHeader ? 'columns' : 'in order'}: ${used.join(', ')}` : '')
            + (ignored ? ` · ${ignored} column${ignored === 1 ? '' : 's'} ignored` : '');
    });
    function addPasted(): void {
        if (!pasted) return;
        const base = currentValues();
        editor.batchRows = [...rows, ...pasted.rows.map(row => ({ ...base, ...row }))];
        pasteText = '';
        pasting = false;
    }

    // ---- previews ----
    const designs = $derived(rows.map(row => editor.designWith({ ...editor.params, ...row })));
    let thumbs = $state<string[]>([]);
    const thumbKey = $derived(JSON.stringify({ rows, w: editor.design.widthPx, h: editor.design.heightPx, p: editor.paper?.id, t: editor.template }));
    const MAX_THUMBS = 200;
    $effect(() => {
        void thumbKey;
        const list = designs;
        let cancelled = false;
        const timer = setTimeout(async () => {
            const next: string[] = [];
            for (const design of list.slice(0, MAX_THUMBS)) {
                if (cancelled) return;
                next.push(await thumbnail(design));
            }
            if (!cancelled) thumbs = next;
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    });
    async function thumbnail(design: LabelDesign): Promise<string> {
        try {
            const image = compositePage(await rasterizeDesign(design), { inks: design.paper?.inks });
            const c = document.createElement('canvas');
            c.width = image.width; c.height = image.height;
            c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
            applyDieMask(c, design, editor.paper);
            return c.toDataURL();
        } catch { return ''; }
    }
    const lengthMm = (design: LabelDesign | undefined) => (design ? `${(design.widthPx / editor.pxPerMm).toFixed(0)} mm` : '');
    /** Rows fully sent in the running print (copies count per row). */
    const sentRows = $derived(progress && rows.length ? Math.floor(progress.done * rows.length / progress.total) : 0);
</script>

<div class="batch-list">
    {#if params.length === 0}
        <div class="empty">
            <strong>This design has no fields yet.</strong>
            <p>In the designer, select a text (or a barcode) and use <em>ƒx Insert field</em>, or select part of the text and choose <em>Make field from selection</em>. Each field becomes a column here.</p>
        </div>
    {:else}
        <div class="toolbar">
            <button onclick={addRow} disabled={printing}><Icon name="plus" size={14} /> Add label</button>
            <button onclick={() => (pasting = !pasting)} disabled={printing} aria-expanded={pasting}><Icon name="file-text" size={14} /> Paste rows</button>
            {#if rows.length > 1 && numberable.length > 0}
                <select class="number" aria-label="Number a field down the rows" onchange={numberColumn} disabled={printing}>
                    <option value="">Number down: 1, 2, 3…</option>
                    {#each numberable as p (p.name)}<option value={p.name}>{p.label}</option>{/each}
                </select>
            {/if}
            <span class="spacer"></span>
            {#if rows.length > 0}
                <button class="quiet" onclick={() => (editor.batchRows = [])} disabled={printing}>Clear all</button>
            {/if}
        </div>

        {#if pasting}
            <div class="paste">
                <textarea rows="5" bind:value={pasteText}
                    placeholder={`Paste from a spreadsheet or CSV, one label per line. A header row naming the fields (${params.map(p => p.label).join(', ')}) maps the columns; without one they fill the fields in order.`}></textarea>
                <div class="paste-foot">
                    <span class="muted">{pasteSummary}</span>
                    <button class="primary" onclick={addPasted} disabled={!pasted || pasted.rows.length === 0}>Add {pasted?.rows.length ?? 0}</button>
                </div>
            </div>
        {/if}

        {#if rows.length === 0}
            <div class="empty">
                <p>No labels yet. <strong>Add label</strong> starts from the values filled in now; <strong>Paste rows</strong> takes a list from a spreadsheet.</p>
            </div>
        {:else}
            <div class="rows" style="--fields: {params.length}">
                <div class="head">
                    <span>#</span>
                    <span>Label</span>
                    {#each params as p (p.name)}
                        <span class="head-field">
                            {p.label}
                            {#if rows.length > 1 && (p.type === 'text' || p.type === 'number')}
                                <button class="number-btn" title="Number {p.label} down the rows from the first value: 1, 2, 3…" aria-label="Number {p.label} down the rows" disabled={printing}
                                    onclick={() => (editor.batchRows = fillSequence(rows, p.name))}>1, 2, 3</button>
                            {/if}
                        </span>
                    {/each}
                    <span></span>
                </div>
                {#each rows as row, i (i)}
                    <div class="row" class:sent={i < sentRows}>
                        <span class="n">{i + 1}</span>
                        <div class="preview">
                            {#if thumbs[i]}<img src={thumbs[i]} alt="Label {i + 1}" />{:else}<span class="ph"></span>{/if}
                            <span class="len">{lengthMm(designs[i])}</span>
                        </div>
                        {#each params as p (p.name)}
                            <label class="field">
                                <span class="field-label">{p.label}</span>
                                <FieldInput param={p} value={row[p.name]} label="{p.label}, label {i + 1}" onchange={v => setCell(i, p.name, v)} />
                            </label>
                        {/each}
                        <div class="actions">
                            <button class="icon" title="Duplicate" aria-label="Duplicate label {i + 1}" onclick={() => duplicate(i)} disabled={printing}><Icon name="copy" size={15} /></button>
                            <button class="icon" title="Remove" aria-label="Remove label {i + 1}" onclick={() => remove(i)} disabled={printing}><Icon name="trash" size={15} /></button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    {/if}
</div>

<style>
    .batch-list { container-type: inline-size; display: flex; flex-direction: column; gap: 10px; }
    .empty { padding: 14px; border: 1px dashed var(--border); border-radius: 3px; color: var(--muted); font-size: 14px; }
    .empty p { margin: 6px 0 0; line-height: 1.5; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .toolbar button { display: inline-flex; align-items: center; gap: 4px; }
    .toolbar .number { max-width: 220px; }
    .spacer { flex: 1; }
    .quiet { background: transparent; box-shadow: none; color: var(--muted); }
    .muted { color: var(--muted); font-size: 13px; }
    .paste { display: flex; flex-direction: column; gap: 6px; }
    .paste textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; }
    .paste-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }

    /* Wide: a grid row per label. */
    .rows { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 3px; }
    .head, .row {
        display: grid;
        grid-template-columns: 2.2em minmax(160px, 1.3fr) repeat(var(--fields), minmax(120px, 1fr)) auto;
        gap: 10px;
        align-items: center;
        padding: 8px 10px;
    }
    .head-field { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .number-btn { font-size: 11px; font-weight: 500; padding: 1px 6px; min-height: 0; line-height: 1.6; white-space: nowrap; }
    /* The header's per-field buttons do this on wide screens; cards use the toolbar menu. */
    .toolbar .number { display: none; }
    .head {
        position: sticky; top: 0; z-index: 1;
        background: var(--panel-2, var(--panel));
        font-size: 12px; font-weight: 600; color: var(--muted);
        border-bottom: 1px solid var(--border);
    }
    .row + .row { border-top: 1px solid var(--border); }
    .row.sent { opacity: 0.5; }
    .n { color: var(--muted); font-variant-numeric: tabular-nums; }
    .preview { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .preview img {
        display: block; max-width: 100%; height: auto; max-height: 96px; object-fit: contain; object-position: left;
        image-rendering: pixelated; background: #fff; border: 1px solid var(--border);
    }
    .ph { display: block; width: 100%; height: 48px; background: var(--panel-2, var(--border)); }
    .len { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .field-label { display: none; font-size: 12px; font-weight: 600; color: var(--muted); }
    .actions { display: flex; gap: 2px; }
    .icon { padding: 5px 6px; background: transparent; border: 0; box-shadow: none; color: var(--muted); cursor: pointer; }
    .icon:hover { color: var(--text); transform: none; }

    /* Narrow: each label is a card — number and actions on top, preview, then fields. */
    @container (max-width: 640px) {
        .rows { border: 0; gap: 10px; }
        .head { display: none; }
        .toolbar .number { display: inline-block; }
        .row {
            grid-template-columns: 1fr auto;
            grid-template-areas: 'n actions';
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 10px;
        }
        .row + .row { border-top: 1px solid var(--border); }
        .n { grid-area: n; font-weight: 600; }
        .n::before { content: 'Label '; }
        .actions { grid-area: actions; }
        .preview, .field { grid-column: 1 / -1; }
        .preview img { max-height: none; width: 100%; }
        .field-label { display: block; }
    }
</style>
