// rfcomm-bridge: opens Bluetooth Classic RFCOMM channels by number and relays
// bytes over stdin/stdout as JSON lines, one object per line.
//
// Requests (stdin), answered by a response carrying the same id:
//   {"id":1,"op":"hello"}                                   → {"id":1,"ok":true,"protocol":1}
//   {"id":2,"op":"list"}                                    → {"id":2,"ok":true,"devices":[{"address","name","connected"}]}
//   {"id":3,"op":"open","address":"F8:5A:…","channel":3}    → {"id":3,"ok":true,"handle":1,"mtu":667}
//   {"id":4,"op":"write","handle":1,"data":"<base64>"}       → {"id":4,"ok":true}
//   {"id":5,"op":"close","handle":1}                        → {"id":5,"ok":true}
// Failures:                                                   {"id":n,"ok":false,"error":"…"}
//
// Events (stdout), unprompted:
//   {"event":"data","handle":1,"data":"<base64>"}
//   {"event":"closed","handle":1,"by":"remote"|"local"}
//
// The bridge knows nothing about printers. It exits, closing every channel,
// when stdin reaches end of file, so it never outlives the app that spawned it.
import Foundation

let bridgeProtocolVersion = 1

/// One open channel, as the backend sees it.
protocol RfcommLink: AnyObject {
    var mtu: Int { get }
    /// Blocks until written. Returns an error message on failure.
    func write(_ bytes: [UInt8]) -> String?
    func close()
}

struct PairedDevice {
    let address: String
    let name: String?
    let connected: Bool
}

struct LinkCallbacks {
    let data: ([UInt8]) -> Void
    /// `local` is true when the bridge closed the channel itself.
    let closed: (_ local: Bool) -> Void
}

/// The Bluetooth stack. Every call is made on the main thread, and callbacks
/// must arrive on the main thread too.
protocol RfcommBackend {
    func pairedDevices() -> [PairedDevice]
    func open(address: String, channel: UInt8, callbacks: LinkCallbacks,
              completion: @escaping (Result<RfcommLink, BridgeFailure>) -> Void)
}

struct BridgeFailure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

struct Request: Decodable {
    let id: Int
    let op: String
    let address: String?
    let channel: Int?
    let handle: Int?
    let data: String?
}

/// Writes whole lines to stdout. Main thread only.
final class LineWriter {
    private let out = FileHandle.standardOutput

    func send(_ object: [String: Any]) {
        guard var line = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        line.append(0x0a)
        out.write(line)
    }
}

/// Canonical form: upper case, colon separated. Nil when it is not an address.
func normaliseAddress(_ raw: String) -> String? {
    let hexDigits = raw.uppercased().filter { $0.isHexDigit }
    let separators = raw.filter { $0 == ":" || $0 == "-" }
    guard hexDigits.count == 12, separators.count == 0 || separators.count == 5,
          raw.count == 12 + separators.count else { return nil }
    var pairs: [String] = []
    var index = hexDigits.startIndex
    while index < hexDigits.endIndex {
        let next = hexDigits.index(index, offsetBy: 2)
        pairs.append(String(hexDigits[index..<next]))
        index = next
    }
    return pairs.joined(separator: ":")
}

final class Bridge {
    private let backend: RfcommBackend
    private let writer = LineWriter()
    private var links: [Int: RfcommLink] = [:]
    private var nextHandle = 1
    private let decoder = JSONDecoder()

    init(backend: RfcommBackend) { self.backend = backend }

    /// Handle one line from stdin. Main thread.
    func receive(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }
        guard let request = try? decoder.decode(Request.self, from: Data(trimmed.utf8)) else {
            writer.send(["event": "error", "error": "Unreadable request"])
            return
        }
        switch request.op {
        case "hello":
            reply(request, ["protocol": bridgeProtocolVersion])
        case "list":
            let devices = backend.pairedDevices().map { device -> [String: Any] in
                var entry: [String: Any] = ["address": device.address, "connected": device.connected]
                if let name = device.name { entry["name"] = name }
                return entry
            }
            reply(request, ["devices": devices])
        case "open":
            open(request)
        case "write":
            write(request)
        case "close":
            guard let handle = request.handle, let link = links[handle] else { return fail(request, "Unknown handle") }
            link.close()
            reply(request, [:])
        default:
            fail(request, "Unknown op \(request.op)")
        }
    }

    /// Close everything; used at end of input.
    func closeAll() {
        for link in links.values { link.close() }
    }

    var openCount: Int { links.count }

    private func open(_ request: Request) {
        guard let raw = request.address, let address = normaliseAddress(raw) else {
            return fail(request, "open needs a Bluetooth address")
        }
        guard let channel = request.channel, (1...30).contains(channel) else {
            return fail(request, "open needs a channel from 1 to 30")
        }
        let handle = nextHandle
        nextHandle += 1
        let callbacks = LinkCallbacks(
            data: { [weak self] bytes in
                self?.writer.send(["event": "data", "handle": handle, "data": Data(bytes).base64EncodedString()])
            },
            closed: { [weak self] local in
                guard let self, self.links.removeValue(forKey: handle) != nil else { return }
                self.writer.send(["event": "closed", "handle": handle, "by": local ? "local" : "remote"])
            })
        backend.open(address: address, channel: UInt8(channel), callbacks: callbacks) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let link):
                self.links[handle] = link
                self.reply(request, ["handle": handle, "mtu": link.mtu])
            case .failure(let failure):
                self.fail(request, failure.message)
            }
        }
    }

    private func write(_ request: Request) {
        guard let handle = request.handle, let link = links[handle] else { return fail(request, "Unknown handle") }
        guard let encoded = request.data, let data = Data(base64Encoded: encoded) else {
            return fail(request, "write needs base64 data")
        }
        if let error = link.write([UInt8](data)) { return fail(request, error) }
        reply(request, [:])
    }

    private func reply(_ request: Request, _ fields: [String: Any]) {
        var object = fields
        object["id"] = request.id
        object["ok"] = true
        writer.send(object)
    }

    private func fail(_ request: Request, _ message: String) {
        writer.send(["id": request.id, "ok": false, "error": message])
    }
}

/// Read stdin on a background thread and hand each line to the main thread.
/// At end of input, close every channel and exit.
func runBridge(_ bridge: Bridge, settle: TimeInterval = 0.5) -> Never {
    let reader = Thread {
        while let line = readLine(strippingNewline: true) {
            DispatchQueue.main.async { bridge.receive(line) }
        }
        DispatchQueue.main.async {
            bridge.closeAll()
            // Let close callbacks and the baseband disconnect run before exiting.
            DispatchQueue.main.asyncAfter(deadline: .now() + settle) { exit(0) }
        }
    }
    reader.start()
    while true {
        _ = RunLoop.main.run(mode: .default, before: .distantFuture)
    }
}
