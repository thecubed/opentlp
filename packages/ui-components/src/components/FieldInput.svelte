<script lang="ts">
    /** One template field's input, by type. Multi-line text grows with its content. */
    import type { TemplateParam } from 'universal-label-renderer';
    import type { BatchValue } from '../printer/batch';

    interface Props {
        param: TemplateParam;
        value: BatchValue | undefined;
        onchange: (value: BatchValue) => void;
        /** Accessible name when no visible label is next to it. */
        label?: string;
    }
    let { param, value, onchange, label }: Props = $props();

    function grow(el: HTMLTextAreaElement): void {
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + 2}px`;
    }
    function autogrow(el: HTMLTextAreaElement) {
        grow(el);
        const observer = new ResizeObserver(() => grow(el));
        observer.observe(el);
        return { destroy: () => observer.disconnect() };
    }
</script>

{#if param.type === 'boolean'}
    <input type="checkbox" aria-label={label ?? param.label} checked={Boolean(value)} onchange={e => onchange(e.currentTarget.checked)} />
{:else if param.type === 'number'}
    <input type="number" aria-label={label ?? param.label} min={param.min} max={param.max} step={param.step}
        value={Number(value ?? param.default)} oninput={e => onchange(Number(e.currentTarget.value))} />
{:else if param.type === 'select'}
    <select aria-label={label ?? param.label} value={String(value ?? '')} onchange={e => onchange(e.currentTarget.value)}>
        {#each param.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
    </select>
{:else if param.type === 'date'}
    <input type="date" aria-label={label ?? param.label} value={String(value ?? '')} oninput={e => onchange(e.currentTarget.value)} />
{:else if param.type === 'color'}
    <input type="color" aria-label={label ?? param.label} value={String(value ?? '#000000')} oninput={e => onchange(e.currentTarget.value)} />
{:else if param.multiline}
    <textarea rows="1" aria-label={label ?? param.label} value={String(value ?? '')}
        use:autogrow
        oninput={e => { grow(e.currentTarget); onchange(e.currentTarget.value); }}></textarea>
{:else}
    <input type="text" aria-label={label ?? param.label} value={String(value ?? '')} oninput={e => onchange(e.currentTarget.value)} />
{/if}

<style>
    input[type='text'], input[type='number'], input[type='date'], select, textarea {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
    }
    textarea { resize: none; overflow: hidden; line-height: 1.35; font: inherit; }
</style>
