<script lang="ts">
    /**
     * Top-level designer shared by the web and Capacitor shells:
     *
     *   Library (home: saved-label grid, search, favorites, + FAB)
     *     └─ Editor (navigated screen: canvas + element chips + inline
     *        properties; ← auto-saves back to the library)
     *          └─ Print / printer sheets (bottom sheets)
     *
     * A printer status chip stays in the header on every screen. Shells pass
     * the two state owners (EditorStore, PrinterSession), the platform's
     * transport options, and optional extra screens.
     *
     * In development builds, the stores are exposed as
     * `globalThis.__blewebler2` for browser inspection.
     */
    import { untrack, onMount } from 'svelte';
    import type { Snippet } from 'svelte';
    import { fromStore } from 'svelte/store';
    import { type DesignOrigin, type LabelDesign, mmToPx } from 'universal-label-renderer';
    import type { PrinterSession } from '../printer/session';
    import type { TransportOption } from '../printer/transports';
    import { printableHeightPx } from '../printer/printable';
    import type { EditorStore } from '../stores/editor.svelte';
    import EditorCanvas from './EditorCanvas.svelte';
    import Toolbar from './Toolbar.svelte';
    import MenuBar from './MenuBar.svelte';
    import OptionsBar from './OptionsBar.svelte';
    import ToolPalette from './ToolPalette.svelte';
    import DockPanel from './DockPanel.svelte';
    import StatusBar from './StatusBar.svelte';
    import { addImageFromFile, insertElement, type EditorTool, type PlacingTool, type ShapeKind } from '../lib/editor-actions';
    import { createEditorCommands } from '../editor-commands';
    import ElementChips from './ElementChips.svelte';
    import PropertiesPanel from './PropertiesPanel.svelte';
    import PreviewBar from './PreviewBar.svelte';
    import ConnectPanel from './ConnectPanel.svelte';
    import PrintPanel from './PrintPanel.svelte';
    import DesignLibraryScreen from './DesignLibraryScreen.svelte';
    import DesignDetailScreen from './DesignDetailScreen.svelte';
    import TemplateInputsPanel from './TemplateInputsPanel.svelte';
    import TemplateAdaptPanel from './TemplateAdaptPanel.svelte';
    import ParametersPanel from './ParametersPanel.svelte';
    import { TemplateSession } from '../stores/templates.svelte';
    import { resolveTemplate, type LabelTemplate, type TemplateAdaptivity } from 'universal-label-renderer';
    import { DEFAULT_PAPER_PROFILES, type InkBinding, type LoadedMedia, type PaperProfile } from 'universal-label-core';
    import { domMeasureText } from 'universal-label-renderer';
    import SettingsPanel from './SettingsPanel.svelte';
    import PaperPanel from './PaperPanel.svelte';
    import { globalSettings as settings, DEFAULT_PRINTER_CAPS, SIDEBAR } from '../stores/settings.svelte';
    import { toast } from '../stores/toasts.svelte';
    import Sheet from './Sheet.svelte';
    import Icon from './Icon.svelte';
    import { scrollToTop } from '../lib/scroll';
    import PrinterMark from './PrinterMark.svelte';
    import Onboarding from './Onboarding.svelte';
    import ToastStack from './ToastStack.svelte';
    import { artworkForDevice } from '../data/artwork';
    import PaperPreview from './PaperPreview.svelte';
    import { loadedMediaIdentityKey, resolveLoadedPaper } from '../printer/media-paper';
    import ReportPanel from './ReportPanel.svelte';
    import type { DiagnosticReportContext, PrintReportContext, ReportKind } from '../reporting/report';

    export interface ExtraTab {
        id: string;
        label: string;
        content: Snippet;
        /**
         * Let this tab run to the app's own edge on wide screens, instead of
         * sitting in the shell's 12px gutter.
         *
         * For panes that are one wide surface rather than a column of cards —
         * the hardware table needs the width for its ten columns, and a gutter
         * only on that screen reads as the layout shifting.
         */
        fullBleed?: boolean;
    }

    interface Props {
        editor: EditorStore;
        session: PrinterSession;
        transports: TransportOption[];
        extraTabs?: ExtraTab[];
        /** Shown in the header, e.g. "BleWebler2" / "BleWebler2 Desktop". */
        title?: string;
        /** Public build identifier included in privacy-safe support reports. */
        reportBuild?: string;
        /** Coarse shell name included in reports, such as web, capacitor, or desktop. */
        reportRuntime?: string;
    }
    let {
        editor,
        session,
        transports,
        extraTabs = [],
        title = 'BleWebler2',
        reportBuild = 'development',
        reportRuntime = 'web'
    }: Props = $props();

    // svelte-ignore state_referenced_locally -- both stores keep a stable
    // identity for the app lifetime; capturing the initial value is intended.
    const printer = fromStore(session);
    const snap = $derived(printer.current);

    /** Owner of the template library + active fill/author session. */
    const templates = new TemplateSession();

    /** 'library' | 'editor' | 'print' | 'templates' | 'template-fill' | an extra-tab id. */
    let view = $state<string>('library');
    /** The palette tool. Everything but `move` places an element on the next label click. */
    let tool = $state<EditorTool>('move');
    let shapeKind = $state<ShapeKind>('rect');
    let imageInput = $state<HTMLInputElement | null>(null);
    /** The Properties panel of the dock; the Layers panel folds with settings.leftOpen. */
    let propsOpen = $state(true);
    /** Excel-style sheet within the template workbench. */
    let tplSheet = $state<'design' | 'preview' | 'adapt'>('design');
    /** When true the editor shell hosts the minimal template *usage* view. */
    let templateUse = $state(false);
    let canvasView = $state<EditorCanvas | null>(null);
    /**
     * Sidebar chrome. Widths and open/shut live in the app settings so the
     * layout the user arranges is still there next session.
     */
    function toggleSide(side: 'left' | 'right'): void {
        if (side === 'left') settings.leftOpen = !settings.leftOpen;
        else settings.rightOpen = !settings.rightOpen;
        settings.save();
    }

    function resetSide(side: 'left' | 'right'): void {
        if (side === 'left') settings.leftW = SIDEBAR.leftDefault;
        else settings.rightW = SIDEBAR.rightDefault;
        settings.save();
    }

    // ---- Photoshop-style tools ----

    /** Place the active tool's element where the label was clicked, then return to Move. */
    function onStageTap(point: { x: number; y: number }): void {
        if (tool === 'move' || tool === 'image') return;
        insertElement(editor, tool, shapeKind, point);
        tool = 'move';
    }

    function insertAtCentre(): void {
        if (tool === 'move' || tool === 'image') return;
        insertElement(editor, tool, shapeKind);
        tool = 'move';
    }

    function insertFromMenu(kind: PlacingTool, shape?: ShapeKind): void {
        if (shape) shapeKind = shape;
        insertElement(editor, kind, shape ?? shapeKind);
        tool = 'move';
    }

    function chooseImage(): void {
        imageInput?.click();
    }

    function onImageFiles(event: Event): void {
        const input = event.currentTarget as HTMLInputElement;
        addImageFromFile(editor, input.files);
        input.value = '';
        tool = 'move';
    }

    function zoomAction(action: 'in' | 'out' | 'fit' | 'reset'): void {
        if (action === 'fit') { canvasView?.fit(); return; }
        if (action === 'reset') { editor.zoom = 1; return; }
        const factor = action === 'in' ? 1.25 : 1 / 1.25;
        editor.zoom = Math.max(0.25, Math.min(16, Math.round(editor.zoom * factor * 100) / 100));
    }

    function startResize(e: PointerEvent, side: 'left' | 'right'): void {
        // A shut sidebar has no edge to grab; its rail button reopens it.
        if (side === 'left' ? !settings.leftOpen : !settings.rightOpen) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = side === 'left' ? settings.leftW : settings.rightW;
        const target = e.currentTarget as HTMLElement;
        // Capture keeps the drag alive over the canvas, but must not be able to
        // abort the whole gesture if the pointer is already gone.
        try { target.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

        const onMove = (ev: PointerEvent) => {
            // The right sidebar grows as the pointer moves *left*.
            const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
            const next = Math.min(SIDEBAR.maxW, Math.max(SIDEBAR.minW, startW + delta));
            if (side === 'left') settings.leftW = next; else settings.rightW = next;
        };
        const onUp = (ev: PointerEvent) => {
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('pointerup', onUp);
            target.removeEventListener('pointercancel', onUp);
            try { target.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
            settings.save();
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
        target.addEventListener('pointercancel', onUp);
    }

    /** App-level bottom sheets. */
    let sheet = $state<'printer' | 'settings' | 'report' | 'paper' | 'tools' | 'params' | 'design-options' | null>(null);
    let reportKind = $state<ReportKind>('missing-printer');
    let printReportContext = $state<PrintReportContext | undefined>();
    let diagnosticReportContext = $state<DiagnosticReportContext | undefined>();

    function openGenericReport(kind: ReportKind): void {
        reportKind = kind;
        printReportContext = undefined;
        diagnosticReportContext = undefined;
        sheet = 'report';
    }

    function openPrintReport(kind: ReportKind, context: PrintReportContext): void {
        reportKind = kind;
        printReportContext = context;
        diagnosticReportContext = undefined;
        sheet = 'report';
    }

    function openMissingPrinterReport(context?: DiagnosticReportContext): void {
        reportKind = 'missing-printer';
        printReportContext = undefined;
        diagnosticReportContext = context;
        sheet = 'report';
    }

    function changeReportKind(kind: ReportKind): void {
        reportKind = kind;
        if (kind === 'missing-printer') printReportContext = undefined;
        else diagnosticReportContext = undefined;
    }
    const editorCommands = untrack(() => createEditorCommands(editor, {
        print: () => (view = 'print'),
        settings: () => (sheet = 'settings')
    }));

    type MobileDrawerState = 'peek' | 'half' | 'full';
    let mobileDrawer = $state<MobileDrawerState>('peek');
    let drawerDragged = false;

    function stepMobileDrawer(direction: 'up' | 'down'): void {
        const states: MobileDrawerState[] = ['peek', 'half', 'full'];
        const current = states.indexOf(mobileDrawer);
        mobileDrawer = states[Math.min(states.length - 1, Math.max(0, current + (direction === 'up' ? 1 : -1)))];
    }

    function startDrawerDrag(event: PointerEvent): void {
        const startY = event.clientY;
        drawerDragged = false;
        const target = event.currentTarget as HTMLElement;
        try { target.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
        const finish = (up: PointerEvent) => {
            const delta = up.clientY - startY;
            if (Math.abs(delta) > 36) {
                drawerDragged = true;
                stepMobileDrawer(delta < 0 ? 'up' : 'down');
            }
            target.removeEventListener('pointerup', finish);
            target.removeEventListener('pointercancel', finish);
            try { target.releasePointerCapture(up.pointerId); } catch { /* already gone */ }
        };
        target.addEventListener('pointerup', finish);
        target.addEventListener('pointercancel', finish);
    }

    function toggleMobileDrawer(): void {
        if (drawerDragged) {
            drawerDragged = false;
            return;
        }
        stepMobileDrawer(mobileDrawer === 'full' ? 'down' : 'up');
    }

    $effect(() => {
        // Selecting an element exposes its useful fields immediately. Closing
        // the selection returns to the compact insert rail.
        const selectedId = editor.selectedId;
        untrack(() => { mobileDrawer = selectedId ? 'half' : 'peek'; });
    });

    // ---- consumer-view actions ------------------------------------------
    // The library entry behind the template being filled in.
    // `useTemplate` hands the document to the editor and leaves TemplateSession
    // untouched, so the editor's own template — not `templates.active` — is
    // what the consumer view is actually showing.
    const usedTemplateId = $derived(templateUse ? editor.template.id : undefined);
    const activeEntry = $derived(
        usedTemplateId ? templates.list().find(e => e.template.id === usedTemplateId) : undefined
    );
    function toggleTemplateFavorite(): void {
        if (usedTemplateId) templates.toggleFavorite(usedTemplateId);
    }

    const activeCapabilities = $derived(snap.capabilities ?? DEFAULT_PRINTER_CAPS[settings.defaultPrinter] ?? DEFAULT_PRINTER_CAPS['none']);

    // The driver owns the device resolution. Retarget the document once at the
    // editor boundary so paper selection, preview and print all use the same
    // physical-to-pixel conversion without manufacturer checks in the UI.
    $effect(() => {
        const dpmm = activeCapabilities.dpmm || 8;
        if (Math.abs(editor.authoringDpmm - dpmm) > 1e-6) {
            untrack(() => editor.setDeviceResolution(dpmm));
        }
    });

    interface MediaOffer {
        key: string;
        media: LoadedMedia;
        state: 'loading' | 'ready' | 'error';
        paper?: PaperProfile;
        error?: string;
    }

    /** Identified consumables are offered once per connection; Refresh must not nag again. */
    let handledMediaKey = $state<string | null>(null);
    let mediaOffer = $state<MediaOffer | null>(null);
    let mediaOfferSequence = 0;
    $effect(() => {
        if (snap.state === 'disconnected') {
            handledMediaKey = null;
            mediaOffer = null;
            mediaOfferSequence += 1;
            return;
        }
        const media = snap.status?.media;
        if (!media?.identification) return;
        const key = loadedMediaIdentityKey(media);
        if (!key || key === handledMediaKey || key === mediaOffer?.key) return;

        const sequence = ++mediaOfferSequence;
        mediaOffer = { key, media, state: 'loading' };
        const papers = [...DEFAULT_PAPER_PROFILES, ...settings.customPapers];
        const currentPaper = settings.paper;
        const printheadWidthMm = activeCapabilities.canvasHeightPx / (activeCapabilities.dpmm || 8);

        void session.resolveMedia(media).then(resolved => {
            if (sequence !== mediaOfferSequence) return;
            const hasDimensions = resolved.widthMm !== undefined
                && (resolved.kind === 'continuous' || resolved.lengthMm !== undefined);
            if (!hasDimensions) throw new Error('This roll identifier is not yet in the local paper catalogue.');
            const paper = resolveLoadedPaper(resolved, papers, currentPaper, printheadWidthMm).paper;
            mediaOffer = { key, media: resolved, paper, state: 'ready' };
        }).catch(error => {
            if (sequence !== mediaOfferSequence) return;
            mediaOffer = {
                key,
                media,
                state: 'error',
                error: error instanceof Error ? error.message : 'Paper details could not be loaded.'
            };
        });
    });

    function ignoreMediaOffer(): void {
        if (mediaOffer) handledMediaKey = mediaOffer.key;
        mediaOffer = null;
        mediaOfferSequence += 1;
    }

    function useMediaOffer(): void {
        if (mediaOffer?.paper) editor.setPaper(mediaOffer.paper);
        ignoreMediaOffer();
    }

    function chooseMediaManually(): void {
        ignoreMediaOffer();
        sheet = 'paper';
    }

    // Enforce pixel-perfect constraints:
    // The canvas height must NEVER exceed the physical printhead capabilities.
    // If the paper is narrower than the printhead, we shrink the canvas to match the paper,
    // and the backend printer driver will automatically center the resulting image on the printhead!
    $effect(() => {
        if (!editor.design) return;

        const printheadPx = activeCapabilities.canvasHeightPx;
        const paperWidthMm = editor.design.paper
            ? (editor.design.paper.labelWidthMm || editor.design.paper.tapeWidthMm)
            : undefined;

        let targetHeightPx: number;
        if (paperWidthMm) {
            const tapePx = Math.round(paperWidthMm * (activeCapabilities.dpmm || 8));
            // Template authoring is device-agnostic: keep the full designed tape
            // height so a 25 mm template isn't squished to a small printer's head
            // (which would also drift its mm-based placements when saved). Real
            // prints re-clamp to the printhead via resolveForPrinter.
            targetHeightPx = editor.isTemplateMode
                ? tapePx
                : printableHeightPx(activeCapabilities, editor.design.paper!.tapeWidthMm, editor.design.paper!.labelWidthMm);
        } else if (editor.isTemplateMode) {
            return; // no paper while authoring — leave the designed height alone
        } else {
            targetHeightPx = printheadPx;
        }

        if (editor.design.heightPx !== targetHeightPx) {
            // Silent (no history) so switching printer/paper doesn't spam undo.
            // setCanvasHeight also reflows responsive elements when authoring a template.
            untrack(() => {
                editor.setCanvasHeight(targetHeightPx);
            });
        }
    });

    // Feed the printer's unprintable margins to the store, so templates that
    // position against the whole physical label can be resolved correctly.
    $effect(() => {
        const x = activeCapabilities?.physical?.headToCutterPx || 0;
        const y = unprintableTopBottomPx;
        if (editor.mediaInsets.x !== x || editor.mediaInsets.y !== y) {
            untrack(() => { editor.mediaInsets = { x, y }; });
        }
    });

    if (import.meta.env.DEV) {
        // svelte-ignore state_referenced_locally
        (globalThis as Record<string, unknown> & typeof globalThis).__blewebler2 = { editor, session, transports, templates };
    }

    // ---- paper / printer-resolution matching for templates ----

    /**
     * Best paper profile for a template's designed size (else a synthesised one).
     * `continuous` forces gapless media — an auto-length template feeds as much
     * tape as its content needs, which only exists on continuous stock, so it
     * must never be matched to a fixed-length gap profile.
     */
    function matchPaper(df: TemplateAdaptivity['designedFor'], continuous = false): PaperProfile {
        const papers = [...DEFAULT_PAPER_PROFILES, ...settings.customPapers];
        if (continuous) {
            const cont = papers.find(p => p.tapeWidthMm === df.tapeWidthMm && p.labelLengthMm === undefined);
            return cont ?? {
                id: `tpl-${df.tapeWidthMm}-continuous`,
                name: `${df.tapeWidthMm}mm continuous`,
                type: 'continuous',
                tapeWidthMm: df.tapeWidthMm
            };
        }
        const exact = papers.find(p => p.tapeWidthMm === df.tapeWidthMm
            && (df.labelLengthMm ? p.labelLengthMm === df.labelLengthMm : !p.labelLengthMm));
        const byWidth = papers.find(p => p.tapeWidthMm === df.tapeWidthMm);
        return exact ?? byWidth ?? {
            id: `tpl-${df.tapeWidthMm}${df.labelLengthMm ? 'x' + df.labelLengthMm : ''}`,
            name: df.labelLengthMm ? `${df.tapeWidthMm}×${df.labelLengthMm}mm` : `${df.tapeWidthMm}mm continuous`,
            type: df.labelLengthMm ? 'gap' : 'continuous',
            tapeWidthMm: df.tapeWidthMm,
            labelLengthMm: df.labelLengthMm
        };
    }

    /** Resolve a template at the *current printer's* resolution, with matched paper. */
    function resolveForPrinter(tpl: LabelTemplate, params: Record<string, unknown>): LabelDesign {
        const df = tpl.adaptivity.designedFor;
        const paper = matchPaper(df);
        const pxPerMm = activeCapabilities?.dpmm || 8;
        const tapeWidthMm = df.tapeWidthMm;
        const labelLengthMm = df.labelLengthMm ?? templates.labelLengthMm;
        const heightPx = activeCapabilities
            ? printableHeightPx(activeCapabilities, tapeWidthMm)
            : Math.round(tapeWidthMm * pxPerMm);
        const widthPx = Math.max(8, Math.round(labelLengthMm * pxPerMm));
        const { design } = resolveTemplate(tpl, { widthPx, heightPx, tapeWidthMm, dpmm: pxPerMm, labelLengthMm, params, measureText: domMeasureText });
        return { ...design, paper };
    }

    /**
     * The media previews should be rendered at: the currently selected paper and
     * the active printer's resolution/printhead. Templates are adaptive, so a
     * thumbnail is only honest if it's resolved for the label you'd actually
     * print on.
     */
    const previewMedia = $derived.by(() => {
        const pxPerMm = activeCapabilities?.dpmm || 8;
        const printheadPx = activeCapabilities?.canvasHeightPx ?? 96;
        const paper = editor.paper;
        const tapeWidthMm = paper?.tapeWidthMm ?? printheadPx / pxPerMm;
        return { pxPerMm, printheadPx, tapeWidthMm, labelLengthMm: paper?.labelLengthMm, name: paper?.name };
    });

    /**
     * Consumer: open a template *in the editor* — the real canvas is the live
     * preview, with just the fill-in fields beside it. Paper/size come from the
     * matched media so what's on screen is what will print.
     */
    function useTemplate(tpl: LabelTemplate, origin?: DesignOrigin): void {
        editor.open(tpl, paperForTemplate(tpl), undefined, origin);
        editor.saveStatus = 'idle';
        templateUse = true;
        view = 'editor';
    }

    /**
     * The media to render a template on: whatever paper is currently selected
     * (that's the tape actually loaded in the printer), falling back to a
     * profile matching the template's designed size when nothing is selected.
     * An auto-length template needs gapless stock, so its fallback is continuous.
     */
    function paperForTemplate(tpl: LabelTemplate): PaperProfile {
        return editor.paper ?? matchPaper(tpl.adaptivity.designedFor, tpl.adaptivity.autoLength === true);
    }

    /** Author: open a saved template in the editor's author mode (paper matched). */
    function editTemplate(tpl: LabelTemplate, origin?: DesignOrigin): void {
        // Authoring edits the template at its own designed size.
        editor.editTemplate(tpl, matchPaper(tpl.adaptivity.designedFor, tpl.adaptivity.autoLength === true), origin);
        editor.saveStatus = 'idle';
        templateUse = false;
        tplSheet = 'design';
        view = 'editor';
    }

    /** Author: start a brand-new blank template. */
    /**
     * Open one of the template sheets on the current document.
     *
     * Marking the document as a template happens here rather than behind a
     * separate "Make template" step: asking for fields or for the size review
     * *is* the intent, and making someone declare it first was the step nobody
     * found. Nothing is destroyed either way — a document that has never been
     * saved to the template library is still just a label.
     *
     * Only the *authoring* sheets mark it, though. Template mode also switches
     * the canvas to the full designed tape height rather than clamping to the
     * printhead (see the reconcile effect), and having the canvas resize because
     * someone glanced at the fill-in preview would be a nasty surprise.
     */
    function openTemplateSheet(target: 'preview' | 'adapt'): void {
        if (target === 'adapt') editor.makeTemplate();
        tplSheet = target;
    }

    /** Save the in-progress template to the library (stays in the workbench). */
    function saveTemplate(): void {
        const tpl = editor.buildCurrentTemplate();
        if (tpl) { templates.saveTemplate(tpl, editor.origin); editor.saveStatus = 'saved'; }
    }

    /** Save + leave the workbench. */
    function finishTemplate(): void {
        saveTemplate();
        editor.exitTemplateMode();
        view = 'library';
    }

    /** The filled template is already the editor's document — just go print it. */
    function printTemplateDesign(): void {
        view = 'print';
    }
    /** Drop into the full editor on the same document (relative placements stay live). */
    function customizeTemplate(): void {
        templateUse = false;
        view = 'editor';
    }

    // Apply the persisted Theme + Animation settings to <body>, which is what
    // the CSS token blocks (body.theme-* / body.anim-*) key off. Without this
    // the settings persist but never take visual effect.
    $effect(() => {
        if (typeof document === 'undefined') return;
        const body = document.body;
        body.classList.remove('theme-system', 'theme-light', 'theme-dark');
        body.classList.add(`theme-${settings.theme}`);
        body.classList.remove('anim-normal', 'anim-fast', 'anim-none');
        body.classList.add(`anim-${settings.animations}`);
        // The skin is orthogonal to light/dark — it re-tints the same tokens.
        body.classList.remove('skin-tech', 'skin-craft');
        body.classList.add(`skin-${settings.skin}`);
    });

    // Auto-save: while enabled, the open label is continuously persisted
    // (debounced) as it's edited — no manual save. Empty canvases are never
    // written (see the guard), so a blank new label leaves no entry.
    $effect(() => {
        // Never auto-save as a *label* while authoring a template — that would
        // spam the library with stray label copies. Templates are saved
        // explicitly from the workbench.
        if (view !== 'editor' || !editor.autoSave || editor.isTemplateMode) return;
        // Subscribe to any change in the design.
        const fingerprint = JSON.stringify(editor.design);
        if (editor.design.elements.length === 0) {
            editor.saveStatus = 'idle';
            return;
        }
        void fingerprint;
        editor.saveStatus = 'saving';
        const timer = setTimeout(() => {
            editor.saveCurrent();
            editor.saveStatus = 'saved';
        }, 600);
        return () => clearTimeout(timer);
    });

    function openDesign(tpl: LabelTemplate, paper?: PaperProfile, inkBindings?: InkBinding[], origin?: DesignOrigin): void {
        editor.open(tpl, paper, inkBindings, origin);
        editor.saveStatus = 'saved'; // opened from the library — already persisted
        templateUse = false;
        view = 'editor';
    }

    function newLabel(): void {
        editor.newDesign(activeCapabilities?.canvasHeightPx ?? editor.design.heightPx);
        editor.saveStatus = 'idle';
        templateUse = false;
        view = 'editor';
    }

    /**
     * Leaving the editor. With auto-save on, flush the latest state; with it
     * off, respect the user's manual control and don't write on exit. An empty
     * canvas is never saved either way.
     */
    function backToLibrary(): void {
        if (templateUse) {
            // Just viewing/using a template — nothing to save.
            templateUse = false;
            view = 'library';
            return;
        }
        if (editor.isTemplateMode) {
            // Authoring a template: save it as a *template*, not a stray label.
            finishTemplate();
            return;
        }
        if (editor.autoSave && editor.design.elements.length > 0) {
            editor.saveCurrent();
        }
        editor.selectedId = null;
        view = 'library';
    }

    // ---- browser back-button integration ----
    // A history "trap": keep one buffered entry so a browser Back maps to the
    // app's own back navigation (close a sheet, print→editor, editor→library)
    // and only leaves the app once we're back at the library root.
    function canGoBack(): boolean {
        return sheet !== null || view !== 'library';
    }
    function goBack(): void {
        const ev = new CustomEvent('app-back', { cancelable: true });
        window.dispatchEvent(ev);
        if (ev.defaultPrevented) return;

        if (sheet !== null) { sheet = null; return; }
        if (view === 'print') { view = 'editor'; return; }
        if (view === 'editor') { backToLibrary(); return; }
        if (activeExtra) { view = 'library'; return; }
    }
    function onPopState(): void {
        if (canGoBack()) {
            goBack();
            history.pushState(null, ''); // re-arm the trap
        }
        // At the library root we let the Back propagate (leave the app).
    }
    onMount(() => {
        history.pushState(null, ''); // initial buffer
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    });

    function isEditingField(): boolean {
        const el = document.activeElement;
        return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    }

    function onKeydown(event: KeyboardEvent): void {
        if (view !== 'editor' || templateUse || sheet !== null || isEditingField()) return;
        const ctrl = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        // Single-letter tool shortcuts, as in Photoshop; Escape drops back to Move.
        if (!ctrl && !event.altKey && tplSheet === 'design') {
            const byKey: Partial<Record<string, EditorTool>> = { v: 'move', t: 'text', b: 'barcode', q: 'qr', m: 'datamatrix', u: 'shape', s: 'symbol' };
            if (event.key === 'Escape') {
                if (tool !== 'move') tool = 'move'; else editor.selectedId = null;
                event.preventDefault();
                return;
            }
            if (!event.shiftKey && byKey[key]) {
                tool = byKey[key]!;
                event.preventDefault();
                return;
            }
            if (!event.shiftKey && key === 'i') {
                chooseImage();
                event.preventDefault();
                return;
            }
        }
        if (ctrl && key === 's') { editorCommands.save(); event.preventDefault(); return; }
        if (ctrl && key === 'p') { editorCommands.print(); event.preventDefault(); return; }
        if (ctrl && (key === '=' || key === '+')) { zoomAction('in'); event.preventDefault(); return; }
        if (ctrl && key === '-') { zoomAction('out'); event.preventDefault(); return; }
        if (ctrl && key === '0') { zoomAction('fit'); event.preventDefault(); return; }
        if (ctrl && key === '1') { zoomAction('reset'); event.preventDefault(); return; }
        if (ctrl && event.key.toLowerCase() === 'z' && !event.shiftKey) {
            editorCommands.undo();
        } else if (ctrl && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) {
            editorCommands.redo();
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            if (editor.selectedId === null) return;
            if (editor.selected?.locked) {
                toast('Element is locked — unlock it first to delete', 'info');
                return;
            }
            editor.deleteSelected();
        } else if (event.key.startsWith('Arrow') && editor.selected && !editor.selected.locked) {
            const step = event.shiftKey ? 8 : 1;
            const el = editor.selected;
            const patch =
                event.key === 'ArrowLeft' ? { x: el.x - step } :
                event.key === 'ArrowRight' ? { x: el.x + step } :
                event.key === 'ArrowUp' ? { y: el.y - step } :
                { y: el.y + step };
            editor.updateSelected(patch);
        } else {
            return;
        }
        event.preventDefault();
    }

    /**
     * Battery as a percentage, or `undefined` where there is nothing to show.
     *
     * The normalized numeric reading keeps formatting and thresholds in the UI.
     */
    const battery = $derived.by(() => {
        const level = snap.status?.battery?.level;
        return level === undefined ? undefined : `${Math.round(level * 100)}%`;
    });

    const chipLabel = $derived.by(() => {
        const name = snap.deviceName ? snap.deviceName.split('-')[0] : 'Printer';
        return `${name}: ${snap.state}`;
    });

    /** The connected printer's own drawing, where the driver has one. */
    const chipArtwork = $derived(artworkForDevice(snap.deviceName, snap.capabilities?.driverName));

    /**
     * The LED the real machine would be showing, using the meanings the driver
     * publishes — green is "on, searching for a connection", blue is
     * "connected". Nothing is invented here: a state the driver has no colour
     * for leaves the LED dark rather than borrowing one that means something
     * else. Red in particular is *battery low* on this hardware, not an error,
     * so a failed connection does not light it.
     */
    const chipLed = $derived.by((): 'green' | 'blue' | 'off' => {
        if (!chipArtwork?.ledStates) return 'off';
        if (snap.state === 'connecting') return chipArtwork.ledStates.green ? 'green' : 'off';
        if (snap.state === 'connected' || snap.state === 'printing') {
            return chipArtwork.ledStates.blue ? 'blue' : 'off';
        }
        return 'off';
    });

    // The loaded media is an app-level setting, independent of whatever label or
    // template happens to be open.
    let paperLabel = $derived(settings.paper?.name ?? 'Select paper');
    const mobilePaperLabel = $derived.by(() => {
        const paper = settings.paper;
        if (!paper) return 'Paper';
        const width = paper.labelWidthMm ?? paper.tapeWidthMm;
        return paper.labelLengthMm ? `${width}×${paper.labelLengthMm} mm` : `${width} mm`;
    });
    const mobilePrinterLabel = $derived.by(() => {
        if (snap.state === 'connected' && battery) return battery;
        if (snap.state === 'disconnected') return 'Printer';
        return snap.state.charAt(0).toUpperCase() + snap.state.slice(1);
    });

    let activeExtra = $derived(extraTabs.find(t => t.id === view));

    /**
     * Every top-level view swap starts at the top.
     *
     * These are navigations in every sense except the browser's — the whole
     * screen is replaced — so they should behave like one. Without this,
     * jumping from a scrolled-down library to the Hardware tab drops you into
     * the middle of the table with no heading in sight.
     */
    $effect(() => {
        view;
        scrollToTop();
    });

    const unprintableTopBottomPx = $derived.by(() => {
        if (!editor.design.paper?.tapeWidthMm || !activeCapabilities?.canvasHeightPx) return 0;
        if (editor.design.paper.type !== 'continuous') return 0; // Only show for continuous tape
        
        // Tape beyond what can be printed: wider than the head, or outside a
        // printer's own band for this tape (DYMO D1).
        const tapeWidthPx = Math.round(editor.design.paper.tapeWidthMm * (activeCapabilities.dpmm || 8));
        const diff = tapeWidthPx - printableHeightPx(activeCapabilities, editor.design.paper.tapeWidthMm);
        return diff > 0 ? diff / 2 : 0;
    });

</script>

<svelte:window onkeydown={onKeydown} />

<div
    class="app"
    class:mode-editor={view === 'editor' || view === 'print'}
    class:mode-detail={view === 'editor' && templateUse}
    class:mode-fullbleed={activeExtra?.fullBleed}
>
    <header
        class:hero={view === 'library'}
        class:editor-design-header={view === 'editor' && !templateUse && tplSheet === 'design'}
    >
        {#if view === 'editor' && templateUse}
            <!-- Catalogue-detail chrome: navigation and device state, without
                 the editable filename, history controls or design ribbon. -->
            <button class="icon-btn" title="Back to designs" aria-label="Back" onclick={backToLibrary}><Icon name="arrow-left" /></button>
            <h1 class="use-title">Design details</h1>
            <span class="spacer"></span>
            <button class="chip paper-chip state-connected" title="Paper: {paperLabel}" onclick={() => (sheet = 'paper')}><span class="chip-text desktop-label">{paperLabel}</span><span class="chip-text mobile-label">{mobilePaperLabel}</span></button>
            <button class="chip printer-chip state-{snap.state}" title={battery ? `${chipLabel} · Battery ${battery}` : chipLabel} onclick={() => (sheet = 'printer')}>{#if chipArtwork}<PrinterMark artwork={chipArtwork} size={24} led={chipLed} />{/if}<span class="chip-text desktop-label">{chipLabel}</span><span class="chip-text mobile-label">{mobilePrinterLabel}</span></button>
            <button class="print-btn" onclick={printTemplateDesign} title={snap.state === 'disconnected' ? 'Connect a printer first' : 'Print'}>
                <Icon name="printer" /> Print
            </button>
        {:else if view === 'editor' || view === 'print'}
            <button
                class="icon-btn"
                title={view === 'print' ? 'Back to editor' : 'Back to designs (saves)'}
                aria-label="Back"
                onclick={() => { view === 'print' ? view = 'editor' : backToLibrary(); }}>
                <Icon name="arrow-left" />
            </button>
            <input
                class="name"
                type="text"
                value={editor.template.name}
                placeholder="Label name"
                onchange={e => editor.setTemplateName(e.currentTarget.value)}
            />
            {#if editor.autoSave && editor.saveStatus !== 'idle'}
                <span class="save-state" class:saved={editor.saveStatus === 'saved'}>
                    {#if editor.saveStatus === 'saved'}<Icon name="check" size={14} /> Saved{:else}Saving…{/if}
                </span>
            {/if}
            <button class="icon-btn menu-owned-action" onclick={editorCommands.undo} disabled={!editor.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
            <button class="icon-btn menu-owned-action" onclick={editorCommands.redo} disabled={!editor.canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
            <button class="chip paper-chip state-connected" title="Paper: {paperLabel}" aria-label="Paper: {paperLabel}. Open paper settings" onclick={() => (sheet = 'paper')}><Icon name="tag" size={16} /><span class="chip-text desktop-label">{paperLabel}</span><span class="chip-text mobile-label">{mobilePaperLabel}</span><span class="status-chevron"><Icon name="chevron-down" size={14} /></span></button>
            <button class="chip printer-chip state-{snap.state}" title={battery ? `${chipLabel} · Battery ${battery}` : chipLabel} aria-label="{chipLabel}. Open printer settings" onclick={() => (sheet = 'printer')}>{#if chipArtwork}<PrinterMark artwork={chipArtwork} size={24} led={chipLed} />{:else}<Icon name="printer" size={16} />{/if}<span class="chip-text desktop-label">{chipLabel}</span><span class="chip-text mobile-label">{mobilePrinterLabel}</span><span class="status-chevron"><Icon name="chevron-down" size={14} /></span></button>
            <button class="print-btn" onclick={() => (view === 'print' ? view = 'editor' : editorCommands.print())} title={view === 'print' ? 'Back to design' : 'Print (Ctrl+P)'}>
                <Icon name={view === 'print' ? 'pencil' : 'printer'} />
                {view === 'print' ? 'Design' : 'Print'}
            </button>
        {:else if activeExtra}
            <button class="icon-btn" title="Back" aria-label="Back" onclick={() => { goBack(); history.pushState(null, ''); }}><Icon name="arrow-left" /></button>
            <h1>{activeExtra.label}</h1>
            <span class="spacer"></span>
            <button class="chip paper-chip state-connected" title="Paper: {paperLabel}" onclick={() => (sheet = 'paper')}><span class="chip-text desktop-label">{paperLabel}</span><span class="chip-text mobile-label">{mobilePaperLabel}</span></button>
            <button class="chip printer-chip state-{snap.state}" title={battery ? `${chipLabel} · Battery ${battery}` : chipLabel} onclick={() => (sheet = 'printer')}>{#if chipArtwork}<PrinterMark artwork={chipArtwork} size={24} led={chipLed} />{/if}<span class="chip-text desktop-label">{chipLabel}</span><span class="chip-text mobile-label">{mobilePrinterLabel}</span></button>
        {:else}
            <h1 class="brand"><span class="brand-mark" aria-hidden="true"><Icon name="tag" size="1em" /></span> {title}</h1>
            <span class="spacer"></span>
            {#each extraTabs as extra (extra.id)}
                <button class="ghost" onclick={() => (view = extra.id)}>{extra.label}</button>
            {/each}
            <button class="chip paper-chip state-connected" title="Paper: {paperLabel}" onclick={() => (sheet = 'paper')}><span class="chip-text desktop-label">{paperLabel}</span><span class="chip-text mobile-label">{mobilePaperLabel}</span></button>
            <button class="chip printer-chip state-{snap.state}" title={battery ? `${chipLabel} · Battery ${battery}` : chipLabel} onclick={() => (sheet = 'printer')}>{#if chipArtwork}<PrinterMark artwork={chipArtwork} size={24} led={chipLed} />{/if}<span class="chip-text desktop-label">{chipLabel}</span><span class="chip-text mobile-label">{mobilePrinterLabel}</span></button>
        {/if}
        <button class="icon-btn menu-owned-action" onclick={editorCommands.settings} title="Settings" aria-label="Settings" style="margin-left: 4px;"><Icon name="settings" size={20} /></button>
    </header>

    <!-- Desktop: a dedicated command row followed by the active tool's options
         row. Mobile keeps its compact header and bottom drawer. -->
    {#if view === 'editor' && !templateUse && tplSheet === 'design'}
        <div class="ps-bars">
            <MenuBar
                {editor}
                commands={editorCommands}
                onSaveTemplate={() => openTemplateSheet('adapt')}
                onDesignFields={() => (sheet = 'params')}
                onSheetTab={t => { if (t === 'design') tplSheet = 'design'; else openTemplateSheet(t); }}
                onZoom={zoomAction}
                onInsert={insertFromMenu}
                onImage={chooseImage}
            />
            <OptionsBar
                {editor}
                {tool}
                {shapeKind}
                onshapekind={k => (shapeKind = k)}
                ontool={t => (tool = t)}
                oninsertcentre={insertAtCentre}
            />
        </div>
    {/if}

    <main>
        {#if view === 'library'}
            <DesignLibraryScreen
                session={templates}
                media={previewMedia}
                paper={editor.paper}
                onopen={openDesign}
                onnew={newLabel}
                onuse={useTemplate}
                onedit={editTemplate}
            />
        {:else if view === 'editor' && templateUse}
            <DesignDetailScreen
                {editor}
                entry={activeEntry}
                onfavorite={toggleTemplateFavorite}
                onedit={customizeTemplate}
                onprint={printTemplateDesign}
                onpaper={() => (sheet = 'paper')}
            />
        {:else if view === 'editor'}
            <div class="editor-view">
                <div class="tpl-workspace">
                    {#if tplSheet === 'design'}
                        <div
                            class="editor-layout"
                            class:right-shut={!settings.rightOpen}
                            style="--right-w:{settings.rightW}px;"
                        >
                            <!-- Desktop-only: the tool palette -->
                            <div class="area-tools">
                                <ToolPalette
                                    {tool}
                                    {shapeKind}
                                    ontool={t => (tool = t)}
                                    onshapekind={k => (shapeKind = k)}
                                    onzoom={zoomAction}
                                    onimage={chooseImage}
                                />
                            </div>
                            <div class="area-canvas">
                                <EditorCanvas
                                    bind:this={canvasView}
                                    {editor}
                                    unprintableLeadingPx={activeCapabilities?.physical?.headToCutterPx || 0}
                                    {unprintableTopBottomPx}
                                    onstagetap={onStageTap}
                                />
                            </div>
                            <!-- Desktop-only: side column — the template's fill-in
                                 fields while using it, else element properties. -->
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div
                                class="splitter right"
                                title="Drag to resize · double-click to reset"
                                onpointerdown={e => startResize(e, 'right')}
                                ondblclick={() => resetSide('right')}
                            ></div>
                            <div class="area-props">
                                {#if settings.rightOpen}
                                    <div class="side-head">
                                        <span class="side-title">Panels</span>
                                        <button class="side-toggle" title="Hide the panels" aria-label="Hide the panels" onclick={() => toggleSide('right')}>
                                            <Icon name="chevron-up" size={14} />
                                        </button>
                                    </div>
                                    <div class="dock">
                                        <DockPanel title="Properties" open={propsOpen} ontoggle={() => (propsOpen = !propsOpen)} grow>
                                            <PropertiesPanel {editor} />
                                        </DockPanel>
                                        <DockPanel title="Layers" badge={editor.design.elements.length} open={settings.leftOpen} ontoggle={() => toggleSide('left')} grow={!propsOpen}>
                                            <ElementChips {editor} embedded />
                                        </DockPanel>
                                    </div>
                                {:else}
                                    <button class="rail" title="Show the panels" aria-label="Show the panels" onclick={() => toggleSide('right')}>
                                        <Icon name="chevron-down" size={14} />
                                        <span class="rail-label">Panels</span>
                                    </button>
                                {/if}
                            </div>
                            <!-- Mobile/portrait-tablet composition of the same
                                 toolbar and properties components used above. -->
                            <div class="area-mobile drawer-{mobileDrawer}">
                                <div class="drawer-grab">
                                    <button
                                        type="button"
                                        aria-label="Resize inspector"
                                        title="Resize inspector"
                                        onpointerdown={startDrawerDrag}
                                        onclick={toggleMobileDrawer}
                                    ><span></span></button>
                                </div>
                                <div class="mobile-switch">
                                    <span class="panel-title">
                                        {editor.selected ? `Editing ${editor.selected.type}` : 'Add element'}
                                    </span>
                                    <span class="spacer"></span>
                                    {#if editor.selected}
                                        <button class="done" onclick={() => (editor.selectedId = null)}>Done</button>
                                    {/if}
                                    <button class="more" title="Design options" aria-label="Design options" onclick={() => (sheet = 'design-options')}><Icon name="more" /></button>
                                </div>
                                <div class="mobile-panel-content">
                                    {#if editor.selected}
                                        <PropertiesPanel {editor} />
                                    {:else}
                                        <Toolbar {editor} activeTab="Insert" compact />
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {:else if tplSheet === 'preview'}
                        <div class="tpl-pane"><TemplateInputsPanel {editor} /></div>
                    {:else}
                        <div class="tpl-pane"><TemplateAdaptPanel {editor} saved={editor.saveStatus === 'saved'} onsave={saveTemplate} onclose={finishTemplate} /></div>
                    {/if}
                </div>

                <!-- Excel-style sheet tabs, shown for *every* editable document.
                     The consumer detail page is a separate surface above. -->
                <div class="sheet-tabs">
                    <div class="desktop-sheet-tabs">
                        <button class="sheet" class:active={tplSheet === 'design'} onclick={() => (tplSheet = 'design')}><Icon name="pencil" size={14} /> Design</button>
                        <button class="sheet" class:active={tplSheet === 'preview'} onclick={() => openTemplateSheet('preview')}><Icon name="type" size={14} /> Test fields</button>
                        <button class="sheet" class:active={tplSheet === 'adapt'} onclick={() => openTemplateSheet('adapt')}><Icon name="save" size={14} /> Compatibility</button>
                        <span class="spacer"></span>
                        <button class="sheet-action" onclick={() => { editor.makeTemplate(); sheet = 'params'; }}>
                            Fields ({editor.templateMeta?.params.length ?? 0})
                        </button>
                        <button class="sheet-action primary" onclick={() => openTemplateSheet('adapt')}><Icon name="save" size={14} /> Save design…</button>
                    </div>
                    {#if tplSheet !== 'design'}
                        <button class="mobile-sheet-menu" onclick={() => (sheet = 'design-options')}>
                            <Icon name="more" size={16} /> Design options
                        </button>
                    {/if}
                </div>
                <div class="status-host">
                    <StatusBar {editor} printerLabel={chipLabel} printerState={snap.state} onzoom={zoomAction} onprinter={() => (sheet = 'printer')} />
                </div>
                <input bind:this={imageInput} type="file" accept="image/*" hidden onchange={onImageFiles} />
            </div>
        {:else if view === 'print'}
            <div class="print-view">
                <section class="print-section">
                    <h2>Label preview</h2>
                    <div class="print-frame">
                        <PreviewBar {editor} {session} />
                    </div>
                </section>
                <section class="print-section">
                    <h2>Printer</h2>
                    <div class="print-frame">
                        <ConnectPanel {session} {transports} onreportmissing={openMissingPrinterReport} />
                    </div>
                </section>
                <section class="print-section">
                    <h2>Print options</h2>
                    <div class="print-frame">
                    <PrintPanel {session} {editor} runtime={reportRuntime} onreport={openPrintReport} />
                    </div>
                </section>
            </div>
        {:else if activeExtra}
            {@render activeExtra.content()}
        {/if}
    </main>
</div>

<!-- First run. Sits above everything but blocks nothing: skipping lands you in
     exactly the app you would have got anyway. -->
{#if !settings.onboarded}
    <Onboarding
        {session}
        {transports}
        {editor}
        onclose={() => { /* settings.onboarded is already set */ }}
        onreportmissing={openMissingPrinterReport}
    />
{/if}

{#if sheet === 'design-options'}
    <Sheet title="Design options" onclose={() => (sheet = null)}>
        <nav class="design-options" aria-label="Design sections">
            <button class:active={tplSheet === 'design'} onclick={() => { tplSheet = 'design'; sheet = null; }}><Icon name="pencil" size={16} /> Design</button>
            <button class:active={tplSheet === 'preview'} onclick={() => { sheet = null; openTemplateSheet('preview'); }}><Icon name="type" size={16} /> Test fields</button>
            <button class:active={tplSheet === 'adapt'} onclick={() => { sheet = null; openTemplateSheet('adapt'); }}><Icon name="save" size={16} /> Compatibility &amp; save</button>
            <button onclick={() => { editor.makeTemplate(); sheet = 'params'; }}>Fields ({editor.templateMeta?.params.length ?? 0})</button>
        </nav>
        <h2>Layout</h2>
        <Toolbar {editor} activeTab="Layout" />
        <h2>File</h2>
        <Toolbar {editor} activeTab="File" onSaveTemplate={() => { sheet = null; openTemplateSheet('adapt'); }} />
    </Sheet>
{:else if sheet === 'printer'}
    <Sheet title="Printer" onclose={() => (sheet = null)}>
        <ConnectPanel {session} {transports} onreportmissing={openMissingPrinterReport} />
    </Sheet>
{:else if sheet === 'tools'}
    <Sheet title="Label tools" onclose={() => (sheet = null)}>
        <h2>Layout</h2>
        <Toolbar {editor} activeTab="Layout" />
        <h2>File</h2>
        <Toolbar {editor} activeTab="File" onSaveTemplate={() => openTemplateSheet('adapt')} />
    </Sheet>
{:else if sheet === 'settings'}
    <Sheet title="Settings" wide stable onclose={() => (sheet = null)}>
        <SettingsPanel onreport={openGenericReport} />
    </Sheet>
{:else if sheet === 'report'}
    <Sheet title="Report to OpenTLP" wide stable onclose={() => (sheet = null)}>
        <ReportPanel
            kind={reportKind}
            {session}
            build={reportBuild}
            runtime={reportRuntime}
            printContext={printReportContext}
            diagnosticContext={diagnosticReportContext}
            onkindchange={changeReportKind}
        />
    </Sheet>
{:else if sheet === 'paper'}
    <Sheet title="Paper Setup" onclose={() => (sheet = null)}>
        <PaperPanel {editor} {session} />
    </Sheet>
{:else if sheet === 'params'}
    <Sheet title="Design fields" onclose={() => (sheet = null)}>
        <ParametersPanel {editor} />
    </Sheet>
{/if}

{#if mediaOffer}
    <Sheet title="Paper detected" onclose={ignoreMediaOffer} priority>
        {#if mediaOffer.state === 'loading'}
            <div class="media-offer loading" aria-live="polite">
                <span class="media-spinner" aria-hidden="true"></span>
                <div>
                    <strong>Reading the loaded paper…</strong>
                    <p>Checking its identifier in the local paper catalogue.</p>
                </div>
            </div>
        {:else if mediaOffer.state === 'ready' && mediaOffer.paper}
            <div class="media-offer">
                <div class="media-offer-preview">
                    <PaperPreview paper={mediaOffer.paper} scale={1.6} length={70} />
                </div>
                <div class="media-offer-copy">
                    <strong>{mediaOffer.paper.name}</strong>
                    <span>
                        {mediaOffer.paper.tapeWidthMm} mm
                        {#if mediaOffer.paper.labelLengthMm} × {mediaOffer.paper.labelLengthMm} mm{/if}
                        · {mediaOffer.paper.type}
                    </span>
                    <span>The roll identifier does not describe exact corner geometry.</span>
                    {#if mediaOffer.media.identification?.barcode}<span>Barcode {mediaOffer.media.identification.barcode}</span>{/if}
                    {#if mediaOffer.media.total !== undefined}<span>Used {mediaOffer.media.used ?? '—'} / {mediaOffer.media.total}</span>{/if}
                </div>
            </div>
            <p class="media-offer-question">Use this paper for the current label?</p>
        {:else}
            <div class="media-offer-error" role="status">
                <strong>Paper dimensions unavailable</strong>
                <p>{mediaOffer.error}</p>
                <span>No information was sent to the printer manufacturer.</span>
                {#if mediaOffer.media.identification?.barcode}<span>Barcode {mediaOffer.media.identification.barcode}</span>{/if}
            </div>
        {/if}
        <div class="media-offer-actions">
            <button onclick={ignoreMediaOffer}>Ignore</button>
            {#if mediaOffer.state === 'ready'}
                <button class="primary" onclick={useMediaOffer}>Use paper</button>
            {:else if mediaOffer.state === 'error'}
                <button class="primary" onclick={chooseMediaManually}>Choose paper</button>
            {/if}
        </div>
    </Sheet>
{/if}

<ToastStack />

<style>
    /* Base (Light) Theme Variables */
    :global(:root), :global(body.theme-light), :global(body.theme-system) {
        --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace;
        --bg: #e9edf1;
        --panel: #f9fafb;
        --panel-2: #eef1f4;
        --border: #aeb7c2;
        --text: #18212b;
        --muted: #52606d;
        --accent: #2457d6;
        --accent-hover: #163f9f;
        --header-bg: #171d26;
        --header-text: #f7f8fa;
        --danger: #dc2626;
        --warn: #b45309;
        --ok: #047857;
        --checker: rgb(0 0 0 / 4%);
        --dot: rgb(31 41 55 / 12%);
        --tile: #fcfcfd;
        --ink: rgb(31 41 55 / 85%);
        --radius-control: 4px;
        --radius-panel: 16px;
        --card-radius: 12px;
        --shadow: 3px 3px 0 rgba(24, 33, 43, 0.10);
        --shadow-hover: 5px 5px 0 rgba(24, 33, 43, 0.14);
        --scrollbar: rgb(0 0 0 / 15%);
    }

    /* Dark Theme Variables */
    :global(body.theme-dark) {
        --bg: #0f1318;
        --panel: #181e26;
        --panel-2: #222a34;
        --border: #3b4653;
        --text: #f2f5f7;
        --muted: #a4aeba;
        --accent: #69c8ff;
        --accent-hover: #91d8ff;
        --header-bg: #0b0e12;
        --header-text: #f9fafb;
        --danger: #f87171;
        --warn: #fbbf24;
        --ok: #34d399;
        --checker: rgb(255 255 255 / 4%);
        --dot: rgb(249 250 251 / 14%);
        --tile: #182233;
        --ink: rgb(0 0 0 / 70%);
        --radius-control: 4px;
        --radius-panel: 16px;
        --card-radius: 12px;
        --shadow: 3px 3px 0 rgba(0,0,0,0.45);
        --shadow-hover: 5px 5px 0 rgba(0,0,0,0.62);
        --scrollbar: rgb(255 255 255 / 20%);
    }

    /* System Theme Override (when Dark OS preference) */
    @media (prefers-color-scheme: dark) {
        :global(body.theme-system) {
            --bg: #0f1318;
            --panel: #181e26;
            --panel-2: #222a34;
            --border: #3b4653;
            --text: #f2f5f7;
            --muted: #a4aeba;
            --accent: #69c8ff;
            --accent-hover: #91d8ff;
            --header-bg: #0b0e12;
            --header-text: #f9fafb;
            --danger: #f87171;
            --warn: #fbbf24;
            --ok: #34d399;
            --checker: rgb(255 255 255 / 4%);
            --dot: rgb(249 250 251 / 14%);
            --tile: #182233;
            --ink: rgb(0 0 0 / 70%);
            --radius-control: 4px;
            --radius-panel: 16px;
            --card-radius: 12px;
            --shadow: 3px 3px 0 rgba(0,0,0,0.45);
            --shadow-hover: 5px 5px 0 rgba(0,0,0,0.62);
            --scrollbar: rgb(255 255 255 / 20%);
        }
    }

    /*
     * ---- Skins -------------------------------------------------------------
     *
     * A skin re-tints the same tokens, so it composes with light/dark rather
     * than replacing them: every rule in the app keeps reading `--accent`,
     * `--panel` and friends. `tech` is the default indigo workshop look and
     * needs no overrides; `craft` is the warm shop-front one, for people who
     * are making labels for products rather than for equipment.
     */
    :global(body.skin-craft) {
        --bg: #faf6f1;
        --panel: #fffdfa;
        --panel-2: #f3ece3;
        --border: #d2bfa6;
        --text: #33261e;
        --muted: #6b5544;
        --accent: #853c29;          /* Mahogany */
        --accent-hover: #662c1d;
        --header-bg: var(--accent);
        --header-text: #fffdfa;
        --danger: #b2331f;
        --warn: #9a6410;
        --ok: #48692f;
        --checker: rgb(61 47 38 / 5%);
        --dot: rgb(93 64 45 / 15%);
        --tile: #fdf8f1;
        --ink: rgb(93 64 45 / 55%);
        --radius-control: 4px;
        --radius-panel: 16px;
        --card-radius: 12px;
        --shadow: 3px 3px 0 rgba(93, 64, 45, 0.14);
        --shadow-hover: 5px 5px 0 rgba(93, 64, 45, 0.20);
        --scrollbar: rgb(93 64 45 / 20%);
        /* Softer geometry and a display face for headings. */
        --display-font: Georgia, 'Iowan Old Style', 'Palatino Linotype', serif;
    }
    /* Warm dark: charcoal with a brown cast, not the cool slate of `tech`. */
    :global(body.skin-craft.theme-dark) {
        --bg: #221b17;
        --panel: #2d2420;
        --panel-2: #3a2f29;
        --border: #463831;
        --text: #f5ece4;
        --muted: #b09a89;
        --accent: #e07a5f; /* Rusty Coral */
        --accent-hover: #d46444;
        --header-bg: #2d2420;
        --header-text: #f5ece4;
        --danger: #e57366;
        --warn: #e0a850;
        --ok: #8fbf6a;
        --checker: rgb(255 250 245 / 5%);
        --dot: rgb(255 250 245 / 16%);
        --tile: #362b25;
        --ink: rgb(0 0 0 / 55%);
        --radius-control: 4px;
        --radius-panel: 16px;
        --card-radius: 12px;
        --shadow: 3px 3px 0 rgba(0, 0, 0, 0.48);
        --shadow-hover: 5px 5px 0 rgba(0, 0, 0, 0.64);
        --scrollbar: rgb(255 250 245 / 20%);
    }
    @media (prefers-color-scheme: dark) {
        :global(body.skin-craft.theme-system) {
            --bg: #221b17;
            --panel: #2d2420;
            --panel-2: #3a2f29;
            --border: #463831;
            --text: #f5ece4;
            --muted: #b09a89;
            --accent: #e07a5f; /* Rusty Coral */
            --accent-hover: #d46444;
            --header-bg: #2d2420;
            --header-text: #f5ece4;
            --danger: #e57366;
            --warn: #e0a850;
            --ok: #8fbf6a;
            --checker: rgb(255 250 245 / 5%);
            --dot: rgb(255 250 245 / 16%);
            --tile: #362b25;
            --ink: rgb(0 0 0 / 55%);
            --radius-control: 4px;
            --radius-panel: 16px;
            --card-radius: 12px;
            --shadow: 3px 3px 0 rgba(0, 0, 0, 0.48);
            --shadow-hover: 5px 5px 0 rgba(0, 0, 0, 0.64);
            --scrollbar: rgb(255 250 245 / 20%);
        }
    }
    /* Shape, not just colour — otherwise it reads as a palette swap. */
    :global(body.skin-craft) :global(h1),
    :global(body.skin-craft) :global(h2) {
        font-family: var(--display-font);
        font-weight: 600;
        letter-spacing: 0;
    }
    :global(body.skin-craft) :global(button),
    :global(body.skin-craft) :global(input),
    :global(body.skin-craft) :global(select),
    :global(body.skin-craft) :global(textarea) {
        border-radius: var(--radius-control);
    }
    :global(body.skin-craft) :global(.card),
    :global(body.skin-craft) :global(.panel) {
        border-radius: var(--radius-panel);
    }

    /* Animation Duration Variables */
    :global(:root), :global(body.anim-normal) {
        --anim-duration: 1.2s;
    }
    :global(body.anim-fast) {
        --anim-duration: 0.4s;
    }
    :global(body.anim-none) {
        --anim-duration: 0.01s; /* non-zero for JS events, virtually instantaneous */
    }
    :global(body) {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        -webkit-tap-highlight-color: transparent;
    }
    :global(button) {
        font: inherit;
        color: var(--text);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-control);
        padding: 6px 14px;
        min-height: 36px;
        cursor: pointer;
        transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease, color 0.12s ease;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
    }
    :global(button:hover:not(:disabled)) {
        background: var(--panel-2);
        border-color: var(--accent);
        box-shadow: 2px 2px 0 color-mix(in srgb, var(--accent) 28%, transparent);
    }
    :global(button:active:not(:disabled)) {
        transform: translate(1px, 1px);
        box-shadow: none;
    }
    :global(button:disabled) {
        opacity: 0.45;
        cursor: default;
    }
    :global(button.primary) {
        background: var(--accent);
        color: #fff;
        border-color: transparent;
        box-shadow: 2px 2px 0 color-mix(in srgb, var(--accent) 32%, transparent);
    }
    :global(button.primary:hover:not(:disabled)) {
        background: var(--accent-hover);
        box-shadow: 3px 3px 0 color-mix(in srgb, var(--accent) 38%, transparent);
    }
    :global(button.danger) {
        color: #fff;
        background: var(--danger);
        border-color: transparent;
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.25);
    }
    .media-offer {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-panel);
        background: var(--panel);
    }
    .media-offer.loading { align-items: flex-start; }
    .media-offer p,
    .media-offer-error p,
    .media-offer-question { margin: 4px 0 0; color: var(--muted); }
    .media-offer-preview { flex: 0 0 112px; overflow: hidden; }
    .media-offer-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .media-offer-copy span,
    .media-offer-error span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .media-offer-error {
        padding: 12px;
        border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border));
        border-radius: var(--radius-panel);
        background: color-mix(in srgb, var(--warn) 8%, var(--panel));
    }
    .media-offer-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .media-spinner {
        width: 18px;
        height: 18px;
        margin-top: 2px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: media-spin .8s linear infinite;
    }
    @keyframes media-spin { to { transform: rotate(360deg); } }
    :global(input),
    :global(select),
    :global(textarea) {
        font: inherit;
        color: var(--text);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-control);
        padding: 8px 12px;
        box-sizing: border-box;
        max-width: 100%;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    :global(input:focus),
    :global(select:focus),
    :global(textarea:focus) {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
    }
    :global(h2) {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
        margin: 4px 0 0;
    }

    .app {
        position: relative;
        z-index: 0;
        display: flex;
        flex-direction: column;
        min-height: 100dvh;
        width: 100%;
        padding: 0 12px calc(12px + env(safe-area-inset-bottom));
        box-sizing: border-box;
    }
    .app.mode-editor {
        max-width: none;
    }
    header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: var(--header-bg);
        color: var(--header-text);
        border-bottom: 1px solid rgba(0,0,0,0.1);
        box-shadow: none;
        z-index: 10;
        position: relative;
    }
    /* Home screen: page-integrated but still reads as deliberate app chrome. */
    header.hero {
        background: transparent;
        color: var(--text);
        border-bottom: 1px solid var(--border);
        box-shadow: none;
        padding: 14px 4px 10px;
        gap: 8px;
    }
    header.hero .brand {
        font-size: 23px;
        font-weight: 800;
        letter-spacing: -0.015em;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    header.hero .brand-mark {
        font-size: 22px;
        color: var(--accent);
        transform: rotate(-8deg);
    }
    header.hero .ghost {
        background: var(--panel);
        border: 1px solid var(--border);
        color: var(--text);
        box-shadow: none;
    }
    header.hero .ghost:hover:not(:disabled) {
        background: var(--panel-2);
    }
    header.hero .chip {
        background: var(--panel);
        border: 1px solid var(--border);
        box-shadow: none;
    }
    /* --header-text is white in every skin, because the app-bar is normally a
       colored slab. The hero drops that background, so its icon buttons have to
       come back to the page's own text colour or they vanish in light mode. */
    header.hero .icon-btn {
        color: var(--text);
    }
    header.hero .icon-btn:hover {
        background: var(--panel-2);
        color: var(--text);
    }
    header.hero .chip.state-connected { color: var(--ok); border-color: var(--ok); }
    header.hero .chip.state-printing { color: var(--accent); border-color: var(--accent); }
    header.hero .chip.state-connecting { color: var(--warn); border-color: var(--warn); }
    h1 {
        font-size: 17px;
        margin: 0;
        white-space: nowrap;
    }
    .spacer {
        flex: 1;
    }
    .icon-btn {
        background: transparent;
        border: none;
        font-size: 18px;
        padding: 8px;
        color: var(--header-text);
        border-radius: var(--radius-control);
        box-shadow: none;
    }
    .icon-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        transform: none;
    }
    .name {
        flex: 1;
        min-width: 60px;
        font-weight: 600;
        background: transparent;
        border-color: transparent;
        font-size: 16px;
        color: var(--header-text);
        padding: 8px 12px;
    }
    .use-title {
        font-size: 16px;
        font-weight: 700;
        margin: 0;
        color: var(--header-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .name:hover,
    .name:focus {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.2);
        box-shadow: none;
    }
    .print-btn {
        white-space: nowrap;
    }
    .save-state {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        color: var(--header-text);
        opacity: 0.7;
        white-space: nowrap;
        padding: 0 2px;
    }
    .save-state.saved {
        opacity: 0.85;
    }
    .ghost {
        background: rgba(255, 255, 255, 0.1);
        border-color: transparent;
        color: var(--header-text);
    }
    .ghost:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.2);
    }
    .chip {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        border-radius: var(--radius-control);
        font-size: 14px;
        font-weight: 700;
        padding: 6px 14px;
        min-height: 36px;
        white-space: nowrap;
        max-width: 40vw;
        overflow: hidden;
        background: #fff;
        border-color: transparent;
        box-shadow: 2px 2px 0 rgba(0,0,0,0.18);
    }
    /* The ellipsis has to live on the text itself now that the chip is a flex
       row — `text-overflow` on a flex container truncates nothing. */
    .chip-text {
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .status-chevron {
        display: inline-flex;
        align-items: center;
        opacity: 0.6;
    }
    .chip:hover:not(:disabled) {
        background: #f9fafb;
        color: var(--text);
    }

    :global(body.theme-dark) .chip {
        background: var(--panel-2);
        color: var(--text);
    }
    :global(body.theme-dark) .chip:hover:not(:disabled) {
        background: color-mix(in srgb, var(--panel-2) 90%, #fff);
    }

    @media (prefers-color-scheme: dark) {
        :global(body.theme-system) .chip {
            background: var(--panel-2);
            color: var(--text);
        }
        :global(body.theme-system) .chip:hover:not(:disabled) {
            background: color-mix(in srgb, var(--panel-2) 90%, #fff);
        }
    }
    .chip.state-connected {
        color: var(--ok);
    }
    .chip.state-printing {
        color: var(--accent);
    }
    .chip.state-connecting {
        color: var(--warn);
    }
    .print-btn {
        white-space: nowrap;
        background: #fff;
        color: var(--accent);
        border-color: transparent;
        font-weight: 700;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .print-btn:hover:not(:disabled) {
        background: #fff;
        color: var(--accent-hover);
    }
    :global(body.theme-dark) .print-btn {
        background: var(--accent);
        color: var(--accent-fg, #fff);
    }
    :global(body.theme-dark) .print-btn:hover:not(:disabled) {
        background: var(--accent-hover);
        color: var(--accent-fg, #fff);
    }
    @media (prefers-color-scheme: dark) {
        :global(body.theme-system) .print-btn {
            background: var(--accent);
            color: var(--accent-fg, #fff);
        }
        :global(body.theme-system) .print-btn:hover:not(:disabled) {
            background: var(--accent-hover);
            color: var(--accent-fg, #fff);
        }
    }
    main {
        flex: 1;
        padding-bottom: 8px;
    }

    /* ---- Desktop ribbon (OnlyOffice/Docs-style) ----
       Desktop-only: full-bleed and flush (real app chrome, not a floating card).
       Hidden on mobile, which uses .mobile-insert instead. */

    /* ---- Mobile panel below the canvas (auto Add / Selection) ---- */
    .mobile-switch {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
    }
    .panel-title {
        font-weight: 700;
        text-transform: capitalize;
    }
    .mobile-switch .more {
        flex: none;
        min-width: 40px;
        font-size: 18px;
        line-height: 1;
    }

    /* ---- Template workbench (Excel-style sheet tabs) ---- */
    .editor-view {
        display: flex;
        flex-direction: column;
        min-height: 0;
    }
    .tpl-workspace {
        min-height: 0;
    }
    .tpl-pane {
        overflow-y: auto;
        max-height: 100%;
    }
    .sheet-tabs {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        flex-wrap: wrap;
        padding: 6px 10px;
        border-top: 1px solid var(--border);
        background: var(--panel);
    }
    .desktop-sheet-tabs {
        display: none;
    }
    .mobile-sheet-menu {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        width: min(100%, 420px);
        min-height: 44px;
    }
    .sheet-tabs .spacer { flex: 1; }
    .sheet-tabs .sheet {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        padding: 5px 14px;
        border: 1px solid var(--border);
        border-bottom: none;
        border-radius: 3px 3px 0 0;
        background: var(--panel-2);
        color: var(--muted);
        box-shadow: none;
        font-size: 13px;
        font-weight: 600;
    }
    .sheet-tabs .sheet:hover { transform: none; }
    .sheet-tabs .sheet.active {
        background: var(--panel);
        color: var(--accent);
        border-color: var(--accent);
    }
    .sheet-tabs .sheet-action {
        min-height: 32px;
        padding: 5px 12px;
        font-size: 13px;
    }
    .mobile-label { display: none; }
    .design-options {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
    }
    .design-options button {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        min-height: 44px;
        text-align: left;
    }
    .design-options button.active {
        background: var(--accent);
        color: var(--accent-fg, #fff);
        border-color: transparent;
    }
    @media (max-width: 859px) {
        .desktop-label { display: none; }
        .mobile-label { display: inline; }
        .status-chevron { display: none; }
        .app.mode-editor:not(.mode-detail) {
            height: 100dvh;
            min-height: 0;
            overflow: hidden;
            padding-bottom: 0;
        }
        .app.mode-editor:not(.mode-detail) main {
            min-height: 0;
            overflow: hidden;
            padding-bottom: 0;
        }
        .app.mode-editor:not(.mode-detail) .editor-view,
        .app.mode-editor:not(.mode-detail) .tpl-workspace {
            height: 100%;
        }
        .app.mode-editor:not(.mode-detail) .tpl-workspace {
            flex: 1;
            overflow: hidden;
        }
        .app.mode-editor:not(.mode-detail) .editor-layout {
            height: 100%;
            grid-template-rows: minmax(0, 1fr);
            box-sizing: border-box;
        }
        .app.mode-editor:not(.mode-detail) .tpl-pane,
        .app.mode-editor:not(.mode-detail) .print-view {
            height: 100%;
        }
    }
    @media (max-width: 640px) {
        header:not(.hero) {
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px;
        }
        header:not(.hero) > button {
            min-height: 40px;
        }
        .app.mode-editor header .use-title {
            flex: 1 1 120px;
            min-width: 80px;
        }
        .app.mode-editor header .name {
            flex: 1 1 80px;
            min-width: 80px;
        }
        .app.mode-editor header::after {
            content: '';
            order: 1;
            flex: 0 0 100%;
            height: 0;
        }
        .app.mode-editor header .spacer { display: none; }
        .app.mode-editor header .save-state { display: none; }
        .app.mode-editor header > .chip,
        .app.mode-editor header > .print-btn {
            order: 2;
        }
        .app.mode-editor header > .chip {
            flex: 1 1 70px;
            min-width: 0;
            max-width: none;
            padding: 6px 8px;
        }
        .app.mode-editor header > .print-btn {
            flex: 1 1 80px;
            min-width: 0;
            padding-inline: 12px;
        }
        header.hero {
            flex-wrap: wrap;
            padding: 12px 0 6px;
            gap: 6px;
        }
        header.hero .brand {
            flex: 1 1 calc(100% - 44px);
            font-size: 19px;
        }
        header.hero .spacer {
            display: none;
        }
        header.hero .ghost,
        header.hero .chip {
            order: 1;
            min-width: 0;
            padding: 5px 10px;
        }
        header.hero .chip {
            flex: 1 1 0;
            max-width: none;
        }
    }

    /* ---- Editor workspace ---- */
    .editor-layout {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
        padding: 12px 12px calc(156px + env(safe-area-inset-bottom));
        grid-template-areas:
            "canvas";
    }
    .area-canvas { grid-area: canvas; }
    .area-tools { grid-area: tools; }
    .area-props { grid-area: props; }
    /* Mobile is a single column: no side columns, so nothing to drag. */
    .splitter { display: none; }
    .side-head { display: none; }
    /* Mobile: the tool palette, the dock, the menu/options bars and the
       status bar are desktop chrome; the canvas + the Add/Selection panel
       are the whole editor. */
    .ps-bars,
    .area-tools,
    .status-host,
    .area-props {
        display: none;
    }
    .area-canvas,
    .area-mobile {
        min-width: 0;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-panel);
        box-shadow: var(--shadow);
    }
    .area-mobile {
        position: fixed;
        z-index: 220;
        left: max(8px, calc((100vw - 720px) / 2));
        right: max(8px, calc((100vw - 720px) / 2));
        bottom: 0;
        display: flex;
        flex-direction: column;
        height: 156px;
        padding: 0 12px calc(10px + env(safe-area-inset-bottom));
        box-sizing: border-box;
        border-radius: 7px 7px 0 0;
        box-shadow: 0 -8px 28px rgb(0 0 0 / 18%);
        transition: height 180ms ease;
        overflow: hidden;
    }
    .area-mobile.drawer-half { height: min(52dvh, 520px); }
    .area-mobile.drawer-full { height: calc(100dvh - 112px); }
    .drawer-grab {
        display: grid;
        place-items: center;
        min-height: 26px;
        touch-action: none;
        cursor: ns-resize;
    }
    .drawer-grab button {
        display: grid;
        place-items: center;
        width: 64px;
        height: 26px;
        min-height: 0;
        padding: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
    }
    .drawer-grab button:hover { transform: none; }
    .drawer-grab span {
        width: 34px;
        height: 4px;
        border-radius: 99px;
        background: var(--border);
    }
    .mobile-panel-content {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        scrollbar-width: thin;
    }
    .area-mobile.drawer-peek .mobile-panel-content { overflow-y: hidden; }
    .area-canvas {
        overflow: hidden;
        min-height: clamp(340px, calc(100dvh - 285px), 660px);
        display: flex;
        flex-direction: column;
    }

    @media (max-width: 420px) {
        .app { padding-inline: 8px; }
        .editor-layout {
            gap: 8px;
            padding: 8px 0 calc(156px + env(safe-area-inset-bottom));
        }
        .area-mobile {
            left: 0;
            right: 0;
            padding-inline: 10px;
        }
        .mobile-switch .more {
            min-width: 40px;
            min-height: 40px;
        }
        .design-options { grid-template-columns: 1fr; }
    }

    /* Portrait tablets have a single-row header, so a fully opened inspector
       can use the extra vertical space phones reserve for their second row. */
    @media (min-width: 641px) and (max-width: 859px) {
        .area-mobile.drawer-full { height: calc(100dvh - 56px); }
    }

    .print-view {
        display: flex;
        flex-direction: column;
        gap: 18px;
        width: 100%;
        max-width: 620px;
        margin: 0 auto;
        padding: 18px 14px calc(24px + env(safe-area-inset-bottom));
        box-sizing: border-box;
        overflow-y: auto;
    }
    .print-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .print-section h2 {
        margin: 0 4px;
    }
    .print-frame {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-panel);
        padding: 14px;
        box-shadow: var(--shadow);
    }
    /* Flatten the components' own panels so each section reads as one card. */
    .print-frame :global(.panel) {
        background: transparent;
        padding: 0;
        box-shadow: none;
        border: none;
    }
    /* ...but keep the inner option/connected/job chips distinct against it. */
    .print-frame :global(.option),
    .print-frame :global(.connected),
    .print-frame :global(.error) {
        background: var(--panel-2);
    }
    @media (max-width: 420px) {
        .print-view { padding-inline: 4px; }
        .print-frame { padding: 10px; }
    }
    @media (min-width: 860px) {
        .app.mode-editor .print-view {
            height: 100%;
        }
    }

    @media (min-width: 860px) {
        /* Desktop chrome: everything flush and edge-to-edge (no floating cards,
           no rounded structural panels) — separated by hairline dividers. */
        .app.mode-editor {
            height: 100dvh;
            overflow: hidden;
            max-width: none;
            padding: 0;
        }
        .app.mode-fullbleed {
            padding-left: 0;
            padding-right: 0;
        }
        .app.mode-editor main {
            flex: 1;
            overflow: hidden;
            min-height: 0;
        }
        .editor-design-header .menu-owned-action {
            display: none;
        }
        /* The editor view fills main; the workspace flexes and the sheet tabs
           pin to the bottom (Excel-style). */
        .editor-view { height: 100%; }
        .tpl-workspace { flex: 1; overflow: hidden; }
        .tpl-pane { height: 100%; }
        .sheet-tabs { justify-content: flex-start; }
        .desktop-sheet-tabs {
            display: flex;
            align-items: center;
            gap: 4px;
            width: 100%;
        }
        .mobile-sheet-menu { display: none; }

        /* Desktop: hide the mobile panel, restore the two side columns. */
        .area-mobile {
            display: none;
        }

        .editor-layout {
            /* Sidebar widths come from the settings; a shut one becomes a slim
               rail that still shows how to bring it back. */
            grid-template-columns: 48px 1fr 5px var(--right-w);
            grid-template-areas: "tools canvas rdrag props";
            /* Photoshop's neutral workspace grey, derived from the theme so it
               sits between the panels and the paper in both light and dark. */
            --workspace: color-mix(in srgb, var(--bg) 78%, #7d7d7d);
            align-items: stretch;
            gap: 0;
            padding: 0;
            height: 100%;
            box-sizing: border-box;
        }
        .area-canvas,
        .area-tools,
        .area-props {
            border: none;
            border-radius: 0;
            box-shadow: none;
            background: var(--panel);
        }
        .area-tools {
            display: block;
            border-right: 1px solid var(--border);
            overflow: visible;
            padding: 0;
        }
        .area-props {
            display: flex;
            flex-direction: column;
            border-left: 1px solid var(--border);
            overflow: hidden;
            padding: 0;
        }
        .dock {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
        }
        .area-canvas {
            /* The recessed workspace the label floats on. */
            background: var(--workspace);
            padding: 0;
        }
        .area-canvas :global(.viewport) {
            border-radius: 0;
            background-color: var(--workspace);
            background-image: none;
        }
        /* Zoom lives in the status bar and the palette on desktop. */
        .area-canvas :global(.zoom-overlay) { display: none; }
        .ps-bars { display: block; }
        .status-host { display: block; }
        /* Document tabs sit above the canvas, like Photoshop's, not below. */
        .sheet-tabs {
            order: -1;
            justify-content: flex-start;
            padding: 6px 8px 0;
            border-top: none;
            border-bottom: 1px solid var(--border);
            background: var(--panel-2);
        }
        .sheet-tabs .sheet { border-radius: 3px 3px 0 0; }
        /* The drag edge. Wider hit area than it looks, so it is grabbable
           without being a visual divider in its own right. */
        .splitter {
            display: block;
            position: relative;
            cursor: col-resize;
            background: transparent;
            touch-action: none;
        }
        .splitter.right { grid-area: rdrag; }
        .splitter::after {
            content: '';
            position: absolute;
            inset: 0 -3px;
        }
        .splitter:hover::after,
        .splitter:active::after {
            background: color-mix(in srgb, var(--accent) 45%, transparent);
        }
        .editor-layout.right-shut .splitter.right { cursor: default; }
        .editor-layout.right-shut .splitter.right::after { background: none; }

        /* A shut dock collapses to this rail. */
        .editor-layout.right-shut { grid-template-columns: 48px 1fr 5px 34px; }

        .side-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 6px 4px 10px;
            border-bottom: 1px solid var(--border);
        }
        .side-title {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.02em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .side-toggle {
            padding: 3px 6px;
            background: var(--panel-2);
            box-shadow: none;
            color: var(--muted);
        }
        .side-toggle:hover { transform: none; color: var(--fg); }
        /* Point the chevron along the axis the dock folds away on. */
        .area-props .side-toggle :global(svg) { transform: rotate(-90deg); }

        .rail {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
            width: 100%;
            height: 100%;
            padding: 12px 0;
            background: none;
            border: none;
            box-shadow: none;
            color: var(--muted);
        }
        .rail:hover { transform: none; color: var(--fg); }
        .rail-label {
            writing-mode: vertical-rl;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.03em;
            white-space: nowrap;
        }
        .editor-layout.right-shut .area-props { padding: 8px 0; overflow: hidden; }

        .area-props::-webkit-scrollbar {
            width: 8px;
        }
        .area-props::-webkit-scrollbar-thumb {
            background: var(--scrollbar);
            border-radius: 4px;
        }
    }

    /* Keep the same desktop composition on landscape tablets and compact
       windows, but give the canvas useful room. User-selected sidebar widths
       return unchanged once the window reaches a conventional desktop size. */
    @media (min-width: 860px) and (max-width: 1199px) {
        .editor-layout {
            grid-template-columns: 48px 1fr 5px var(--right-w);
        }
        .editor-layout.right-shut {
            grid-template-columns: 48px 1fr 5px 34px;
        }
    }

    /* Landscape tablets keep the desktop composition when it fits. Only the
       invisible hit zones grow for touch; desktop visuals do not. */
    @media (min-width: 860px) and (pointer: coarse) {
        .splitter::after { inset: 0 -8px; }
        .side-toggle::after {
            content: '';
            position: absolute;
            inset: -7px;
        }
        .side-toggle { position: relative; }
    }

    /* The editor intentionally locks to the viewport; a catalogue detail page
       is a document-style surface and must scroll through its specifications. */
    @media (min-width: 860px) {
        .app.mode-editor.mode-detail {
            height: auto;
            min-height: 100dvh;
            overflow: visible;
        }
        .app.mode-editor.mode-detail main { overflow: visible; }
    }
</style>
