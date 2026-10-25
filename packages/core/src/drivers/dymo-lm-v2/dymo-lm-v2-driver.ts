import type { IDeviceTransport } from '../../core/transports/transport.interface';
import type {
    ConnectionHints,
    IPrinterDriver,
    PrinterCapabilities,
    PrinterModelProfile,
    UniversalPrintOptions,
} from '../driver.interface';
import { PrinterError } from '../printer-error';
import type { StatusField } from '../printer-status';
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
    printDataHeader,
    startJob,
    tapeForWidth,
    type D1TapeGeometry,
} from './dymo-lm-v2-protocol';

export interface DymoLmV2DriverOptions {
    /** Raster bytes per write. */
    chunkBytes?: number;
    /** Pause between raster writes. */
    chunkDelayMs?: number;
    /** Job id source; random by default, injectable for tests. */
    jobId?: () => number;
    /** Timer, injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Print-only driver for DYMO's LabelManager "V2" protocol (MobileLabeler).
 *
 * The printer splits its Bluetooth traffic over two RFCOMM channels: print
 * jobs on channel 3 (its advertised serial port) and commands, including the
 * status request, on channel 2, which is not advertised. Web Serial and an OS
 * serial port reach only channel 3, so this driver prints without reading
 * status: the tape width comes from the selected paper, and the printer itself
 * is the authority on whether the job succeeds.
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
    /** Nothing: the print channel never answers. */
    readonly reports: readonly StatusField[] = [];
    readonly connectionHints: ConnectionHints = {
        bluetoothClassicHint:
            'Pair the MobileLabeler in your OS Bluetooth settings, then choose its serial port ' +
            '("DYMO – paired" in Chrome, /dev/cu.DYMO… on macOS, COM… on Windows, /dev/rfcomm… on Linux). ' +
            'Choose a paper with the width of the loaded tape: the printer’s status cannot be read over this port.',
        windowsClassicHint: 'Pair the MobileLabeler in Windows Bluetooth settings and pick its outgoing SPP COM port.',
    };

    private transport?: IDeviceTransport;
    private currentOptions?: UniversalPrintOptions;
    private readonly opts: Required<DymoLmV2DriverOptions>;

    constructor(options: DymoLmV2DriverOptions = {}) {
        this.opts = {
            chunkBytes: options.chunkBytes ?? 512,
            chunkDelayMs: options.chunkDelayMs ?? 10,
            jobId: options.jobId ?? (() => Math.floor(Math.random() * 0xffffffff) >>> 0),
            sleep: options.sleep ?? defaultSleep,
        };
    }

    isCompatible(deviceName: string): boolean {
        return isDymoLmV2Compatible(deviceName);
    }

    async bindTransport(transport: IDeviceTransport): Promise<void> {
        this.transport = transport;
    }

    async unbindTransport(): Promise<void> {
        this.transport = undefined;
        this.currentOptions = undefined;
    }

    getCapabilities(): PrinterCapabilities {
        return { ...DYMO_MOBILELABELER_PROFILE.capabilities, driverId: this.id, driverName: this.name };
    }

    async printInit(options: UniversalPrintOptions): Promise<void> {
        this.currentOptions = options;
    }

    async printPage(page: UniversalPage): Promise<void> {
        const options = this.currentOptions ?? { density: 1, copies: 1 };
        const tape = tapeFor(options);
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
