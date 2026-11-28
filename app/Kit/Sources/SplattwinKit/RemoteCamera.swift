import Combine
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import Network

public struct StreamStats: Equatable, Sendable {
    public var fps = 0.0
    /// Bilder, die unterwegs verloren gingen oder vom Geraet verworfen wurden.
    public var lost = 0
    /// Zeit von der Aufnahme bis zur Ankunft am Mac in Sekunden (T-8).
    public var latency = 0.0
    /// Mittlere Helligkeit 0…1; nahe 0 heisst: Linse verdeckt oder kein Licht (M-16).
    public var brightness = 0.0
    public var width = 0
    public var height = 0
    public var megabits = 0.0

    public init() {}
}

/// Verteilt die Livebilder an alle, die sie brauchen (Browser-Bruecke, Koerpererkennung),
/// ohne Umweg ueber die Bedienoberflaeche.
public final class FrameTap: @unchecked Sendable {
    public typealias Handler = (_ header: FrameHeader, _ jpeg: Data, _ hubTime: Double) -> Void
    private let lock = NSLock()
    private var handlers: [UUID: Handler] = [:]

    public init() {}

    @discardableResult
    public func add(_ handler: @escaping Handler) -> UUID {
        let id = UUID()
        lock.lock()
        handlers[id] = handler
        lock.unlock()
        return id
    }

    public func remove(_ id: UUID) {
        lock.lock()
        handlers[id] = nil
        lock.unlock()
    }

    func emit(_ header: FrameHeader, _ jpeg: Data, _ hubTime: Double) {
        lock.lock()
        let list = Array(handlers.values)
        lock.unlock()
        list.forEach { $0(header, jpeg, hubTime) }
    }
}

/// Eine Kamera aus Sicht des Macs: Verbindung, Zustand, Livebild, Fernsteuerung, Dateien.
@MainActor
public final class RemoteCamera: ObservableObject, Identifiable {
    public enum LinkState: Equatable {
        case idle, connecting, connected
        case failed(String)
    }

    public nonisolated let id: String
    /// Weg zum Geraet: Bonjour im WLAN, per USB-Kabel ein Anschluss auf 127.0.0.1.
    @Published public private(set) var endpoint: NWEndpoint
    /// Verbunden ueber das USB-Kabel statt ueber das WLAN.
    @Published public private(set) var wired = false
    public nonisolated let frames = FrameTap()
    @Published public var name: String
    @Published public var code: String
    @Published public private(set) var state = LinkState.idle
    @Published public private(set) var hello: NodeHello?
    @Published public private(set) var status: NodeStatus?
    /// Gewuenschte Einstellungen. Nach einer Aenderung `apply()` aufrufen.
    @Published public var config = CameraConfig()
    @Published public private(set) var image: CGImage?
    @Published public private(set) var stats = StreamStats()
    /// Fortschritt der laufenden Dateiuebertragung, 0…1.
    @Published public private(set) var transfer: Double?
    /// Abstand Geraeteuhr minus Mac-Uhr und Laufzeit der besten Messung.
    @Published public private(set) var clockOffset: Double?
    @Published public private(set) var roundTrip: Double?
    @Published public private(set) var lastError: String?

    private let net = DispatchQueue(label: "splattwin.remote")
    private var peer: Peer?
    private var wanted = false
    private var hasConfig = false
    private var generation = 0
    private var pingTimer: Timer?
    private var pings = 0
    private var clock = ClockSync()
    private var recorded: CheckedContinuation<RecordingInfo, Error>?
    private let counters = Counters()

    public init(id: String, name: String, endpoint: NWEndpoint, code: String, wired: Bool = false) {
        self.id = id
        self.name = name
        self.endpoint = endpoint
        self.wired = wired
        self.code = code
    }

    public var isConnected: Bool { state == .connected }

    nonisolated static var hostName: String {
        #if os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }

    /// Rechnet eine Zeit von der Uhr des Geraets auf die Uhr des Macs um.
    public func hubTime(_ nodeTime: Double) -> Double { nodeTime - (clockOffset ?? 0) }

    // MARK: Verbindung

    public func connect() {
        wanted = true
        open()
    }

    /// Neuer Weg zum Geraet (Kabel angesteckt oder abgezogen): bestehende Verbindung neu aufbauen.
    public func reroute(to endpoint: NWEndpoint, wired: Bool) {
        guard endpoint != self.endpoint else { return }
        self.endpoint = endpoint
        self.wired = wired
        if wanted { open() }
    }

    public func disconnect() {
        wanted = false
        generation += 1
        peer?.cancel()
        peer = nil
        pingTimer?.invalidate()
        state = .idle
        image = nil
    }

    private func open() {
        generation += 1
        let generation = generation
        peer?.cancel()
        state = .connecting
        let peer = Peer(connection: NWConnection(to: endpoint, using: Link.parameters(code: code)), queue: net)
        let counters = counters, frames = frames
        peer.onReady = { [weak peer] in
            peer?.send(.hello(HubHello(name: RemoteCamera.hostName, role: "control")))
        }
        peer.onPacket = { [weak self, weak peer] packet in
            switch packet.kind {
            case .frame:
                guard let header = packet.decode(FrameHeader.self) else { return }
                // Sofort quittieren: das Geraet schickt erst danach das naechste Bild.
                peer?.send(.frameAck(FrameAck(seq: header.seq)))
                let now = Clock.now
                let offset = counters.note(header, bytes: packet.body.count, now: now)
                frames.emit(header, packet.body, header.time - offset)
                // Fuer die Anzeige reicht das jeweils neueste Bild: nicht stauen, wenn die Oberflaeche beschaeftigt ist.
                guard counters.beginDisplay() else { return }
                let image = RemoteCamera.decode(packet.body)
                let brightness = header.seq % 15 == 0 ? image.map(RemoteCamera.brightness) : nil
                Task { @MainActor in
                    counters.endDisplay()
                    guard let self, generation == self.generation else { return }
                    self.image = image
                    if let brightness { self.stats.brightness = brightness }
                }
            case .message:
                guard let message = packet.decode(Message.self) else { return }
                let arrived = Clock.now
                Task { @MainActor in
                    guard let self, generation == self.generation else { return }
                    self.receive(message, arrived: arrived)
                }
            case .chunk:
                break
            }
        }
        peer.onClosed = { [weak self] reason in
            Task { @MainActor in
                guard let self, generation == self.generation else { return }
                self.closed(reason)
            }
        }
        self.peer = peer
        peer.start()
        // Meldet sich das Geraet nicht, gilt der Versuch als gescheitert.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, generation == self.generation, self.state == .connecting else { return }
            self.peer?.cancel()
            self.closed("Gerät antwortet nicht")
        }
    }

    private func closed(_ reason: String?) {
        peer = nil
        pingTimer?.invalidate()
        recorded?.resume(throwing: NodeError("Verbindung während der Aufnahme verloren"))
        recorded = nil
        state = .failed(reason ?? "Verbindung beendet")
        // Von selbst wieder aufbauen (M-17), ausser der Code ist falsch: dann hilft kein Wiederholen.
        guard wanted, reason != "Kopplungscode stimmt nicht" else { return }
        let generation = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.wanted, generation == self.generation else { return }
            self.open()
        }
    }

    private func receive(_ message: Message, arrived: Double) {
        switch message {
        case .welcome(let hello):
            self.hello = hello
            state = .connected
            lastError = nil
            if !hasConfig {
                // Erste Verbindung: mit der bestmoeglichen Einstellung dieses Geraets beginnen.
                config = RemoteCamera.defaultConfig(for: hello)
                hasConfig = true
            }
            apply() // nach einem Abbruch gelten die alten Einstellungen weiter (M-17)
            clock = ClockSync()
            pings = 0
            schedulePing(0.2)
        case .pong(let pong):
            clock.add(t1: pong.t1, t2: pong.t2, t3: pong.t3, t4: arrived)
            clockOffset = clock.offset
            roundTrip = clock.roundTrip
            counters.setOffset(clock.offset ?? 0)
        case .status(let status):
            self.status = status
            var stats = counters.snapshot(now: Clock.now)
            stats.brightness = self.stats.brightness
            self.stats = stats
        case .recorded(let info):
            recorded?.resume(returning: info)
            recorded = nil
        case .failure(let text):
            lastError = text
        default:
            break
        }
    }

    private func schedulePing(_ interval: TimeInterval) {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.peer?.send(.ping(Ping(t1: Clock.now)))
                self.pings += 1
                // Am Anfang dicht messen, danach genuegt ein Abgleich alle zwei Sekunden.
                if self.pings == 10 { self.schedulePing(2) }
            }
        }
    }

    static func defaultConfig(for hello: NodeHello) -> CameraConfig {
        var config = CameraConfig()
        let lens = hello.lenses.first { $0.lens == .wide } ?? hello.lenses.first
        guard let lens else { return config }
        config.lens = lens.lens
        if lens.lens == .external {
            // Mac-Kamera: Querformat in der groessten Aufloesung.
            config.deviceID = lens.id
            config.rotation = 0
        }
        let format = lens.formats.first { $0.width == 3840 && $0.height == 2160 && $0.maxFPS >= 30 }
            ?? lens.formats.first { $0.maxFPS >= 30 } ?? lens.formats.first
        if let format {
            config.width = format.width
            config.height = format.height
            config.fps = min(30, format.maxFPS)
        }
        return config
    }

    // MARK: Fernsteuerung

    public func apply() {
        hasConfig = true
        peer?.send(.configure(config))
    }

    public func send(_ phase: PhaseInfo) {
        peer?.send(.phase(phase))
    }

    public func confirmPosition() {
        peer?.send(.confirmPosition)
    }

    /// Aufnahme ab einem Zeitpunkt auf der Mac-Uhr; alle Kameras bekommen denselben (M-3).
    public func startRecording(name: String, at hubTime: Double) {
        let offset = clockOffset ?? 0
        peer?.send(.startRecording(RecordRequest(name: name, startAt: hubTime + offset, clockOffset: offset)))
    }

    public func stopRecording() async throws -> RecordingInfo {
        guard let peer else { throw NodeError("\(name) ist nicht verbunden") }
        return try await withCheckedThrowingContinuation { continuation in
            recorded = continuation
            peer.send(.stopRecording)
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
                guard let self, self.recorded != nil else { return }
                self.recorded?.resume(throwing: NodeError("\(self.name) hat die Aufnahme nicht abgeschlossen"))
                self.recorded = nil
            }
        }
    }

    /// Holt eine Datei ueber eine eigene Verbindung ab, damit das Livebild nicht stockt (H-8).
    public func fetch(_ file: String, to url: URL) async throws {
        transfer = 0
        defer { transfer = nil }
        let endpoint = endpoint, parameters = Link.parameters(code: code)
        let queue = DispatchQueue(label: "splattwin.fetch")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let peer = Peer(connection: NWConnection(to: endpoint, using: parameters), queue: queue)
            var hash = SHA256()
            var done = false
            var shown = 0.0
            func finish(_ error: Error?) {
                guard !done else { return }
                done = true
                peer.onClosed = nil
                peer.cancel()
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
            peer.onReady = {
                peer.send(.hello(HubHello(name: "Mac", role: "files")))
                peer.send(.fetch(FetchRequest(file: file)))
            }
            peer.onPacket = { [weak self] packet in
                if packet.kind == .message, case .failure(let text)? = packet.decode(Message.self) {
                    return finish(NodeError(text))
                }
                guard packet.kind == .chunk, let header = packet.decode(ChunkHeader.self) else { return }
                do { try handle.write(contentsOf: packet.body) } catch { return finish(error) }
                hash.update(data: packet.body)
                let progress = header.total > 0 ? Double(header.offset + Int64(packet.body.count)) / Double(header.total) : 1
                if progress - shown > 0.01 {
                    shown = progress
                    Task { @MainActor in self?.transfer = progress }
                }
                if let expected = header.sha256 {
                    let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
                    finish(digest == expected ? nil : NodeError("Datei \(file) kam beschädigt an"))
                }
            }
            peer.onClosed = { reason in finish(NodeError(reason ?? "Verbindung beim Übertragen verloren")) }
            peer.start()
        }
    }

    public func deleteRemote(_ file: String) {
        peer?.send(.delete(FetchRequest(file: file)))
    }

    // MARK: Bild

    nonisolated static func decode(_ jpeg: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    nonisolated static func brightness(_ image: CGImage) -> Double {
        let side = 16
        var pixels = [UInt8](repeating: 0, count: side * side)
        guard let context = CGContext(data: &pixels, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return 0 }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return Double(pixels.reduce(0) { $0 + Int($1) }) / Double(side * side) / 255
    }
}

/// Zaehlt Bilder auf der Netzwerk-Warteschlange, ohne die Oberflaeche zu belasten.
private final class Counters: @unchecked Sendable {
    private let lock = NSLock()
    private var offset = 0.0
    private var lastSeq = 0
    private var lost = 0
    private var frames = 0
    private var bytes = 0
    private var since = Clock.now
    private var latency = 0.0
    private var size = (0, 0)
    private var displaying = false
    private var last = StreamStats()

    func setOffset(_ value: Double) {
        lock.lock()
        offset = value
        lock.unlock()
    }

    /// Liefert den aktuellen Uhrenabstand zurueck, damit der Aufrufer die Zeit umrechnen kann.
    func note(_ header: FrameHeader, bytes count: Int, now: Double) -> Double {
        lock.lock()
        defer { lock.unlock() }
        if lastSeq > 0, header.seq > lastSeq + 1 { lost += header.seq - lastSeq - 1 }
        lastSeq = header.seq
        frames += 1
        bytes += count
        size = (header.width, header.height)
        let delay = now - (header.time - offset)
        latency = latency == 0 ? delay : latency + (delay - latency) * 0.1
        return offset
    }

    func beginDisplay() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if displaying { return false }
        displaying = true
        return true
    }

    func endDisplay() {
        lock.lock()
        displaying = false
        lock.unlock()
    }

    func snapshot(now: Double) -> StreamStats {
        lock.lock()
        defer { lock.unlock() }
        let span = now - since
        if span >= 0.9 {
            last.fps = Double(frames) / span
            last.megabits = Double(bytes) * 8 / span / 1_000_000
            frames = 0
            bytes = 0
            since = now
        }
        last.lost = lost
        last.latency = latency
        last.width = size.0
        last.height = size.1
        return last
    }
}

/// Findet Handys im Netz und verwaltet alle verbundenen Kameras (M-1, M-2).
@MainActor
public final class Hub: ObservableObject {
    public struct Found: Identifiable, Equatable {
        public var id: String { name }
        public let name: String
        public let endpoint: NWEndpoint
        /// am USB-Kabel
        public var wired = false
    }

    @Published public private(set) var found: [Found] = []
    @Published public private(set) var cameras: [RemoteCamera] = []
    @Published public private(set) var browsing = false
    private var browser: NWBrowser?
    private var watchers: [String: AnyCancellable] = [:]
    private let defaults: UserDefaults
    private var network: [Found] = []
    private var cabled: [Found] = []
    #if os(macOS)
    private let usb = USBWatcher()
    #endif

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Kopplungscodes bekannter Geraete, damit sie beim naechsten Start von selbst verbinden.
    private var codes: [String: String] {
        get { defaults.dictionary(forKey: "codes") as? [String: String] ?? [:] }
        set { defaults.set(newValue, forKey: "codes") }
    }

    public func startBrowsing() {
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: Link.serviceType, domain: nil), using: parameters)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found = results.compactMap { result -> Found? in
                guard case .service(let name, _, _, _) = result.endpoint else { return nil }
                return Found(name: name, endpoint: result.endpoint)
            }
            Task { @MainActor in
                self?.network = found
                self?.merge()
            }
        }
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in if case .ready = state { self?.browsing = true } }
        }
        browser.start(queue: .main)
        self.browser = browser
        #if os(macOS)
        // Handys am USB-Kabel: schneller und ohne WLAN, sonst gleich wie im Netz.
        usb.onChange = { [weak self] devices in
            MainActor.assumeIsolated {
                self?.cabled = devices.map {
                    Found(name: $0.name, endpoint: .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: $0.port)!), wired: true)
                }
                self?.merge()
            }
        }
        usb.start()
        #endif
    }

    /// Kabel vor WLAN: ist ein Handy auf beiden Wegen da, gilt das Kabel.
    private func merge() {
        var byName: [String: Found] = [:]
        for item in network { byName[item.name] = item }
        for item in cabled { byName[item.name] = item }
        update(byName.values.sorted { $0.name < $1.name })
    }

    private func update(_ list: [Found]) {
        found = list
        for item in list {
            if let camera = camera(item.name) {
                camera.reroute(to: item.endpoint, wired: item.wired)
            } else if let code = codes[item.name] {
                // Bekannte Geraete sofort wieder verbinden.
                pair(item, code: code)
            }
        }
    }

    public func camera(_ id: String) -> RemoteCamera? { cameras.first { $0.id == id } }

    @discardableResult
    public func pair(_ item: Found, code: String) -> RemoteCamera {
        if let existing = camera(item.name) {
            existing.code = code
            existing.connect()
            return existing
        }
        let camera = RemoteCamera(id: item.name, name: item.name, endpoint: item.endpoint, code: code, wired: item.wired)
        add(camera)
        // Der Code wird erst gemerkt, wenn die Verbindung damit wirklich zustande kam.
        watchers[camera.id] = camera.$state.sink { [weak self, weak camera] state in
            guard let self, let camera, state == .connected else { return }
            self.codes[camera.id] = camera.code
        }
        return camera
    }

    /// Kamera auf diesem Rechner (eingebaute Kamera, Testbild, Videodatei).
    @discardableResult
    public func addLocal(id: String, name: String, port: UInt16, code: String) -> RemoteCamera {
        let endpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        let camera = RemoteCamera(id: id, name: name, endpoint: endpoint, code: code)
        add(camera)
        return camera
    }

    private func add(_ camera: RemoteCamera) {
        cameras.append(camera)
        camera.connect()
    }

    public func remove(_ camera: RemoteCamera, forget: Bool = true) {
        camera.disconnect()
        cameras.removeAll { $0.id == camera.id }
        watchers[camera.id] = nil
        if forget { codes[camera.id] = nil }
    }
}
