<script lang="ts">
    /**
     * Properties of the selected element. Text-ish inputs use the transform
     * protocol (focus = snapshot, input = live update, blur = one undo step);
     * discrete controls (selects, checkboxes, buttons) commit directly.
     */
    import { rotatesFreely, type AnyElement, type LinearSymbology, type ShapeKind } from 'universal-label-renderer';
    import type { EditorStore } from '../stores/editor.svelte';
    import { measureElement, textLayout } from 'universal-label-renderer';
    import { domMeasureText } from 'universal-label-renderer';
    import { FONT_FAMILIES, FONT_MANIFEST, resolveBitmapFont } from 'universal-label-renderer';
    import {
        LINEAR_SYMBOLOGIES, SYMBOLOGY_LABELS, SYMBOLOGY_HINTS, encodeLinear,
        dataMatrixSize, SYMBOLS, SYMBOL_NAMES, svgToPath
    } from 'universal-label-renderer';
    import Icon from './Icon.svelte';
    import ResponsivePanel from './ResponsivePanel.svelte';
    import FieldTextArea from './FieldTextArea.svelte';
    import PositionPanel from './PositionPanel.svelte';

    interface Props {
        editor: EditorStore;
    }
    let { editor }: Props = $props();
    let advancedOpen = $state(false);

    const el = $derived(editor.selected);

    /**
     * Offer the ink picker where a second colour is reachable *or* meaningful to
     * declare: the loaded roll can develop one, the design already declares a
     * slot (which must stay editable after the roll is swapped for plain black,
     * or the author could never fix it), or a template is being authored — where
     * the whole point is designing for stock that is not in the machine today.
     *
     * Hidden otherwise, because a picker with one option is noise on the
     * overwhelming majority of labels, which are monochrome.
     */
    const showInk = $derived(
        (editor.paper?.inks?.length ?? 0) > 1
        || editor.slots.length > 0
        || editor.isTemplateMode
    );
    const activeSlot = $derived(el?.ink ? editor.slots.find(s => s.id === el.ink) : undefined);

    /** Declare a slot and put the selection on it in one step. */
    function newInkSlot(): void {
        const n = editor.slots.length + 1;
        const id = `ink${n}`;
        editor.upsertSlot({ id, name: `Ink ${n}`, intent: '#d2262c' });
        editor.setSelectedInk(id);
    }

    // Live encodability feedback: a wrong-length EAN or a non-digit in an ITF
    // should say so here rather than silently printing an error box.
    const barcodeError = $derived.by(() => {
        if (el?.type !== 'barcode') return null;
        try { encodeLinear(el.symbology ?? 'code128', el.data); return null; }
        catch (err) { return err instanceof Error ? err.message : String(err); }
    });
    const dmSize = $derived.by(() => {
        if (el?.type !== 'datamatrix') return 0;
        try { return dataMatrixSize(el.data); } catch { return 0; }
    });
    const dmError = $derived.by(() => {
        if (el?.type !== 'datamatrix') return null;
        try { dataMatrixSize(el.data); return null; }
        catch (err) { return err instanceof Error ? err.message : String(err); }
    });

    let svgInput = $state<HTMLInputElement | null>(null);
    let svgError = $state<string | null>(null);

    /** Reduce a chosen SVG to sanitised path geometry and attach it. */
    function importSvg(files: FileList | null): void {
        const file = files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const art = svgToPath(String(reader.result ?? ''));
                editor.updateSelected({
                    path: {
                        d: art.d, viewBox: art.viewBox, fillRule: art.fillRule,
                        label: file.name.replace(/\.svg$/i, '')
                    }
                } as Partial<AnyElement>);
                svgError = art.skipped.length
                    ? `Imported. Ignored (no geometry): ${art.skipped.join(', ')}.`
                    : null;
            } catch (err) {
                svgError = err instanceof Error ? err.message : String(err);
            }
        };
        reader.readAsText(file);
        if (svgInput) svgInput.value = '';
    }

    // For a pixel-text element, map its stored `bitmapFont` (a family key or a
    // concrete master id) to the family shown in the picker, and resolve
    // the concrete master + scale actually used for the current size.
    const pixelFamily = $derived.by(() => {
        if (el?.type !== 'text') return FONT_FAMILIES[0].key;
        const key = el.bitmapFont;
        const byKey = FONT_FAMILIES.find(f => f.key === key);
        if (byKey) return byKey.key;
        const byMember = FONT_FAMILIES.find(f => f.memberIds.includes(key));
        return (byMember ?? FONT_FAMILIES[0]).key;
    });
    const resolved = $derived(
        el?.type === 'text' && el.font === 'bitmap'
            ? resolveBitmapFont(el.bitmapFont, el.size)
            : null
    );
    // Exact mode = the stored bitmapFont is a concrete master id, not a family key.
    const exactFont = $derived(
        el?.type === 'text' && el.font === 'bitmap' && !FONT_FAMILIES.some(f => f.key === el.bitmapFont)
    );

    function setExactFont(on: boolean): void {
        if (el?.type !== 'text') return;
        // Keep the current appearance: concrete resolved master ⇄ its family key.
        commit({ bitmapFont: on ? resolveBitmapFont(el.bitmapFont, el.size).id : pixelFamily });
    }

    function live(patch: Partial<AnyElement>): void {
        if (editor.selectedId !== null) editor.moveElement(editor.selectedId, patch);
    }

    function commit(patch: Partial<AnyElement>): void {
        editor.updateSelected(patch);
    }

    const bounds = $derived(el ? measureElement(el, domMeasureText) : null);
    /** Corner radius of the loaded media, for the "match label" hint. */
    const labelCornerMm = $derived(editor.paper?.borderRadiusMm ?? 0);
    /** The glyph block's own size — the sensible starting value for the frame. */
    const textInk = $derived.by(() => {
        if (el?.type !== 'text') return { width: 0, height: 0 };
        const t = textLayout(el, domMeasureText);
        return { width: t.inkW, height: t.inkH };
    });
    /** Which edge/centre the element is anchored to, per axis (drives the Align toggles). */
</script>

{#snippet content(id: string, multiline: boolean, rows: number)}
    <FieldTextArea
        value={editor.contentSource(id)}
        params={editor.template.params}
        {multiline}
        {rows}
        label={el?.type === 'text' ? 'Text' : 'Data'}
        onfocus={() => editor.beginTransform()}
        onblur={() => editor.endTransform()}
        oninput={source => editor.setContentSource(id, source)}
        oncommit={source => editor.setContentSource(id, source, true)}
        oncreatefield={(label, defaultValue) => editor.addField(label, defaultValue, el?.type === 'text')}
    />
{/snippet}

{#if el}
    <div class="panel">
        <div class="row head">
            <strong class="type">{el.type}</strong>
            {#if el.locked}<span class="locked-tag" title="Locked"><Icon name="lock" size={12} /></span>{/if}
            {#if bounds?.error}
                <span class="error">{bounds.error}</span>
            {/if}
            <span class="spacer"></span>
            <button class="lock-btn" class:on={el.locked} title={el.locked ? 'Unlock (allow moving)' : 'Lock in place'} aria-label={el.locked ? 'Unlock' : 'Lock'} onclick={() => editor.toggleLock()}>
                <Icon name={el.locked ? 'lock' : 'unlock'} size={15} />
            </button>
            <button title="Send backward" aria-label="Send backward" onclick={() => editor.reorderSelected('backward')}><Icon name="chevron-down" /></button>
            <button title="Bring forward" aria-label="Bring forward" onclick={() => editor.reorderSelected('forward')}><Icon name="chevron-up" /></button>
            <button class="danger" disabled={el.locked} onclick={() => editor.deleteSelected()}><Icon name="trash" size={15} /> Delete</button>
        </div>

        <section class="advanced" class:open={advancedOpen}>
            <button
                type="button"
                class="advanced-toggle"
                aria-expanded={advancedOpen}
                onclick={() => advancedOpen = !advancedOpen}
            >
                <span>Position &amp; layout</span>
                <Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={15} />
            </button>
            <div class="advanced-body">
                <!-- Position: one rule per coordinate, canvas- or element-relative. -->
                <PositionPanel {editor} />
                <ResponsivePanel {editor} section="limits" />

        <div class="row">
            <span class="lbl">Rotate</span>
            {#if rotatesFreely(el)}
                <input
                    type="range" min="0" max="359"
                    value={el.rotation ?? 0}
                    onpointerdown={() => editor.beginTransform()}
                    oninput={e => editor.rotateLive(el.id, Number(e.currentTarget.value))}
                    onpointerup={() => editor.endTransform()}
                />
                <input
                    type="number" min="0" max="359"
                    value={el.rotation ?? 0}
                    onchange={e => editor.setRotation(el.id, Number(e.currentTarget.value))}
                    style="width: 60px;"
                />
                <span class="dim">°</span>
            {:else}
                <div class="rot-seg">
                    {#each [0, 90, 180, 270] as ang (ang)}
                        <button class="seg" class:on={(el.rotation ?? 0) === ang} onclick={() => editor.setRotation(el.id, ang)}>{ang}°</button>
                    {/each}
                </div>
            {/if}
            <button class="rot-btn" title="Rotate 90°" aria-label="Rotate 90°" onclick={() => editor.setRotation(el.id, (el.rotation ?? 0) + 90)}><Icon name="rotate" size={15} /></button>
        </div>

        <!--
            The 1-bit cutoff for this element alone.

            One document-wide number is a compromise across everything on the
            label: lift it until a pale photo has detail and fine text goes
            heavy; drop it for the text and the photo washes out. Off by default,
            so a label that never needs this never sees a second slider.
        -->
        <div class="row">
            <span class="lbl">Threshold</span>
            <label class="check">
                <input
                    type="checkbox"
                    checked={el.monoThreshold !== undefined}
                    onchange={e => editor.setSelectedThreshold(
                        e.currentTarget.checked ? editor.design.threshold : undefined
                    )}
                />
                Own
            </label>
            {#if el.monoThreshold !== undefined}
                <input
                    type="range" min="1" max="254"
                    value={el.monoThreshold}
                    oninput={e => editor.setSelectedThreshold(Number(e.currentTarget.value))}
                />
                <span class="dim">{el.monoThreshold}</span>
            {:else}
                <span class="dim">document ({editor.design.threshold})</span>
            {/if}
        </div>

        <!--
            Ink slot. Hidden entirely on plain black stock with no slots declared:
            a picker with one option is noise for the overwhelming majority of
            labels, which are monochrome.
        -->
        {#if showInk}
            <div class="row">
                <span class="lbl">Ink</span>
                <select
                    value={el.ink ?? ''}
                    onchange={e => editor.setSelectedInk(e.currentTarget.value || undefined)}
                >
                    <option value="">Primary</option>
                    {#each editor.slots as s (s.id)}
                        <option value={s.id}>{s.name ?? s.id}</option>
                    {/each}
                </select>
                {#if activeSlot}
                    <input
                        type="color"
                        class="ink-swatch"
                        title="Intended colour — matches this slot to the loaded roll"
                        value={activeSlot.intent ?? '#d2262c'}
                        onchange={e => editor.upsertSlot({ ...activeSlot, intent: e.currentTarget.value })}
                    />
                {/if}
                <button title="New ink slot" aria-label="New ink slot" onclick={newInkSlot}>
                    <Icon name="plus" size={15} />
                </button>
            </div>
            {#if activeSlot}
                <div class="row">
                    <span class="lbl">If unavailable</span>
                    <select
                        value={activeSlot.onUnavailable ?? 'merge'}
                        onchange={e => editor.upsertSlot({
                            ...activeSlot,
                            onUnavailable: e.currentTarget.value as 'merge' | 'drop'
                        })}
                    >
                        <option value="merge">Print in primary</option>
                        <option value="drop">Leave it off</option>
                    </select>
                </div>
            {/if}
        {/if}
            </div>
        </section>

        {#if el.type === 'text'}
            {@const a = editor.selectedAuthoring}
            {@const boxMode = el.width === undefined && el.height === undefined ? 'fit' : el.height === undefined ? 'width' : 'box'}
            <div class="group">
                <span class="group-title">Content</span>
                {@render content(el.id, true, 2)}
            </div>

            <div class="group">
                <span class="group-title">Font</span>
                <div class="row">
                    <select
                        value={el.font}
                        onchange={e => commit({ font: e.currentTarget.value as 'bitmap' | 'vector' })}
                    >
                        <option value="bitmap">Pixel (crisp)</option>
                        <option value="vector">System font</option>
                    </select>
                    {#if el.font === 'vector'}
                        <select value={el.fontFamily} onchange={e => commit({ fontFamily: e.currentTarget.value })}>
                            {#each editor.systemFonts as f (f)}
                                <option value={f}>{f}</option>
                            {/each}
                        </select>
                    {:else if exactFont}
                        <select value={el.bitmapFont} onchange={e => commit({ bitmapFont: e.currentTarget.value })}>
                            {#each FONT_MANIFEST as f (f.id)}
                                <option value={f.id}>{f.label} ({f.w}×{f.h})</option>
                            {/each}
                        </select>
                    {:else}
                        <select value={pixelFamily} onchange={e => commit({ bitmapFont: e.currentTarget.value })}>
                            {#each FONT_FAMILIES as fam (fam.key)}
                                <option value={fam.key}>{fam.label}</option>
                            {/each}
                        </select>
                    {/if}
                    <button
                        type="button"
                        class="info"
                        aria-label="Pixel stays crisp at small–medium sizes; use a system font for larger text."
                        data-tip="Pixel stays crisp at small–medium sizes; use a system font for larger text."
                        onclick={(e) => e.currentTarget.focus()}
                    ><Icon name="info" size={16} /></button>
                </div>
                {#if el.font === 'vector' && editor.canLoadSystemFonts && !editor.systemFontsLoaded}
                    <div class="row">
                        <button onclick={() => editor.loadSystemFonts()}>Load installed fonts…</button>
                        <span class="note">Add all fonts installed on this device.</span>
                    </div>
                {/if}
                <ResponsivePanel {editor} section="size" />
                {#if el.font === 'bitmap'}
                    <div class="row">
                        <span class="lbl"></span>
                        <label class="check">
                            <input type="checkbox" checked={exactFont} onchange={e => setExactFont(e.currentTarget.checked)} />
                            Pick exact font
                        </label>
                        {#if !exactFont && resolved}
                            <span class="note">→ {resolved.meta.label} ×{resolved.scale} = {resolved.renderedH}px</span>
                        {/if}
                    </div>
                {/if}
                <div class="row tool-row">
                    <div class="seg-group" role="group" aria-label="Style">
                        <button class="style-btn" class:on={el.bold} title="Bold" aria-label="Bold" aria-pressed={el.bold} onclick={() => commit({ bold: !el.bold })}><Icon name="bold" size={16} /></button>
                        <button class="style-btn" class:on={el.italic} title="Italic" aria-label="Italic" aria-pressed={el.italic} onclick={() => commit({ italic: !el.italic })}><Icon name="italic" size={16} /></button>
                        <button class="style-btn" class:on={el.underline} title="Underline" aria-label="Underline" aria-pressed={el.underline} onclick={() => commit({ underline: !el.underline })}><Icon name="underline" size={16} /></button>
                    </div>
                    <div class="seg-group" role="group" aria-label="Align text">
                        {#each [['left', 'align-left'], ['center', 'align-center-h'], ['right', 'align-right']] as const as [value, icon] (value)}
                            <button class="style-btn" class:on={el.align === value} title="Align {value}" aria-label="Align {value}" aria-pressed={el.align === value} onclick={() => commit({ align: value })}><Icon name={icon} size={16} /></button>
                        {/each}
                    </div>
                    <button class="style-btn knock" class:on={!!el.invert} title="Knockout: white text on a solid block" aria-label="Knockout" aria-pressed={!!el.invert} onclick={() => commit({ invert: el.invert ? undefined : true })}><Icon name="invert" size={16} /> Knockout</button>
                    {#if el.invert}
                        <label class="check" title="Padding around the text inside the block">
                            Pad
                            <input
                                class="pad"
                                type="number" min="0" max="40" value={el.invertPad ?? 4}
                                onfocus={() => editor.beginTransform()}
                                oninput={e => live({ invertPad: Math.max(0, Number(e.currentTarget.value)) })}
                                onblur={() => editor.endTransform()}
                            />
                        </label>
                    {/if}
                </div>
            </div>

            <!-- The text frame: hug the glyphs, or a fixed width / box the text sits in. -->
            <div class="group">
                <span class="group-title">Text box</span>
                <div class="seg-group wide" role="radiogroup" aria-label="Text box size">
                    <button class="seg" class:on={boxMode === 'fit'} role="radio" aria-checked={boxMode === 'fit'}
                        title="The box hugs the text"
                        onclick={() => commit({ width: undefined, height: undefined, wrap: undefined })}>Fit text</button>
                    <button class="seg" class:on={boxMode === 'width'} role="radio" aria-checked={boxMode === 'width'}
                        title="A fixed width; the height follows the text"
                        onclick={() => commit({ width: el.width ?? Math.round(textInk.width), height: undefined })}>Fixed width</button>
                    <button class="seg" class:on={boxMode === 'box'} role="radio" aria-checked={boxMode === 'box'}
                        title="A fixed width and height; the text sits inside"
                        onclick={() => commit({ width: el.width ?? Math.round(textInk.width), height: el.height ?? Math.round(textInk.height) })}>Fixed box</button>
                </div>
                {#if boxMode !== 'fit'}
                    <div class="row">
                        <label class="check">W
                            <input
                                class="num" type="number" min="8" max={editor.design.widthPx}
                                value={el.width ?? Math.round(textInk.width)}
                                onfocus={() => editor.beginTransform()}
                                oninput={e => live({ width: Math.max(8, Number(e.currentTarget.value)) })}
                                onblur={() => editor.endTransform()}
                            />
                        </label>
                        {#if boxMode === 'box'}
                            <label class="check">H
                                <input
                                    class="num" type="number" min="8" max={editor.design.heightPx}
                                    value={el.height ?? Math.round(textInk.height)}
                                    onfocus={() => editor.beginTransform()}
                                    oninput={e => live({ height: Math.max(8, Number(e.currentTarget.value)) })}
                                    onblur={() => editor.endTransform()}
                                />
                            </label>
                            <div class="seg-group" role="group" aria-label="Vertical position">
                                {#each [['top', 'align-top'], ['middle', 'align-center-v'], ['bottom', 'align-bottom']] as const as [value, icon] (value)}
                                    <button class="style-btn" class:on={(el.valign ?? 'top') === value} title="Text at the {value}" aria-label="Text at the {value}" aria-pressed={(el.valign ?? 'top') === value} onclick={() => commit({ valign: value })}><Icon name={icon} size={16} /></button>
                                {/each}
                            </div>
                        {/if}
                        <span class="note">px</span>
                    </div>
                {/if}
                <div class="row">
                    {#if boxMode !== 'fit'}
                        <label class="check" title="Break long lines at the box width">
                            <input type="checkbox" checked={el.wrap === true} onchange={e => commit({ wrap: e.currentTarget.checked || undefined })} />
                            Wrap long lines
                        </label>
                    {/if}
                    {#if a}
                        <label class="check" title="Make the text smaller until it fits">
                            <input type="checkbox" checked={a.autofit ?? false} onchange={e => editor.setAutofit(el.id, e.currentTarget.checked)} />
                            Shrink to fit {boxMode === 'fit' ? 'the label' : 'the box'}
                        </label>
                    {/if}
                </div>
                {#if boxMode === 'fit' && !el.wrap}
                    <span class="note">Runs on one line; Enter starts a new one.</span>
                {/if}
            </div>
        {:else if el.type === 'barcode'}
            <div class="group">
                <span class="group-title">Data</span>
                {@render content(el.id, false, 1)}
            </div>
            <div class="row">
                <span class="lbl">Symbology</span>
                <select value={el.symbology ?? 'code128'} onchange={e => commit({ symbology: e.currentTarget.value as LinearSymbology })}>
                    {#each LINEAR_SYMBOLOGIES as sym (sym)}
                        <option value={sym}>{SYMBOLOGY_LABELS[sym]}</option>
                    {/each}
                </select>
            </div>
            <div class="row">
                <span class="note" class:bad={barcodeError !== null}>
                    {barcodeError ?? SYMBOLOGY_HINTS[el.symbology ?? 'code128']}
                </span>
            </div>
            <ResponsivePanel {editor} section="size" />
            <div class="row">
                <label class="check"><input type="checkbox" checked={el.showText} onchange={e => commit({ showText: e.currentTarget.checked })} /> Human-readable text</label>
            </div>
        {:else if el.type === 'qr'}
            <div class="group">
                <span class="group-title">Data</span>
                {@render content(el.id, true, 2)}
            </div>
            <ResponsivePanel {editor} section="size" />
            <div class="row">
                <span class="lbl">Error corr.</span>
                <select value={el.ecLevel} onchange={e => commit({ ecLevel: e.currentTarget.value as 'L' | 'M' | 'Q' | 'H' })}>
                    <option value="L">L (7%)</option>
                    <option value="M">M (15%)</option>
                    <option value="Q">Q (25%)</option>
                    <option value="H">H (30%)</option>
                </select>
            </div>
        {:else if el.type === 'datamatrix'}
            <div class="group">
                <span class="group-title">Data</span>
                {@render content(el.id, true, 2)}
            </div>
            <div class="row">
                <span class="note" class:bad={dmError !== null}>
                    {dmError ?? `Symbol size ${dmSize}x${dmSize} modules · scans smaller than QR`}
                </span>
            </div>
            <ResponsivePanel {editor} section="size" />
        {:else if el.type === 'shape'}
            <div class="row">
                <span class="lbl">Shape</span>
                <select value={el.shape} onchange={e => commit({ shape: e.currentTarget.value as ShapeKind })}>
                    <option value="line">Line</option>
                    <option value="rect">Box</option>
                    <option value="ellipse">Ellipse</option>
                </select>
            </div>
            <ResponsivePanel {editor} section="size" />
            <label class="row">
                <span class="lbl">Thickness</span>
                <input
                    type="number" min="1" max="60" value={el.stroke}
                    onfocus={() => editor.beginTransform()}
                    oninput={e => live({ stroke: Math.max(1, Number(e.currentTarget.value)) })}
                    onblur={() => editor.endTransform()}
                />
                px
            </label>
            {#if el.shape === 'line'}
                <label class="row">
                    <span class="lbl">Dash</span>
                    <input
                        type="number" min="0" max="60" value={el.dash ?? 0}
                        onfocus={() => editor.beginTransform()}
                        oninput={e => live({ dash: Math.max(0, Number(e.currentTarget.value)) || undefined })}
                        onblur={() => editor.endTransform()}
                    />
                    px
                    <span class="note">0 = solid</span>
                </label>
                <div class="row">
                    <span class="note">Runs along the longer side, so stretching the box keeps it thin.</span>
                </div>
            {:else}
                <div class="row">
                    <label class="check"><input type="checkbox" checked={el.fill} onchange={e => commit({ fill: e.currentTarget.checked })} /> Filled</label>
                </div>
                {#if el.shape === 'rect'}
                    {@const followsLabel = editor.radiusFollowsLabel(el.id)}
                    <div class="row">
                        <span class="lbl">Corner</span>
                        <input
                            class="num" type="number" min="0" max="200"
                            disabled={followsLabel}
                            value={el.radius ?? 0}
                            onfocus={() => editor.beginTransform()}
                            oninput={e => editor.setShapeRadius(el.id, Math.max(0, Number(e.currentTarget.value)) || undefined)}
                            onblur={() => editor.endTransform()}
                        />
                        px
                        <label class="check" title="Track the corner radius of the loaded label, so the frame keeps matching the sticker">
                            <input
                                type="checkbox"
                                checked={followsLabel}
                                onchange={e => editor.setShapeRadius(el.id, e.currentTarget.checked ? 'label' : (el.radius ?? 0))}
                            />
                            match label
                        </label>
                    </div>
                    {#if followsLabel}
                        <div class="row">
                            <span class="note">
                                {labelCornerMm > 0
                                    ? `Following the label: ${labelCornerMm} mm (${el.radius ?? 0} px).`
                                    : 'The selected media has square corners, so this resolves to 0.'}
                            </span>
                        </div>
                    {/if}
                {/if}
            {/if}
        {:else if el.type === 'symbol'}
            <div class="row">
                <span class="lbl">Symbol</span>
                <select
                    class="symbol-select"
                    value={el.path ? '__custom' : el.name}
                    onchange={e => {
                        const v = e.currentTarget.value;
                        if (v !== '__custom') commit({ name: v, path: undefined });
                    }}
                >
                    {#each SYMBOL_NAMES as name (name)}
                        <option value={name}>{SYMBOLS[name].label}</option>
                    {/each}
                    {#if el.path}
                        <option value="__custom">{el.path.label ?? 'Imported SVG'}</option>
                    {/if}
                </select>
            </div>
            <div class="symbol-grid" aria-label="Choose symbol">
                {#each SYMBOL_NAMES as name (name)}
                    <button
                        type="button"
                        class:on={!el.path && el.name === name}
                        title={SYMBOLS[name].label}
                        aria-label={SYMBOLS[name].label}
                        onclick={() => commit({ name, path: undefined })}
                    >
                        <svg viewBox={SYMBOLS[name].viewBox.join(' ')} aria-hidden="true">
                            <path d={SYMBOLS[name].d} fill-rule={SYMBOLS[name].fillRule ?? 'nonzero'} />
                        </svg>
                    </button>
                {/each}
            </div>
            <ResponsivePanel {editor} section="size" />
            <div class="row">
                <button class="ghost" onclick={() => svgInput?.click()}><Icon name="upload" size={13} /> Import SVG…</button>
                {#if el.path}
                    <button class="ghost" onclick={() => commit({ path: undefined })}>Use a built-in</button>
                {/if}
            </div>
            <input
                bind:this={svgInput}
                type="file"
                accept=".svg,image/svg+xml"
                hidden
                onchange={e => importSvg(e.currentTarget.files)}
            />
            <div class="row">
                <span class="note" class:bad={svgError !== null}>
                    {svgError ?? 'Any SVG works — it is reduced to plain outlines on import, so nothing executable comes with it.'}
                </span>
            </div>
        {:else if el.type === 'image'}
            <ResponsivePanel {editor} section="size" />
            <div class="row">
                <span class="lbl">Dither</span>
                <select value={el.mode} onchange={e => commit({ mode: e.currentTarget.value as typeof el.mode })}>
                    <option value="floyd-steinberg">Floyd–Steinberg</option>
                    <option value="bayer">Ordered (Bayer)</option>
                    <option value="threshold">Threshold</option>
                </select>
                <label class="check"><input type="checkbox" checked={el.invert} onchange={e => commit({ invert: e.currentTarget.checked })} /> Invert</label>
            </div>
            <label class="row">
                <span class="lbl">Level</span>
                <input
                    type="range"
                    min="1"
                    max="254"
                    value={el.threshold}
                    onpointerdown={() => editor.beginTransform()}
                    oninput={e => live({ threshold: Number(e.currentTarget.value) })}
                    onpointerup={() => editor.endTransform()}
                />
                <span class="dim">{el.threshold}</span>
            </label>
        {/if}
    </div>
{:else}
    <!-- Nothing selected: label-level settings have been moved to the Layout tab. -->
    <div class="panel">
        <div class="row head">
            <strong class="type">Selection</strong>
        </div>
        <div class="row">
            <span class="note">Select an element on the canvas or in the Layers panel to edit its properties.</span>
        </div>
        <div class="row">
            <span class="dim">Label length, snapping and the print threshold are in the options bar above the canvas.</span>
        </div>
    </div>
{/if}

<style>
    .note.bad { color: var(--danger); }
    .ghost { background: var(--panel-2); box-shadow: none; font-size: 12px; padding: 4px 8px; }
    .ghost:hover { transform: none; }
    .pad { width: 52px; }

    .panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        background: var(--panel);
        border-radius: 2px;
    }
    /* Position, rotation, threshold and ink: collapsed at the end of the panel. */
    .advanced {
        display: block;
        order: 10;
        border-top: 1px solid var(--border);
        padding-top: 8px;
    }
    .advanced-toggle {
        display: flex;
        width: 100%;
        align-items: center;
        justify-content: space-between;
        min-height: 36px;
        background: var(--panel-2);
    }
    .advanced-body { display: none; }
    .advanced.open .advanced-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 8px;
    }
    .symbol-grid {
        display: none;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .row.head .type {
        text-transform: capitalize;
    }
    .spacer {
        flex: 1;
    }
    .lbl {
        min-width: 64px;
        color: var(--muted);
        font-size: 13px;
    }
    input[type='number'] {
        width: 72px;
    }
    input[type='range'] {
        flex: 1;
        min-width: 100px;
    }
    .check {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .error {
        color: var(--danger);
        font-size: 12px;
    }
    .note,
    .dim {
        color: var(--muted);
        font-size: 12px;
    }
    .info {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        min-height: 0;
        padding: 0;
        border: none;
        background: none;
        box-shadow: none;
        border-radius: 50%;
        color: var(--muted);
        cursor: help;
        font-size: 14px;
        flex: none;
    }
    .info:hover {
        transform: none;
        background: none;
    }
    .info:hover,
    .info:focus-visible {
        color: var(--accent);
        outline: none;
    }
    .info::after {
        content: attr(data-tip);
        position: absolute;
        bottom: calc(100% + 8px);
        right: 0;
        width: max-content;
        max-width: 220px;
        padding: 8px 10px;
        border-radius: 2px;
        background: var(--panel-2);
        border: 1px solid var(--border);
        color: var(--text);
        font-size: 12px;
        line-height: 1.35;
        font-style: normal;
        box-shadow: 0 6px 18px rgb(0 0 0 / 25%);
        opacity: 0;
        transform: translateY(4px);
        pointer-events: none;
        transition: opacity 0.15s ease, transform 0.15s ease;
        z-index: 30;
    }
    .info:hover::after,
    .info:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
    }
    .group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 10px;
        border-top: 1px solid var(--border);
    }
    .group-title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--muted);
    }
    .tool-row { gap: 10px; }
    /* Joined buttons: one control, several choices. */
    .seg-group {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: 3px;
        overflow: hidden;
    }
    .seg-group > button {
        border: 0;
        border-radius: 0;
        box-shadow: none;
        min-height: 32px;
    }
    .seg-group > button + button { border-left: 1px solid var(--border); }
    .seg-group > button:hover { transform: none; }
    .seg-group.wide { display: flex; }
    .seg-group.wide > .seg { flex: 1; padding: 6px 8px; font-size: 13px; }
    .seg-group > .seg.on {
        background: var(--accent);
        color: var(--accent-fg, #fff);
    }
    .knock { border: 1px solid var(--border); display: inline-flex; align-items: center; gap: 6px; }
    .num { width: 72px; }
    .style-btn {
        min-width: 38px;
        padding: 6px 10px;
    }
    .style-btn.on {
        background: var(--accent);
        color: var(--accent-fg, #fff);
        border-color: transparent;
    }
    .lock-btn {
        min-width: 34px;
        padding: 6px 8px;
    }
    .lock-btn.on {
        background: var(--accent);
        color: var(--accent-fg, #fff);
        border-color: transparent;
    }
    .locked-tag {
        display: inline-flex;
        color: var(--accent);
    }
    .rot-seg {
        display: inline-flex;
        gap: 3px;
    }
    .rot-seg .seg {
        min-width: 40px;
        min-height: 30px;
        padding: 4px 6px;
        font-size: 12px;
    }
    .rot-seg .seg.on {
        background: var(--accent);
        color: var(--accent-fg, #fff);
        border-color: transparent;
    }
    .rot-btn {
        min-width: 34px;
        padding: 6px 8px;
    }

    @media (max-width: 859px) {
        .panel > .row.head { order: -10; }
        .advanced-toggle { min-height: 44px; }
        .symbol-select { display: none; }
        .symbol-grid {
            display: grid;
            grid-template-columns: repeat(5, minmax(44px, 1fr));
            gap: 6px;
        }
        .symbol-grid button {
            display: grid;
            place-items: center;
            min-width: 44px;
            min-height: 44px;
            padding: 8px;
        }
        .symbol-grid button.on {
            color: var(--accent-fg, #fff);
            background: var(--accent);
            border-color: transparent;
        }
        .symbol-grid svg {
            width: 22px;
            height: 22px;
            fill: currentColor;
        }
    }
</style>
