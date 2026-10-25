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
        expect('getStatus' in driver).toBe(false);
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
});
