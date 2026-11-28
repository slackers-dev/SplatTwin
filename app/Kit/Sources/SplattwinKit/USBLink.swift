#if os(macOS)
import Darwin
import Foundation
import Network

// Verbindung zum Handy ueber das USB-Kabel statt ueber das WLAN.
//
// macOS stellt angeschlossene iPhones ueber den Dienst usbmuxd bereit (/var/run/usbmuxd, derselbe Weg
// wie Xcode und der Finder). Ueber ihn laesst sich eine TCP-Verbindung zu einem Anschluss auf dem Handy
// oeffnen, den dort eine App auf 127.0.0.1 anbietet. Das Handy muss diesem Mac vertrauen.
//
// Damit der restliche Code (NWConnection mit TLS) unveraendert bleibt, bietet der Mac pro Handy einen
// Anschluss auf 127.0.0.1 an und reicht die Bytes durch das Kabel weiter. Die Verschluesselung laeuft
// weiterhin Ende zu Ende zwischen Mac-App und Handy-App.

/// Das Protokoll von usbmuxd: 16 Byte Kopf (Laenge, Version 1, Typ 8 = Plist, Tag), danach eine XML-Plist.
enum USBMux {
    static let socketPath = "/var/run/usbmuxd"

    static func openSocket() -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let bytes = Array(socketPath.utf8.prefix(raw.count - 1))
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard ok == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    static func base(_ type: String) -> [String: Any] {
        ["MessageType": type, "ClientVersionString": "splattwin", "ProgName": "Splattwin"]
    }

    static func send(_ fd: Int32, _ message: [String: Any], tag: UInt32 = 1) -> Bool {
        guard let body = try? PropertyListSerialization.data(fromPropertyList: message, format: .xml, options: 0) else { return false }
        var packet = Data()
        for value in [UInt32(16 + body.count), 1, 8, tag] {
            withUnsafeBytes(of: value.littleEndian) { packet.append(contentsOf: $0) }
        }
        packet.append(body)
        return writeAll(fd, packet)
    }

    static func read(_ fd: Int32) -> [String: Any]? {
        guard let head = readExactly(fd, 16) else { return nil }
        let length = head.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        guard length >= 16, length < 1 << 20, let body = readExactly(fd, Int(length) - 16) else { return nil }
        return (try? PropertyListSerialization.propertyList(from: body, format: nil)) as? [String: Any]
    }

    /// Oeffnet eine Verbindung zum Anschluss `port` auf dem Geraet. Danach ist der Socket ein roher Datenkanal.
    static func connect(device: Int, port: UInt16) -> Int32? {
        guard let fd = openSocket() else { return nil }
        var message = base("Connect")
        message["DeviceID"] = device
        message["PortNumber"] = Int(port.bigEndian)
        guard send(fd, message), let reply = read(fd), (reply["Number"] as? Int) == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n < 0, errno == EINTR { continue }
                guard n > 0 else { return false }
                offset += n
            }
            return true
        }
    }

    static func readExactly(_ fd: Int32, _ count: Int) -> Data? {
        var data = Data(count: count)
        let ok = data.withUnsafeMutableBytes { raw -> Bool in
            var offset = 0
            while offset < count {
                let n = Darwin.read(fd, raw.baseAddress! + offset, count - offset)
                if n < 0, errno == EINTR { continue }
                guard n > 0 else { return false }
                offset += n
            }
            return true
        }
        return ok ? data : nil
    }

    /// Liest bis zum Ende der Verbindung (hoechstens `limit` Byte, mit Zeitlimit).
    static func readAll(_ fd: Int32, limit: Int = 4096, timeout: Int = 2) -> Data {
        var tv = timeval(tv_sec: timeout, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while data.count < limit {
            let n = Darwin.read(fd, &buffer, buffer.count)
            if n < 0, errno == EINTR { continue }
            guard n > 0 else { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// Reicht eine Verbindung auf 127.0.0.1 durch einen usbmuxd-Kanal weiter, in beide Richtungen.
final class USBPipe {
    private let connection: NWConnection
    private let fd: Int32
    private let readQueue = DispatchQueue(label: "splattwin.usb.read")
    private let writeQueue = DispatchQueue(label: "splattwin.usb.write")
    private let lock = NSLock()
    private var source: DispatchSourceRead?
    private var closed = false
    var onClose: (() -> Void)?

    init(connection: NWConnection, fd: Int32) {
        self.connection = connection
        self.fd = fd
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.close()
            default: break
            }
        }
        connection.start(queue: writeQueue)
        receive()
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: readQueue)
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let n = Darwin.read(self.fd, &buffer, buffer.count)
            if n > 0 {
                self.connection.send(content: Data(buffer[0 ..< n]), completion: .contentProcessed { _ in })
            } else if n == 0 || errno != EINTR && errno != EAGAIN {
                self.close()
            }
        }
        let fd = fd
        source.setCancelHandler { Darwin.close(fd) }
        self.source = source
        source.resume()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data, !data.isEmpty, !USBMux.writeAll(self.fd, data) { return self.close() }
            if done || error != nil { return self.close() }
            self.receive()
        }
    }

    func close() {
        lock.lock()
        let first = !closed
        closed = true
        lock.unlock()
        guard first else { return }
        source?.cancel()
        connection.cancel()
        onClose?()
    }
}

/// Ein angeschlossenes Handy: Anschluss auf 127.0.0.1, der durch das Kabel zur Handy-App fuehrt.
final class USBTunnel {
    let device: Int
    private let queue = DispatchQueue(label: "splattwin.usb.tunnel")
    private var listener: NWListener?
    private var pipes: [ObjectIdentifier: USBPipe] = [:]

    init(device: Int) {
        self.device = device
    }

    /// Startet den Anschluss und meldet seine Nummer.
    func start(ready: @escaping (UInt16) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { state in
            if case .ready = state, let port = listener.port?.rawValue { ready(port) }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func accept(_ connection: NWConnection) {
        let device = device
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let fd = USBMux.connect(device: device, port: Link.wiredPort) else {
                connection.cancel()
                return
            }
            var on: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            let pipe = USBPipe(connection: connection, fd: fd)
            let id = ObjectIdentifier(pipe)
            self?.queue.async {
                guard let self else { return pipe.close() }
                self.pipes[id] = pipe
                pipe.onClose = { [weak self] in self?.queue.async { self?.pipes[id] = nil } }
                pipe.start()
            }
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            self.pipes.values.forEach { $0.close() }
            self.pipes = [:]
        }
    }
}

/// Beobachtet usbmuxd und meldet Handys am Kabel, auf denen die Splattwin-App laeuft:
/// Name des Geraets (wie im WLAN) und der Anschluss auf 127.0.0.1, der zu ihm fuehrt.
public final class USBWatcher: @unchecked Sendable {
    public struct Device: Equatable, Sendable {
        public let id: Int
        public let name: String
        public let port: UInt16
    }

    /// Aktuelle Liste, auf dem Hauptstrang gemeldet.
    public var onChange: (([Device]) -> Void)?

    private let queue = DispatchQueue(label: "splattwin.usb.watch")
    private var attached: Set<Int> = []
    private var tunnels: [Int: USBTunnel] = [:]
    private var devices: [Int: Device] = [:]
    private var running = false

    public init() {}

    public func start() {
        queue.async {
            guard !self.running else { return }
            self.running = true
            Thread.detachNewThread { [weak self] in self?.listen() }
            self.schedulePoll()
        }
    }

    /// Haelt die Verbindung zu usbmuxd und verfolgt An- und Abstecken.
    private func listen() {
        while true {
            guard let fd = USBMux.openSocket() else {
                Thread.sleep(forTimeInterval: 3)
                continue
            }
            if USBMux.send(fd, USBMux.base("Listen")), let reply = USBMux.read(fd), (reply["Number"] as? Int) == 0 {
                while let message = USBMux.read(fd) {
                    handle(message)
                }
            }
            close(fd)
            queue.sync {
                for id in self.attached { self.detach(id) }
                self.attached = []
            }
            Thread.sleep(forTimeInterval: 2)
        }
    }

    private func handle(_ message: [String: Any]) {
        guard let type = message["MessageType"] as? String, let id = message["DeviceID"] as? Int else { return }
        queue.async {
            switch type {
            case "Attached":
                let properties = message["Properties"] as? [String: Any]
                // Nur Kabel: usbmuxd meldet auch Geraete, die ueber das Netz synchronisieren.
                guard (properties?["ConnectionType"] as? String ?? "USB") == "USB" else { return }
                self.attached.insert(id)
                self.probe(id)
            case "Detached":
                self.attached.remove(id)
                self.detach(id)
            default:
                break
            }
        }
    }

    private func detach(_ id: Int) {
        tunnels.removeValue(forKey: id)?.stop()
        if devices.removeValue(forKey: id) != nil { publish() }
    }

    /// Die App auf dem Handy ist vielleicht noch nicht offen: alle 2 Sekunden nachfragen.
    private func schedulePoll() {
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            for id in self.attached where self.devices[id] == nil { self.probe(id) }
            self.schedulePoll()
        }
    }

    private var probing: Set<Int> = []

    private func probe(_ id: Int) {
        guard devices[id] == nil, !probing.contains(id) else { return }
        probing.insert(id)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var name: String?
            if let fd = USBMux.connect(device: id, port: Link.wiredInfoPort) {
                let data = USBMux.readAll(fd)
                close(fd)
                name = (try? JSONDecoder().decode([String: String].self, from: data))?["name"]
            }
            self?.queue.async {
                guard let self else { return }
                self.probing.remove(id)
                guard let name, self.attached.contains(id), self.devices[id] == nil else { return }
                self.open(id, name: name)
            }
        }
    }

    private func open(_ id: Int, name: String) {
        let tunnel = USBTunnel(device: id)
        tunnels[id] = tunnel
        try? tunnel.start { [weak self] port in
            self?.queue.async {
                guard let self, self.tunnels[id] === tunnel else { return }
                self.devices[id] = Device(id: id, name: name, port: port)
                self.publish()
            }
        }
    }

    private func publish() {
        let list = devices.values.sorted { $0.name < $1.name }
        DispatchQueue.main.async { self.onChange?(list) }
    }
}
#endif
