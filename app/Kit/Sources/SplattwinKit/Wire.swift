import CoreMedia
import CryptoKit
import Foundation
import Network

/// Ein Paket auf der Leitung: [Art u8][Kopflaenge u32][Datenlaenge u32][Kopf als JSON][Daten].
/// Nachrichten haben nur einen Kopf, Bilder und Dateistuecke zusaetzlich Daten.
public struct Packet: Equatable {
    public enum Kind: UInt8 { case message = 1, frame = 2, chunk = 3 }

    public var kind: Kind
    public var header: Data
    public var body: Data

    public static let prefixLength = 9
    public static let maxHeader = 1 << 20
    public static let maxBody = 64 << 20

    public init(kind: Kind, header: Data, body: Data = Data()) {
        self.kind = kind
        self.header = header
        self.body = body
    }

    public init(_ message: Message) {
        self.init(kind: .message, header: (try? JSONEncoder().encode(message)) ?? Data())
    }

    public init<H: Encodable>(_ kind: Kind, header: H, body: Data) {
        self.init(kind: kind, header: (try? JSONEncoder().encode(header)) ?? Data(), body: body)
    }

    public func decode<T: Decodable>(_ type: T.Type) -> T? {
        try? JSONDecoder().decode(type, from: header)
    }

    public var encoded: Data {
        var out = Data(capacity: Packet.prefixLength + header.count + body.count)
        out.append(kind.rawValue)
        out.append(contentsOf: Packet.bigEndian(UInt32(header.count)))
        out.append(contentsOf: Packet.bigEndian(UInt32(body.count)))
        out.append(header)
        out.append(body)
        return out
    }

    /// Liest Art und Laengen aus den ersten neun Bytes. nil bei unsinnigen Werten.
    public static func parsePrefix(_ data: Data) -> (kind: Kind, header: Int, body: Int)? {
        guard data.count == prefixLength, let kind = Kind(rawValue: data[data.startIndex]) else { return nil }
        let bytes = [UInt8](data)
        let header = Int(UInt32(bytes[1]) << 24 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 8 | UInt32(bytes[4]))
        let body = Int(UInt32(bytes[5]) << 24 | UInt32(bytes[6]) << 16 | UInt32(bytes[7]) << 8 | UInt32(bytes[8]))
        guard header <= maxHeader, body <= maxBody else { return nil }
        return (kind, header, body)
    }

    private static func bigEndian(_ value: UInt32) -> [UInt8] {
        [UInt8(value >> 24), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)]
    }
}

/// Gemeinsame Uhr: die Systemuhr, auf der auch die Kamera ihre Bilder stempelt.
public enum Clock {
    public static var now: Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }
}

public enum Link {
    public static let serviceType = "_splattwin._tcp"

    /// Verschluesselte Verbindung, deren Schluessel aus dem Kopplungscode entsteht: ohne den
    /// Code kommt keine Verbindung zustande, und niemand im selben Netz kann mitsehen (D-3).
    public static func parameters(code: String) -> NWParameters {
        let tls = NWProtocolTLS.Options()
        let key = SymmetricKey(data: Data(code.utf8))
        let secret = HMAC<SHA256>.authenticationCode(for: Data("Splattwin".utf8), using: key)
        let secretData = secret.withUnsafeBytes { DispatchData(bytes: $0) }
        let identity = Data("Splattwin".utf8).withUnsafeBytes { DispatchData(bytes: $0) }
        sec_protocol_options_add_pre_shared_key(tls.securityProtocolOptions,
                                                secretData as __DispatchData, identity as __DispatchData)
        sec_protocol_options_append_tls_ciphersuite(
            tls.securityProtocolOptions, tls_ciphersuite_t(rawValue: UInt16(TLS_PSK_WITH_AES_128_GCM_SHA256))!)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 2
        tcp.keepaliveInterval = 2
        tcp.keepaliveCount = 3
        let parameters = NWParameters(tls: tls, tcp: tcp)
        parameters.includePeerToPeer = true
        return parameters
    }

    public static func randomCode() -> String {
        String(format: "%06d", Int.random(in: 0 ..< 1_000_000))
    }
}

/// Eine Verbindung, die Pakete sendet und empfaengt. Alle Rueckrufe laufen auf `queue`.
public final class Peer {
    public let connection: NWConnection
    public let queue: DispatchQueue
    public var onPacket: ((Packet) -> Void)?
    public var onReady: (() -> Void)?
    public var onClosed: ((String?) -> Void)?
    /// Bilder, die noch nicht auf der Leitung sind. Ist die Leitung zu langsam, werden neue
    /// Bilder verworfen statt gestaut, damit die Verzoegerung nicht waechst (T-1).
    public private(set) var framesInFlight = 0
    private var closed = false

    public init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    public func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onReady?()
                self.receive()
            case .failed(let error): self.close(Peer.describe(error))
            case .waiting(let error): self.close(Peer.describe(error))
            case .cancelled: self.close(nil)
            default: break
            }
        }
        connection.start(queue: queue)
    }

    public func send(_ message: Message, completion: ((Bool) -> Void)? = nil) {
        send(Packet(message), completion: completion)
    }

    public func send(_ packet: Packet, completion: ((Bool) -> Void)? = nil) {
        connection.send(content: packet.encoded, completion: .contentProcessed { error in
            completion?(error == nil)
        })
    }

    /// Sendet ein Livebild nur, wenn die vorherigen schon unterwegs sind. Rueckgabe false = verworfen.
    public func sendFrame(_ packet: Packet) -> Bool {
        guard framesInFlight < 2 else { return false }
        framesInFlight += 1
        connection.send(content: packet.encoded, completion: .contentProcessed { [weak self] _ in
            self?.queue.async { self?.framesInFlight -= 1 }
        })
        return true
    }

    public func cancel() {
        connection.cancel()
    }

    private func close(_ reason: String?) {
        guard !closed else { return }
        closed = true
        connection.cancel()
        onClosed?(reason)
    }

    private func receive() {
        read(Packet.prefixLength) { [weak self] prefix in
            guard let self else { return }
            guard let (kind, headerLength, bodyLength) = Packet.parsePrefix(prefix) else {
                return self.close("Unlesbare Daten empfangen")
            }
            self.read(headerLength) { header in
                self.read(bodyLength) { body in
                    self.onPacket?(Packet(kind: kind, header: header, body: body))
                    self.receive()
                }
            }
        }
    }

    private func read(_ count: Int, then: @escaping (Data) -> Void) {
        guard count > 0 else { return then(Data()) }
        connection.receive(minimumIncompleteLength: count, maximumLength: count) { [weak self] data, _, isComplete, error in
            if let data, data.count == count { return then(data) }
            self?.close(error.map(Peer.describe) ?? (isComplete ? "Verbindung beendet" : "Verbindung unterbrochen"))
        }
    }

    static func describe(_ error: NWError) -> String {
        if case .tls = error { return "Kopplungscode stimmt nicht" }
        if case .posix(let code) = error {
            switch code {
            case .ECONNREFUSED: return "Gerät nimmt keine Verbindung an"
            case .ETIMEDOUT: return "Zeitüberschreitung"
            case .ECONNRESET, .ENOTCONN, .EPIPE: return "Verbindung abgebrochen"
            default: break
            }
        }
        return error.localizedDescription
    }
}

/// Uhrenabgleich wie bei NTP (M-3): der Mac fragt, das Geraet antwortet mit seiner Uhrzeit.
/// Von den letzten Messungen gilt die mit der kuerzesten Laufzeit, dort ist der Fehler am kleinsten.
public struct ClockSync: Sendable {
    private var samples: [(rtt: Double, offset: Double)] = []
    public var window = 20

    public init() {}

    /// t1: Mac sendet, t2: Geraet empfaengt, t3: Geraet antwortet, t4: Mac empfaengt.
    public mutating func add(t1: Double, t2: Double, t3: Double, t4: Double) {
        let rtt = (t4 - t1) - (t3 - t2)
        guard rtt >= 0 else { return }
        samples.append((rtt, ((t2 - t1) + (t3 - t4)) / 2))
        if samples.count > window { samples.removeFirst() }
    }

    private var best: (rtt: Double, offset: Double)? { samples.min { $0.rtt < $1.rtt } }

    /// Geraeteuhr minus Mac-Uhr in Sekunden.
    public var offset: Double? { best?.offset }
    /// Laufzeit hin und zurueck; der Fehler des Abgleichs ist hoechstens die Haelfte davon.
    public var roundTrip: Double? { best?.rtt }
    public var count: Int { samples.count }
}
