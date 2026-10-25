<script lang="ts">
    /**
     * Print options + the print button. Options are clamped to the connected
     * printer's capabilities; the button is disabled while printing and
     * re-enables on the session's idle transition.
     */
    import { printableHeightPx as bandHeightPx } from '../printer/printable';
    import { fromStore } from 'svelte/store';
    import { DEFAULT_PAPER_PROFILES, type UniversalPrintOptions, type UniversalPage, type PaperProfile } from 'universal-label-core';
    import type { LabelDesign } from 'universal-label-renderer';
    import type { PrinterSession } from '../printer/session';
    import type { EditorStore } from '../stores/editor.svelte';
    import { globalSettings as settings, PRINTER_PROFILES } from '../stores/settings.svelte';
    import { rasterizeDesign, planInks, previewBinding } from 'universal-label-renderer';
    import {
        collectCoarseEnvironment,
        printEvidenceDimensions,
        samePrintEvidenceDimensions,
        type PrintEvidenceIndex,
        type PrintReportContext,
        type ReportKind
    } from '../reporting/report';
    import Icon from './Icon.svelte';
    import { resolveContinuousFeed } from '../printer/continuous-feed';

    interface Props {
        session: PrinterSession;
        editor: EditorStore;
        runtime?: string;
        onreport?: (kind: ReportKind, context: PrintReportContext) => void;
    }
    let { session, editor, runtime = 'web', onreport }: Props = $props();

    // svelte-ignore state_referenced_locally -- session identity is stable.
    const printer = fromStore(session);
    const snap = $derived(printer.current);
    const caps = $derived(snap.capabilities);

    let density = $state(8);
    let userDensity = $state(8);  // The user's choice, unclamped — restored on reconnect.
    let copies = $state(1);
    
    // Fallback to the first paper profile if the design has none
    let activePaperId = $state<string>('');
    const allPapers = $derived([...DEFAULT_PAPER_PROFILES, ...settings.customPapers]);
    let activePaper = $derived(allPapers.find(p => p.id === activePaperId) || editor.design.paper || DEFAULT_PAPER_PROFILES[0]);
    
    let speed = $state(1);
    let printError = $state('');
    let printedOk = $state(false);
    let printing = $state(false);
    let evidenceCount = $state(0);
    let evidenceThreshold = $state(3);
    const enoughEvidence = $derived(evidenceCount >= evidenceThreshold);

    // Reset stale print status when the design changes.
    $effect(() => {
        void editor.design;
        printedOk = false;
        printError = '';
    });

    $effect(() => {
        if (caps) density = Math.min(Math.max(1, userDensity), caps.maxDensity);
        
        // Ensure activePaperId is synced (though UI select moved to Toolbar)
        if (editor.design.paper) {
            activePaperId = editor.design.paper.id;
        } else if (!activePaperId) {
            activePaperId = DEFAULT_PAPER_PROFILES[0].id;
        }
    });

    const enforcesFeedBefore = $derived(
        caps?.mediaDefaults?.feedBeforeMinPx !== undefined && 
        caps.mediaDefaults.feedBeforeMinPx === caps.mediaDefaults.feedBeforeMaxPx
    );
    const enforcesFeedAfter = $derived(
        caps?.mediaDefaults?.feedAfterMinPx !== undefined && 
        caps.mediaDefaults.feedAfterMinPx === caps.mediaDefaults.feedAfterMaxPx
    );
    const feedPlan = $derived(resolveContinuousFeed(caps, editor.printFeedMode, editor.printFeedBeforeMm, editor.printFeedAfterMm));

    const printableHeightPx = $derived(caps
        ? bandHeightPx(caps, activePaper.tapeWidthMm)
        : editor.design.heightPx
    );
    const designHeightMm = $derived(editor.design.heightPx / editor.pxPerMm);
    const heightMismatch = $derived(caps !== undefined && editor.design.heightPx !== printableHeightPx);

    /**
     * How many separated ink planes this printer accepts. The renderer resolves
     * the design's slots against this budget, so a colour the hardware cannot
     * develop is merged or dropped while there is still a design to re-render.
     */
    const inkChannels = $derived(caps?.colorSupport.channels ?? 1);

    /**
     * Colours that will not come out as designed on this printer and paper.
     *
     * Shown before printing rather than after: the whole point of resolving
     * slots up front is that the user can change the roll instead of discovering
     * a black banner where they wanted red.
     */
    const inkCompromises = $derived(
        planInks({ ...editor.design, paper: activePaper }, inkChannels).compromises
    );

    /** Colorants the loaded roll can develop. */
    const paperInks = $derived(activePaper.inks ?? []);

    /**
     * Slot -> colorant, shown here rather than in the designer because it is a
     * per-job question: not "what colour did I want" but "what is in the machine
     * right now". Each row shows what it would auto-match to, so leaving every
     * one on Auto is a real answer rather than an unmade decision.
     */
    const bindingRows = $derived(
        editor.slots.map(slot => ({
            slot,
            chosen: editor.inkBindings.find(b => b.paperId === activePaper.id)?.map[slot.id],
            resolved: previewBinding(slot, paperInks, editor.inkBindings.find(b => b.paperId === activePaper.id))
        }))
    );

    /** Labels sent so far in the running print, shared with the batch list. */
    const progress = $derived(editor.printProgress);
    let stopper: AbortController | undefined;
    const batchMode = $derived(editor.printMode === 'batch');
    const batchCount = $derived(editor.batchRows.length);
    const perCopy = $derived(Number.isFinite(copies) ? Math.min(99, Math.max(1, Math.trunc(copies))) : 1);

    function printOptions(): UniversalPrintOptions {
        return {
            paper: activePaper,
            density,
            copies: 1,
            ...(caps?.supportsSpeedMode ? { speed } : {}),
            ...(activePaper.type === 'continuous' ? { feedOverrides: {
                feedBeforeMm: feedPlan.beforeDots !== undefined ? feedPlan.beforeDots / caps!.dpmm : undefined,
                feedAfterMm: feedPlan.afterDots !== undefined ? feedPlan.afterDots / caps!.dpmm : undefined
            } } : {})
        };
    }

    /**
     * Print these designs, each `copies` times in a row. One job where the
     * driver can separate labels inside it (DYMO), one job per label otherwise.
     */
    async function printDesigns(designs: LabelDesign[]): Promise<void> {
        printError = '';
        printedOk = false;
        evidenceCount = 0;
        evidenceThreshold = 3;
        printing = true;
        stopper = new AbortController();
        try {
            const requestedCopies = Number.isFinite(copies)
                ? Math.min(99, Math.max(1, Math.trunc(copies)))
                : 1;
            copies = requestedCopies;
            const pages: UniversalPage[] = [];
            for (const design of designs) {
                const page = await rasterizeDesign(design, undefined, { inkChannels });
                for (let i = 0; i < requestedCopies; i++) pages.push(page);
            }
            editor.printProgress = { done: 0, total: pages.length };
            const sent = await session.printBatch(pages, printOptions(), {
                signal: stopper.signal,
                onPage: (done, total) => { editor.printProgress = { done, total }; }
            });
            printedOk = true;
            if (sent < pages.length) printError = `Stopped after ${sent} of ${pages.length} labels.`;
            void refreshEvidence(makeReportContext('sent'));
        } catch (err) {
            printError = err instanceof Error ? err.message : String(err);
        } finally {
            printing = false;
            editor.printProgress = undefined;
            stopper = undefined;
        }
    }

    function print(): Promise<void> {
        if (!batchMode) return printDesigns([editor.design]);
        const designs = editor.batchRows.map(row => editor.designWith({ ...editor.params, ...row }));
        return printDesigns(designs);
    }

    const printLabel = $derived.by(() => {
        if (printing) return progress && progress.total > 1 ? `Printing ${progress.done} of ${progress.total}…` : 'Printing…';
        if (!batchMode) return `Print ${perCopy > 1 ? perCopy + ' copies' : 'label'}`;
        const total = batchCount * perCopy;
        return `Print ${total} label${total === 1 ? '' : 's'}${perCopy > 1 ? ` (${perCopy} of each)` : ''}`;
    });

    function makeReportContext(printResult: 'sent' | 'failed'): PrintReportContext {
        const requestedCopies = Number.isFinite(copies)
            ? Math.min(99, Math.max(1, Math.trunc(copies)))
            : 1;
        return {
            pageWidthPx: editor.design.widthPx,
            pageHeightPx: editor.design.heightPx,
            pageWidthMm: editor.design.widthPx / editor.pxPerMm,
            pageHeightMm: editor.design.heightPx / editor.pxPerMm,
            mediaWidthMm: activePaper.tapeWidthMm,
            paperType: activePaper.type,
            printDensity: density,
            printCopies: requestedCopies,
            ...(caps?.supportsSpeedMode ? { printSpeed: speed } : {}),
            printResult
        };
    }

    function report(kind: ReportKind): void {
        onreport?.(kind, makeReportContext(printError ? 'failed' : 'sent'));
    }

    async function refreshEvidence(context: PrintReportContext): Promise<void> {
        const profile = PRINTER_PROFILES.find(item => item.id === settings.defaultPrinter);
        const dimensions = printEvidenceDimensions({
            hardwareId: profile?.tohId ?? profile?.id,
            profileId: profile?.id,
            driverId: snap.driverId,
            driverName: snap.driverName,
            transportKind: snap.transportKind,
            transportType: snap.transportType,
            runtime,
            osFamily: collectCoarseEnvironment().osFamily,
            paperType: context.paperType,
            dpmm: snap.capabilities?.dpmm,
            mediaWidthMm: context.mediaWidthMm
        });
        if (!dimensions || typeof document === 'undefined') return;
        try {
            const response = await fetch(new URL('print-evidence.json', document.baseURI), { cache: 'no-cache' });
            if (!response.ok) return;
            const index = await response.json() as PrintEvidenceIndex;
            if (index.schemaVersion !== 1 || !Array.isArray(index.combinations)) return;
            evidenceThreshold = Number.isFinite(index.threshold) && index.threshold > 0 ? index.threshold : 3;
            const match = index.combinations.find(item => item?.dimensions && samePrintEvidenceDimensions(item.dimensions, dimensions));
            const confirmations = match?.confirmations;
            evidenceCount = typeof confirmations === 'number' && Number.isFinite(confirmations)
                ? Math.max(0, confirmations)
                : 0;
        } catch {
            // Offline, desktop and older deployments keep the confirmation action.
        }
    }
</script>

<div class="panel">
    {#if !caps}
        <div class="hint">Connect a printer to print.</div>
    {:else}
        {#if heightMismatch}
            <div class="warn">
                Design height ({designHeightMm.toFixed(1)}mm) doesn't match this paper's
                {printableHeightPx}px printable width.
                <button onclick={() => {
                    editor.setLabelSize(editor.design.widthPx, printableHeightPx);
                }}>
                    Resize design to printable width
                </button>
            </div>
        {/if}
        {#if bindingRows.length > 0 && paperInks.length > 1}
            <div class="inks">
                <span class="inks-title">Inks on this roll</span>
                {#each bindingRows as r (r.slot.id)}
                    <div class="ink-row">
                        <span class="ink-dot" style="background: {r.slot.intent ?? '#111111'}"></span>
                        <span class="ink-name">{r.slot.name ?? r.slot.id}</span>
                        <select
                            value={r.chosen ?? ''}
                            onchange={e => editor.bindSlot(activePaper.id, r.slot.id, e.currentTarget.value || undefined)}
                        >
                            <option value="">Auto{r.resolved ? ` (${r.resolved.name ?? r.resolved.id})` : ''}</option>
                            {#each paperInks as ink (ink.id)}
                                <option value={ink.id}>{ink.name ?? ink.id}</option>
                            {/each}
                        </select>
                        <span class="ink-dot" style="background: {r.resolved?.color ?? 'transparent'}"></span>
                    </div>
                {/each}
            </div>
        {/if}
        {#each inkCompromises as c (c.slotId)}
            <div class="warn">
                {#if c.action === 'drop'}
                    “{c.slotName}” will not print —
                {:else}
                    “{c.slotName}” will print in the primary colour —
                {/if}
                {#if c.reason === 'no-colorant'}
                    this paper cannot develop it.
                {:else}
                    this printer has no spare ink channel for it.
                {/if}
            </div>
        {/each}
        <div class="row">
            <label class="opt">
                Density
                <input type="range" min="1" max={caps.maxDensity} bind:value={userDensity} />
                <span class="val">{density}/{caps.maxDensity}</span>
            </label>
        </div>
        <div class="row">
            <label class="opt">
                Copies
                <input type="number" min="1" max="99" bind:value={copies} />
            </label>
            {#if caps.supportsSpeedMode}
                <label class="opt">
                    Speed
                    <input type="number" min="1" max="5" bind:value={speed} />
                </label>
            {/if}
        </div>
        {#if activePaper.type === 'continuous'}
            {#if feedPlan.canBalance}
                <label class="opt">
                    Cut margins
                    <select bind:value={editor.printFeedMode}>
                        <option value="default">Default spacing</option>
                        <option value="balanced">Equal margins</option>
                        <option value="minimum">Minimum tape</option>
                        <option value="custom">Custom feed</option>
                    </select>
                </label>
                <div class="hint">Expected white margin: {(feedPlan.leadingMarginDots / caps.dpmm).toFixed(1)} mm before, {(feedPlan.trailingMarginDots / caps.dpmm).toFixed(1)} mm after print. Approximate cut length: {((editor.design.widthPx + feedPlan.leadingMarginDots + feedPlan.trailingMarginDots) / caps.dpmm).toFixed(1)} mm. Assumes tape starts at the cutter.</div>
            {/if}
            {#if caps.mediaDefaults?.feedBeforeDefaultPx !== undefined || caps.mediaDefaults?.feedAfterDefaultPx !== undefined}
            <details class="advanced" bind:open={editor.showAdvancedFeedingPreview}>
                <summary>Advanced feeding options</summary>
                <div class="row">
                    {#if caps.mediaDefaults?.feedBeforeDefaultPx !== undefined}
                    <label class="opt" title="Distance to feed before printing starts">
                        Feed Before (mm)
                        <input 
                            type="number" 
                            step="0.1"
                            min={caps.mediaDefaults?.feedBeforeMinPx !== undefined ? (caps.mediaDefaults.feedBeforeMinPx / caps.dpmm).toFixed(1) : 0}
                            max={caps.mediaDefaults?.feedBeforeMaxPx !== undefined ? (caps.mediaDefaults.feedBeforeMaxPx / caps.dpmm).toFixed(1) : 100}
                            bind:value={editor.printFeedBeforeMm} 
                            disabled={enforcesFeedBefore || (feedPlan.canBalance && editor.printFeedMode !== 'custom')}
                            placeholder={caps.mediaDefaults?.feedBeforeDefaultPx !== undefined ? (caps.mediaDefaults.feedBeforeDefaultPx / caps.dpmm).toFixed(1) : "0"} 
                        />
                    </label>
                    {/if}
                    {#if caps.mediaDefaults?.feedAfterDefaultPx !== undefined}
                    <label class="opt" title="Distance to feed after printing ends (for tearing/cutting)">
                        Feed After (mm)
                        <input 
                            type="number" 
                            step="0.1"
                            min={(Math.max(caps.physical?.headToCutterPx ?? 0, caps.mediaDefaults?.feedAfterMinPx ?? 0) / caps.dpmm).toFixed(1)}
                            max={caps.mediaDefaults?.feedAfterMaxPx !== undefined ? (caps.mediaDefaults.feedAfterMaxPx / caps.dpmm).toFixed(1) : 100}
                            bind:value={editor.printFeedAfterMm} 
                            disabled={enforcesFeedAfter || (feedPlan.canBalance && editor.printFeedMode !== 'custom')}
                            placeholder={caps.mediaDefaults?.feedAfterDefaultPx !== undefined ? (caps.mediaDefaults.feedAfterDefaultPx / caps.dpmm).toFixed(1) : "0"} 
                        />
                    </label>
                    {/if}
                </div>
            </details>
            {:else}
                <div class="hint">This printer does not expose adjustable continuous feed.</div>
            {/if}
        {/if}
        <div class="print-row">
            <button
                class="primary print"
                disabled={snap.state !== 'connected' || printing || (batchMode && batchCount === 0)}
                onclick={print}
            >
                {printLabel}
            </button>
            {#if printing && progress && progress.total > 1}
                <button class="stop" onclick={() => stopper?.abort()}>Stop</button>
            {/if}
        </div>
        {#if printing && progress && progress.total > 1}
            <progress class="bar" max={progress.total} value={progress.done}></progress>
        {/if}
        {#if printError}
            <div class="error">{printError}</div>
            {#if onreport}
                <button type="button" class="report-link" onclick={() => report('print-problem')}>
                    <Icon name="flag" size={14} /> Report this printing problem
                </button>
            {/if}
        {:else if printedOk}
            <div class="ok">
                Sent to printer.{enoughEvidence ? ` This exact setup already has ${evidenceCount} independent ToH confirmations.` : ''}
            </div>
            {#if onreport}
                <div class="report-actions">
                    {#if !enoughEvidence}
                        <button type="button" class="report-link" onclick={() => report('print-success')}>
                            <Icon name="check" size={14} /> Confirm it printed correctly for the ToH
                        </button>
                    {/if}
                    <button type="button" class="report-link" onclick={() => report('print-problem')}>
                        <Icon name="flag" size={14} /> Report incorrect output
                    </button>
                </div>
            {/if}
        {/if}
    {/if}
</div>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 10px;
        background: var(--panel);
        border-radius: 2px;
    }
    .row {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        align-items: center;
    }
    .opt {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .opt input[type='range'] {
        width: 140px;
    }
    .opt input[type='number'] {
        width: 64px;
    }
    .val {
        font-variant-numeric: tabular-nums;
        color: var(--muted);
    }
    .print {
        font-size: 16px;
        padding: 12px;
        flex: 1;
    }
    .print-row { display: flex; gap: 8px; }
    .stop { padding-inline: 16px; }
    .bar { width: 100%; }
    .hint {
        color: var(--muted);
    }
    .warn {
        color: var(--warn);
        font-size: 13px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-start;
    }
    .error {
        color: var(--danger);
        font-size: 13px;
    }
    .inks {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .inks-title {
        font-size: 12px;
        color: var(--muted);
    }
    .ink-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
    }
    .ink-name {
        flex: 1;
    }
    .ink-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 1px solid var(--border);
        flex: none;
    }
    .ok {
        color: var(--ok);
        font-size: 13px;
    }
    .report-actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
    }
    .report-link {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        width: fit-content;
        padding: 3px 0;
        border: 0;
        background: transparent;
        color: var(--muted);
        font-size: 12px;
        cursor: pointer;
        box-shadow: none;
    }
    .report-link:hover {
        color: var(--accent);
        transform: none;
        box-shadow: none;
    }
    .advanced {
        border-top: 1px solid var(--border);
        padding-top: 8px;
        margin-top: 4px;
    }
    .advanced summary {
        font-size: 12px;
        color: var(--muted);
        cursor: pointer;
        user-select: none;
        margin-bottom: 12px;
    }
    .advanced summary:hover {
        color: var(--text);
    }
</style>
