import AVFoundation
import CoreMotion
import SplattwinKit
import SwiftUI
import UIKit

/// Alles, was auf dem Handy passiert: Kamera bereitstellen, Befehle des Macs ausfuehren,
/// gross anzeigen und ansagen, was zu tun ist. Gerechnet wird hier nichts (Abschnitt 10).
@MainActor
final class PhoneModel: ObservableObject {
    @Published var code: String
    @Published var connected = false
    @Published var hubName = ""
    @Published var phase = PhaseInfo(title: "Bereit", detail: "Auf dem Mac die App Splattwin öffnen und koppeln")
    @Published var status = NodeStatus()
    @Published var cameraDenied = false
    @Published var startError: String?
    @Published var dimmed = false
    @Published var files: [(name: String, bytes: Int64)] = []
    @Published var showPreview = true

    let source = CameraSource()
    private var node: CameraNode?
    private let motion = CMMotionManager()
    private let speaker = AVSpeechSynthesizer()
    private let shared = SharedState()
    private var lastTouch = Date()
    private var lastPhase = Date.distantPast
    private var normalBrightness: CGFloat = 0.6
    private var timer: Timer?

    /// Was der Lagesensor misst; wird von der Kameraseite aus einem anderen Thread gelesen.
    private final class SharedState: @unchecked Sendable {
        private let lock = NSLock()
        private var environment = CameraNode.Environment()
        private var reference: [Double]?
        private var offSince: Date?

        func read() -> CameraNode.Environment {
            lock.lock()
            defer { lock.unlock() }
            return environment
        }

        func set(battery: Double?, charging: Bool?) {
            lock.lock()
            environment.battery = battery
            environment.charging = charging
            lock.unlock()
        }

        func confirm() {
            lock.lock()
            environment.moved = false
            reference = environment.gravity
            offSince = nil
            lock.unlock()
        }

        /// Wurde das Handy verschoben? Verglichen wird mit der Lage bei der letzten Bestaetigung (H-18).
        func update(gravity: [Double], rotation: Double, acceleration: Double) {
            lock.lock()
            defer { lock.unlock() }
            environment.gravity = gravity
            guard let reference else {
                self.reference = gravity
                return
            }
            let dot = zip(gravity, reference).map(*).reduce(0, +)
            let angle = acos(max(-1, min(1, dot))) * 180 / .pi
            // Gekippt um mehr als 1,5 Grad, gedreht oder angestossen.
            if angle > 1.5 || rotation > 0.35 || acceleration > 0.2 {
                offSince = offSince ?? Date()
                if Date().timeIntervalSince(offSince!) > 0.25 { environment.moved = true }
            } else {
                offSince = nil
            }
        }
    }

    init() {
        let defaults = UserDefaults.standard
        if let saved = defaults.string(forKey: "code") {
            code = saved
        } else {
            code = Link.randomCode()
            defaults.set(code, forKey: "code")
        }
    }

    var formattedCode: String { String(code.prefix(3)) + " " + String(code.suffix(3)) }

    func start() async {
        guard node == nil else { return }
        guard await CameraSource.authorize() else {
            cameraDenied = true
            return
        }
        UIDevice.current.isBatteryMonitoringEnabled = true
        // Solange die App offen ist, darf das Handy nicht einschlafen (H-19): sonst verschwindet es aus dem Netz,
        // sobald der Mac kurz weg ist, und laesst sich nicht mehr von selbst verbinden.
        UIApplication.shared.isIdleTimerDisabled = true
        // Ansagen sollen auch bei stummgeschaltetem Handy zu hoeren sein.
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])

        var machine = [CChar](repeating: 0, count: 64)
        var size = machine.count
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Aufnahmen")
        let node = CameraNode(name: UIDevice.current.name, model: String(cString: machine),
                              system: "iOS \(UIDevice.current.systemVersion)", source: source, code: code, directory: directory)
        let shared = shared
        node.environment = { shared.read() }
        node.onConfirmPosition = { shared.confirm() }
        node.onLink = { [weak self] connected, name in
            Task { @MainActor in self?.linkChanged(connected, name) }
        }
        node.onPhase = { [weak self] info in
            Task { @MainActor in self?.show(info) }
        }
        node.onStatus = { [weak self] status in
            Task { @MainActor in self?.status = status }
        }
        do {
            try node.start(advertise: true)
            self.node = node
        } catch {
            startError = error.localizedDescription
            return
        }
        startMotion()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        refreshFiles()
    }

    private func linkChanged(_ connected: Bool, _ name: String) {
        self.connected = connected
        hubName = name
        if connected {
            shared.confirm()
            phase = PhaseInfo(title: "Verbunden", detail: "Gesteuert von \(name)", color: "wait")
            lastTouch = Date()
        } else {
            phase = PhaseInfo(title: "Bereit", detail: "Warte auf den Mac")
            lastTouch = Date()
            setDimmed(false)
        }
        refreshFiles()
    }

    private func show(_ info: PhaseInfo) {
        var shown = info
        shown.speak = nil
        phase = shown
        lastPhase = Date()
        setDimmed(false)
        if let text = info.speak {
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "de-DE")
            speaker.speak(utterance)
        }
    }

    private func tick() {
        let device = UIDevice.current
        let level = device.batteryLevel
        shared.set(battery: level >= 0 ? Double(level) : nil,
                   charging: device.batteryState == .charging || device.batteryState == .full)
        // Nur Livebild, keine Anweisungen: Bildschirm abdunkeln, das spart Akku und Waerme (H-19).
        // Ohne Verbindung laenger hell bleiben, damit der Kopplungscode lesbar ist.
        let limit: TimeInterval = connected ? 20 : 120
        let quiet = Date().timeIntervalSince(lastTouch) > limit && Date().timeIntervalSince(lastPhase) > limit
        if quiet, !dimmed { setDimmed(true) }
    }

    func touched() {
        lastTouch = Date()
        setDimmed(false)
    }

    private func setDimmed(_ on: Bool) {
        guard on != dimmed else { return }
        if on {
            normalBrightness = UIScreen.main.brightness
            UIScreen.main.brightness = 0.02
        } else {
            UIScreen.main.brightness = normalBrightness
        }
        dimmed = on
    }

    private func startMotion() {
        guard motion.isDeviceMotionAvailable else { return }
        motion.deviceMotionUpdateInterval = 0.1
        let shared = shared
        motion.startDeviceMotionUpdates(to: OperationQueue()) { data, _ in
            guard let data else { return }
            let g = data.gravity, r = data.rotationRate, a = data.userAcceleration
            shared.update(gravity: [g.x, g.y, g.z],
                          rotation: sqrt(r.x * r.x + r.y * r.y + r.z * r.z),
                          acceleration: sqrt(a.x * a.x + a.y * a.y + a.z * a.z))
        }
    }

    // MARK: Am Handy bedienbar

    func newCode() {
        code = Link.randomCode()
        UserDefaults.standard.set(code, forKey: "code")
        node?.setCode(code, advertise: true)
    }

    func refreshFiles() {
        files = node?.storedFiles() ?? []
    }

    func deleteFiles() {
        node?.deleteStoredFiles()
        refreshFiles()
    }

    var storedBytes: Int64 { files.reduce(0) { $0 + $1.bytes } }

    /// Pruefung vor der Aufnahme (H-14).
    var checks: [(ok: Bool, text: String)] {
        var list: [(Bool, String)] = []
        if let battery = status.battery {
            list.append((battery > 0.2 || status.charging == true, "Akku \(Int(battery * 100)) %" + (status.charging == true ? ", lädt" : "")))
        }
        list.append((status.freeBytes > 3_000_000_000, "Frei \(ByteCountFormatter.string(fromByteCount: status.freeBytes, countStyle: .file))"))
        list.append((status.thermal == "normal" || status.thermal == "warm", "Temperatur \(status.thermal)"))
        if status.moved { list.append((false, "Bewegt – neu kalibrieren")) }
        return list
    }
}
