import { describe, expect, it } from 'vitest';
import EventEmitter from 'eventemitter3';
import type { IDeviceTransport, TransportEventMap } from '../../core/transports/transport.interface';
import { monoPage } from '../../types/ink';
import type { PaperProfile } from '../../types/paper';
import { PrintManager } from '../../core/print-manager';
import { isPrinterError } from '../printer-error';
import { DymoLmV2Driver, DYMO_LM_V2_MODELS, type DymoLmV2DriverOptions } from './dymo-lm-v2-driver';

/** A write-only serial port, like the printer's channel 3. */
class MockPort extends EventEmitter<TransportEventMap> implements IDeviceTransport {
    readonly type = 'Mock Classic';
    readonly writes: Uint8Array[] = [];
    constructor(private readonly name = 'DYMO ML 0EB7') { super(); }
    getDeviceName(): string { return this.name; }
    isConnected(): boolean { return true; }
    async connect(): Promise<void> { /* already connected */ }
    async disconnect(): Promise<void> { /* nothing to release */ }
    async write(data: Uint8Array): Promise<void> { this.writes.push(new Uint8Array(data)); }
    bytes(): number[] { return this.writes.flatMap(w => Array.from(w)); }
}

const fromHex = (text: string) => Uint8Array.from(text.trim().split(/\s+/), b => parseInt(b, 16));
/** Replies captured from a MobileLabeler with a 12 mm cassette. */
const IDLE = '00 00 00 00 00 00 00 01 00 00 08 03 00 00 00 00 00 00 00 00 11 01 54 00 00 00 00 07';
const PRINTING = '01 fc d0 24 35 01 00 01 00 00 08 03 00 00 00 00 00 00 00 00 11 01 54 00 00 00 00 07';
/** IDLE with byte 10 (bay) and byte 11 (media type) replaced. */
const withBay = (bay: number, media: number) => {
    const bytes = IDLE.split(' ');
    bytes[10] = bay.toString(16).padStart(2, '0');
    bytes[11] = media.toString(16).padStart(2, '0');
    return bytes.join(' ');
};

/** Channel 2: answers each ESC A with the next scripted reply, split in two like RFCOMM may. */
class MockCommand extends MockPort {
    constructor(private readonly replies: string[], private readonly silent = false) { super(); }
    override async write(data: Uint8Array): Promise<void> {
        await super.write(data);
        if (this.silent || data[0] !== 0x1b || data[1] !== 0x41) return;
        const reply = fromHex(this.replies.length > 1 ? this.replies.shift()! : this.replies[0]);
        queueMicrotask(() => {
            this.emit('data', reply.slice(0, 10));
            this.emit('data', reply.slice(10));
        });
    }
    disconnected = false;
    override async disconnect(): Promise<void> { this.disconnected = true; }
}

/** Channel 3 on a transport that can also open channel 2. */
class MockBridgedPort extends MockPort {
    readonly opened: number[] = [];
    constructor(readonly command: MockCommand | Error) { super(); }
    async openRfcommChannel(channel: number): Promise<IDeviceTransport> {
        this.opened.push(channel);
        if (this.command instanceof Error) throw this.command;
        return this.command;
    }
}

const fast: DymoLmV2DriverOptions = { chunkDelayMs: 0, jobId: () => 0x04030201, sleep: async () => undefined };

const d1 = (tapeWidthMm: number): PaperProfile => ({ id: `d1-${tapeWidthMm}`, name: `D1 ${tapeWidthMm} mm`, type: 'continuous', tapeWidthMm });

function blankPage(width: number, height: number) {
    return monoPage({ width, height, data: new Uint8Array(width * height * 4).fill(255) });
}

/** Split a job into commands by walking the known opcodes. */
function commands(job: number[]): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < job.length) {
        expect(job[i]).toBe(0x1b);
        const op = String.fromCharCode(job[i + 1]);
        const size = { s: 6, n: 4, l: 6, t: 6, D: 12, E: 2, Q: 2, p: 3 }[op];
        if (size === undefined) throw new Error(`Unexpected opcode ${op} at ${i}`);
        out.push(op === 'p' ? `p${String.fromCharCode(job[i + 2])}` : op);
        if (op === 'D') {
            const lines = job[i + 4] | (job[i + 5] << 8) | (job[i + 6] << 16) | (job[i + 7] << 24);
            const bits = job[i + 8] | (job[i + 9] << 8);
            i += size + lines * (bits / 8);
            out.push(`raster ${lines}x${bits}`);
        } else {
            i += size;
        }
    }
    return out;
}

async function print(port: MockPort, paper: PaperProfile | undefined, width: number, height: number, copies = 1) {
    const driver = new DymoLmV2Driver(fast);
    await driver.bindTransport(port);
    await driver.printInit({ density: 1, copies, paper });
    await driver.printPage(blankPage(width, height));
    await driver.printEnd();
}

describe('DymoLmV2Driver', () => {
    it('declares a stable id, the MobileLabeler model, and no readings', () => {
        const driver = new DymoLmV2Driver();
        expect(driver.id).toBe('dymo-lm-v2');
        expect(driver.driverType).toBe('hardware');
        expect(driver.supportedModels).toBe(DYMO_LM_V2_MODELS);
        expect(driver.reports).toEqual([]);
        expect(driver.getStatus).toBeUndefined();
        expect(driver.hasStatus()).toBe(false);
        const caps = driver.getCapabilities();
        expect(caps.canvasHeightPx).toBe(224);
        expect(caps.dpmm).toBeCloseTo(11.811, 3);
        expect(caps.driverId).toBe('dymo-lm-v2');
    });

    it('emits the full job in DYMO\'s order, sized for the selected tape', async () => {
        const port = new MockPort();
        await print(port, d1(12), 400, 94);
        const job = port.bytes();
        expect(job.slice(0, 6)).toEqual([0x1b, 0x73, 0x01, 0x02, 0x03, 0x04]);
        expect(commands(job)).toEqual(['s', 'n', 'l', 't', 'D', 'raster 400x96', 'E', 'p0', 'Q']);
        // Leader 36, trailer 28, as DYMO's own encoder sends them.
        expect(job.slice(10, 22)).toEqual([0x1b, 0x6c, 36, 0, 0, 0, 0x1b, 0x74, 28, 0, 0, 0]);
    });

    it('never reads from or waits on the port', async () => {
        const port = new MockPort();
        await print(port, d1(24), 300, 224);
        expect(port.listenerCount('data')).toBe(0);
        expect(port.writes.some(w => w[0] === 0x1b && w[1] === 0x41)).toBe(false);
    });

    it('uses the line width of each D1 tape', async () => {
        const widths: Record<number, number> = { 6: 64, 9: 80, 12: 96, 19: 160, 24: 224 };
        for (const [mm, bits] of Object.entries(widths)) {
            const port = new MockPort();
            await print(port, d1(Number(mm)), 300, 50);
            expect(commands(port.bytes())).toContain(`raster 300x${bits}`);
        }
    });

    it('separates copies with a feed and cut and numbers each label', async () => {
        const port = new MockPort();
        await print(port, d1(9), 20, 80, 2);
        const job = port.bytes();
        expect(commands(job)).toEqual([
            's',
            'n', 'l', 't', 'D', 'raster 211x80',
            'E', 'p0',
            'n', 'l', 't', 'D', 'raster 211x80',
            'E', 'p0', 'Q',
        ]);
        expect(job.findIndex((b, i) => b === 0x1b && job[i + 1] === 0x6e && job[i + 2] === 2)).toBeGreaterThan(0);
    });

    it('splits raster writes into chunks', async () => {
        const port = new MockPort();
        const driver = new DymoLmV2Driver({ ...fast, chunkBytes: 100 });
        await driver.bindTransport(port);
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        await driver.printPage(blankPage(400, 94));
        expect(Math.max(...port.writes.map(w => w.length))).toBe(100);
        expect(port.bytes().length).toBe(6 + 4 + 6 + 6 + 12 + 400 * 12 + 2 + 3 + 2);
    });

    it('asks for a tape width when no paper is selected, before sending anything', async () => {
        const port = new MockPort();
        const error = await print(port, undefined, 300, 94).catch(e => e);
        expect(isPrinterError(error)).toBe(true);
        expect(error.code).toBe('unsupported');
        expect(error.message).toMatch(/tape width/);
        expect(port.writes).toEqual([]);
    });

    it('rejects a non-D1 paper width before sending anything', async () => {
        const port = new MockPort();
        const error = await print(port, d1(15), 300, 94).catch(e => e);
        expect(error.code).toBe('unsupported');
        expect(error.message).toMatch(/15 mm is not a D1 tape width/);
        expect(port.writes).toEqual([]);
    });

    it('fails cleanly when no transport is bound', async () => {
        const driver = new DymoLmV2Driver(fast);
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        const error = await driver.printPage(blankPage(300, 94)).catch(e => e);
        expect(error.code).toBe('not-connected');
    });
});

describe('DymoLmV2Driver with the command channel', () => {
    const fastStatus: DymoLmV2DriverOptions = { ...fast, statusTimeoutMs: 50, lockRetryMs: 0 };

    async function bound(replies: string[], options: DymoLmV2DriverOptions = fastStatus) {
        const command = new MockCommand(replies);
        const port = new MockBridgedPort(command);
        const driver = new DymoLmV2Driver(options);
        await driver.bindTransport(port);
        return { driver, port, command };
    }

    it('opens channel 2 and reports battery, charging, cassette and faults', async () => {
        const { driver, port, command } = await bound([IDLE]);
        expect(port.opened).toEqual([2]);
        expect(driver.hasStatus()).toBe(true);
        expect(driver.reports).toEqual(['battery', 'charging', 'media', 'faults']);

        const status = await driver.getStatus!();
        expect(command.bytes()).toEqual([0x1b, 0x41, 0x00]);
        expect(status.battery).toEqual({ level: 0.84, charging: true });
        expect(status.media).toMatchObject({ kind: 'continuous', widthMm: 12, name: 'D1 12 mm' });
        expect(status.faults).toEqual([]);
        expect(status.details?.find(d => d.id === 'raw')?.value).toBe(IDLE);
    });

    it('locks with ESC A 1 and prints for the loaded cassette without a selected paper', async () => {
        const { driver, port, command } = await bound([IDLE]);
        await driver.printInit({ density: 1, copies: 1 });
        await driver.printPage(blankPage(300, 94));
        expect(command.bytes()).toEqual([0x1b, 0x41, 0x01]);
        expect(commands(port.bytes())).toContain('raster 300x96');
    });

    it('waits while the printer is busy, then prints', async () => {
        const sleeps: number[] = [];
        const { driver, port, command } = await bound([PRINTING, PRINTING, IDLE], {
            ...fastStatus, lockRetryMs: 3000, sleep: async ms => { sleeps.push(ms); },
        });
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        await driver.printPage(blankPage(300, 94));
        expect(command.writes.length).toBe(3);
        expect(sleeps.filter(ms => ms === 3000)).toEqual([3000, 3000]);
        expect(port.bytes().length).toBeGreaterThan(0);
    });

    it('gives up after five busy replies without sending the job', async () => {
        const { driver, port, command } = await bound([PRINTING]);
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        const error = await driver.printPage(blankPage(300, 94)).catch(e => e);
        expect(error.code).toBe('device-fault');
        expect(error.message).toMatch(/stayed busy/);
        expect(command.writes.length).toBe(5);
        expect(port.writes).toEqual([]);
    });

    it('refuses at once on an open bay', async () => {
        const { driver, port, command } = await bound([withBay(1, 0)]);
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        const error = await driver.printPage(blankPage(300, 94)).catch(e => e);
        expect(error.code).toBe('device-fault');
        expect(error.fault).toMatchObject({ code: 'cover-open', blocking: true });
        expect(command.writes.length).toBe(1);
        expect(port.writes).toEqual([]);
    });

    it('refuses a paper that does not match the cassette', async () => {
        const { driver, port } = await bound([IDLE]);
        await driver.printInit({ density: 1, copies: 1, paper: d1(24) });
        const error = await driver.printPage(blankPage(300, 224)).catch(e => e);
        expect(error.code).toBe('unsupported');
        expect(error.message).toMatch(/loaded cassette is 12 mm/);
        expect(port.writes).toEqual([]);
    });

    it('reports a 24 mm cassette and an empty bay', async () => {
        const wide = await bound([withBay(8, 1)]);
        expect((await wide.driver.getStatus!()).media?.widthMm).toBe(24);
        const empty = await bound([withBay(2, 0)]);
        const status = await empty.driver.getStatus!();
        expect(status.media).toBeUndefined();
        expect(status.faults).toEqual([expect.objectContaining({ code: 'paper-out', blocking: true })]);
    });

    it('times out cleanly when channel 2 stays silent', async () => {
        const port = new MockBridgedPort(new MockCommand([IDLE], true));
        const driver = new DymoLmV2Driver({ ...fastStatus, statusTimeoutMs: 20 });
        await driver.bindTransport(port);
        const error = await driver.getStatus!().catch(e => e);
        expect(error.code).toBe('timeout');
    });

    it('falls back to print-only when channel 2 will not open', async () => {
        const port = new MockBridgedPort(new Error('refused'));
        const driver = new DymoLmV2Driver(fast);
        await driver.bindTransport(port);
        expect(driver.hasStatus()).toBe(false);
        expect(driver.getStatus).toBeUndefined();
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        await driver.printPage(blankPage(300, 94));
        expect(commands(port.bytes())).toContain('raster 300x96');
    });

    it('drops back to print-only when channel 2 closes, and closes it on unbind', async () => {
        const { driver, command } = await bound([IDLE]);
        command.emit('disconnected');
        expect(driver.hasStatus()).toBe(false);
        expect(driver.reports).toEqual([]);

        const again = await bound([IDLE]);
        await again.driver.unbindTransport();
        expect(again.command.disconnected).toBe(true);
        expect(again.command.listenerCount('data')).toBe(0);
    });
});

describe('DymoLmV2Driver batches', () => {
    const fastStatus: DymoLmV2DriverOptions = { ...fast, statusTimeoutMs: 50, lockRetryMs: 0 };
    const pageOf = (width: number) => blankPage(width, 94);

    it('prints different pages as labels of one job, cut between them', async () => {
        const port = new MockPort();
        const driver = new DymoLmV2Driver(fast);
        await driver.bindTransport(port);
        const progress: string[] = [];
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        await driver.printPages!([pageOf(300), pageOf(400), pageOf(250)], { onPage: (done, total) => progress.push(`${done}/${total}`) });
        await driver.printEnd();
        expect(commands(port.bytes())).toEqual([
            's',
            'n', 'l', 't', 'D', 'raster 300x96',
            'E', 'p0', 'n', 'l', 't', 'D', 'raster 400x96',
            'E', 'p0', 'n', 'l', 't', 'D', 'raster 250x96',
            'E', 'p0', 'Q',
        ]);
        expect(progress).toEqual(['1/3', '2/3', '3/3']);
    });

    it('stops after the current label when aborted, still closing the job', async () => {
        const port = new MockPort();
        const driver = new DymoLmV2Driver(fast);
        await driver.bindTransport(port);
        const stop = new AbortController();
        await driver.printInit({ density: 1, copies: 1, paper: d1(12) });
        await driver.printPages!([pageOf(300), pageOf(300), pageOf(300)], {
            signal: stop.signal,
            onPage: done => { if (done === 1) stop.abort(); },
        });
        expect(commands(port.bytes())).toEqual(['s', 'n', 'l', 't', 'D', 'raster 300x96', 'E', 'p0', 'Q']);
    });

    it('claims the printer once, and stops on a fault reported between labels', async () => {
        const command = new MockCommand([IDLE, IDLE, withBay(1, 3)]);
        const port = new MockBridgedPort(command);
        const driver = new DymoLmV2Driver(fastStatus);
        await driver.bindTransport(port);
        await driver.printInit({ density: 1, copies: 1 });
        const error = await driver.printPages!([pageOf(300), pageOf(300), pageOf(300)]).catch(e => e);
        expect(error.code).toBe('device-fault');
        expect(error.fault).toMatchObject({ code: 'cover-open' });
        // ESC A 1 once to claim, then ESC A 0 between labels.
        expect(command.writes.map(w => w[2])).toEqual([1, 0, 0]);
        expect(commands(port.bytes()).filter(c => c === 'n').length).toBe(2);
        expect(commands(port.bytes()).slice(-3)).toEqual(['E', 'p0', 'Q']);
    });

    it('prints a batch through PrintManager as one job, and copies once each', async () => {
        const manager = new PrintManager();
        const port = new MockPort('DYMO ML 0EB7');
        await manager.connectWithTransport(port);
        const sent = await manager.printBatch([pageOf(300), pageOf(300)], { density: 1, copies: 3, paper: d1(12) });
        expect(sent).toBe(2);
        expect(commands(port.bytes()).filter(c => c === 's' || c === 'n' || c === 'Q')).toEqual(['s', 'n', 'n', 'Q']);
        await manager.disconnect();
    });
});

describe('PrintManager integration', () => {
    it('selects the DYMO driver from the MobileLabeler name and reports no status', async () => {
        const manager = new PrintManager();
        await manager.connectWithTransport(new MockPort('DYMO ML 0EB7'));
        expect(manager.getCapabilities().driverId).toBe('dymo-lm-v2');
        expect(manager.getActiveModelProfile()?.id).toBe('dymo_mobilelabeler');
        expect(manager.getReportedFields()).toEqual([]);
        expect(await manager.getStatus()).toBeNull();
        await manager.disconnect();
    });

    it('selects it by model on a generically named serial port', async () => {
        const manager = new PrintManager();
        await manager.connectWithTransport(new MockPort('Serial Printer'), undefined, 'dymo_mobilelabeler');
        expect(manager.getCapabilities().driverId).toBe('dymo-lm-v2');
        await manager.disconnect();
    });

    it('reads status through PrintManager when the transport opens channel 2', async () => {
        const manager = new PrintManager();
        const command = new MockCommand([IDLE]);
        await manager.connectWithTransport(new MockBridgedPort(command));
        expect(manager.getCapabilities().driverId).toBe('dymo-lm-v2');
        expect(manager.getReportedFields()).toContain('media');
        expect((await manager.getStatus())?.media?.widthMm).toBe(12);
        await manager.disconnect();
        expect(command.disconnected).toBe(true);
    });
});
