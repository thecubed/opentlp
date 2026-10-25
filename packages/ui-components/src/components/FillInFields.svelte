<script lang="ts">
    /** The design's fields for one print: changes the preview, not the design's defaults. */
    import type { EditorStore } from '../stores/editor.svelte';
    import type { BatchValue } from '../printer/batch';
    import FieldInput from './FieldInput.svelte';

    interface Props { editor: EditorStore; }
    let { editor }: Props = $props();
    const params = $derived(editor.template.params);
</script>

{#if params.length > 0}
    <div class="fields">
        {#each params as p (p.name)}
            <label class="field" class:check={p.type === 'boolean'}>
                <span class="field-label">{p.label}</span>
                <FieldInput
                    param={p}
                    value={(editor.params[p.name] as BatchValue | undefined) ?? p.default}
                    onchange={v => (editor.params = { ...editor.params, [p.name]: v })}
                />
            </label>
        {/each}
    </div>
{/if}

<style>
    .fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .field.check { flex-direction: row-reverse; justify-content: flex-end; align-items: center; gap: 8px; }
    .field-label { font-size: 13px; font-weight: 600; color: var(--muted); }
</style>
