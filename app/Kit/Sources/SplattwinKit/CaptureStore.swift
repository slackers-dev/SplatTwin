import Foundation

/// Die Metadatei einer Aufnahme (M-9). Die oberen Felder sind dieselben wie bei capture.html,
/// damit `process_capture.py` beide Arten von Aufnahmen gleich verarbeitet. Unter `app` steht
/// alles Weitere, was die App weiss.
public struct CaptureMeta: Codable, Equatable {
    public struct Saved: Codable, Equatable {
        public var saved: String
        public var width: Int
        public var height: Int
        public var seconds: Double

        public init(saved: String, width: Int, height: Int, seconds: Double) {
            self.saved = saved
            self.width = width
            self.height = height
            self.seconds = seconds
        }
    }

    public struct Camera: Codable, Equatable {
        public var key: String
        public var device: String
        public var model: String
        public var file: String
        public var sidecar: String
        public var frames: Int
        public var dropped: Int
        /// Aufnahmezeit des ersten Bildes auf der Mac-Uhr.
        public var firstFrame: Double
        /// Sekunden, um die ein Ereignis in diesem Video spaeter liegt als in Video A.
        public var offset: Double
        /// Genauigkeit des Uhrenabgleichs: halbe Laufzeit in Millisekunden.
        public var syncErrorMs: Double
        public var status: NodeStatus?

        public init(key: String, device: String, model: String, file: String, sidecar: String, frames: Int, dropped: Int,
                    firstFrame: Double, offset: Double, syncErrorMs: Double, status: NodeStatus?) {
            self.key = key
            self.device = device
            self.model = model
            self.file = file
            self.sidecar = sidecar
            self.frames = frames
            self.dropped = dropped
            self.firstFrame = firstFrame
            self.offset = offset
            self.syncErrorMs = syncErrorMs
            self.status = status
        }
    }

    public struct App: Codable, Equatable {
        public var version = 1
        public var created: String
        public var options: FlowOptions
        public var cameras: [Camera]

        public init(created: String, options: FlowOptions, cameras: [Camera]) {
            self.created = created
            self.options = options
            self.cameras = cameras
        }
    }

    public var name: String
    /// Sekunden im Video A.
    public var marks: [String: Double]
    /// Sekunden, um die ein Ereignis in Video B spaeter liegt als in Video A.
    public var offset: Double
    public var saved: [String: Saved]
    public var notes: [String]
    /// Koerpergroesse in Metern, legt den Massstab des Splats fest (A-7).
    public var height: Double
    /// Nur bei einem Gesichtsscan als eigener Aufnahme: Name der Koerper-Aufnahme, auf die der Kopf gehoert.
    public var body: String?
    public var app: App

    public init(name: String, marks: [String: Double], offset: Double, saved: [String: Saved], notes: [String], height: Double,
                body: String? = nil, app: App) {
        self.body = body
        self.name = name
        self.marks = marks
        self.offset = offset
        self.saved = saved
        self.notes = notes
        self.height = height
        self.app = app
    }
}

public struct CaptureEntry: Identifiable, Equatable {
    public var id: String { name }
    public let name: String
    public let url: URL
    public let date: Date
    /// nil bei einer Aufnahme, deren Metadatei sich nicht lesen laesst.
    public let meta: CaptureMeta?
    /// Aufnahmen aus capture.html haben keinen App-Teil, lassen sich aber genauso rechnen.
    public let fromApp: Bool
    public let hasSplat: Bool
}

/// Ablage der Aufnahmen im Projektordner: `splat/captures` fuer Rohdaten, `splat/runs` fuer Ergebnisse.
public struct CaptureStore {
    public let project: URL

    public init(project: URL) {
        self.project = project
    }

    public var captures: URL { project.appendingPathComponent("splat/captures") }
    public var runs: URL { project.appendingPathComponent("splat/runs") }
    public var isValid: Bool { FileManager.default.fileExists(atPath: project.appendingPathComponent("splat/process_capture.py").path) }

    public func metaURL(_ name: String) -> URL { captures.appendingPathComponent(name + ".json") }
    public func runURL(_ name: String) -> URL { runs.appendingPathComponent(name) }

    public static func validName(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil
    }

    /// Ein Name, unter dem noch nichts liegt, damit keine aeltere Aufnahme ueberschrieben wird.
    public func freeName(_ wanted: String) -> String {
        var name = wanted
        var n = 2
        while FileManager.default.fileExists(atPath: metaURL(name).path) {
            name = "\(wanted)-\(n)"
            n += 1
        }
        return name
    }

    public static func suggestedName(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HHmm"
        return "scan-" + formatter.string(from: date)
    }

    public func write(_ meta: CaptureMeta) throws {
        try FileManager.default.createDirectory(at: captures, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(meta).write(to: metaURL(meta.name), options: .atomic)
    }

    public func list() -> [CaptureEntry] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: captures, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return urls.filter { $0.pathExtension == "json" && !$0.lastPathComponent.hasSuffix(".frames.json") }.map { url in
            let name = url.deletingPathExtension().lastPathComponent
            let data = try? Data(contentsOf: url)
            let meta = data.flatMap { try? JSONDecoder().decode(CaptureMeta.self, from: $0) }
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return CaptureEntry(name: name, url: url, date: date, meta: meta, fromApp: meta != nil,
                                hasSplat: FileManager.default.fileExists(atPath: runURL(name).appendingPathComponent("splat.ply").path))
        }.sorted { $0.date > $1.date }
    }

    /// Die drei Dateien, die die Avatar-Seite braucht (M-15).
    public func exportFiles(_ name: String) -> [URL] {
        ["splat.ply", "splat.json", "rig.json"].map { runURL(name).appendingPathComponent($0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }
}

/// Was die Pipeline ueber die Qualitaet eines Laufs ausgibt (M-10).
public struct QualityReport: Equatable {
    public var registered: Int?
    public var total: Int?
    /// Pro Video: Bogen der Kamerabahn in Grad.
    public var arcs: [String: Int] = [:]
    public var cover: [String: Int] = [:]
    public var failure: String?

    public init() {}

    /// Liest die Kennzahlen aus der Ausgabe von `splat_pipeline.py`. Bei mehreren Laeufen (Koerper, Kopf) zaehlt der erste.
    public init(log: String) {
        for line in log.split(whereSeparator: \.isNewline) {
            let text = String(line)
            if registered == nil, let m = text.firstMatch(of: #/Registriert: (\d+) von (\d+)/#) {
                registered = Int(m.1)
                total = Int(m.2)
            }
            if let m = text.firstMatch(of: #/Video (\w): \d+ Frames, Kamerabahn (\d+) Grad/#), arcs[String(m.1)] == nil {
                arcs[String(m.1)] = Int(m.2)
            }
            if let m = text.firstMatch(of: #/Video (\w): Person bedeckt im Schnitt (\d+)%/#), cover[String(m.1)] == nil {
                cover[String(m.1)] = Int(m.2)
            }
            if text.contains("fehlgeschlagen") || text.contains("COLMAP hat kein Modell") || text.contains("Weniger als die Haelfte") {
                failure = failure ?? text
            }
        }
    }

    /// Ampel (D-4): gut, brauchbar, wiederholen.
    public var verdict: String {
        guard failure == nil, let registered, let total, total > 0 else { return failure == nil ? "unbekannt" : "wiederholen" }
        let share = Double(registered) / Double(total)
        let arc = arcs["a"] ?? 0
        if share >= 0.9, arc >= 330 { return "gut" }
        if share >= 0.6, arc >= 250 { return "brauchbar" }
        return "wiederholen"
    }
}

#if os(macOS)
/// Startet die Pipeline als eigenen Prozess und reicht ihre Ausgabe zeilenweise weiter (M-10).
public final class PipelineRunner {
    public private(set) var process: Process?

    public init() {}

    /// Programme wie uv, colmap und ffmpeg liegen bei Homebrew; eine App erbt deren Pfad nicht.
    public static var searchPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.cargo/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .joined(separator: ":")
    }

    public static func find(_ tool: String) -> String? {
        searchPath.split(separator: ":").map { "\($0)/\(tool)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    public var isRunning: Bool { process?.isRunning ?? false }

    public func run(_ arguments: [String], in directory: URL, onOutput: @escaping (String) -> Void, onExit: @escaping (Int32) -> Void) throws {
        guard let tool = PipelineRunner.find(arguments[0]) else { throw NodeError("\(arguments[0]) ist nicht installiert") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = Array(arguments.dropFirst())
        process.currentDirectoryURL = directory
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = PipelineRunner.searchPath
        environment["PYTHONUNBUFFERED"] = "1"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { onOutput(text) }
        }
        process.terminationHandler = { process in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async { onExit(process.terminationStatus) }
        }
        try process.run()
        self.process = process
    }

    /// Beendet die Pipeline samt allen Programmen, die sie gestartet hat (COLMAP, Brush).
    public func cancel() {
        guard let process, process.isRunning else { return }
        PipelineRunner.descendants(of: process.processIdentifier).reversed().forEach { kill($0, SIGTERM) }
        process.terminate()
    }

    static func descendants(of pid: Int32) -> [Int32] {
        let lookup = Process()
        lookup.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        lookup.arguments = ["-P", String(pid)]
        let pipe = Pipe()
        lookup.standardOutput = pipe
        guard (try? lookup.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        lookup.waitUntilExit()
        let children = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).compactMap { Int32($0) }
        return children.flatMap { [$0] + descendants(of: $0) }
    }
}
#endif
