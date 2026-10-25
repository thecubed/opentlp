import { describe, expect, it } from 'vitest';
import EventEmitter from 'eventemitter3';
import type { IDeviceTransport, TransportEventMap } from './transports/transport.interface';
import type { IPrinterDriver, PrinterCapabilities, UniversalPrintOptions } from '../drivers/driver.interface';
import { monoPage, type UniversalPage } from '../types/ink';
import { PrintManager } from './print-manager';

class Port extends EventEmitter<TransportEventMap> implements IDeviceTransport {
    readonly type = 'Mock';
    getDeviceName() { return 'Batch Test Printer'; }
    isConnected() { return true; }
    async connect() { /* connected */ }
    async disconnect() { /* nothing */ }
    async write() { /* unused */ }
}

/** Records the lifecycle calls a driver receives. */
class RecordingDriver implements IPrinterDriver {
    readonly id = 'batch-test';
    readonly name = 'Batch test';
    readonly driverType = 'hardware' as const;
    readonly supportedTransports = ['bluetooth-le'] as const;
    readonly connectionRequirements = { services: [] as string[], namePrefixes: ['Batch Test'] };
    calls: string[] = [];
    isCompatible(name: string) { return name.startsWith('Batch Test'); }
    async bindTransport() { /* nothing */ }
    async unbindTransport() { /* nothing */ }
    getCapabilities(): PrinterCapabilities {
        return { canvasHeightPx: 8, dpmm: 8, maxDensity: 1, supportsSpeedMode: false, colorSupport: { type: 'monochrome', channels: 1 } };
    }
    async printInit(options: UniversalPrintOptions) { this.calls.push(`init copies=${options.copies}`); }
    async printPage(page: UniversalPage) { this.calls.push(`page ${page.width}`); }
    async printEnd() { this.calls.push('end'); }
}

const page = (width: number) => monoPage({ width, height: 8, data: new Uint8Array(width * 8 * 4).fill(255) });

async function managerWith(driver: IPrinterDriver) {
    const manager = new PrintManager();
    manager.registerDriver(driver);
    await manager.connectWithTransport(new Port(), driver.id);
    return manager;
}

describe('PrintManager.printBatch', () => {
    it('prints one job per page for drivers without printPages, with copies cleared', async () => {
        const driver = new RecordingDriver();
        const manager = await managerWith(driver);
        const progress: number[] = [];
        const sent = await manager.printBatch([page(10), page(20)], { density: 1, copies: 4 }, { onPage: done => progress.push(done) });
        expect(sent).toBe(2);
        expect(progress).toEqual([1, 2]);
        expect(driver.calls).toEqual(['init copies=1', 'page 10', 'end', 'init copies=1', 'page 20', 'end']);
    });

    it('stops between jobs when aborted', async () => {
        const driver = new RecordingDriver();
        const manager = await managerWith(driver);
        const stop = new AbortController();
        const sent = await manager.printBatch([page(10), page(20), page(30)], { density: 1, copies: 1 }, {
            signal: stop.signal, onPage: () => stop.abort(),
        });
        expect(sent).toBe(1);
        expect(driver.calls).toEqual(['init copies=1', 'page 10', 'end']);
    });

    it('hands the whole batch to printPages in one job when the driver has it', async () => {
        const driver = new RecordingDriver() as RecordingDriver & { printPages(pages: readonly UniversalPage[], hooks?: { onPage?(d: number, t: number): void }): Promise<void> };
        driver.printPages = async (pages, hooks) => {
            driver.calls.push(`pages ${pages.map(p => p.width).join(',')}`);
            pages.forEach((_, i) => hooks?.onPage?.(i + 1, pages.length));
        };
        const manager = await managerWith(driver);
        expect(await manager.printBatch([page(10), page(20)], { density: 1, copies: 2 })).toBe(2);
        expect(driver.calls).toEqual(['init copies=1', 'pages 10,20', 'end']);
    });
});
