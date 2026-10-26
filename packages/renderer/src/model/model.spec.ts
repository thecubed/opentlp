import { describe, expect, it } from 'vitest';
import {
    addElement, createDesign, createElement, isLabelDesign, printsNothing,
    removeElement, reorderElement, updateElement, type LabelDesign
} from './design';
import { History } from './history';
import { LabelLibrary } from './storage';
import { createTemplate } from '../template/template';

describe('design model', () => {
    it('creates a valid design', () => {
        const d = createDesign(96, 320);
        expect(isLabelDesign(d)).toBe(true);
        expect(d.heightPx).toBe(96);
        expect(d.elements).toHaveLength(0);
    });

    it('element operations are immutable', () => {
        const d = createDesign(96, 320);
        const el = createElement('text', d);
        const d2 = addElement(d, el);
        expect(d.elements).toHaveLength(0);
        expect(d2.elements).toHaveLength(1);

        const d3 = updateElement(d2, el.id, { x: 42 });
        expect(d2.elements[0].x).not.toBe(42);
        expect(d3.elements[0].x).toBe(42);

        const d4 = removeElement(d3, el.id);
        expect(d4.elements).toHaveLength(0);
    });

    it('reorders z-order correctly', () => {
        let d = createDesign(96, 320);
        const a = createElement('text', d);
        const b = createElement('qr', d);
        const c = createElement('barcode', d);
        d = addElement(addElement(addElement(d, a), b), c);

        expect(reorderElement(d, a.id, 'front').elements.map(e => e.id)).toEqual([b.id, c.id, a.id]);
        expect(reorderElement(d, c.id, 'back').elements.map(e => e.id)).toEqual([c.id, a.id, b.id]);
        expect(reorderElement(d, a.id, 'forward').elements.map(e => e.id)).toEqual([b.id, a.id, c.id]);
        expect(reorderElement(d, a.id, 'backward').elements.map(e => e.id)).toEqual([a.id, b.id, c.id]);
    });

    it('identifies payload elements that currently cannot print ink', () => {
        const d = createDesign(96, 320);
        const text = createElement('text', d);
        const image = createElement('image', d);
        const shape = createElement('shape', d);
        if (text.type !== 'text' || image.type !== 'image') throw new Error('Unexpected element type');

        expect(printsNothing({ ...text, text: '   ' })).toBe(true);
        expect(printsNothing({ ...text, text: 'Label' })).toBe(false);
        expect(printsNothing({ ...image, src: '' })).toBe(true);
        expect(printsNothing(shape)).toBe(false);
    });
});

describe('history', () => {
    it('undoes and redoes', () => {
        const h = new History<LabelDesign>();
        const v1 = createDesign(96, 100);
        const v2 = { ...v1, widthPx: 200 };
        h.push(v1);
        expect(h.canUndo).toBe(true);
        const back = h.undo(v2);
        expect(back?.widthPx).toBe(100);
        expect(h.canRedo).toBe(true);
        const fwd = h.redo(v1);
        expect(fwd?.widthPx).toBe(200);
    });

    it('clears the redo stack on new pushes', () => {
        const h = new History<LabelDesign>();
        const v1 = createDesign(96, 100);
        h.push(v1);
        h.undo({ ...v1, widthPx: 200 });
        h.push(v1);
        expect(h.canRedo).toBe(false);
    });
});

describe('label library', () => {
    function memBackend() {
        const map = new Map<string, string>();
        return {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => void map.set(k, v)
        };
    }

    it('saves, lists, overwrites and removes', () => {
        const lib = new LabelLibrary(memBackend());
        const t = createTemplate('test', 12, 40);
        lib.save(t);
        expect(lib.list()).toHaveLength(1);

        lib.save({ ...t, name: 'renamed' });
        expect(lib.list()).toHaveLength(1);
        expect(lib.get(t.id)?.template.name).toBe('renamed');

        lib.remove(t.id);
        expect(lib.list()).toHaveLength(0);
    });

    it('ignores corrupt storage content', () => {
        const backend = memBackend();
        backend.setItem('blewebler2.labels.v1', '{not json');
        const lib = new LabelLibrary(backend);
        expect(lib.list()).toEqual([]);
    });

    it('installs starter templates once and respects later deletion', () => {
        const backend = memBackend();
        const starters = [createTemplate('one', 12, 40), createTemplate('two', 12, 40)];
        const lib = new LabelLibrary(backend);

        lib.installDefaults(starters);
        expect(lib.list()).toHaveLength(2);
        expect(lib.get(starters[0].id)?.origin).toEqual({ kind: 'bundled', collection: 'starter' });

        lib.remove(starters[0].id);
        new LabelLibrary(backend).installDefaults(starters);
        expect(new LabelLibrary(backend).list().map(entry => entry.template.id)).toEqual([starters[1].id]);
    });

    it('adds starters from a later release without restoring deleted ones', () => {
        const backend = memBackend();
        const first = [createTemplate('one', 12, 40), createTemplate('two', 12, 40)];
        new LabelLibrary(backend).installDefaults(first);
        new LabelLibrary(backend).remove(first[0].id);

        const later = [...first, createTemplate('three', 12, 40)];
        new LabelLibrary(backend).installDefaults(later);
        expect(new LabelLibrary(backend).list().map(entry => entry.template.id).sort())
            .toEqual([first[1].id, later[2].id].sort());
    });

    it('treats an install with only the old flag as having seen the original starters', () => {
        const backend = memBackend();
        backend.setItem('blewebler2.labels.starters.v1', '1');
        const original = { ...createTemplate('asset', 12, 40), id: 'example-asset-tag' };
        const added = createTemplate('quick', 12, 40);
        new LabelLibrary(backend).installDefaults([original, added]);
        expect(new LabelLibrary(backend).list().map(entry => entry.template.id)).toEqual([added.id]);
    });

    it('does not overwrite an existing label when installing starters', () => {
        const backend = memBackend();
        const original = createTemplate('starter', 12, 40);
        const lib = new LabelLibrary(backend);
        lib.save({ ...original, name: 'customized' });

        lib.installDefaults([original]);
        expect(lib.get(original.id)?.template.name).toBe('customized');
    });

    it('keeps catalogue provenance when a community design is edited locally', () => {
        const lib = new LabelLibrary(memBackend());
        const original = createTemplate('community-design', 12, 40);
        const origin = { kind: 'community', provider: 'Example catalogue', externalId: 'design-42', revision: 3 } as const;

        lib.save(original, undefined, undefined, origin);
        lib.save({ ...original, name: 'My edited copy' });

        expect(lib.get(original.id)?.origin).toEqual(origin);
    });

});
