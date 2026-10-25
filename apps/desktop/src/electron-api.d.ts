interface BluetoothPickerDevice {
    deviceId: string;
    deviceName: string;
}

interface UsbPickerDevice {
    deviceId: string;
    productName?: string;
    vendorId?: number;
    productId?: number;
}

interface SerialPickerDevice {
    portId: string;
    displayName?: string;
    portName: string;
    vendorId?: string;
    productId?: string;
}

interface RfcommBridgeStatus {
    /** False off macOS, where there is no helper yet. */
    supported: boolean;
    /** False until native/macos/rfcomm-bridge/build.sh has been run (or in a package without it). */
    built: boolean;
    running: boolean;
    reason?: string;
}

interface RfcommDevice {
    address: string;
    name?: string;
    connected?: boolean;
}

/** Native RFCOMM channels through the main process; the helper starts on the first call that needs it. */
interface ElectronRfcommAPI {
    status(): Promise<RfcommBridgeStatus>;
    listDevices(): Promise<RfcommDevice[]>;
    open(address: string, channel: number): Promise<{ handle: number; mtu?: number }>;
    write(handle: number, data: Uint8Array): Promise<void>;
    close(handle: number): Promise<void>;
    onData(callback: (event: { handle: number; data: Uint8Array }) => void): () => void;
    onClosed(callback: (event: { handle: number; by: string }) => void): () => void;
}

interface ElectronAPI {
    onBluetoothDeviceList(callback: (devices: BluetoothPickerDevice[]) => void): () => void;
    chooseBluetoothDevice(deviceId: string): void;
    cancelBluetoothDevice(): void;
    onUsbDeviceList(callback: (devices: UsbPickerDevice[]) => void): () => void;
    chooseUsbDevice(deviceId: string): void;
    cancelUsbDevice(): void;
    onSerialDeviceList(callback: (devices: SerialPickerDevice[]) => void): () => void;
    chooseSerialDevice(portId: string): void;
    cancelSerialDevice(): void;
    rfcomm: ElectronRfcommAPI;
}

interface Window {
    electronAPI: ElectronAPI;
}
