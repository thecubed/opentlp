<script lang="ts">
    /**
     * The interactive design surface. The label is a DOM rectangle scaled by
     * `zoom`; elements are pixel-exact previews positioned absolutely. All
     * pointer gestures (select, drag with snapping, resize, and canvas panning)
     * are handled here.
     */
    import type { AnyElement, LabelDesign } from 'universal-label-renderer';
    import type { EditorStore } from '../stores/editor.svelte';
    import { anchorFx, anchorFy } from 'universal-label-renderer';
    import { measureElement, rotatedBounds } from 'universal-label-renderer';
    import { domMeasureText } from 'universal-label-renderer';
    import { dieWithHoles, diePlacement, hasShapedDie } from 'universal-label-renderer';
    import ElementView from './ElementView.svelte';
    import Icon from './Icon.svelte';
    import { untrack } from 'svelte';

    interface Props {
        editor: EditorStore;
        unprintableLeadingPx?: number;
        unprintableTopBottomPx?: number;
        /**
         * Height at the bottom of the canvas hidden behind an overlay (the
         * phone inspector). The label is centred in, and the selection kept
         * within, the part above it.
         */
        bottomInset?: number;
        /** View-only: elements can't be selected, moved, resized or rotated. */
        readonly?: boolean;
        /**
         * A click on the empty label (no pan), in label pixels. The designer
         * uses it to place the active tool's element where the user pointed.
         */
        onstagetap?: (point: { x: number; y: number }) => void;
    }
    let { editor, unprintableLeadingPx = 0, unprintableTopBottomPx = 0, bottomInset = 0, readonly = false, onstagetap }: Props = $props();

    const design = $derived(editor.design);

    let containerWidth = $state(0);
    let containerHeight = $state(0);
    /** The part of the canvas not covered by an overlay at the bottom. */
    const visibleHeight = $derived(Math.max(48, containerHeight - bottomInset));
    
    let panX = $state(0);
    let panY = $state(0);

    /**
     * The canvas drawn as the loaded label: its shape and its colour.
     *
     * It clips to the same die path used by the preview and print mask, so the
     * editing surface matches rounded, elliptical and custom label shapes.
     */
    const paper = $derived(editor.design.paper);
    /** Whether the canvas needs clipping at all — a plain rectangle does not. */
    const clipped = $derived(!!paper && paper.type !== 'continuous' && hasShapedDie(paper));
    /**
     * The die as an SVG clip path.
     *
     * An SVG `<clipPath>` rather than the CSS `path()` function, because the
     * die is authored upright and may be mounted sideways: SVG can carry that
     * rotation as a transform, while CSS `path()` takes bare geometry and would
     * mean rotating arc commands by hand.
     */
    const dieGeom = $derived(clipped ? dieWithHoles(paper!) : null);
    const dieTransform = $derived.by(() => {
        if (!paper || !clipped) return '';
        // diePlacement maps label-space mm to *canvas* pixels; the clip path is
        // declared in the same pixel space as the (zoomed) canvas element, so we
        // scale the whole transform by the zoom factor to keep the outline glued
        // to the canvas at any zoom. Sharing the placement with the thumbnail and
        // print mask means a die-cut sticker narrower than its carrier is inset
        // and to scale here too, not stretched to the full tape height.
        const m = diePlacement(paper, design.widthPx, design.heightPx);
        if (!m) return '';
        const z = editor.zoom;
        return `matrix(${m.a * z} ${m.b * z} ${m.c * z} ${m.d * z} ${m.e * z} ${m.f * z})`;
    });
    /** Substrate colour behind the design, so coloured stock reads as coloured. */
    const paperColor = $derived(
        paper?.appearance?.baseColor ?? paper?.appearance?.colorways?.[0]?.color ?? '#ffffff'
    );

    interface Gesture {
        mode: 'move' | 'resize' | 'pan' | 'pinch' | 'resize-canvas' | 'rotate';
        pointerId: number;
        startClientX: number;
        startClientY: number;
        element?: AnyElement;
        startPanX?: number;
        startPanY?: number;
        startCanvasWidth?: number;
        /** Rotation pivot in client coordinates (rotate gesture). */
        centerX?: number;
        centerY?: number;
    }
    let gesture: Gesture | null = null;
    let activePointers = new Map<number, PointerEvent>();
    let initialPinchDistance = 0;
    let initialPinchZoom = 0;
    let snapLinesX = $state<number[]>([]);
    let snapLinesY = $state<number[]>([]);
    let snapTargetIds = $state<string[]>([]);
    /**
     * Id of the element being dragged. `gesture` is a plain variable (not $state)
     * so it can't drive reactivity — this mirrors it for the anchor guide.
     */
    let movingId = $state<string | null>(null);

    /**
     * While an element is being moved, show what it is anchored to: a marker on
     * the canvas anchor point and a leader to the element's own origin point.
     * That makes "this sticks to the right edge, 2 mm in" visible rather than
     * something you have to infer from the properties panel.
     */
    const anchorGuide = $derived.by(() => {
        const el = editor.selected;
        const te = editor.selectedTemplate;
        if (!el || !te || movingId !== el.id) return null;
        const anchor = te.place.anchor ?? 'tl';
        const origin = te.place.origin ?? anchor;
        const b = measureElement(el, domMeasureText);
        return {
            anchorX: design.widthPx * anchorFx(anchor),
            anchorY: design.heightPx * anchorFy(anchor),
            originX: el.x + b.width * anchorFx(origin),
            originY: el.y + b.height * anchorFy(origin)
        };
    });

    function constrainPan(x: number, y: number, zoom: number = editor.zoom) {
        const unprintableW = (!editor.design.paper || editor.design.paper.type === 'continuous') ? unprintableLeadingPx * zoom : 0;
        const cw = design.widthPx * zoom + unprintableW;
        const ch = design.heightPx * zoom + (unprintableTopBottomPx * 2 * zoom);

        let nextX = x;
        let nextY = y;

        if (cw <= containerWidth) {
            nextX = (containerWidth - cw) / 2;
        } else {
            const minX = containerWidth - cw - 16;
            const maxX = 16;
            nextX = Math.max(minX, Math.min(maxX, nextX));
        }

        if (ch <= visibleHeight) {
            // Center the physical tape, which centers the printable area too since top/bottom margins are equal
            nextY = ((visibleHeight - ch) / 2) + (unprintableTopBottomPx * zoom);
        } else {
            const minY = visibleHeight - ch - 16 + (unprintableTopBottomPx * zoom);
            const maxY = 16 + (unprintableTopBottomPx * zoom);
            nextY = Math.max(minY, Math.min(maxY, nextY));
        }

        return { x: nextX, y: nextY };
    }

    /** Fit the complete label into the visible container, including on phones. */
    export function fit(): void {
        if (containerWidth > 32) {
            const unprintableW = (!editor.design.paper || editor.design.paper.type === 'continuous') ? unprintableLeadingPx : 0;
            const totalW = design.widthPx + unprintableW;
            const totalH = design.heightPx + (unprintableTopBottomPx * 2);
            const zoomX = (containerWidth - 32) / totalW;
            const zoomY = visibleHeight > 32 ? (visibleHeight - 32) / totalH : zoomX;
            editor.zoom = Math.max(0.25, Math.floor(Math.min(zoomX, zoomY) * 4) / 4);
            const constrained = constrainPan(panX, panY);
            panX = constrained.x;
            panY = constrained.y;
        }
    }

    /**
     * Keep the selected element in view when an overlay covers part of the
     * canvas: pan just enough to bring it into the visible area.
     */
    $effect(() => {
        void bottomInset;
        void editor.selectedId;
        untrack(() => {
            const el = editor.selected;
            if (!el || gesture || containerWidth <= 0 || containerHeight <= 0) return;
            const b = measureElement(el, domMeasureText);
            const zoom = editor.zoom;
            const margin = 16;
            const top = panY + el.y * zoom, bottom = top + b.height * zoom;
            const left = panX + el.x * zoom, right = left + b.width * zoom;
            let nextX = panX, nextY = panY;
            if (bottom > visibleHeight - margin) nextY -= bottom - (visibleHeight - margin);
            if (top + (nextY - panY) < margin) nextY = panY + (margin - top);
            if (right > containerWidth - margin) nextX -= right - (containerWidth - margin);
            if (left + (nextX - panX) < margin) nextX = panX + (margin - left);
            const constrained = constrainPan(nextX, nextY);
            panX = constrained.x;
            panY = constrained.y;
        });
    });

    let hasFit = false;

    $effect(() => {
        // Trigger refit when a different canvas geometry arrives.
        void design.heightPx;
        void design.widthPx;
        hasFit = false;
    });

    $effect(() => {
        if (!hasFit && containerWidth > 0 && containerHeight > 0) {
            untrack(() => {
                if (!gesture || gesture.mode !== 'resize-canvas') fit();
            });
            hasFit = true;
        }
    });

    $effect(() => {
        // Auto-center or constrain pan when container resizes or zoom changes
        // Suspend constraints during canvas resize so the left edge stays fixed.
        if (containerWidth > 0 && containerHeight > 0 && (!gesture || gesture.mode !== 'resize-canvas')) {
            const constrained = constrainPan(panX, panY);
            untrack(() => {
                if (panX !== constrained.x) panX = constrained.x;
                if (panY !== constrained.y) panY = constrained.y;
            });
        }
    });

    function startRotate(event: PointerEvent, element: AnyElement, center: { x: number; y: number }): void {
        if (readonly) { event.preventDefault(); event.stopPropagation(); return; }
        editor.selectedId = element.id;
        if (element.locked) { event.preventDefault(); event.stopPropagation(); return; }
        editor.beginTransform();
        gesture = {
            mode: 'rotate',
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            element,
            centerX: center.x,
            centerY: center.y
        };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    }

    function selectAndStart(event: PointerEvent, element: AnyElement, mode: 'move' | 'resize'): void {
        if (readonly) {
            // View-only (template fill): the canvas is a live preview, not a tool.
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        editor.selectedId = element.id;
        if (element.locked) {
            // Frozen: allow selection (so it can be unlocked) but no move/resize.
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        editor.beginTransform();
        if (mode === 'move') movingId = element.id; // drives the anchor guide
        gesture = {
            mode,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            element
        };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    }

    function onPointerDown(event: PointerEvent): void {
        if (gesture && gesture.mode !== 'pan' && gesture.mode !== 'pinch') return;
        
        activePointers.set(event.pointerId, event);

        // Deselect any selected element because if an element was clicked, 
        // it would have called stopPropagation() and we wouldn't be here.
        editor.selectedId = null;

        if (activePointers.size === 2) {
            const pts = Array.from(activePointers.values());
            const dx = pts[0].clientX - pts[1].clientX;
            const dy = pts[0].clientY - pts[1].clientY;
            initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
            initialPinchZoom = editor.zoom;
            
            gesture = {
                mode: 'pinch',
                pointerId: -1,
                startClientX: (pts[0].clientX + pts[1].clientX) / 2,
                startClientY: (pts[0].clientY + pts[1].clientY) / 2,
                startPanX: panX,
                startPanY: panY
            };
        } else if (activePointers.size === 1 && !gesture) {
            if (event.button !== 0 && event.button !== 1 && event.pointerType === 'mouse') return;
            gesture = {
                mode: 'pan',
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startPanX: panX,
                startPanY: panY
            };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }
    }

    function onMove(event: PointerEvent): void {
        if (activePointers.has(event.pointerId)) {
            activePointers.set(event.pointerId, event);
        }

        if (!gesture) return;

        if (gesture.mode === 'pinch' && activePointers.size === 2) {
            const pts = Array.from(activePointers.values());
            const dx = pts[0].clientX - pts[1].clientX;
            const dy = pts[0].clientY - pts[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            const zoomFactor = dist / initialPinchDistance;
            let newZoom = initialPinchZoom * zoomFactor;
            newZoom = Math.max(0.25, Math.min(16, newZoom));

            const cx = (pts[0].clientX + pts[1].clientX) / 2;
            const cy = (pts[0].clientY + pts[1].clientY) / 2;

            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const localCx = cx - rect.left;
            const localCy = cy - rect.top;

            const scale = newZoom / initialPinchZoom;
            const nextX = localCx - (localCx - gesture.startPanX!) * scale;
            const nextY = localCy - (localCy - gesture.startPanY!) * scale;

            const constrained = constrainPan(nextX, nextY, newZoom);
            panX = constrained.x;
            panY = constrained.y;
            editor.zoom = newZoom;
            
        } else if (gesture.pointerId === event.pointerId) {
            const dx = event.clientX - gesture.startClientX;
            const dy = event.clientY - gesture.startClientY;

            if (gesture.mode === 'pan') {
                const nextX = gesture.startPanX! + dx;
                const nextY = gesture.startPanY! + dy;
                
                const constrained = constrainPan(nextX, nextY);
                panX = constrained.x;
                panY = constrained.y;
            } else if (gesture.mode === 'resize-canvas' && gesture.startCanvasWidth !== undefined) {
                const nextWidth = Math.max(32, Math.round(gesture.startCanvasWidth + dx / editor.zoom));
                editor.resizeCanvas(nextWidth);
            } else if (gesture.mode === 'rotate' && gesture.element && gesture.centerX !== undefined && gesture.centerY !== undefined) {
                // Absolute angle from the pivot; +90° so a pointer straight up = 0°.
                const ang = Math.atan2(event.clientY - gesture.centerY, event.clientX - gesture.centerX) * 180 / Math.PI + 90;
                editor.rotateLive(gesture.element.id, ang);
            } else if (gesture.element) {
                const zdx = dx / editor.zoom;
                const zdy = dy / editor.zoom;
                if (gesture.mode === 'move') {
                    applyMove(gesture.element, zdx, zdy);
                } else {
                    applyResize(gesture.element, zdx, zdy);
                }
            }
        }
    }

    function endGesture(event: PointerEvent): void {
        activePointers.delete(event.pointerId);

        if (!gesture) return;
        
        if (gesture.mode === 'pinch' && activePointers.size < 2) {
            if (activePointers.size === 1) {
                const remaining = Array.from(activePointers.values())[0];
                gesture = {
                    mode: 'pan',
                    pointerId: remaining.pointerId,
                    startClientX: remaining.clientX,
                    startClientY: remaining.clientY,
                    startPanX: panX,
                    startPanY: panY
                };
            } else {
                gesture = null;
            }
        } else if (gesture.pointerId === event.pointerId) {
            // A pan that never moved is a tap on the stage.
            if (gesture.mode === 'pan' && onstagetap && !readonly) {
                const dx = event.clientX - gesture.startClientX;
                const dy = event.clientY - gesture.startClientY;
                if (Math.hypot(dx, dy) < 4) {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const x = (event.clientX - rect.left - panX) / editor.zoom;
                    const y = (event.clientY - rect.top - panY) / editor.zoom;
                    // The viewport also receives clicks on the grey workspace.
                    // Only clicks inside the actual label should place content.
                    if (x >= 0 && x <= design.widthPx && y >= 0 && y <= design.heightPx) {
                        onstagetap({ x, y });
                    }
                }
            }
            if (gesture.mode !== 'pan' && gesture.mode !== 'pinch') {
                editor.endTransform();
                snapLinesX = [];
                snapLinesY = [];
                snapTargetIds = [];
            }
            try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch(e) {}
            gesture = null;
            movingId = null;
        }
    }

    function wheelAction(node: HTMLElement) {
        function handleWheel(event: WheelEvent) {
            event.preventDefault();
            const zoomDelta = event.deltaY > 0 ? -0.25 : 0.25;
            const newZoom = Math.max(0.25, Math.min(16, editor.zoom + zoomDelta));
            
            if (newZoom !== editor.zoom) {
                const scale = newZoom / editor.zoom;
                const rect = node.getBoundingClientRect();
                const cx = event.clientX - rect.left;
                const cy = event.clientY - rect.top;

                const nextX = cx - (cx - panX) * scale;
                const nextY = cy - (cy - panY) * scale;
                
                const constrained = constrainPan(nextX, nextY, newZoom);
                panX = constrained.x;
                panY = constrained.y;
                
                editor.zoom = newZoom;
            }
        }
        node.addEventListener('wheel', handleWheel, { passive: false });
        return {
            destroy() {
                node.removeEventListener('wheel', handleWheel);
            }
        };
    }

    function applyMove(start: AnyElement, dx: number, dy: number): void {
        // Snap the box the user can actually see. For a rotated element that is
        // the rotated bounding box, not the unrotated content box — the offset
        // between the two is constant under translation, so snap in visible
        // space and convert back at the end.
        const rb = rotatedBounds(start, domMeasureText);
        const bounds = { width: rb.width, height: rb.height };
        const offX = rb.x - start.x;
        const offY = rb.y - start.y;
        let x = rb.x + dx;
        let y = rb.y + dy;
        const tolerance = 8 / editor.zoom;

        let activeSnapX: number[] = [];
        let activeSnapY: number[] = [];
        const activeTargets = new Set<string>();

        if (editor.snapMode) {
            const xTargets: {t: number, pos: number, elementId?: string}[] = [
                { t: 0, pos: 0 },
                { t: (design.widthPx - bounds.width) / 2, pos: design.widthPx / 2 },
                { t: design.widthPx - bounds.width, pos: design.widthPx }
            ];
            const yTargets: {t: number, pos: number, elementId?: string}[] = [
                { t: 0, pos: 0 },
                { t: (design.heightPx - bounds.height) / 2, pos: design.heightPx / 2 },
                { t: design.heightPx - bounds.height, pos: design.heightPx }
            ];

            for (const other of design.elements) {
                if (other.id === start.id) continue;
                const ob = rotatedBounds(other, domMeasureText);
                xTargets.push({ t: ob.x, pos: ob.x, elementId: other.id });
                xTargets.push({ t: ob.x + ob.width - bounds.width, pos: ob.x + ob.width, elementId: other.id });
                yTargets.push({ t: ob.y, pos: ob.y, elementId: other.id });
                yTargets.push({ t: ob.y + ob.height - bounds.height, pos: ob.y + ob.height, elementId: other.id });
            }

            let snappedX: number | null = null;
            for (const {t, pos, elementId} of xTargets) {
                if (snappedX === null && Math.abs(x - t) <= tolerance) {
                    snappedX = t;
                    x = t;
                }
                if (snappedX !== null && Math.abs(t - snappedX) < 0.001) {
                    activeSnapX.push(pos);
                    if (elementId) activeTargets.add(elementId);
                }
            }

            let snappedY: number | null = null;
            for (const {t, pos, elementId} of yTargets) {
                if (snappedY === null && Math.abs(y - t) <= tolerance) {
                    snappedY = t;
                    y = t;
                }
                if (snappedY !== null && Math.abs(t - snappedY) < 0.001) {
                    activeSnapY.push(pos);
                    if (elementId) activeTargets.add(elementId);
                }
            }
        }

        snapLinesX = activeSnapX;
        snapLinesY = activeSnapY;
        snapTargetIds = [...activeTargets];

        // Grid snapping applies after guide snapping (guides take priority when
        // both are on and a guide is within tolerance).
        if (editor.gridEnabled && editor.gridSize > 0) {
            const g = editor.gridSize;
            if (snapLinesX.length === 0) x = Math.round(x / g) * g;
            if (snapLinesY.length === 0) y = Math.round(y / g) * g;
        }

        // Back from the visible box to the element's own origin.
        editor.moveElement(start.id, { x: Math.round(x - offX), y: Math.round(y - offY) });
    }

    function applyResize(start: AnyElement, screenDx: number, screenDy: number): void {
        // The handle sits on the rotated frame, so a drag "outward" is outward
        // along the element's own axes, not the screen's. Undo the rotation to
        // get the delta the element actually grows by.
        const rad = ((start.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const dx = screenDx * cos + screenDy * sin;
        const dy = -screenDx * sin + screenDy * cos;

        switch (start.type) {
            case 'text': {
                // Drag sizes the text *frame*; the font size is its own field.
                // Starting from the measured bounds means the first drag on an
                // auto-sized run turns it into a frame at its current size,
                // rather than jumping.
                const b = measureElement(start, domMeasureText);
                editor.moveElement(start.id, {
                    width: Math.max(8, Math.round((start.width ?? b.width) + dx)),
                    height: Math.max(8, Math.round((start.height ?? b.height) + dy))
                });
                break;
            }
            case 'barcode':
                editor.moveElement(start.id, {
                    width: Math.max(24, Math.round(start.width + dx)),
                    height: Math.max(12, Math.round(start.height + dy))
                });
                break;
            case 'qr':
                editor.moveElement(start.id, { size: Math.max(21, Math.round(start.size + Math.max(dx, dy))) });
                break;
            case 'datamatrix':
                // Square, like QR: the larger drag axis wins.
                editor.moveElement(start.id, { size: Math.max(20, Math.round(start.size + Math.max(dx, dy))) });
                break;
            case 'symbol':
                editor.moveElement(start.id, { size: Math.max(8, Math.round(start.size + Math.max(dx, dy))) });
                break;
            case 'shape':
                editor.moveElement(start.id, {
                    width: Math.max(2, Math.round(start.width + dx)),
                    height: Math.max(2, Math.round(start.height + dy))
                });
                break;
            case 'image':
                editor.moveElement(start.id, {
                    width: Math.max(4, Math.round(start.width + dx)),
                    height: Math.max(4, Math.round(start.height + dy))
                });
                break;
            default:
                // Exhaustive: a new element type is a compile error here rather
                // than a resize handle that silently does nothing.
                assertHandled(start);
        }
    }

    function assertHandled(x: never): void {
        if (import.meta.env.DEV) console.warn('applyResize: unhandled element', x);
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- pan/zoom/select gesture
     surface; element selection, nudging and deletion have app-level keyboard bindings -->
<div
    class="viewport"
    bind:clientWidth={containerWidth}
    bind:clientHeight={containerHeight}
    onpointerdown={onPointerDown}
    onpointermove={onMove}
    onpointerup={endGesture}
    onpointercancel={endGesture}
    use:wheelAction
>
    <!-- The die, as a clip for the canvas below. Defined here rather than
         inline so the same path can be reused without re-parsing. -->
    {#if dieGeom}
        <svg class="die-defs" aria-hidden="true">
            <clipPath id="die-clip-{design.id}" clipPathUnits="userSpaceOnUse">
                <path d={dieGeom.d} clip-rule={dieGeom.fillRule} transform={dieTransform} />
            </clipPath>
        </svg>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="label-surface"
        class:show-grid={editor.gridEnabled && editor.gridSize > 0}
        style="transform: translate({panX}px, {panY}px); width:{design.widthPx * editor.zoom}px; height:{design.heightPx * editor.zoom}px; background:{paperColor}; {dieGeom ? `clip-path: url(#die-clip-${design.id});` : ''} --grid: {editor.gridSize * editor.zoom}px;"
    >
        {#each snapLinesX as sx}
            <div class="snap-line-x" style="left: {sx * editor.zoom}px;"></div>
        {/each}
        {#each snapLinesY as sy}
            <div class="snap-line-y" style="top: {sy * editor.zoom}px;"></div>
        {/each}
        {#each snapTargetIds as id (id)}
            {@const target = design.elements.find(element => element.id === id)}
            {#if target}
                {@const targetBounds = rotatedBounds(target, domMeasureText)}
                <div
                    class="snap-target"
                    style="left:{targetBounds.x * editor.zoom}px;top:{targetBounds.y * editor.zoom}px;width:{targetBounds.width * editor.zoom}px;height:{targetBounds.height * editor.zoom}px;"
                ></div>
            {/if}
        {/each}

        <!-- Anchor guide: where this element is pinned, and how far off it sits. -->
        {#if anchorGuide}
            {@const z = editor.zoom}
            {@const ax = anchorGuide.anchorX * z}
            {@const ay = anchorGuide.anchorY * z}
            {@const ox = anchorGuide.originX * z}
            {@const oy = anchorGuide.originY * z}
            <svg class="anchor-guide" width="100%" height="100%">
                <line x1={ax} y1={ay} x2={ox} y2={oy} class="leader" />
                <circle cx={ox} cy={oy} r="3" class="origin-dot" />
                <g class="anchor-mark" transform="translate({ax},{ay})">
                    <line x1="-6" y1="0" x2="6" y2="0" />
                    <line x1="0" y1="-6" x2="0" y2="6" />
                </g>
            </svg>
        {/if}

        <!-- Visual clue for top/bottom unprintable margins (hardware limitation) -->
        {#if unprintableTopBottomPx > 0}
            <div class="unprintable-margin top" style="height: {unprintableTopBottomPx * editor.zoom}px; top: -{unprintableTopBottomPx * editor.zoom}px; left: 0; right: 0;">
                <div class="unprintable-stripe"></div>
            </div>
            <div class="unprintable-margin bottom" style="height: {unprintableTopBottomPx * editor.zoom}px; bottom: -{unprintableTopBottomPx * editor.zoom}px; left: 0; right: 0;">
                <div class="unprintable-stripe"></div>
            </div>
        {/if}

        <!-- Visual clue for unprintable cutter margin (only on continuous tape) -->
        {#if unprintableLeadingPx > 0 && (!editor.design.paper || editor.design.paper.type === 'continuous')}
            <!-- Stretch the leading margin to cover the top/bottom margins too, because physical tape continues! -->
            <div class="unprintable-margin" style="
                width: {unprintableLeadingPx * editor.zoom}px; 
                right: -{unprintableLeadingPx * editor.zoom}px;
                top: -{unprintableTopBottomPx * editor.zoom}px;
                bottom: -{unprintableTopBottomPx * editor.zoom}px;
            ">
                <div class="unprintable-stripe"></div>
                <div class="unprintable-label" title="Unprintable leading margin (distance from print head to cutter)">
                    <Icon name="scissors" size={16} />
                </div>
            </div>
        {/if}

        <!-- Canvas resize handle for continuous tape (auto-length owns the
             length instead, so the handle is hidden then). -->
        {#if (!editor.design.paper || editor.design.paper.type === 'continuous') && !editor.autoLength && !readonly}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="canvas-resize-handle"
                onpointerdown={(e) => {
                    editor.beginTransform();
                    gesture = {
                        mode: 'resize-canvas',
                        pointerId: e.pointerId,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        startCanvasWidth: design.widthPx
                    };
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    e.preventDefault();
                    e.stopPropagation();
                }}
            >
                <div class="handle-grip"></div>
            </div>
        {/if}

        {#each design.elements as element (element.id)}
            <ElementView
                {element}
                {design}
                zoom={editor.zoom}
                selected={editor.selectedId === element.id}
                onpointerdownelement={(e, el) => selectAndStart(e, el, 'move')}
                onpointerdownhandle={(e, el) => selectAndStart(e, el, 'resize')}
                onpointerdownrotate={startRotate}
            />
        {/each}
    </div>

    <!-- Viewport Zoom Controls -->
    <!-- svelte-ignore a11y_no_static_element_interactions -- wrapper only stops
         pointer-downs from reaching the canvas; the buttons inside are focusable -->
    <div class="zoom-overlay" onpointerdown={(e) => e.stopPropagation()}>
        <button class="zoom-btn" aria-label="Zoom out" onclick={() => { editor.zoom = Math.max(0.25, editor.zoom - 0.5); }}><Icon name="minus" size={16} /></button>
        <span class="zoom-val">{editor.zoom}×</span>
        <button class="zoom-btn" aria-label="Zoom in" onclick={() => { editor.zoom = Math.min(16, editor.zoom + 0.5); }}><Icon name="plus" size={16} /></button>
        <button class="zoom-btn fit" onclick={() => fit()}>Fit</button>
    </div>
</div>

<style>
    .viewport {
        overflow: hidden;
        width: 100%;
        min-height: 280px;
        flex: 1;
        position: relative;
        background: radial-gradient(var(--border) 1px, transparent 1px);
        background-size: 16px 16px;
        background-color: var(--bg);
        border-radius: 3px;
        touch-action: none;
        user-select: none;
    }
    .label-surface {
        position: absolute;
        top: 0;
        left: 0;
        /* Colour comes from the loaded paper, set inline; this is the fallback
           for a design with no paper attached. */
        background: #fff;
        box-shadow: 0 8px 24px rgba(0,0,0,0.1);
        transform-origin: 0 0;
    }

    /* The clip-path definition needs to exist in the document, not to occupy
       any of it. */
    .die-defs {
        position: absolute;
        width: 0;
        height: 0;
        pointer-events: none;
    }

    .label-surface.show-grid {
        background-image:
            linear-gradient(to right, rgba(79, 142, 247, 0.28) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(79, 142, 247, 0.28) 1px, transparent 1px);
        background-size: var(--grid) var(--grid);
    }
    /* Anchor guide overlay (drag-time only) — non-interactive. */
    .anchor-guide {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: visible;
        z-index: 5;
    }
    .anchor-guide .leader {
        stroke: var(--accent);
        stroke-width: 1;
        stroke-dasharray: 3 3;
        opacity: 0.9;
    }
    .anchor-guide .origin-dot {
        fill: var(--accent);
    }
    .anchor-guide .anchor-mark line {
        stroke: var(--accent);
        stroke-width: 2;
    }
    .snap-line-x {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 0;
        border-left: 1px dashed var(--accent);
        pointer-events: none;
        z-index: 100;
    }
    .snap-line-y {
        position: absolute;
        left: 0;
        right: 0;
        height: 0;
        border-top: 1px dashed var(--accent);
        pointer-events: none;
        z-index: 100;
    }
    .snap-target {
        position: absolute;
        pointer-events: none;
        z-index: 99;
        outline: 2px solid var(--accent);
        outline-offset: 3px;
        border-radius: 3px;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .zoom-overlay {
        position: absolute;
        bottom: 16px;
        right: 16px;
        display: flex;
        align-items: center;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 2px;
        padding: 4px;
        box-shadow: var(--shadow);
        z-index: 100;
        transition: box-shadow 0.2s ease, transform 0.2s ease;
    }
    .zoom-overlay:hover {
        box-shadow: var(--shadow-hover);
        transform: translateY(-2px);
    }
    .zoom-btn {
        background: transparent;
        border: none;
        color: var(--text);
        min-height: 28px;
        padding: 4px 8px;
        font-size: 14px;
        cursor: pointer;
        border-radius: 2px;
        transition: background 0.2s ease;
    }
    .zoom-btn:hover {
        background: var(--bg);
        transform: none;
        box-shadow: none;
    }
    .zoom-btn:active {
        transform: scale(0.92);
    }
    .zoom-btn.fit {
        font-size: 13px;
        border-left: 1px solid var(--border);
        margin-left: 4px;
        border-radius: 0 2px 2px 0;
    }
    .zoom-val {
        min-width: 40px;
        text-align: center;
        font-variant-numeric: tabular-nums;
        font-size: 13px;
        color: var(--text);
    }
    @media (max-width: 420px) {
        .viewport { min-height: 240px; }
        .zoom-overlay {
            right: 8px;
            bottom: 8px;
        }
        .zoom-btn {
            min-width: 38px;
            min-height: 38px;
        }
        .zoom-val { min-width: 34px; }
    }
    .unprintable-margin {
        position: absolute;
        pointer-events: none;
        display: flex;
        align-items: center;
        justify-content: flex-start;
    }
    .unprintable-margin:not(.top):not(.bottom) {
        border: 1px dashed var(--muted);
        border-left: none;
        background: var(--checker);
    }
    .unprintable-margin.top {
        border-top: 1px dashed var(--muted);
        background: var(--checker);
    }
    .unprintable-margin.bottom {
        border-bottom: 1px dashed var(--muted);
        background: var(--checker);
    }
    .unprintable-stripe {
        position: absolute;
        inset: 0;
        background-image: repeating-linear-gradient(45deg, transparent, transparent 10px, var(--checker) 10px, var(--checker) 20px);
        overflow: hidden;
    }
    .unprintable-label {
        position: relative;
        color: var(--muted);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        background: var(--bg);
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        opacity: 0.9;
        margin-left: 8px;
        cursor: help;
        pointer-events: auto;
        transition: transform 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease;
    }
    .unprintable-label:hover {
        opacity: 1;
        transform: scale(1.05);
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
    }
    .canvas-resize-handle {
        position: absolute;
        right: -10px;
        top: 50%;
        transform: translateY(-50%);
        width: 20px;
        height: 36px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 2px;
        box-shadow: var(--shadow);
        cursor: ew-resize;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        transition: background 0.2s;
    }
    .canvas-resize-handle:hover,
    .canvas-resize-handle:active {
        background: var(--panel-2);
    }
    .handle-grip {
        width: 4px;
        height: 16px;
        border-left: 1px solid var(--muted);
        border-right: 1px solid var(--muted);
    }
</style>
