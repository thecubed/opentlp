import { describe, expect, it } from 'vitest';
import { RfcommBridgeTransport, type RfcommBridge, type RfcommBridgeDevice } from './rfcomm-bridge-transport';

class FakeBridge implements RfcommBridge {
    devices: RfcommBridgeDevice[] = [
        { address: '00:11:22:33:44:55', name: 'Headphones', connected: true },
        { address: 'F8:5A:00:01:0E:B7', name: 'DYMO ML 0EB7', connected: false },
    ];
    opened: Array<{ handle: number; address: string; channel: number }> = [];
    writes: Array<{ handle: number; data: number[] }> = [];
    closed: number[] = [];
    refuse = new Set<number>();
    private next = 1;
    private dataListeners = new Set<(handle: number, data: Uint8Array) => void>();
    private closedListeners = new Set<(handle: number, by: string) => void>();

    async listDevices() { return this.devices; }
    async open(address: string, channel: number) {
        if (this.refuse.has(channel)) throw new Error(`refused ${channel}`);
        const handle = this.next++;
        this.opened.push({ handle, address, channel });
        return { handle, mtu: 667 };
    }
    async write(handle: number, data: Uint8Array) { this.writes.push({ handle, data: Array.from(data) }); }
    async close(handle: number) { this.closed.push(handle); }
    onData(listener: (handle: number, data: Uint8Array) => void) {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
    }
    onClosed(listener: (handle: number, by: string) => void) {
        this.closedListeners.add(listener);
        return () => this.closedListeners.delete(listener);
    }
    push(handle: number, bytes: number[]) { for (const l of this.dataListeners) l(handle, Uint8Array.from(bytes)); }
    drop(handle: number) { for (const l of this.closedListeners) l(handle, 'remote'); }
    get listenerCount() { return this.dataListeners.size + this.closedListeners.size; }
}

describe('RfcommBridgeTransport', () => {
    it('picks the paired device by the driver name prefixes and opens its channel', async () => {
        const bridge = new FakeBridge();
        const transport = new RfcommBridgeTransport(bridge, { channel: 3 });

        await transport.connect([{ namePrefix: 'DYMO ML' }]);
        await transport.write(Uint8Array.of(0x1b, 0x51));

        expect(bridge.opened).toEqual([{ handle: 1, address: 'F8:5A:00:01:0E:B7', channel: 3 }]);
        expect(bridge.writes).toEqual([{ handle: 1, data: [0x1b, 0x51] }]);
        expect(transport.getDeviceName()).toBe('DYMO ML 0EB7');
        expect(transport.isConnected()).toBe(true);
    });

    it('uses a custom selector and its not-found message', async () => {
        const bridge = new FakeBridge();
        const transport = new RfcommBridgeTransport(bridge, {
            channel: 3,
            selectDevice: devices => devices.find(device => device.name === 'Nothing'),
            notFoundMessage: 'Pair the printer first.',
        });
        await expect(transport.connect()).rejects.toThrow('Pair the printer first.');
        expect(bridge.listenerCount).toBe(0);
    });

    it('emits only its own channel’s data, and opens sibling channels on the same device', async () => {
        const bridge = new FakeBridge();
        const print = new RfcommBridgeTransport(bridge, { channel: 3 });
        await print.connect([{ namePrefix: 'DYMO' }]);
        const command = await print.openRfcommChannel(2);

        const printData: number[][] = [];
        const commandData: number[][] = [];
        print.on('data', data => printData.push(Array.from(data)));
        command.on('data', data => commandData.push(Array.from(data)));
        bridge.push(2, [1, 2]);
        bridge.push(1, [9]);

        expect(bridge.opened[1]).toEqual({ handle: 2, address: 'F8:5A:00:01:0E:B7', channel: 2 });
        expect(command.getDeviceName()).toBe('DYMO ML 0EB7');
        expect(commandData).toEqual([[1, 2]]);
        expect(printData).toEqual([[9]]);
    });

    it('reports a remote close and cleans up its listeners', async () => {
        const bridge = new FakeBridge();
        const transport = new RfcommBridgeTransport(bridge, { channel: 3 });
        await transport.connect([{ namePrefix: 'DYMO' }]);
        let disconnected = 0;
        transport.on('disconnected', () => { disconnected += 1; });

        bridge.drop(1);

        expect(disconnected).toBe(1);
        expect(transport.isConnected()).toBe(false);
        expect(bridge.listenerCount).toBe(0);
        await expect(transport.write(Uint8Array.of(0))).rejects.toThrow('not open');
        await transport.disconnect();
        expect(bridge.closed).toEqual([]);
    });

    it('closes its handle on disconnect, and cleans up when the open is refused', async () => {
        const bridge = new FakeBridge();
        const transport = new RfcommBridgeTransport(bridge, { channel: 3 });
        await transport.connect([{ namePrefix: 'DYMO' }]);
        await transport.disconnect();
        expect(bridge.closed).toEqual([1]);
        expect(bridge.listenerCount).toBe(0);

        bridge.refuse.add(3);
        await expect(transport.connect([{ namePrefix: 'DYMO' }])).rejects.toThrow('refused 3');
        expect(bridge.listenerCount).toBe(0);
        expect(transport.isConnected()).toBe(false);
    });
});
