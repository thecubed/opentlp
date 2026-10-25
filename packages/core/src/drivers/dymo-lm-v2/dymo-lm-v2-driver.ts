import type { IDeviceTransport } from '../../core/transports/transport.interface';
import type {
    ConnectionHints,
    IPrinterDriver,
    PrinterCapabilities,
    PrinterModelProfile,
    UniversalPrintOptions,
} from '../driver.interface';
import { PrinterError } from '../printer-error';
import type { PrinterFault, PrinterStatus, StatusField } from '../printer-status';
import { singlePlane, type UniversalPage } from '../../types/ink';
import { encodeD1Raster } from './dymo-lm-v2-raster';
import {
    cut,
    D1_TAPES,
    DEFAULT_LEADER_LINES,
    DEFAULT_TRAILER_LINES,
    DYMO_LM_V2_MODELS,
    DYMO_LM_V2_NAME_PATTERNS,
    DYMO_MOBILELABELER_PROFILE,
    endJob,
    formFeed,
    isDymoLmV2Compatible,
    labelIndex,
    labelLeader,
    labelTrailer,
    parseStatus,
    printDataHeader,
    readyForJob,
    startJob,
    statusRequest,
    STATUS_REPLY_BYTES,
    tapeForWidth,
    type D1Status,
    type D1TapeGeometry,
} from './dymo-lm-v2-protocol';

/** RFCOMM channel that carries commands and status. */
export const DYMO_COMMAND_CHANNEL = 2;

export interface DymoLmV2DriverOptions {
    /** Raster bytes per write. */
    chunkBytes?: number;
    /** Pause between raster writes. */
    chunkDelayMs?: number;
    /** Job id source; random by default, injectable for tests. */
    jobId?: () => number;
    /** Timer, injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** How long to wait for a 28-byte status reply. */
    statusTimeoutMs?: number;
    /** How long to wait for the command channel to open. */
    commandOpenTimeoutMs?: number;
    /** Lock attempts before a job, and the pause between them (DYMO's app: 5 × 3 s). */
    lockAttempts?: number;
    lockRetryMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Driver for DYMO's LabelManager "V2" protocol (MobileLabeler).
 *
 * The printer splits its Bluetooth traffic over two RFCOMM channels: print
 * jobs on channel 3 (its advertised serial port) and commands, including the
 * status request, on channel 2, which is not advertised.
 *
 * - **Print-only** when bound to a transport that reaches just channel 3 (Web
 *   Serial, an OS serial port): the tape width comes from the selected paper,
 *   and the printer itself is the authority on whether the job succeeds.
 * - **With status** when the transport can open channel 2 as well
 *   ({@link IDeviceTransport.openRfcommChannel}, e.g. a native bridge): reads
 *   battery, cassette and faults, and claims the printer with `ESC A 1` before
 *   each job the way DYMO's app does, printing for the loaded cassette.
 *
 * A job is:
 *
 *   ESC s <job id>
 *   per label:  [ESC E, ESC p 0 between labels]
 *               ESC n <index>  ESC l <leader>  ESC t <trailer>
 *               ESC D 01 02 <lines> <dots per line>  <raster>
 *   ESC E  ESC p 0  ESC Q
 *
 * Label length is the number of raster lines; there are no fixed sizes.
 */
export class DymoLmV2Driver implements IPrinterDriver {
    readonly id = 'dymo-lm-v2';
    readonly name = 'DYMO LabelManager V2';
    readonly driverType = 'hardware' as const;
    readonly defaultKind = 'label' as const;
    readonly supportedKinds = ['label'] as const;
    readonly supportedTransports = ['bluetooth-classic'] as const;
    readonly connectionRequirements = {
        services: [] as string[],
        namePrefixes: [...DYMO_LM_V2_NAME_PATTERNS],
    };
    readonly supportedModels: PrinterModelProfile[] = DYMO_LM_V2_MODELS;
    /** Nothing on the print channel alone, which never answers; more with the command channel. */
    get reports(): readonly StatusField[] {
        return this.command ? STATUS_REPORTS : [];
    }
    readonly connectionHints: ConnectionHints = {
        bluetoothClassicHint:
            'Pair the MobileLabeler in your OS Bluetooth settings, then choose its serial port ' +
            '("DYMO – paired" in Chrome, /dev/cu.DYMO… on macOS, COM… on Windows, /dev/rfcomm… on Linux). ' +
            'Choose a paper with the width of the loaded tape: the printer’s status cannot be read over this port. ' +
            'In the desktop app on macOS, the native Bluetooth option also reads battery, cassette and faults.',
        windowsClassicHint: 'Pair the MobileLabeler in Windows Bluetooth settings and pick its outgoing SPP COM port.',
    };

    private transport?: IDeviceTransport;
    /** Channel 2, when the transport could open it. */
    private command?: IDeviceTransport;
    private reply: number[] = [];
    private replyWaiter?: () => void;
    private statusQueue: Promise<unknown> = Promise.resolve();
    private currentOptions?: UniversalPrintOptions;
    private readonly opts: Required<DymoLmV2DriverOptions>;

    constructor(options: DymoLmV2DriverOptions = {}) {
        this.opts = {
            chunkBytes: options.chunkBytes ?? 512,
            chunkDelayMs: options.chunkDelayMs ?? 10,
            jobId: options.jobId ?? (() => Math.floor(Math.random() * 0xffffffff) >>> 0),
            sleep: options.sleep ?? defaultSleep,
            statusTimeoutMs: options.statusTimeoutMs ?? 3000,
            commandOpenTimeoutMs: options.commandOpenTimeoutMs ?? 15000,
            lockAttempts: options.lockAttempts ?? 5,
            lockRetryMs: options.lockRetryMs ?? 3000,
        };
    }

    isCompatible(deviceName: string): boolean {
        return isDymoLmV2Compatible(deviceName);
    }

    async bindTransport(transport: IDeviceTransport): Promise<void> {
        this.transport = transport;
        if (transport.openRfcommChannel) await this.openCommandChannel(transport);
    }

    async unbindTransport(): Promise<void> {
        const command = this.command;
        this.dropCommandChannel();
        await command?.disconnect().catch(() => undefined);
        this.transport = undefined;
        this.currentOptions = undefined;
    }

    /** Whether the command channel is open, so status and the job lock are available. */
    hasStatus(): boolean {
        return this.command !== undefined;
    }

    /**
     * Present only while the command channel is open: over the print channel
     * alone the printer says nothing, which PrintManager reports as `null`.
     */
    getStatus?: () => Promise<PrinterStatus>;

    private async currentStatus(): Promise<PrinterStatus> {
        return toPrinterStatus(await this.readStatus(false), this.transport?.getDeviceName());
    }

    getCapabilities(): PrinterCapabilities {
        return { ...DYMO_MOBILELABELER_PROFILE.capabilities, driverId: this.id, driverName: this.name };
    }

    async printInit(options: UniversalPrintOptions): Promise<void> {
        this.currentOptions = options;
    }

    async printPage(page: UniversalPage): Promise<void> {
        const options = this.currentOptions ?? { density: 1, copies: 1 };
        const tape = this.command ? tapeFromStatus(await this.claimPrinter(), options) : tapeFor(options);
        const raster = encodeD1Raster(singlePlane(page), tape);
        const copies = Math.max(1, Math.min(0xffff, Math.round(options.copies ?? 1)));

        await this.send(startJob(this.opts.jobId() >>> 0));
        for (let index = 1; index <= copies; index += 1) {
            if (index > 1) {
                await this.send(formFeed());
                await this.send(cut());
            }
            await this.send(labelIndex(index));
            await this.send(labelLeader(DEFAULT_LEADER_LINES));
            await this.send(labelTrailer(DEFAULT_TRAILER_LINES));
            await this.send(printDataHeader(raster.lineCount, raster.lineBits));
            await this.sendChunked(raster.data);
        }
        await this.send(formFeed());
        await this.send(cut());
        await this.send(endJob());
    }

    async printEnd(): Promise<void> {
        this.currentOptions = undefined;
    }

    private async openCommandChannel(transport: IDeviceTransport): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const opening = transport.openRfcommChannel!(DYMO_COMMAND_CHANNEL);
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), this.opts.commandOpenTimeoutMs);
        });
        try {
            const command = await Promise.race([opening, timeout]);
            this.command = command;
            this.getStatus = () => this.currentStatus();
            this.reply = [];
            command.on('data', this.onCommandData);
            command.on('disconnected', this.onCommandClosed);
        } catch {
            // Print-only, as over a serial port. A late open is closed again.
            void opening.then(late => late.disconnect()).catch(() => undefined);
        } finally {
            clearTimeout(timer);
        }
    }

    private readonly onCommandData = (data: Uint8Array) => {
        this.reply.push(...data);
        if (this.reply.length >= STATUS_REPLY_BYTES) this.replyWaiter?.();
    };

    private readonly onCommandClosed = () => this.dropCommandChannel();

    private dropCommandChannel(): void {
        this.command?.off('data', this.onCommandData);
        this.command?.off('disconnected', this.onCommandClosed);
        this.command = undefined;
        this.getStatus = undefined;
        this.replyWaiter?.();
    }

    /** One `ESC A` round trip on channel 2. Requests never overlap. */
    private readStatus(lock: boolean): Promise<D1Status> {
        const run = this.statusQueue.then(() => this.requestStatus(lock));
        this.statusQueue = run.catch(() => undefined);
        return run;
    }

    private async requestStatus(lock: boolean): Promise<D1Status> {
        const command = this.command;
        if (!command) throw new PrinterError('not-connected', 'The DYMO command channel is closed.');
        this.reply = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arrived = new Promise<void>(resolve => {
            this.replyWaiter = resolve;
            timer = setTimeout(resolve, this.opts.statusTimeoutMs);
        });
        try {
            await command.write(statusRequest(lock));
            if (this.reply.length < STATUS_REPLY_BYTES) await arrived;
        } finally {
            clearTimeout(timer);
            this.replyWaiter = undefined;
        }
        if (this.reply.length < STATUS_REPLY_BYTES) {
            throw new PrinterError(
                this.command ? 'timeout' : 'not-connected',
                `No status reply from the printer (got ${this.reply.length} of ${STATUS_REPLY_BYTES} bytes).`
            );
        }
        return parseStatus(Uint8Array.from(this.reply.slice(0, STATUS_REPLY_BYTES)));
    }

    /**
     * `ESC A 1` until the printer is free, as DYMO's app does before a job.
     * Refuses at once on a fault that waiting will not clear.
     */
    private async claimPrinter(): Promise<D1Status> {
        let status: D1Status | undefined;
        for (let attempt = 1; attempt <= this.opts.lockAttempts; attempt += 1) {
            status = await this.readStatus(true);
            // DYMO's readiness test ignores the bay, so faults are checked first.
            const blocking = faultsOf(status).find(fault => fault.blocking);
            if (blocking && !isTransient(status)) {
                throw new PrinterError('device-fault', `Printer not ready: ${blocking.message ?? blocking.code}.`, { fault: blocking });
            }
            if (readyForJob(status)) return status;
            if (attempt < this.opts.lockAttempts) await this.opts.sleep(this.opts.lockRetryMs);
        }
        throw new PrinterError('device-fault', `The printer stayed busy (${describeBusy(status!)}).`);
    }

    private requireTransport(): IDeviceTransport {
        if (!this.transport) throw new PrinterError('not-connected', 'DYMO transport is not bound.');
        return this.transport;
    }

    private async send(data: Uint8Array): Promise<void> {
        await this.requireTransport().write(data);
    }

    private async sendChunked(data: Uint8Array): Promise<void> {
        const transport = this.requireTransport();
        const size = this.opts.chunkBytes;
        for (let offset = 0; offset < data.length; offset += size) {
            await transport.write(data.slice(offset, offset + size));
            if (offset + size < data.length && this.opts.chunkDelayMs > 0) {
                await this.opts.sleep(this.opts.chunkDelayMs);
            }
        }
    }
}

const D1_WIDTHS = D1_TAPES.map(t => t.widthMm).join(', ');
const STATUS_REPORTS: readonly StatusField[] = ['battery', 'charging', 'media', 'faults'];

/** The loaded cassette decides; a selected paper of another width is refused. */
function tapeFromStatus(status: D1Status, options: UniversalPrintOptions): D1TapeGeometry {
    const loaded = status.tape;
    const requested = options.paper?.tapeWidthMm;
    if (!loaded) return tapeFor(options);
    if (requested !== undefined && Math.abs(requested - loaded.widthMm) > 0.75) {
        throw new PrinterError(
            'unsupported',
            `The loaded cassette is ${loaded.widthMm} mm but the selected paper is ${requested} mm. Choose the ${loaded.widthMm} mm paper.`
        );
    }
    return loaded;
}

/** Busy rather than broken: worth waiting for. */
function isTransient(status: D1Status): boolean {
    return status.print === 'printing' || status.cutter === 'cutting' || status.cutter === 'cleaning'
        || (status.jobId !== 0 && status.print !== 'error');
}

function describeBusy(status: D1Status): string {
    const parts = [`print ${status.print}`, `cutter ${status.cutter}`];
    if (status.jobId) parts.push(`job ${status.jobId}`);
    if (status.errorId) parts.push(`error ${status.errorId}`);
    return parts.join(', ');
}

const BAY_FAULTS: Partial<Record<D1Status['bay'], PrinterFault>> = {
    'open': { code: 'cover-open', blocking: true, message: 'Cassette bay open' },
    'empty-bay': { code: 'paper-out', blocking: true, message: 'No cassette' },
    'media-empty': { code: 'paper-out', blocking: true, message: 'Tape used up' },
    'jammed': { code: 'paper-jam', blocking: true, message: 'Tape jammed' },
    'misinserted': { code: 'unknown', blocking: true, message: 'Cassette inserted improperly' },
    'media-critical': { code: 'unknown', blocking: false, message: 'Tape almost used up' },
    'media-low': { code: 'unknown', blocking: false, message: 'Tape low' },
    'counterfeit': { code: 'unknown', blocking: false, message: 'Cassette not recognised as genuine' },
};

/** DYMO error ids with a portable meaning. */
const ERROR_FAULTS: Record<number, PrinterFault> = {
    16: { code: 'paper-out', blocking: true, message: 'No cassette' },
    18: { code: 'paper-jam', blocking: true, message: 'Tape jammed' },
    19: { code: 'paper-out', blocking: true, message: 'Out of tape' },
    22: { code: 'cover-open', blocking: true, message: 'Cassette door open' },
    24: { code: 'overheated', blocking: true, message: 'Print head overheated' },
    25: { code: 'paper-jam', blocking: true, message: 'Cutter jammed' },
    28: { code: 'power', blocking: true, message: 'Not enough power' },
    48: { code: 'battery-critical', blocking: true, message: 'Battery critically low' },
    49: { code: 'unknown', blocking: false, message: 'Battery low' },
};

export function faultsOf(status: D1Status): PrinterFault[] {
    const faults: PrinterFault[] = [];
    const add = (fault: PrinterFault, raw: string) => {
        if (!faults.some(f => f.code === fault.code && f.message === fault.message)) faults.push({ ...fault, raw });
    };
    const bay = BAY_FAULTS[status.bay];
    if (bay) add(bay, `bay ${status.bay}`);
    if (status.headOverheated) add({ code: 'overheated', blocking: true, message: 'Print head overheated' }, 'head 1');
    if (status.cutter === 'jammed') add({ code: 'paper-jam', blocking: true, message: 'Cutter jammed' }, 'cutter 4');
    if (status.battery === 3) add({ code: 'battery-critical', blocking: false, message: 'Battery critically low' }, 'battery 3');
    if (status.battery === 4) add({ code: 'battery-critical', blocking: true, message: 'Battery empty' }, 'battery 4');
    if (status.errorId) {
        add(ERROR_FAULTS[status.errorId] ?? { code: 'unknown', blocking: true, message: `DYMO error ${status.errorId}` },
            `error ${status.errorId}`);
    } else if (status.print === 'error') {
        add({ code: 'unknown', blocking: true, message: 'Printer reports an error' }, 'print 2');
    }
    return faults;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

export function toPrinterStatus(status: D1Status, deviceName?: string): PrinterStatus {
    const charging = status.charging === 1 || status.charging === 2;
    return {
        identity: deviceName ? { deviceName } : {},
        battery: {
            ...(status.batteryLevel !== undefined ? { level: Math.min(100, status.batteryLevel) / 100 } : {}),
            charging,
        },
        ...(status.tape
            ? {
                media: {
                    kind: 'continuous' as const,
                    widthMm: status.tape.widthMm,
                    id: `d1-${status.tape.widthMm}`,
                    name: `D1 ${status.tape.widthMm} mm`,
                    identification: { technology: 'cartridge-code' as const },
                },
            }
            : {}),
        faults: faultsOf(status),
        details: [
            { id: 'print', label: 'Print state', value: status.jobId ? `${status.print} (job ${status.jobId})` : status.print },
            { id: 'cutter', label: 'Cutter', value: status.cutter },
            { id: 'bay', label: 'Cassette bay', value: `${status.bay} (media type ${status.mediaType})` },
            { id: 'raw', label: 'Status bytes', value: hex(status.raw), monospace: true },
        ],
        readAt: Date.now(),
    };
}

/** The selected paper decides the geometry; there is no status to consult. */
function tapeFor(options: UniversalPrintOptions): D1TapeGeometry {
    const requested = options.paper?.tapeWidthMm;
    if (requested === undefined) {
        throw new PrinterError(
            'unsupported',
            `Choose a paper with the loaded D1 tape width (${D1_WIDTHS} mm): this connection cannot read the cassette.`
        );
    }
    const tape = tapeForWidth(requested);
    if (!tape) {
        throw new PrinterError('unsupported', `${requested} mm is not a D1 tape width. Use ${D1_WIDTHS} mm.`);
    }
    return tape;
}

export { DYMO_LM_V2_MODELS } from './dymo-lm-v2-protocol';
