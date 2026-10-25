import type { UniversalImageData } from '../driver.interface';
import { MIN_LABEL_LINES, type D1TapeGeometry } from './dymo-lm-v2-protocol';

const INK_THRESHOLD = 200;

export interface D1RasterOptions {
    /** Pad labels shorter than this to keep the header well formed. */
    minLines?: number;
}

export interface D1Raster {
    /** `lineCount * lineBits / 8` bytes, one line after another. */
    data: Uint8Array;
    lineCount: number;
    lineBits: number;
    /** Canvas rows that fell outside the printable band and were dropped. */
    clippedRows: number;
}

/**
 * Encode the editor canvas as D1 raster lines, laid out the way DYMO's
 * Android app does it.
 *
 * COORDINATE SYSTEM: the canvas is height-fixed across the tape and
 * width-variable along it. Each canvas column (x) becomes one raster line, in
 * order, so x = 0 is printed first. Each canvas row (y) becomes one dot.
 *
 * Each line is the tape's printable band and nothing else, padded with blank
 * bits to a whole byte. The band is filled from the label's BOTTOM edge: the
 * canvas's last row is dot 0 (the most significant bit of the first byte).
 * Confirmed on hardware: this prints the canvas upright.
 *
 * A canvas shorter than the band is centred in it; rows of a taller canvas
 * that fall outside the band are dropped. Labels are padded at both ends to
 * the minimum length. Bits are MSB-first, 1 = ink.
 */
export function encodeD1Raster(image: UniversalImageData, tape: D1TapeGeometry, options: D1RasterOptions = {}): D1Raster {
    const { width, height } = image;
    if (!Number.isInteger(width) || width < 1) throw new RangeError('Image width must be a positive whole number.');
    if (!Number.isInteger(height) || height < 1) throw new RangeError('Image height must be a positive whole number.');

    const band = tape.printableDots;
    const lineBytes = tape.lineBits / 8;
    const minLines = Math.max(1, Math.floor(options.minLines ?? MIN_LABEL_LINES));
    const lineCount = Math.max(width, minLines);
    const leadPad = Math.floor((lineCount - width) / 2);

    // Canvas row → band row (0 = top of the band) → dot (0 = bottom of the band).
    const top = Math.floor((band - height) / 2);
    const dotForRow = new Int32Array(height);
    let clippedRows = 0;
    for (let y = 0; y < height; y += 1) {
        const bandRow = top + y;
        if (bandRow < 0 || bandRow >= band) {
            dotForRow[y] = -1;
            clippedRows += 1;
        } else {
            dotForRow[y] = band - 1 - bandRow;
        }
    }

    const data = new Uint8Array(lineCount * lineBytes);
    for (let x = 0; x < width; x += 1) {
        const lineBase = (leadPad + x) * lineBytes;
        for (let y = 0; y < height; y += 1) {
            const dot = dotForRow[y];
            if (dot < 0) continue;
            const source = (y * width + x) * 4;
            const alpha = image.data[source + 3] ?? 0;
            if (alpha === 0) continue;
            const luminance = ((image.data[source] ?? 255)
                + (image.data[source + 1] ?? 255)
                + (image.data[source + 2] ?? 255)) / 3;
            if (luminance > INK_THRESHOLD) continue;
            data[lineBase + (dot >>> 3)] |= 0x80 >>> (dot & 7);
        }
    }

    return { data, lineCount, lineBits: tape.lineBits, clippedRows };
}
