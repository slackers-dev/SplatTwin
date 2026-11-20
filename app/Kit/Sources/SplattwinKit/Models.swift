import Foundation

/// Version des Protokolls zwischen Handy und Mac. Bei jeder unvertraeglichen Aenderung erhoehen.
public let protocolVersion = 1

public enum Lens: String, Codable, CaseIterable, Sendable {
    case ultraWide, wide, tele, front, external

    public var label: String {
        switch self {
        case .ultraWide: return "Ultraweitwinkel 0,5×"
        case .wide: return "Hauptkamera 1×"
        case .tele: return "Tele"
        case .front: return "Frontkamera"
        case .external: return "Kamera"
        }
    }
}

/// Automatik, an der aktuellen Stelle gesperrt, oder fester Wert (H-2).
public enum LockMode: String, Codable, CaseIterable, Sendable {
    case auto, locked, manual

    public var label: String {
        switch self {
        case .auto: return "Automatik"
        case .locked: return "Gesperrt"
        case .manual: return "Fester Wert"
        }
    }
}

/// Alles, was der Mac an einer Kamera einstellen kann (H-1 bis H-5, H-16, T-2).
public struct CameraConfig: Codable, Equatable, Sendable {
    public var lens: Lens = .wide
    /// Nur Mac: bestimmte Kamera, sonst die erste.
    public var deviceID: String?
    /// Sensorformat im Querformat, vor dem Drehen.
    public var width = 3840
    public var height = 2160
    public var fps = 30
    /// 90 = Hochformat (H-1), 0 = Querformat.
    public var rotation = 90
    public var exposure = LockMode.auto
    public var iso: Double?
    /// Verschlusszeit in Sekunden, z.B. 0.005 = 1/200 s (H-3).
    public var shutter: Double?
    public var focus = LockMode.auto
    /// 0 = nah, 1 = unendlich.
    public var lensPosition: Double?
    public var whiteBalance = LockMode.auto
    public var temperature: Double?
    public var tint: Double?
    /// Livebild fuer Vorschau und Tracking (H-7, T-1).
    public var streamEnabled = true
    public var streamMaxSide = 1280
    public var streamFPS = 30
    public var streamQuality = 0.6

    public init() {}
}

public struct FormatInfo: Codable, Hashable, Sendable {
    public var width: Int
    public var height: Int
    public var maxFPS: Int

    public init(width: Int, height: Int, maxFPS: Int) {
        self.width = width
        self.height = height
        self.maxFPS = maxFPS
    }

    public var label: String { "\(width)×\(height), bis \(maxFPS) B/s" }
}

public struct LensInfo: Codable, Equatable, Sendable {
    public var lens: Lens
    public var id: String
    public var name: String
    public var formats: [FormatInfo]
    public var minISO = 0.0
    public var maxISO = 0.0
    public var minShutter = 0.0
    public var maxShutter = 0.0
    public var manualExposure = false
    public var manualFocus = false
    public var manualWhiteBalance = false

    public init(lens: Lens, id: String, name: String, formats: [FormatInfo]) {
        self.lens = lens
        self.id = id
        self.name = name
        self.formats = formats
    }
}

/// Kameradaten als ideale Lochkamera, bezogen auf Bildbreite und -hoehe (wie in main.js),
/// damit sie fuer das volle Bild und das verkleinerte Livebild gleich gelten (H-10, T-3, T-4).
public struct Intrinsics: Codable, Equatable, Sendable {
    public var fx: Double
    public var fy: Double
    public var cx: Double
    public var cy: Double
    /// "device": vom Geraet pro Bild gemessen, "fov": aus dem Oeffnungswinkel des Formats geschaetzt.
    public var source: String
    /// "corrected": das Bild ist bereits entzerrt, "uncorrected": Verzeichnung noch im Bild, "unknown".
    public var distortion: String

    public init(fx: Double, fy: Double, cx: Double, cy: Double, source: String, distortion: String) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
        self.source = source
        self.distortion = distortion
    }

    public var fovX: Double { 2 * atan(0.5 / fx) * 180 / .pi }
    public var fovY: Double { 2 * atan(0.5 / fy) * 180 / .pi }
}

public struct NodeHello: Codable, Equatable, Sendable {
    public var version = protocolVersion
    public var name: String
    public var model: String
    public var system: String
    public var lenses: [LensInfo]

    public init(name: String, model: String, system: String, lenses: [LensInfo]) {
        self.name = name
        self.model = model
        self.system = system
        self.lenses = lenses
    }
}

/// Zustand einer Kamera, einmal pro Sekunde und bei jeder Aenderung (M-16, T-5).
public struct NodeStatus: Codable, Equatable, Sendable {
    public var config = CameraConfig()
    public var lensName = ""
    /// Bildgroesse nach dem Drehen, so wie aufgenommen wird.
    public var width = 0
    public var height = 0
    public var fps = 0.0
    public var iso: Double?
    public var shutter: Double?
    public var lensPosition: Double?
    public var temperature: Double?
    public var tint: Double?
    public var hdr = false
    public var colorSpace = ""
    public var stabilization = false
    public var centerStage = false
    public var intrinsics: Intrinsics?
    public var battery: Double?
    public var charging: Bool?
    public var thermal = "normal"
    public var freeBytes: Int64 = 0
    public var recording = false
    public var recordedFrames = 0
    public var droppedFrames = 0
    /// Das Handy wurde seit der letzten Bestaetigung bewegt (H-18).
    public var moved = false
    /// Richtung der Schwerkraft im Kamerabild: x rechts, y unten, z in Blickrichtung (H-11).
    public var gravity: [Double]?
    /// Was nicht so eingestellt werden konnte wie verlangt.
    public var warnings: [String] = []

    public init() {}
}

public struct PhaseInfo: Codable, Equatable, Sendable {
    public var title: String
    public var detail = ""
    /// "idle", "wait", "ok", "bad", "rec"
    public var color = "idle"
    public var speak: String?
    public var progress: Double?

    public init(title: String, detail: String = "", color: String = "idle", speak: String? = nil, progress: Double? = nil) {
        self.title = title
        self.detail = detail
        self.color = color
        self.speak = speak
        self.progress = progress
    }
}

public struct RecordRequest: Codable, Equatable, Sendable {
    public var name: String
    /// Zeitpunkt auf der Uhr des Geraets, ab dem aufgenommen wird (M-3).
    public var startAt: Double
    /// Abstand Geraeteuhr minus Mac-Uhr in Sekunden, fuer die Metadatei (H-9).
    public var clockOffset: Double

    public init(name: String, startAt: Double, clockOffset: Double) {
        self.name = name
        self.startAt = startAt
        self.clockOffset = clockOffset
    }
}

public struct RecordingInfo: Codable, Equatable, Sendable {
    public var name: String
    public var file: String
    public var sidecar: String
    public var bytes: Int64
    public var width: Int
    public var height: Int
    public var frames: Int
    public var dropped: Int
    /// Aufnahmezeit des ersten und letzten Bildes auf der Uhr des Geraets.
    public var firstFrame: Double
    public var lastFrame: Double
    public var error: String?

    public var seconds: Double { max(0, lastFrame - firstFrame) }
}

/// Liegt neben jeder Aufnahme: alles, was die Pipeline ueber die Kamera wissen kann (H-9 bis H-11, M-9).
public struct RecordingSidecar: Codable, Sendable {
    public var name: String
    public var device: String
    public var model: String
    public var system: String
    public var status: NodeStatus
    public var clockOffset: Double
    /// Aufnahmezeit jedes Bildes auf der Uhr des Geraets; minus clockOffset = Uhr des Macs.
    public var frameTimes: [Double]
    /// Kameradaten pro Bild als [fx, fy, cx, cy], bezogen auf Breite und Hoehe; leer, wenn unbekannt.
    public var frameIntrinsics: [[Double]]
    public var gravity: [Double]?
}

public struct FetchRequest: Codable, Equatable, Sendable {
    public var file: String

    public init(file: String) { self.file = file }
}

public struct ChunkHeader: Codable, Equatable, Sendable {
    public var file: String
    public var offset: Int64
    public var total: Int64
    /// Nur im letzten Stueck: SHA-256 der ganzen Datei.
    public var sha256: String?
}

public struct FrameHeader: Codable, Equatable, Sendable {
    public var seq: Int
    /// Aufnahmezeit auf der Uhr des Geraets (T-7).
    public var time: Double
    public var width: Int
    public var height: Int
    /// [fx, fy, cx, cy] bezogen auf Breite und Hoehe, falls vom Geraet geliefert.
    public var k: [Double]?

    public init(seq: Int, time: Double, width: Int, height: Int, k: [Double]?) {
        self.seq = seq
        self.time = time
        self.width = width
        self.height = height
        self.k = k
    }
}

public struct HubHello: Codable, Equatable, Sendable {
    public var version = protocolVersion
    public var name: String
    /// "control": Steuerung und Livebild, "files": nur Dateien abholen.
    public var role: String

    public init(name: String, role: String) {
        self.name = name
        self.role = role
    }
}

public struct Ping: Codable, Equatable, Sendable {
    public var t1: Double
    public init(t1: Double) { self.t1 = t1 }
}

public struct Pong: Codable, Equatable, Sendable {
    public var t1: Double
    public var t2: Double
    public var t3: Double
}

public enum Message: Codable, Equatable, Sendable {
    // Mac -> Geraet
    case hello(HubHello)
    case ping(Ping)
    case configure(CameraConfig)
    case phase(PhaseInfo)
    case startRecording(RecordRequest)
    case stopRecording
    case fetch(FetchRequest)
    case delete(FetchRequest)
    case confirmPosition
    // Geraet -> Mac
    case welcome(NodeHello)
    case pong(Pong)
    case status(NodeStatus)
    case recorded(RecordingInfo)
    case failure(String)
}
