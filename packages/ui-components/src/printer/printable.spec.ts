import { describe, expect, it } from 'vitest';
import { DYMO_LM_V2_MODELS } from 'universal-label-core';
import { printableAcrossMm, printableHeightPx } from './printable';

const dymo = DYMO_LM_V2_MODELS[0].capabilities;
const plain = { canvasHeightPx: 96, dpmm: 8, physical: {} };

describe('printable height', () => {
    it('sizes the DYMO canvas to its band on each D1 tape', () => {
        const heights = Object.fromEntries([6, 9, 12, 19, 24].map(mm => [mm, printableHeightPx(dymo, mm)]));
        expect(heights).toEqual({ 6: 60, 9: 80, 12: 94, 19: 158, 24: 224 });
        expect(printableAcrossMm(dymo, 19)).toBeCloseTo(13.38, 2);
    });

    it('keeps the tape, label width and head limits for printers without bands', () => {
        expect(printableHeightPx(plain, 12)).toBe(96);
        expect(printableHeightPx(plain, 15)).toBe(96);
        expect(printableHeightPx(plain, 12, 10)).toBe(80);
        expect(printableHeightPx(dymo, 15)).toBe(177);
    });

    it('uses a label narrower than the band', () => {
        expect(printableAcrossMm(dymo, 19, 10)).toBe(10);
    });
});
