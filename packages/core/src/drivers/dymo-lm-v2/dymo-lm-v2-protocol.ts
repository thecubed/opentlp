import type { PrinterModelProfile, SupportLevel } from '../driver.interface';

/**
 * DYMO LabelManager "V2" protocol facts, as used by the MobileLabeler.
 *
 * The job format is the escape-sequence protocol DYMO's own drivers emit
 * (`ESC s/n/l/t`, one `ESC D` print-data header per label followed by raw
 * raster lines, `ESC E ESC p 0 ESC Q`). It is NOT the older LabelManager
 * protocol (`ESC B` dot tab, per-line `SYN` prefixes) of the PnP/280/420P.
 *
 * Transport (from DYMO's Android app, confirmed against hardware):
 *
 * - RFCOMM channel 3, advertised as the "MLS DataPort" serial port, takes the
 *   print job. It never answers.
 * - RFCOMM channel 2, not advertised in SDP, carries commands such as the
 *   `ESC A` status request. The app opens both channels by number and keeps
 *   them open together.
 *
 * A job sent on channel 3 alone prints; the status lock on channel 2 is not
 * required. That is what makes a single serial port (Web Serial, a macOS
 * `/dev/cu.*` port) enough to print.
 *
 * Facts were recorded by interoperability analysis of DYMO's published macOS
 * CUPS driver package and Android app (DYMO Connect 2.0.892), and confirmed by
 * printing on a MobileLabeler. No DYMO code is copied; only wire-format facts
 * are used. Multi-byte integers are little-endian.
 */

const UNTESTED: SupportLevel = 'Untested';

/** Print resolution: the PPD and the Android app both use 300 dpi. */
export const DYMO_LM_V2_DPI = 300;
/** Dots per millimetre at 300 dpi, kept exact so millimetre layouts stay true. */
export const DYMO_LM_V2_DPMM = DYMO_LM_V2_DPI / 25.4;

/**
 * DYMO's encoder only fills in the dots-per-line field for labels longer than
 * 210 lines and leaves it at zero otherwise. Its own label sizes are always
 * longer; this driver pads shorter labels so the header is always well formed.
 */
export const MIN_LABEL_LINES = 211;

/** Feed before the first raster line, in lines (DYMO's default). */
export const DEFAULT_LEADER_LINES = 36;
/** Feed after the last raster line, in lines (DYMO's default). */
export const DEFAULT_TRAILER_LINES = 28;

/**
 * One D1 tape width as DYMO's Android app rasterises it: every line carries
 * just the printable band, padded to whole bytes, with no offset or shift.
 *
 * `printableDots` comes from the app's paper table (printable width in twips
 * at 300 dpi) and agrees with the macOS PPD's imageable areas to within a dot.
 */
export interface D1TapeGeometry {
    widthMm: 6 | 9 | 12 | 19 | 24;
    printableDots: number;
    lineBits: number;
}

const tape = (widthMm: D1TapeGeometry['widthMm'], printableDots: number): D1TapeGeometry => ({
    widthMm,
    printableDots,
    lineBits: Math.ceil(printableDots / 8) * 8,
});

export const D1_TAPES: readonly D1TapeGeometry[] = [
    tape(6, 60),
    tape(9, 80),
    tape(12, 94),
    tape(19, 158),
    tape(24, 224),
];

/** Widest printable band (24 mm tape): the designer canvas height. */
export const MAX_PRINTABLE_DOTS = 224;

export function tapeForWidth(widthMm: number | undefined): D1TapeGeometry | undefined {
    if (widthMm === undefined || !Number.isFinite(widthMm)) return undefined;
    return D1_TAPES.find(t => Math.abs(t.widthMm - widthMm) < 0.75);
}

/* ========================================================================= *
 * Command builders
 * ========================================================================= */

const ESC = 0x1b;

function u16(value: number): number[] {
    return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function uint(value: number, max: number, name: string): number {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`${name} must be an integer from 0 to ${max}.`);
    }
    return value;
}

/**
 * `ESC A <lock>`: request the 28-byte status. Command channel only.
 * Lock is 1 when claiming the printer for a job.
 */
export function statusRequest(lock: boolean): Uint8Array {
    return new Uint8Array([ESC, 0x41, lock ? 1 : 0]);
}

/** `ESC V`: request the 10-byte version reply. Command channel only. */
export function versionRequest(): Uint8Array {
    return new Uint8Array([ESC, 0x56]);
}

/** `ESC s <u32 job id>`: start of job. */
export function startJob(jobId: number): Uint8Array {
    return new Uint8Array([ESC, 0x73, ...u32(uint(jobId, 0xffffffff, 'Job id'))]);
}

/** `ESC n <u16 index>`: label number within the job, starting at 1. */
export function labelIndex(index: number): Uint8Array {
    return new Uint8Array([ESC, 0x6e, ...u16(uint(index, 0xffff, 'Label index'))]);
}

/** `ESC l <u32 lines>`: feed before the raster. */
export function labelLeader(lines: number): Uint8Array {
    return new Uint8Array([ESC, 0x6c, ...u32(uint(lines, 0xffffffff, 'Leader'))]);
}

/** `ESC t <u32 lines>`: feed after the raster. */
export function labelTrailer(lines: number): Uint8Array {
    return new Uint8Array([ESC, 0x74, ...u32(uint(lines, 0xffffffff, 'Trailer'))]);
}

/**
 * `ESC D 01 02 <u32 line count> <u32 dots per line>`: print-data header.
 * The `01 02` pair is constant in DYMO's encoder. Dots per line must be a
 * whole number of bytes.
 */
export function printDataHeader(lineCount: number, dotsPerLine: number): Uint8Array {
    uint(lineCount, 0xffffffff, 'Line count');
    if (lineCount < 1) throw new RangeError('Line count must be positive.');
    uint(dotsPerLine, 0xffffffff, 'Dots per line');
    if (dotsPerLine < 8 || dotsPerLine % 8 !== 0) {
        throw new RangeError('Dots per line must be a positive multiple of 8.');
    }
    return new Uint8Array([ESC, 0x44, 0x01, 0x02, ...u32(lineCount), ...u32(dotsPerLine)]);
}

/** `ESC E`: form feed, sent between labels and before the final cut. */
export function formFeed(): Uint8Array {
    return new Uint8Array([ESC, 0x45]);
}

/** `ESC G`: short form feed. Defined by the protocol; not used by this driver. */
export function shortFormFeed(): Uint8Array {
    return new Uint8Array([ESC, 0x47]);
}

/** `ESC p '0'`: cut. */
export function cut(): Uint8Array {
    return new Uint8Array([ESC, 0x70, 0x30]);
}

/** `ESC p '1'`: print a chain (cutter) mark instead of cutting. */
export function chainMark(): Uint8Array {
    return new Uint8Array([ESC, 0x70, 0x31]);
}

/** `ESC Q`: end of job. */
export function endJob(): Uint8Array {
    return new Uint8Array([ESC, 0x51]);
}

/* ========================================================================= *
 * Status reply (command channel)
 *
 * Not read by the print-only driver: a single serial port reaches only the
 * print channel. Decoded here, with DYMO's own field names, for transports
 * that can also open the command channel.
 * ========================================================================= */

export const STATUS_REPLY_BYTES = 28;

export type D1PrintState = 'idle' | 'printing' | 'error' | 'cancelled' | 'unknown';
export type D1CutterState = 'none' | 'idle' | 'cutting' | 'cleaning' | 'jammed' | 'unknown';
export type D1BayState =
    | 'unknown' | 'open' | 'empty-bay' | 'misinserted' | 'present-unknown'
    | 'media-empty' | 'media-critical' | 'media-low' | 'ok' | 'jammed' | 'counterfeit';

export interface D1Status {
    raw: Uint8Array;
    print: D1PrintState;
    /** Job currently printing; 0 when idle. */
    jobId: number;
    labelIndex: number;
    cutter: D1CutterState;
    headOverheated: boolean;
    bay: D1BayState;
    /** Cassette type index; 0 = none. */
    mediaType: number;
    /** Tape width for {@link mediaType}, when it names one. */
    tape?: D1TapeGeometry;
    /** Charging state nibble: 0 n/a, 1 charging, 2 trickle, 3 failure. */
    charging: number;
    /** Battery state nibble: 0 unknown, 1 ok, 2 low, 3 critical, 4 empty. */
    battery: number;
    /** Battery level, 0–100; undefined when the printer reports 255. */
    batteryLevel?: number;
    /** DYMO error id; 0 = none. */
    errorId: number;
}

const PRINT_STATES: readonly D1PrintState[] = ['idle', 'printing', 'error', 'cancelled'];
const CUTTER_STATES: readonly D1CutterState[] = ['none', 'idle', 'cutting', 'cleaning', 'jammed'];
const BAY_STATES: readonly D1BayState[] = [
    'unknown', 'open', 'empty-bay', 'misinserted', 'present-unknown',
    'media-empty', 'media-critical', 'media-low', 'ok', 'jammed', 'counterfeit',
];
/** Media type index → width; the five widths repeat for indices 1–15. */
const MEDIA_WIDTHS: readonly (D1TapeGeometry['widthMm'] | 0)[] = [0, 24, 19, 12, 6, 9, 24, 19, 12, 6, 9, 24, 19, 12, 6, 9];

export function tapeForMediaType(mediaType: number): D1TapeGeometry | undefined {
    const width = MEDIA_WIDTHS[mediaType];
    return width ? tapeForWidth(width) : undefined;
}

function readU32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** Decode an `ESC A` reply. Throws unless it is exactly 28 bytes. */
export function parseStatus(raw: Uint8Array): D1Status {
    if (raw.length !== STATUS_REPLY_BYTES) {
        throw new RangeError(`Status reply must be ${STATUS_REPLY_BYTES} bytes, got ${raw.length}.`);
    }
    const mediaType = readU32(raw, 11);
    return {
        raw: new Uint8Array(raw),
        print: PRINT_STATES[raw[0]] ?? 'unknown',
        jobId: readU32(raw, 1),
        labelIndex: raw[5] | (raw[6] << 8),
        cutter: CUTTER_STATES[raw[7]] ?? 'unknown',
        headOverheated: raw[8] === 1,
        bay: BAY_STATES[raw[10]] ?? 'unknown',
        mediaType,
        tape: tapeForMediaType(mediaType),
        charging: raw[20] >> 4,
        battery: raw[21] & 0x0f,
        batteryLevel: raw[22] === 0xff ? undefined : raw[22],
        errorId: raw[23],
    };
}

/** DYMO's own test for "ready to take a job". */
export function readyForJob(status: D1Status): boolean {
    return status.jobId === 0
        && status.print === 'idle'
        && !status.headOverheated
        && status.cutter === 'idle'
        && status.errorId === 0;
}

/* ========================================================================= *
 * Model profile
 * ========================================================================= */

export const DYMO_MOBILELABELER_PROFILE: PrinterModelProfile = {
    id: 'dymo_mobilelabeler',
    brand: 'DYMO',
    model: 'MobileLabeler',
    family: 'DYMO LabelManager V2',
    kind: 'label',
    supportedKinds: ['label'],
    supportedTransports: ['bluetooth-classic'],
    aliases: ['DYMO ML', 'Mobile Labeler'],
    supportLevel: UNTESTED,
    notes: [
        '300-dpi D1 tape labeler (6, 9, 12, 19 and 24 mm cassettes) over Bluetooth Classic.',
        'Prints over its serial port (RFCOMM 3); there, choose a paper with the loaded tape width.',
        'Status and cassette detection use a second, unadvertised channel (RFCOMM 2) that browsers and serial ports cannot open;',
        'the desktop app’s native Bluetooth option on macOS opens both and reads them.',
        'Printable band per tape: 6 mm ≈ 5.1 mm, 9 mm ≈ 6.8 mm, 12 mm ≈ 8.0 mm, 19 mm ≈ 13.4 mm, 24 mm ≈ 19.0 mm,',
        'centred on the tape; the canvas is sized to the band and the rest of the tape stays blank.',
    ].join(' '),
    capabilities: {
        maxDensity: 1,
        canvasHeightPx: MAX_PRINTABLE_DOTS,
        supportsSpeedMode: false,
        colorSupport: { type: 'monochrome', channels: 1 },
        dpmm: DYMO_LM_V2_DPMM,
        driverName: 'DYMO LabelManager V2',
        physical: {
            supportedMediaWidthsMm: { min: 6, max: 24 },
            // The printer positions the band by cassette; DYMO never prints outside it.
            printableBandsMm: D1_TAPES.map(t => ({ mediaWidthMm: t.widthMm, printableWidthMm: t.printableDots / DYMO_LM_V2_DPMM })),
        },
    },
};

export const DYMO_LM_V2_MODELS: PrinterModelProfile[] = [DYMO_MOBILELABELER_PROFILE];

/** Name tokens the MobileLabeler pairs or enumerates under. */
export const DYMO_LM_V2_NAME_PATTERNS = ['DYMO ML', 'DYMOML', 'MobileLabeler', 'Mobile Labeler'] as const;

export function isDymoLmV2Compatible(deviceName: string): boolean {
    if (!deviceName || typeof deviceName !== 'string') return false;
    const compact = deviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return compact.includes('dymoml') || compact.includes('mobilelabeler');
}
