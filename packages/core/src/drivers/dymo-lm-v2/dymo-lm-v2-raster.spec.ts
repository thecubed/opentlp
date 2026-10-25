import { describe, expect, it } from 'vitest';
import { encodeD1Raster } from './dymo-lm-v2-raster';
import { MIN_LABEL_LINES, tapeForWidth } from './dymo-lm-v2-protocol';

function canvas(width: number, height: number, ink: (x: number, y: number) => boolean) {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const v = ink(x, y) ? 0 : 255;
            data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
        }
    }
    return { data, width, height };
}

function inkedDots(line: Uint8Array): number[] {
    const dots: number[] = [];
    for (let i = 0; i < line.length * 8; i += 1) {
        if (line[i >>> 3] & (0x80 >>> (i & 7))) dots.push(i);
    }
    return dots;
}

/** The "F in a frame" test label, as drawn by the hardware test that printed upright. */
function testLabel(height: number, length: number) {
    const unit = Math.max(2, Math.floor(height / 8));
    const left = Math.floor(length / 6);
    return (x: number, y: number) => {
        if (x === 0 || x === length - 1 || y === 0 || y === height - 1) return true;
        const stem = x >= left && x < left + unit && y >= unit && y < height - unit;
        const top = y >= unit && y < 2 * unit && x >= left && x < left + 4 * unit;
        const mid = y >= Math.floor(height / 2) - Math.floor(unit / 2)
            && y < Math.floor(height / 2) + Math.floor(unit / 2) + 1 && x >= left && x < left + 3 * unit;
        const tick = y < 3 * unit && x >= length - 1 - unit && x < length - 1;
        return stem || top || mid || tick;
    };
}

const tape12 = tapeForWidth(12)!;

describe('encodeD1Raster', () => {
    it('reproduces the 12 mm test label that printed upright on a MobileLabeler', () => {
        // The hardware test sent dot = band - 1 - y for each inked canvas row y.
        const length = 400;
        const band = tape12.printableDots;
        const ink = testLabel(band, length);
        const expected = new Uint8Array(length * 12);
        for (let x = 0; x < length; x += 1) {
            for (let y = 0; y < band; y += 1) {
                if (!ink(x, y)) continue;
                const dot = band - 1 - y;
                expected[x * 12 + (dot >> 3)] |= 0x80 >> (dot & 7);
            }
        }
        const raster = encodeD1Raster(canvas(length, band, ink), tape12);
        expect(raster.lineCount).toBe(length);
        expect(raster.lineBits).toBe(96);
        expect(raster.data).toEqual(expected);
    });

    it('fills the band from the bottom edge of the label', () => {
        // One inked pixel at the top-left corner, one at the bottom-left.
        const top = encodeD1Raster(canvas(300, 94, (x, y) => x === 0 && y === 0), tape12);
        expect(inkedDots(top.data.subarray(0, 12))).toEqual([93]);
        const bottom = encodeD1Raster(canvas(300, 94, (x, y) => x === 0 && y === 93), tape12);
        expect(inkedDots(bottom.data.subarray(0, 12))).toEqual([0]);
        expect(inkedDots(top.data.subarray(12, 24))).toEqual([]);
    });

    it('pads short labels to the minimum length at both ends', () => {
        const raster = encodeD1Raster(canvas(11, 94, x => x === 0), tape12);
        expect(raster.lineCount).toBe(MIN_LABEL_LINES);
        expect(raster.data.length).toBe(MIN_LABEL_LINES * 12);
        const firstInked = Array.from({ length: raster.lineCount }, (_, i) => i)
            .find(i => raster.data.subarray(i * 12, i * 12 + 12).some(b => b !== 0));
        expect(firstInked).toBe(100);
    });

    it('centres a short canvas and clips one taller than the band', () => {
        const small = encodeD1Raster(canvas(300, 10, () => true), tape12);
        expect(inkedDots(small.data.subarray(0, 12))).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);

        const tall = encodeD1Raster(canvas(300, 144, () => true), tape12);
        expect(tall.clippedRows).toBe(50);
        expect(inkedDots(tall.data.subarray(0, 12))).toEqual(Array.from({ length: 94 }, (_, i) => i));
    });

    it('never writes into the padding bits', () => {
        const raster = encodeD1Raster(canvas(300, 94, () => true), tape12);
        for (let line = 0; line < raster.lineCount; line += 1) {
            expect(raster.data[line * 12 + 11] & 0b11).toBe(0);
        }
    });

    it('treats light and transparent pixels as paper', () => {
        const image = canvas(MIN_LABEL_LINES, 94, () => true);
        image.data[3] = 0;                                    // (0, 0) transparent
        image.data[4] = 230; image.data[5] = 230; image.data[6] = 230; // (1, 0) light
        const raster = encodeD1Raster(image, tape12);
        expect(inkedDots(raster.data.subarray(0, 12)).at(-1)).toBe(92);
        expect(inkedDots(raster.data.subarray(12, 24)).at(-1)).toBe(92);
        expect(inkedDots(raster.data.subarray(24, 36)).at(-1)).toBe(93);
    });

    it('rejects empty canvases', () => {
        expect(() => encodeD1Raster({ data: new Uint8Array(0), width: 0, height: 94 }, tape12)).toThrow(RangeError);
        expect(() => encodeD1Raster({ data: new Uint8Array(0), width: 1, height: 0 }, tape12)).toThrow(RangeError);
    });
});
