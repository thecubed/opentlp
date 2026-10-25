// IOBluetooth implementation of the bridge's backend.
//
// IOBluetooth delivers channel callbacks on the run loop of the thread that
// opened the channel, so everything here runs on the main thread, whose run
// loop runBridge keeps spinning.
import Foundation
import IOBluetooth

final class IOBluetoothLink: NSObject, RfcommLink, IOBluetoothRFCOMMChannelDelegate {
    private let callbacks: LinkCallbacks
    private let onGone: (IOBluetoothLink) -> Void
    fileprivate var channel: IOBluetoothRFCOMMChannel?
    private var finished = false

    init(callbacks: LinkCallbacks, onGone: @escaping (IOBluetoothLink) -> Void) {
        self.callbacks = callbacks
        self.onGone = onGone
    }

    var mtu: Int { Int(channel?.getMTU() ?? 0) }

    func write(_ bytes: [UInt8]) -> String? {
        guard let channel, channel.isOpen() else { return "Channel is not open" }
        let size = max(1, mtu)
        var offset = 0
        while offset < bytes.count {
            var chunk = Array(bytes[offset..<min(offset + size, bytes.count)])
            let result = chunk.withUnsafeMutableBytes { channel.writeSync($0.baseAddress, length: UInt16($0.count)) }
            if result != kIOReturnSuccess { return "Write failed at byte \(offset) (IOReturn \(result))" }
            offset += chunk.count
        }
        return nil
    }

    func close() {
        let open = channel
        finish(local: true)
        _ = open?.close()
    }

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!, data dataPointer: UnsafeMutableRawPointer!, length dataLength: Int) {
        guard !finished, let dataPointer, dataLength > 0 else { return }
        callbacks.data([UInt8](UnsafeRawBufferPointer(start: dataPointer, count: dataLength)))
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        finish(local: false)
    }

    private func finish(local: Bool) {
        if finished { return }
        finished = true
        channel = nil
        callbacks.closed(local)
        onGone(self)
    }
}

final class IOBluetoothBackend: RfcommBackend {
    /// Links per device address, so the baseband link is dropped with the last channel.
    private var live: [String: [ObjectIdentifier: IOBluetoothLink]] = [:]
    private let attempts = 3
    private let retryDelay: TimeInterval = 1.5

    func pairedDevices() -> [PairedDevice] {
        let devices = (IOBluetoothDevice.pairedDevices() ?? []).compactMap { $0 as? IOBluetoothDevice }
        return devices.compactMap { device in
            guard let raw = device.addressString, let address = normaliseAddress(raw) else { return nil }
            return PairedDevice(address: address, name: device.name, connected: device.isConnected())
        }
    }

    func open(address: String, channel: UInt8, callbacks: LinkCallbacks,
              completion: @escaping (Result<RfcommLink, BridgeFailure>) -> Void) {
        guard let device = IOBluetoothDevice(addressString: address.replacingOccurrences(of: ":", with: "-")) else {
            return completion(.failure(BridgeFailure("No device with address \(address)")))
        }
        attempt(1, device: device, address: address, channel: channel, callbacks: callbacks, completion: completion)
    }

    private func attempt(_ number: Int, device: IOBluetoothDevice, address: String, channel: UInt8,
                         callbacks: LinkCallbacks, completion: @escaping (Result<RfcommLink, BridgeFailure>) -> Void) {
        let created = IOBluetoothLink(callbacks: callbacks) { [weak self] link in
            self?.forget(link, address: address, device: device)
        }
        var opened: IOBluetoothRFCOMMChannel?
        let result = device.openRFCOMMChannelSync(&opened, withChannelID: channel, delegate: created)
        if result == kIOReturnSuccess, let opened, opened.isOpen() {
            created.channel = opened
            live[address, default: [:]][ObjectIdentifier(created)] = created
            return completion(.success(created))
        }
        _ = opened?.close()
        guard number < attempts else {
            if live[address] == nil { _ = device.closeConnection() }
            return completion(.failure(BridgeFailure(
                "Could not open RFCOMM \(channel) on \(address) (IOReturn \(result)). " +
                "Wake the printer and disconnect it in the Bluetooth menu if macOS is holding it.")))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) { [weak self] in
            self?.attempt(number + 1, device: device, address: address, channel: channel,
                          callbacks: callbacks, completion: completion)
        }
    }

    private func forget(_ link: IOBluetoothLink, address: String, device: IOBluetoothDevice) {
        live[address]?.removeValue(forKey: ObjectIdentifier(link))
        guard live[address]?.isEmpty ?? true else { return }
        live.removeValue(forKey: address)
        // Drop the baseband link once nothing uses it, after the channel close lands.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard self?.live[address] == nil else { return }
            _ = device.closeConnection()
        }
    }
}
