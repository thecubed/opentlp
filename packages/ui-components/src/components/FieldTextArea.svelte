<script lang="ts">
    /**
     * Content input that understands template fields: `{name}` references are
     * highlighted, a field can be inserted at the caret, and selected text can
     * be turned into a new field (its default is the selected text).
     *
     * Highlighting is a mirror layer behind a transparent-text textarea, so
     * editing stays a plain textarea (undo, IME, selection all native).
     *
     * While focused the textarea keeps its own text: the stored form escapes a
     * lone literal brace, and writing that back mid-typing would move the caret.
     */
    import type { TemplateParam } from 'universal-label-renderer';
    import { tokenizeFieldSource } from '../lib/field-text';
    import Icon from './Icon.svelte';

    interface Props {
        /** Source text, `{name}` for fields. */
        value: string;
        params: readonly TemplateParam[];
        multiline?: boolean;
        rows?: number;
        label?: string;
        oninput: (source: string) => void;
        /** Discrete edits (insert, make field): one undo step. */
        oncommit: (source: string) => void;
        /** Create a field; returns its name. */
        oncreatefield: (label: string, defaultValue: string) => string;
        onfocus?: () => void;
        onblur?: () => void;
    }
    let {
        value, params, multiline = true, rows = 2, label = 'Text',
        oninput, oncommit, oncreatefield, onfocus, onblur
    }: Props = $props();

    let area = $state<HTMLTextAreaElement | null>(null);
    let mirror = $state<HTMLDivElement | null>(null);
    let focused = $state(false);
    let draft = $state('');
    const text = $derived(focused ? draft : value);
    const names = $derived(new Set(params.map(p => p.name)));
    const tokens = $derived(tokenizeFieldSource(text, names));
    const unknown = $derived(tokens.filter(t => t.kind === 'unknown').map(t => t.text));

    /** Selection captured when the user reaches for a toolbar control. */
    let selection = { start: 0, end: 0 };
    function remember(): void {
        if (area) selection = { start: area.selectionStart, end: area.selectionEnd };
    }
    let hasSelection = $state(false);
    function trackSelection(): void {
        remember();
        hasSelection = selection.end > selection.start;
    }

    function begin(): void {
        draft = value;
        focused = true;
        onfocus?.();
    }
    function end(): void {
        remember();
        focused = false;
        onblur?.();
    }
    function typed(next: string): void {
        draft = next;
        oninput(next);
        trackSelection();
    }
    function keydown(e: KeyboardEvent): void {
        if (!multiline && e.key === 'Enter') e.preventDefault();
    }
    function syncScroll(): void {
        if (area && mirror) {
            mirror.scrollTop = area.scrollTop;
            mirror.scrollLeft = area.scrollLeft;
        }
    }

    /** Replace the remembered selection with `insert` and put the caret after it. */
    function replaceSelection(insert: string): void {
        const current = text;
        const { start, end } = selection;
        const next = current.slice(0, start) + insert + current.slice(end);
        draft = next;
        oncommit(next);
        const caret = start + insert.length;
        queueMicrotask(() => {
            area?.focus();
            area?.setSelectionRange(caret, caret);
            selection = { start: caret, end: caret };
            hasSelection = false;
        });
    }

    function insertField(name: string): void {
        replaceSelection(`{${name}}`);
    }

    // ---- new field ----
    let naming = $state<{ defaultValue: string } | null>(null);
    let newLabel = $state('');
    function startNewField(fromSelection: boolean): void {
        const { start, end } = selection;
        naming = { defaultValue: fromSelection ? text.slice(start, end) : '' };
        newLabel = '';
        queueMicrotask(() => (document.getElementById(labelInputId) as HTMLInputElement | null)?.focus());
    }
    function createField(): void {
        if (!naming) return;
        const name = oncreatefield(newLabel, naming.defaultValue);
        naming = null;
        insertField(name);
    }
    const labelInputId = `field-label-${Math.random().toString(36).slice(2)}`;

    function onInsertChoice(e: Event & { currentTarget: HTMLSelectElement }): void {
        const choice = e.currentTarget.value;
        e.currentTarget.value = '';
        if (choice === '__new') startNewField(false);
        else if (choice) insertField(choice);
    }
</script>

<div class="field-text">
    <div class="box" class:single={!multiline}>
        <div class="mirror" bind:this={mirror} aria-hidden="true">{#each tokens as t, i (i)}{#if t.kind === 'text'}{t.text}{:else}<mark class={t.kind}>{t.text}</mark>{/if}{/each}{'​'}</div>
        <textarea
            bind:this={area}
            aria-label={label}
            rows={multiline ? rows : 1}
            spellcheck="false"
            value={text}
            onfocus={begin}
            onblur={end}
            oninput={e => typed(e.currentTarget.value)}
            onkeydown={keydown}
            onkeyup={trackSelection}
            onmouseup={trackSelection}
            onselect={trackSelection}
            onscroll={syncScroll}
        ></textarea>
    </div>

    <div class="tools">
        <label class="insert" title="Insert a field at the cursor">
            <span class="fx">ƒx</span>
            <select aria-label="Insert field" onpointerdown={remember} onfocus={remember} onchange={onInsertChoice}>
                <option value="">Insert field…</option>
                {#each params as p (p.name)}<option value={p.name}>{p.label} {'{'}{p.name}{'}'}</option>{/each}
                <option value="__new">＋ New field…</option>
            </select>
        </label>
        <button
            type="button"
            class="make"
            disabled={!hasSelection}
            title={hasSelection ? 'Turn the selected text into a field' : 'Select some text first'}
            onpointerdown={remember}
            onclick={() => startNewField(true)}
        >
            Make field from selection
        </button>
    </div>

    {#if naming}
        <form class="naming" onsubmit={e => { e.preventDefault(); createField(); }}>
            <input id={labelInputId} type="text" bind:value={newLabel} placeholder="Field name, e.g. Asset ID" />
            <button type="submit" class="primary">Create</button>
            <button type="button" class="quiet" onclick={() => (naming = null)} aria-label="Cancel"><Icon name="x" size={14} /></button>
            {#if naming.defaultValue}<span class="note">Default: “{naming.defaultValue}”</span>{/if}
        </form>
    {/if}

    {#if unknown.length > 0}
        <span class="note bad">No field named {unknown.join(', ')} — it prints as nothing. Use ƒx to insert one, or type {'{{'} for a literal brace.</span>
    {/if}
</div>

<style>
    .field-text { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
    .box { position: relative; }
    .mirror, textarea {
        box-sizing: border-box;
        width: 100%;
        margin: 0;
        padding: 6px 8px;
        border: 1px solid transparent;
        font: inherit;
        font-size: 14px;
        line-height: 1.45;
        letter-spacing: normal;
        white-space: pre-wrap;
        overflow-wrap: break-word;
        word-break: normal;
        tab-size: 4;
    }
    .mirror {
        position: absolute;
        inset: 0;
        overflow: hidden;
        color: var(--text);
        pointer-events: none;
    }
    textarea {
        position: relative;
        display: block;
        resize: vertical;
        min-height: 34px;
        background: transparent;
        color: transparent;
        caret-color: var(--text);
        border-color: var(--border);
        border-radius: 2px;
    }
    .single textarea { resize: none; overflow: hidden; white-space: nowrap; }
    .single .mirror { white-space: pre; }
    textarea::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); color: transparent; }
    .box { background: var(--input-bg, var(--panel-2, transparent)); border-radius: 2px; }
    mark {
        color: inherit;
        border-radius: 3px;
        padding: 0;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
    }
    mark.field { background: color-mix(in srgb, var(--accent) 18%, transparent); }
    mark.expr { background: color-mix(in srgb, var(--ok, #2a9d5b) 18%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ok, #2a9d5b) 45%, transparent); }
    mark.unknown { background: color-mix(in srgb, var(--danger) 18%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 55%, transparent); }
    .tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .insert {
        display: inline-flex; align-items: center; gap: 0;
        border: 1px solid var(--border); border-radius: 2px; overflow: hidden;
    }
    .insert .fx { padding: 0 6px; font-style: italic; font-weight: 700; color: var(--accent); }
    .insert select { border: 0; border-left: 1px solid var(--border); border-radius: 0; font-size: 12px; max-width: 180px; }
    .make { font-size: 12px; padding: 4px 8px; }
    .naming { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .naming input { flex: 1; min-width: 140px; }
    .quiet { background: transparent; box-shadow: none; padding: 4px; }
    .note { color: var(--muted); font-size: 12px; }
    .note.bad { color: var(--danger); }
</style>
