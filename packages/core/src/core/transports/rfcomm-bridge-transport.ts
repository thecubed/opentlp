import EventEmitter from "eventemitter3";
import type { BluetoothLEScanFilter, IDeviceTransport, TransportEventMap } from "./transport.interface";

/** A paired Bluetooth Classic device, as a native bridge lists it. */
export interface RfcommBridgeDevice {
    /** Upper-case, colon-separated, e.g. `F8:5A:00:01:0E:B7`. */
    address: string;
    name?: string;
    connected?: boolean;
}

/**
 * A native helper that opens RFCOMM channels by number: an Electron main
 * process talking to a platform helper, or an Android plugin. It knows nothing
 * about printers; it moves bytes on numbered channels.
 */
export interface RfcommBridge {
    listDevices(): Promise<RfcommBridgeDevice[]>;
    /** Opens one channel and returns a handle for it. */
    open(address: string, channel: number): Promise<{ handle: number; mtu?: number }>;
    write(handle: number, data: Uint8Array): Promise<void>;
    close(handle: number): Promise<void>;
    /** Returns an unsubscribe function. */
    onData(listener: (handle: number, data: Uint8Array) => void): () => void;
    /** `by` is "remote" when the device or link dropped the channel. */
    onClosed(listener: (handle: number, by: string) => void): () => void;
}

export interface RfcommBridgeTransportOptions {
    /** RFCOMM channel this transport carries. */
    channel: number;
    /** Device to use; otherwise chosen from the bridge's paired list. */
    address?: string;
    /** Name reported to drivers when the address was given without one. */
    deviceName?: string;
    /** Picks among paired devices; defaults to the connect filters' name prefixes. */
    selectDevice?: (devices: RfcommBridgeDevice[]) => RfcommBridgeDevice | undefined;
    /** Shown when no paired device fits. */
    notFoundMessage?: string;
}

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * One RFCOMM channel through a native {@link RfcommBridge}. Other channels on
 * the same device open with {@link openRfcommChannel}.
 */
export class RfcommBridgeTransport extends EventEmitter<TransportEventMap> implements IDeviceTransport {
    readonly type = "BluetoothClassic-RFCOMM";
    readonly filterType = "none" as const;

    private handle?: number;
    private device?: RfcommBridgeDevice;
    private unsubscribe: Array<() => void> = [];

    constructor(private readonly bridge: RfcommBridge, private readonly options: RfcommBridgeTransportOptions) {
        super();
    }

    get channel(): number {
        return this.options.channel;
    }

    async connect(filters: BluetoothLEScanFilter[] = []): Promise<void> {
        if (this.handle !== undefined) return;
        const device = this.options.address
            ? { address: this.options.address, name: this.options.deviceName }
            : this.choose(await this.bridge.listDevices(), filters);

        this.unsubscribe = [
            this.bridge.onData((handle, data) => {
                if (handle === this.handle) this.emit("data", data);
            }),
            this.bridge.onClosed(handle => {
                if (handle !== this.handle) return;
                this.release();
                this.emit("disconnected");
            }),
        ];
        try {
            const { handle } = await this.bridge.open(device.address, this.options.channel);
            this.handle = handle;
        } catch (error) {
            this.release();
            throw error;
        }
        this.device = device;
        this.emit("connected");
    }

    async disconnect(): Promise<void> {
        const handle = this.handle;
        if (handle === undefined) return;
        this.release();
        await this.bridge.close(handle).catch(() => undefined);
        this.emit("disconnected");
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.handle === undefined) throw new Error(`RFCOMM channel ${this.options.channel} is not open.`);
        await this.bridge.write(this.handle, data);
    }

    isConnected(): boolean {
        return this.handle !== undefined;
    }

    getDeviceName(): string | undefined {
        return this.device?.name ?? this.options.deviceName;
    }

    async getPrimaryServices(): Promise<string[]> {
        return [];
    }

    async openRfcommChannel(channel: number): Promise<IDeviceTransport> {
        if (!this.device) throw new Error("Connect before opening another RFCOMM channel.");
        const sibling = new RfcommBridgeTransport(this.bridge, {
            channel,
            address: this.device.address,
            deviceName: this.device.name,
        });
        await sibling.connect();
        return sibling;
    }

    private choose(devices: RfcommBridgeDevice[], filters: BluetoothLEScanFilter[]): RfcommBridgeDevice {
        let chosen: RfcommBridgeDevice | undefined;
        if (this.options.selectDevice) {
            chosen = this.options.selectDevice(devices);
        } else {
            const prefixes = filters.flatMap(filter => (filter.namePrefix ? [compact(filter.namePrefix)] : []));
            const matches = devices.filter(device =>
                prefixes.length === 0 || prefixes.some(prefix => compact(device.name ?? "").startsWith(prefix)));
            chosen = matches.find(device => device.connected) ?? matches[0];
        }
        if (!chosen) throw new Error(this.options.notFoundMessage ?? "No paired Bluetooth device matches.");
        return chosen;
    }

    private release(): void {
        this.handle = undefined;
        for (const off of this.unsubscribe.splice(0)) off();
    }
}
