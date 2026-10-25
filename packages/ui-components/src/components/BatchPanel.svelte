<script lang="ts">
    /**
     * Batch printing: the open template once per row, each row with its own
     * field values. Rows live on the editor (`batchRows`) so they survive
     * switching views; values a row leaves out come from the current fill-in.
     */
    import type { EditorStore } from '../stores/editor.svelte';
    import type { LabelDesign, TemplateParam } from 'universal-label-renderer';
    import { rasterizeDesign, compositePage } from 'universal-label-renderer';
    import { applyDieMask } from '../lib/paper-thumb';
    import { fillSequence, parsePastedRows, type BatchRow, type BatchValue } from '../printer/batch';
    import Icon from './Icon.svelte';

    interface Props {
        editor: EditorStore;
        /** True while any print is running. */
        printing: boolean;
        /** Labels sent so far in a running batch, and its size. */
        progress?: { done: number; total: number };
        canPrint: boolean;
        copies: number;
        onprint: (designs: LabelDesign[]) => void;
        onstop: () => void;
    }
    let { editor, printing, progress, canPrint, copies, onprint, onstop }: Props = $props();

    const params = $derived<TemplateParam[]>(editor.template.params);
    const rows = $derived(editor.batchRows);
    let open = $state(false);
    $effect(() => { if (rows.length > 0) open = true; });

    /** The current fill-in values, as the starting point for a new row. */
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
    function numberColumn(name: string): void {
        editor.batchRows = fillSequence(rows, name);
    }

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

    // ---- designs and thumbnails ----
    const designs = $derived(rows.map(row => editor.designWith({ ...editor.params, ...row })));
    let thumbs = $state<string[]>([]);
    const thumbKey = $derived(JSON.stringify({ rows, w: editor.design.widthPx, h: editor.design.heightPx, p: editor.paper?.id, t: editor.template.id }));
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
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    });
    const MAX_THUMBS = 60;

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

    const lengthMm = (design: LabelDesign) => (design.widthPx / editor.pxPerMm).toFixed(0);
    const total = $derived(rows.length * Math.max(1, copies));
</script>

{#if params.length > 0}
    <details class="batch" bind:open>
        <summary>
            Batch
            <span class="muted">— {rows.length === 0 ? 'print this template with different values' : `${rows.length} label${rows.length === 1 ? '' : 's'}`}</span>
        </summary>

        {#if rows.length === 0}
            <p class="muted">One row per label. Fields left as they are use the values filled in now.</p>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th class="n">#</th>
                            <th>Preview</th>
                            {#each params as p (p.name)}
                                <th>
                                    <span class="th">
                                        {p.label}
                                        {#if p.type === 'text' || p.type === 'number'}
                                            <button class="tiny" title="Number down the rows from the first value" onclick={() => numberColumn(p.name)}>1, 2, 3</button>
                                        {/if}
                                    </span>
                                </th>
                            {/each}
                            <th class="actions"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each rows as row, i (i)}
                            <tr class:sent={progress && i < Math.floor(progress.done / Math.max(1, copies))}>
                                <td class="n">{i + 1}</td>
                                <td class="thumb">
                                    {#if thumbs[i]}<img src={thumbs[i]} alt="Label {i + 1}" />{:else}<span class="ph"></span>{/if}
                                    {#if designs[i]}<span class="len">{lengthMm(designs[i])} mm</span>{/if}
                                </td>
                                {#each params as p (p.name)}
                                    <td>
                                        {#if p.type === 'boolean'}
                                            <input type="checkbox" checked={Boolean(row[p.name])} onchange={e => setCell(i, p.name, e.currentTarget.checked)} />
                                        {:else if p.type === 'number'}
                                            <input type="number" value={Number(row[p.name] ?? p.default)} oninput={e => setCell(i, p.name, Number(e.currentTarget.value))} />
                                        {:else if p.type === 'select'}
                                            <select value={String(row[p.name] ?? '')} onchange={e => setCell(i, p.name, e.currentTarget.value)}>
                                                {#each p.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
                                            </select>
                                        {:else}
                                            <input type="text" value={String(row[p.name] ?? '')} oninput={e => setCell(i, p.name, e.currentTarget.value)} />
                                        {/if}
                                    </td>
                                {/each}
                                <td class="actions">
                                    <button class="icon" title="Duplicate" aria-label="Duplicate row {i + 1}" onclick={() => duplicate(i)}><Icon name="copy" size={14} /></button>
                                    <button class="icon" title="Remove" aria-label="Remove row {i + 1}" onclick={() => remove(i)}><Icon name="trash" size={14} /></button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}

        <div class="buttons">
            <button onclick={addRow} disabled={printing}><Icon name="plus" size={14} /> Add label</button>
            <button onclick={() => (pasting = !pasting)} disabled={printing}><Icon name="file-text" size={14} /> Paste rows</button>
            {#if rows.length > 0}
                <button class="quiet" onclick={() => (editor.batchRows = [])} disabled={printing}>Clear</button>
            {/if}
        </div>

        {#if pasting}
            <div class="paste">
                <textarea rows="5" bind:value={pasteText}
                    placeholder={`Paste from a spreadsheet or CSV. A header row naming the fields (${params.map(p => p.label).join(', ')}) maps the columns; without one they fill the fields in order.`}></textarea>
                <div class="paste-foot">
                    <span class="muted">{pasteSummary}</span>
                    <button onclick={addPasted} disabled={!pasted || pasted.rows.length === 0}>Add {pasted?.rows.length ?? 0}</button>
                </div>
            </div>
        {/if}

        {#if rows.length > 0}
            {#if printing && progress}
                <div class="progress">
                    <progress max={progress.total} value={progress.done}></progress>
                    <span>{progress.done} of {progress.total}</span>
                    <button onclick={onstop}>Stop</button>
                </div>
            {:else}
                <button class="primary print" disabled={!canPrint || printing} onclick={() => onprint(designs)}>
                    Print {total} label{total === 1 ? '' : 's'}{copies > 1 ? ` (${copies} of each)` : ''}
                </button>
            {/if}
        {/if}
    </details>
{/if}

<style>
    .batch { border-top: 1px solid var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
    .batch[open] { gap: 8px; }
    summary { cursor: pointer; font-weight: 600; user-select: none; margin-bottom: 8px; }
    .muted { color: var(--muted); font-weight: 400; font-size: 13px; }
    p.muted { margin: 0 0 8px; }
    .table-wrap { overflow-x: auto; max-height: 360px; overflow-y: auto; border: 1px solid var(--border); border-radius: 3px; margin-bottom: 8px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { padding: 4px 6px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
    th { position: sticky; top: 0; background: var(--panel-2, var(--panel)); font-weight: 600; color: var(--muted); white-space: nowrap; }
    .th { display: inline-flex; align-items: center; gap: 6px; }
    td input[type='text'], td select { width: 100%; min-width: 90px; }
    td input[type='number'] { width: 72px; }
    .n { width: 2ch; color: var(--muted); font-variant-numeric: tabular-nums; }
    .thumb { white-space: nowrap; }
    .thumb img { height: 28px; image-rendering: pixelated; border: 1px solid var(--border); background: #fff; vertical-align: middle; }
    .ph { display: inline-block; width: 48px; height: 28px; background: var(--panel-2, var(--border)); vertical-align: middle; }
    .len { color: var(--muted); font-size: 11px; margin-left: 4px; font-variant-numeric: tabular-nums; }
    .actions { white-space: nowrap; width: 1%; }
    tr.sent td { opacity: 0.5; }
    .icon { padding: 3px 5px; background: transparent; border: 0; box-shadow: none; color: var(--muted); cursor: pointer; }
    .icon:hover { color: var(--text); transform: none; }
    .tiny { font-size: 11px; padding: 1px 5px; font-weight: 400; }
    .buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .buttons button { display: inline-flex; align-items: center; gap: 4px; }
    .quiet { background: transparent; box-shadow: none; color: var(--muted); }
    .paste { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
    .paste textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 12px; box-sizing: border-box; }
    .paste-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .progress { display: flex; align-items: center; gap: 10px; font-variant-numeric: tabular-nums; }
    .progress progress { flex: 1; }
    .print { font-size: 16px; padding: 12px; width: 100%; }
</style>
