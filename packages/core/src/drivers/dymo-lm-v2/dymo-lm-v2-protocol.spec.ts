import { describe, expect, it } from 'vitest';
import {
    chainMark,
    cut,
    D1_TAPES,
    endJob,
    formFeed,
    isDymoLmV2Compatible,
    labelIndex,
    labelLeader,
    labelTrailer,
    parseStatus,
    printDataHeader,
    readyForJob,
    shortFormFeed,
    startJob,
    statusRequest,
    tapeForMediaType,
    tapeForWidth,
    versionRequest,
} from './dymo-lm-v2-protocol';

const bytes = (...values: number[]) => new Uint8Array(values);
const fromHex = (hex: string) => new Uint8Array(hex.trim().split(/\s+/).map(h => parseInt(h, 16)));

/** Replies captured from a MobileLabeler with a 12 mm cassette, on the command channel. */
const IDLE = fromHex('00 00 00 00 00 00 00 01 00 00 08 03 00 00 00 00 00 00 00 00 11 01 54 00 00 00 00 07');
const PRINTING = fromHex('01 fc d0 24 35 01 00 01 00 00 08 03 00 00 00 00 00 00 00 00 11 01 54 00 00 00 00 07');
const CUTTING = fromHex('01 fc d0 24 35 01 00 02 00 00 08 03 00 00 00 00 00 00 00 00 11 01 54 00 00 00 00 07');

describe('DYMO LabelManager V2 commands', () => {
    it('encodes each escape sequence with little-endian operands', () => {
        expect(statusRequest(true)).toEqual(bytes(0x1b, 0x41, 0x01));
        expect(statusRequest(false)).toEqual(bytes(0x1b, 0x41, 0x00));
        expect(versionRequest()).toEqual(bytes(0x1b, 0x56));
        expect(startJob(0x3524d0fc)).toEqual(bytes(0x1b, 0x73, 0xfc, 0xd0, 0x24, 0x35));
        expect(labelIndex(0x0201)).toEqual(bytes(0x1b, 0x6e, 0x01, 0x02));
        expect(labelLeader(36)).toEqual(bytes(0x1b, 0x6c, 36, 0, 0, 0));
        expect(labelTrailer(28)).toEqual(bytes(0x1b, 0x74, 28, 0, 0, 0));
        expect(formFeed()).toEqual(bytes(0x1b, 0x45));
        expect(shortFormFeed()).toEqual(bytes(0x1b, 0x47));
        expect(cut()).toEqual(bytes(0x1b, 0x70, 0x30));
        expect(chainMark()).toEqual(bytes(0x1b, 0x70, 0x31));
        expect(endJob()).toEqual(bytes(0x1b, 0x51));
    });

    it('matches the header of a job that printed on hardware', () => {
        // 400 lines × 96 bits on 12 mm tape.
        expect(printDataHeader(400, 96)).toEqual(fromHex('1b 44 01 02 90 01 00 00 60 00 00 00'));
    });

    it('rejects operands the header cannot carry', () => {
        expect(() => printDataHeader(0, 96)).toThrow(RangeError);
        expect(() => printDataHeader(10, 94)).toThrow(RangeError);
        expect(() => labelIndex(0x10000)).toThrow(RangeError);
        expect(() => startJob(-1)).toThrow(RangeError);
    });
});

describe('D1 tape geometry', () => {
    it('sends only the printable band, padded to whole bytes', () => {
        expect(D1_TAPES.map(t => [t.widthMm, t.printableDots, t.lineBits])).toEqual([
            [6, 60, 64],
            [9, 80, 80],
            [12, 94, 96],
            [19, 158, 160],
            [24, 224, 224],
        ]);
    });

    it('matches tape widths tolerantly and refuses non-D1 widths', () => {
        expect(tapeForWidth(12)?.widthMm).toBe(12);
        expect(tapeForWidth(12.4)?.widthMm).toBe(12);
        expect(tapeForWidth(15)).toBeUndefined();
        expect(tapeForWidth(undefined)).toBeUndefined();
    });

    it('maps cassette type indices to widths, repeating every five', () => {
        expect([1, 2, 3, 4, 5].map(i => tapeForMediaType(i)?.widthMm)).toEqual([24, 19, 12, 6, 9]);
        expect([6, 11].map(i => tapeForMediaType(i)?.widthMm)).toEqual([24, 24]);
        expect(tapeForMediaType(0)).toBeUndefined();
        expect(tapeForMediaType(16)).toBeUndefined();
    });
});

describe('status reply', () => {
    it('decodes an idle printer with a 12 mm cassette', () => {
        const s = parseStatus(IDLE);
        expect(s).toMatchObject({
            print: 'idle',
            jobId: 0,
            cutter: 'idle',
            headOverheated: false,
            bay: 'ok',
            mediaType: 3,
            charging: 1,
            battery: 1,
            batteryLevel: 84,
            errorId: 0,
        });
        expect(s.tape?.widthMm).toBe(12);
        expect(readyForJob(s)).toBe(true);
    });

    it('follows a job through printing and cutting', () => {
        const printing = parseStatus(PRINTING);
        expect(printing).toMatchObject({ print: 'printing', jobId: 0x3524d0fc, labelIndex: 1, cutter: 'idle' });
        expect(readyForJob(printing)).toBe(false);
        expect(parseStatus(CUTTING).cutter).toBe('cutting');
    });

    it('reports an unknown battery level as absent', () => {
        const raw = new Uint8Array(IDLE);
        raw[22] = 0xff;
        expect(parseStatus(raw).batteryLevel).toBeUndefined();
    });

    it('rejects replies that are not 28 bytes', () => {
        expect(() => parseStatus(new Uint8Array(27))).toThrow(RangeError);
    });
});

describe('device matching', () => {
    it('matches MobileLabeler names and serial ports', () => {
        expect(isDymoLmV2Compatible('DYMO ML 0EB7')).toBe(true);
        expect(isDymoLmV2Compatible('/dev/cu.DYMOML0EB7')).toBe(true);
        expect(isDymoLmV2Compatible('DYMO MobileLabeler')).toBe(true);
        expect(isDymoLmV2Compatible('DYMO LabelManager PnP')).toBe(false);
        expect(isDymoLmV2Compatible('Nelko P21')).toBe(false);
        expect(isDymoLmV2Compatible('')).toBe(false);
    });
});
