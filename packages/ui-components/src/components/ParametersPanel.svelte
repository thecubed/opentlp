<script lang="ts">
    /**
     * The design's fields. Each is something filled in per print (or per batch
     * row); content refers to one as {name}, inserted from the content box.
     */
    import type { EditorStore } from '../stores/editor.svelte';
    import type { ParamType } from 'universal-label-renderer';
    import Icon from './Icon.svelte';

    interface Props {
        editor: EditorStore;
        /** Inside a dock panel that already shows the title. */
        embedded?: boolean;
    }
    let { editor, embedded = false }: Props = $props();

    const params = $derived(editor.template.params);
    const TYPES: ParamType[] = ['text', 'number', 'boolean', 'select', 'color', 'date'];

    function add(): void {
        const n = params.length + 1;
        editor.addField(`Field ${n}`, '');
    }

    function rename(oldName: string, next: string): void {
        const name = next.trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) return; // keep a valid identifier
        if (params.some(p => p.name === name && p.name !== oldName)) return;
        editor.updateParam(oldName, { name });
    }

    function setType(name: string, type: ParamType): void {
        const def = type === 'number' ? 0 : type === 'boolean' ? false : '';
        editor.updateParam(name, { type, default: def, options: type === 'select' ? [] : undefined });
    }
</script>

<div class="params">
    <div class="head">
        {#if !embedded}<h2>Fields</h2>{/if}
        <span class="spacer"></span>
        <button class="add" onclick={add}><Icon name="plus" size={14} /> Add</button>
    </div>

    {#if params.length === 0}
        <p class="empty">No fields yet. Select a text and use <em>ƒx Insert field</em>, or select part of it and choose <em>Make field from selection</em>.</p>
    {:else}
        <div class="list">
            {#each params as p (p.name)}
                <div class="param">
                    <div class="prow">
                        <input class="pname" type="text" value={p.name} title="Identifier used in expressions"
                            onchange={e => rename(p.name, e.currentTarget.value)} />
                        <input class="plabel" type="text" value={p.label} placeholder="Label"
                            onchange={e => editor.updateParam(p.name, { label: e.currentTarget.value })} />
                        <button class="del" title="Remove" aria-label="Remove" onclick={() => editor.removeParam(p.name)}><Icon name="trash" size={14} /></button>
                    </div>
                    <div class="prow">
                        <select value={p.type} onchange={e => setType(p.name, e.currentTarget.value as ParamType)}>
                            {#each TYPES as t (t)}<option value={t}>{t}</option>{/each}
                        </select>
                        {#if p.type === 'boolean'}
                            <label class="def-check"><input type="checkbox" checked={Boolean(p.default)} onchange={e => editor.updateParam(p.name, { default: e.currentTarget.checked })} /> default on</label>
                        {:else if p.type === 'number'}
                            <input class="pdef" type="number" value={Number(p.default) || 0} placeholder="default" onchange={e => editor.updateParam(p.name, { default: Number(e.currentTarget.value) })} />
                        {:else}
                            <input class="pdef" type="text" value={String(p.default ?? '')} placeholder="default" onchange={e => editor.updateParam(p.name, { default: e.currentTarget.value })} />
                        {/if}
                    </div>
                    {#if p.type === 'text'}
                        <label class="def-check" title="Let this field hold several lines">
                            <input type="checkbox" checked={!!p.multiline} onchange={e => editor.updateParam(p.name, { multiline: e.currentTarget.checked || undefined })} />
                            Multi-line
                        </label>
                    {/if}
                    {#if p.type === 'select'}
                        <input class="popts" type="text" value={(p.options ?? []).join(', ')} placeholder="options, comma-separated"
                            onchange={e => editor.updateParam(p.name, { options: e.currentTarget.value.split(',').map(s => s.trim()).filter(Boolean) })} />
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .params { display: flex; flex-direction: column; gap: 10px; }
    .head { display: flex; align-items: center; gap: 8px; }
    .head h2 { margin: 0; }
    .spacer { flex: 1; }
    .add { min-height: 32px; }
    .empty { color: var(--muted); font-size: 13px; margin: 0; }
    .list { display: flex; flex-direction: column; gap: 10px; }
    .param { border: 1px solid var(--border); border-radius: 2px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .prow { display: flex; gap: 6px; align-items: center; }
    .pname { width: 96px; font-family: ui-monospace, monospace; font-size: 12px; }
    .plabel { flex: 1; min-width: 90px; }
    .pdef { flex: 1; min-width: 90px; }
    .popts { width: 100%; }
    .def-check { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
    .del { min-height: 32px; color: var(--muted); }
    .del:hover { color: var(--danger); }
    @media (max-width: 420px) {
        .prow { flex-wrap: wrap; }
        .pname { width: 100%; }
        .plabel,
        .pdef {
            flex: 1 1 120px;
            min-width: 0;
        }
        .prow select { flex: 0 1 120px; min-width: 0; }
        .del {
            min-width: 42px;
            min-height: 42px;
        }
    }
</style>
