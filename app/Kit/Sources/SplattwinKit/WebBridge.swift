import Foundation
import Network

/// Bruecke zum Browser: stellt die Kameras der App der Tracking-Seite (tracking.html) zur Verfuegung,
/// mit Aufnahmezeit und Kameradaten zu jedem Bild (T-1, T-3, T-7). Nur auf diesem Rechner erreichbar.
///
/// Textnachrichten sind JSON. Ein Bild ist binaer: [Laenge u32 LE][JSON-Kopf][JPEG].
public final class WebBridge: @unchecked Sendable {
    public struct CameraInfo: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var lens: String
        public var width: Int
        public var height: Int
        public var fps: Double
        /// Zeit von der Aufnahme bis zur Ankunft am Mac in Millisekunden.
        public var latencyMs: Double
        /// [fx, fy, cx, cy] bezogen auf Breite und Hoehe.
        public var k: [Double]?
        /// "device", "fov" oder leer.
        public var source: String
        /// "corrected", "uncorrected" oder "unknown".
        public var distortion: String

        public init(id: String, name: String, lens: String, width: Int, height: Int, fps: Double, latencyMs: Double,
                    k: [Double]?, source: String, distortion: String) {
            self.id = id
            self.name = name
            self.lens = lens
            self.width = width
            self.height = height
            self.fps = fps
            self.latencyMs = latencyMs
            self.k = k
            self.source = source
            self.distortion = distortion
        }
    }

    public let port: UInt16
    /// Anzahl verbundener Seiten hat sich geaendert.
    public var onClients: ((Int) -> Void)?

    private let queue = DispatchQueue(label: "splattwin.bridge")
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: Client] = [:]
    private var listing = Data("{\"type\":\"cameras\",\"cameras\":[]}".utf8)

    private final class Client {
        let connection: NWConnection
        /// Kamera -> (kleinster Abstand zwischen zwei Bildern, zuletzt gesendet, noch unterwegs)
        var subscriptions: [String: (interval: Double, last: Double, inFlight: Int)] = [:]
        init(_ connection: NWConnection) { self.connection = connection }
    }

    public init(port: UInt16 = 8932) {
        self.port = port
    }

    /// Nur Seiten, die von diesem Rechner geladen wurden, duerfen die Kamerabilder lesen.
    /// Ohne diese Pruefung koennte jede geoeffnete Webseite ueber den Browser mitsehen.
    public static func allowed(origin: String?) -> Bool {
        guard let origin else { return true } // kein Browser, sondern ein Programm auf diesem Rechner
        guard let url = URLComponents(string: origin), url.scheme == "http" else { return false }
        return ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? "")
    }

    public func start() throws {
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        websocket.setClientRequestHandler(queue) { _, headers in
            let origin = headers.first { $0.name.caseInsensitiveCompare("Origin") == .orderedSame }?.value
            return NWProtocolWebSocket.Response(status: WebBridge.allowed(origin: origin) ? .accept : .reject, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] in self?.accept($0) }
        listener.start(queue: queue)
        queue.async { self.listener = listener }
    }

    public func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            self.clients.values.forEach { $0.connection.cancel() }
            self.clients = [:]
        }
    }

    /// Aktuelle Kameraliste und gemessener Kameraabstand (T-9) an alle Seiten.
    public func publish(cameras: [CameraInfo], baseline: Double?) {
        struct Listing: Encodable {
            let type = "cameras"
            let cameras: [CameraInfo]
            let baseline: Double?
        }
        guard let data = try? JSONEncoder().encode(Listing(cameras: cameras, baseline: baseline)) else { return }
        queue.async {
            guard data != self.listing else { return }
            self.listing = data
            self.clients.values.forEach { self.send(text: data, to: $0) }
        }
    }

    /// Ein Livebild weiterreichen. Darf von jeder Warteschlange aus aufgerufen werden.
    public func push(id: String, header: FrameHeader, jpeg: Data, hubTime: Double) {
        queue.async {
            var message: Data?
            for client in self.clients.values {
                guard var subscription = client.subscriptions[id] else { continue }
                // Langsame Seiten bekommen weniger Bilder, statt dass sich alte stauen.
                guard subscription.inFlight < 2, hubTime - subscription.last >= subscription.interval * 0.9 else { continue }
                if message == nil { message = WebBridge.frameMessage(id: id, header: header, jpeg: jpeg, hubTime: hubTime) }
                subscription.inFlight += 1
                subscription.last = hubTime
                client.subscriptions[id] = subscription
                let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
                let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
                client.connection.send(content: message, contentContext: context, completion: .contentProcessed { [weak client] _ in
                    self.queue.async { client?.subscriptions[id]?.inFlight -= 1 }
                })
            }
        }
    }

    static func frameMessage(id: String, header: FrameHeader, jpeg: Data, hubTime: Double) -> Data {
        var json: [String: Any] = ["id": id, "seq": header.seq, "t": hubTime * 1000, "w": header.width, "h": header.height]
        if let k = header.k { json["k"] = k }
        let head = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        var out = Data(capacity: 4 + head.count + jpeg.count)
        let count = UInt32(head.count)
        out.append(contentsOf: [UInt8(count & 0xff), UInt8(count >> 8 & 0xff), UInt8(count >> 16 & 0xff), UInt8(count >> 24)])
        out.append(head)
        out.append(jpeg)
        return out
    }

    private func accept(_ connection: NWConnection) {
        let client = Client(connection)
        let id = ObjectIdentifier(client)
        // Der Rueckruf haelt die Seite fest, bis die Verbindung endet.
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.clients[id] = client
                self.onClients?(self.clients.count)
                self.send(text: self.listing, to: client)
                self.receive(client)
            case .failed, .cancelled:
                if self.clients.removeValue(forKey: id) != nil { self.onClients?(self.clients.count) }
                connection.stateUpdateHandler = nil
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(_ client: Client) {
        client.connection.receiveMessage { [weak self, weak client] data, context, _, error in
            guard let self, let client else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if error != nil || metadata?.opcode == .close {
                client.connection.cancel()
                return
            }
            if let data, metadata?.opcode == .text,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                self.handle(json, from: client)
            }
            self.receive(client)
        }
    }

    private func handle(_ json: [String: Any], from client: Client) {
        switch json["type"] as? String {
        case "subscribe":
            guard let id = json["id"] as? String else { return }
            let maxFPS = max(1, min(120, json["maxFps"] as? Double ?? 60))
            client.subscriptions[id] = (1 / maxFPS, -Double.infinity, 0)
        case "unsubscribe":
            if let id = json["id"] as? String { client.subscriptions[id] = nil }
        case "ping":
            // Die Seite gleicht ihre Uhr mit der des Macs ab, um Aufnahmezeiten umzurechnen.
            let reply: [String: Any] = ["type": "pong", "c": json["c"] ?? 0, "s": Clock.now * 1000]
            if let data = try? JSONSerialization.data(withJSONObject: reply) { send(text: data, to: client) }
        default:
            break
        }
    }

    private func send(text: Data, to client: Client) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        client.connection.send(content: text, contentContext: context, completion: .idempotent)
    }
}
