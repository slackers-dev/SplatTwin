import CryptoKit
import Foundation
import Network

/// Die Kameraseite: laeuft auf dem Handy (und fuer die eingebaute Kamera auch auf dem Mac).
/// Nimmt Befehle vom Mac entgegen, schickt das Livebild, nimmt auf und gibt die Dateien heraus.
public final class CameraNode {
    /// Was nur die App selbst weiss (Akku, Lagesensor).
    public struct Environment {
        public var battery: Double?
        public var charging: Bool?
        public var moved = false
        public var gravity: [Double]?
        public init() {}
    }

    public let name: String
    public let model: String
    public let system: String
    public let source: FrameSource
    public let directory: URL
    public private(set) var code: String

    /// Neue Anzeige fuer den Bildschirm des Handys (H-13).
    public var onPhase: ((PhaseInfo) -> Void)?
    /// Verbunden oder getrennt, mit dem Namen des Macs.
    public var onLink: ((Bool, String) -> Void)?
    public var onStatus: ((NodeStatus) -> Void)?
    public var onReady: ((UInt16) -> Void)?
    /// Der Mac bestaetigt die Lage der Kamera, z.B. nach einer neuen Kalibrierung (H-18).
    public var onConfirmPosition: (() -> Void)?
    public var environment: (() -> Environment)?

    private let queue = DispatchQueue(label: "splattwin.node")
    private let encodeQueue = DispatchQueue(label: "splattwin.node.encode")
    private let encoder = JPEGEncoder()
    private let lock = NSLock()
    private var listener: NWListener?
    private var control: Peer?
    private var others: [ObjectIdentifier: Peer] = [:]
    private var timer: DispatchSourceTimer?
    private var config = CameraConfig()
    private var recorder: Recorder?
    private var request: RecordRequest?
    private var recordError: String?
    private var encoding = false
    private var streaming = false
    private var seq = 0
    private var lastSent = 0.0

    public init(name: String, model: String, system: String, source: FrameSource, code: String, directory: URL) {
        self.name = name
        self.model = model
        self.system = system
        self.source = source
        self.code = code
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        source.onFrame = { [weak self] in self?.handle($0) }
        source.onChange = { [weak self] in self?.queue.async { self?.sendStatus() } }
    }

    /// Oeffnet den Dienst. `advertise`: im Netz sichtbar machen (Handy). `loopbackOnly`: nur auf diesem Rechner erreichbar.
    public func start(advertise: Bool, loopbackOnly: Bool = false, port: UInt16? = nil) throws {
        let parameters = Link.parameters(code: code)
        if loopbackOnly { parameters.requiredInterfaceType = .loopback }
        parameters.allowLocalEndpointReuse = true
        let listener = try port.flatMap(NWEndpoint.Port.init(rawValue:)).map { try NWListener(using: parameters, on: $0) }
            ?? NWListener(using: parameters)
        if advertise { listener.service = NWListener.Service(name: name, type: Link.serviceType) }
        listener.newConnectionHandler = { [weak self] in self?.accept($0) }
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = listener.port?.rawValue { self?.onReady?(port) }
        }
        listener.start(queue: queue)
        queue.async {
            self.listener = listener
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler { [weak self] in self?.sendStatus() }
            timer.resume()
            self.timer = timer
        }
        source.start()
    }

    public func stop() {
        source.stop()
        queue.async {
            self.timer?.cancel()
            self.timer = nil
            self.listener?.cancel()
            self.listener = nil
            self.control?.cancel()
            self.others.values.forEach { $0.cancel() }
        }
    }

    /// Neuer Kopplungscode: der Dienst startet neu, bestehende Verbindungen enden.
    public func setCode(_ code: String, advertise: Bool) {
        queue.sync {
            self.listener?.cancel()
            self.control?.cancel()
            self.timer?.cancel()
        }
        self.code = code
        try? start(advertise: advertise)
    }

    /// Einstellung direkt am Geraet (z.B. Linse am Handy antippen).
    public func apply(_ config: CameraConfig) {
        queue.async { self.setConfig(config) }
    }

    public var currentConfig: CameraConfig {
        lock.lock()
        defer { lock.unlock() }
        return config
    }

    public func currentStatus() -> NodeStatus {
        var status = NodeStatus()
        source.fill(&status)
        lock.lock()
        status.config = config
        status.recording = request != nil
        status.recordedFrames = recorder?.frameTimes.count ?? 0
        lock.unlock()
        if let environment = environment?() {
            status.battery = environment.battery
            status.charging = environment.charging
            status.moved = environment.moved
            status.gravity = environment.gravity
        }
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: status.thermal = "normal"
        case .fair: status.thermal = "warm"
        case .serious: status.thermal = "heiss"
        default: status.thermal = "kritisch"
        }
        let values = try? directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        status.freeBytes = values?.volumeAvailableCapacityForImportantUsage ?? 0
        return status
    }

    // MARK: Verbindungen

    private func accept(_ connection: NWConnection) {
        let peer = Peer(connection: connection, queue: queue)
        let id = ObjectIdentifier(peer)
        others[id] = peer
        peer.onPacket = { [weak self, weak peer] packet in
            guard let self, let peer, let message = packet.decode(Message.self) else { return }
            self.receive(message, from: peer)
        }
        peer.onClosed = { [weak self, weak peer] _ in
            guard let self else { return }
            self.others[id] = nil
            if let peer, peer === self.control {
                self.control = nil
                self.lock.lock()
                self.streaming = false
                self.lock.unlock()
                self.onLink?(false, "")
            }
        }
        peer.start()
    }

    private func receive(_ message: Message, from peer: Peer) {
        switch message {
        case .hello(let hello):
            guard hello.version == protocolVersion else {
                peer.send(.failure("Die Versionen der Apps auf Handy und Mac passen nicht zusammen"))
                return
            }
            if hello.role == "control" {
                // Es steuert immer nur ein Mac: ein neuer loest den alten ab.
                control?.cancel()
                control = peer
                others[ObjectIdentifier(peer)] = nil
                onLink?(true, hello.name)
                updateStreaming()
            }
            peer.send(.welcome(NodeHello(name: name, model: model, system: system, lenses: source.lenses)))
            sendStatus()
        case .ping(let ping):
            let now = Clock.now
            peer.send(.pong(Pong(t1: ping.t1, t2: now, t3: Clock.now)))
        case .configure(let config):
            setConfig(config)
        case .phase(let info):
            onPhase?(info)
        case .startRecording(let request):
            startRecording(request, peer: peer)
        case .stopRecording:
            stopRecording(peer: peer)
        case .fetch(let request):
            sendFile(request.file, to: peer)
        case .delete(let request):
            if let url = fileURL(request.file) { try? FileManager.default.removeItem(at: url) }
        case .confirmPosition:
            onConfirmPosition?()
            sendStatus()
        default:
            break
        }
    }

    private func setConfig(_ new: CameraConfig) {
        lock.lock()
        config = new
        lock.unlock()
        updateStreaming()
        source.apply(new) // meldet sich ueber onChange, danach geht der neue Zustand an den Mac (T-5)
    }

    private func updateStreaming() {
        lock.lock()
        streaming = control != nil && config.streamEnabled
        lock.unlock()
    }

    private func sendStatus() {
        let status = currentStatus()
        onStatus?(status)
        control?.send(.status(status))
    }

    // MARK: Bilder

    private func handle(_ frame: VideoFrame) {
        lock.lock()
        if let request, frame.time >= request.startAt, recordError == nil {
            if recorder == nil {
                do {
                    recorder = try Recorder(name: request.name, url: directory.appendingPathComponent(request.name + ".mov"),
                                            width: frame.width, height: frame.height, fps: config.fps)
                } catch {
                    recordError = error.localizedDescription
                }
            }
            recorder?.append(frame)
        }
        let interval = 1 / Double(max(1, config.streamFPS))
        let send = streaming && !encoding && frame.time - lastSent >= interval * 0.9
        if send {
            encoding = true
            lastSent = frame.time
        }
        let maxSide = config.streamMaxSide, quality = config.streamQuality
        lock.unlock()
        guard send else { return }
        encodeQueue.async {
            let jpeg = self.encoder.encode(frame.pixelBuffer, maxSide: maxSide, quality: quality)
            self.lock.lock()
            self.encoding = false
            self.lock.unlock()
            guard let jpeg else { return }
            self.queue.async {
                self.seq += 1
                let header = FrameHeader(seq: self.seq, time: frame.time, width: jpeg.width, height: jpeg.height, k: frame.k)
                _ = self.control?.sendFrame(Packet(.frame, header: header, body: jpeg.data))
            }
        }
    }

    // MARK: Aufnahme

    private func startRecording(_ request: RecordRequest, peer: Peer) {
        guard CameraNode.validName(request.name) else { return peer.send(.failure("Ungültiger Name für die Aufnahme")) }
        lock.lock()
        let busy = self.request != nil
        if !busy {
            self.request = request
            recordError = nil
        }
        lock.unlock()
        if busy { peer.send(.failure("Es läuft bereits eine Aufnahme")) }
        sendStatus()
    }

    private func stopRecording(peer: Peer) {
        lock.lock()
        let recorder = self.recorder, request = self.request, error = recordError
        self.recorder = nil
        self.request = nil
        lock.unlock()
        guard let request else { return peer.send(.failure("Es läuft keine Aufnahme")) }
        var info = RecordingInfo(name: request.name, file: request.name + ".mov", sidecar: request.name + ".frames.json",
                                 bytes: 0, width: 0, height: 0, frames: 0, dropped: 0, firstFrame: 0, lastFrame: 0, error: error)
        guard let recorder else {
            info.error = error ?? "Kein Bild aufgenommen"
            peer.send(.recorded(info))
            return sendStatus()
        }
        let status = currentStatus()
        recorder.finish { [weak self] failure in
            guard let self else { return }
            self.queue.async {
                info.error = failure
                info.width = recorder.width
                info.height = recorder.height
                info.frames = recorder.frameTimes.count
                info.dropped = recorder.dropped
                info.firstFrame = recorder.frameTimes.first ?? 0
                info.lastFrame = recorder.frameTimes.last ?? 0
                let size = try? recorder.url.resourceValues(forKeys: [.fileSizeKey]).fileSize
                info.bytes = Int64(size ?? 0)
                let sidecar = RecordingSidecar(
                    name: request.name, device: self.name, model: self.model, system: self.system, status: status,
                    clockOffset: request.clockOffset, frameTimes: recorder.frameTimes,
                    frameIntrinsics: recorder.frameIntrinsics, gravity: status.gravity)
                try? JSONEncoder().encode(sidecar).write(to: self.directory.appendingPathComponent(info.sidecar))
                peer.send(.recorded(info))
                self.sendStatus()
            }
        }
    }

    // MARK: Dateien

    static func validName(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$", options: .regularExpression) != nil && !name.contains("..")
    }

    private func fileURL(_ file: String) -> URL? {
        CameraNode.validName(file) ? directory.appendingPathComponent(file) : nil
    }

    /// Schickt eine Datei in Stuecken; das naechste Stueck erst, wenn das vorige auf der Leitung ist.
    private func sendFile(_ file: String, to peer: Peer) {
        guard let url = fileURL(file), let handle = try? FileHandle(forReadingFrom: url),
              let total = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
            return peer.send(.failure("Datei \(file) nicht gefunden"))
        }
        var hash = SHA256()
        var offset: Int64 = 0
        func next() {
            let data = (try? handle.read(upToCount: 1 << 19)) ?? Data()
            hash.update(data: data)
            let last = offset + Int64(data.count) >= Int64(total)
            let digest = last ? hash.finalize().map { String(format: "%02x", $0) }.joined() : nil
            let header = ChunkHeader(file: file, offset: offset, total: Int64(total), sha256: digest)
            offset += Int64(data.count)
            peer.send(Packet(.chunk, header: header, body: data)) { ok in
                if ok, !last { self.queue.async(execute: next) } else { try? handle.close() }
            }
        }
        next()
    }

    /// Dateien, die noch auf dem Geraet liegen.
    public func storedFiles() -> [(name: String, bytes: Int64)] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return urls.map { ($0.lastPathComponent, Int64((try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)) }
            .sorted { $0.0 < $1.0 }
    }

    public func deleteStoredFiles() {
        for file in storedFiles() { try? FileManager.default.removeItem(at: directory.appendingPathComponent(file.name)) }
    }
}
