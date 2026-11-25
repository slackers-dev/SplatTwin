import AppKit
import AVFoundation
import Combine
import SplattwinKit

/// Gespeicherter Aufbau: Einstellungen aller Kameras und der gemessene Kameraabstand (M-20).
struct Setup: Codable, Identifiable, Equatable {
    var id: String { name }
    var name: String
    var configs: [String: CameraConfig]
    var baseline: Double
    var main: String?
}

struct CaptureSummary: Equatable {
    var name: String
    var lines: [String]
    var notes: [String]
}

/// Koerper und Gesicht sind getrennte Aufnahmen: fuer das Gesicht setzt man sich bequem nah an die Kamera.
enum CaptureMode: String, CaseIterable, Identifiable {
    case body = "Körper", face = "Gesicht"
    var id: String { rawValue }
}

/// Woher die Ansagen kommen (H-13).
enum Announce: String, CaseIterable, Identifiable {
    case mac = "Mac", phone = "Handy", both = "Beide"
    var id: String { rawValue }
}

enum RunState: Equatable {
    case idle, starting, running
    case saving(String)
    case finished(CaptureSummary)
    case failed(String)

    var isActive: Bool {
        switch self {
        case .starting, .running, .saving: return true
        default: return false
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    let hub = Hub()
    let bridge = WebBridge()
    private(set) var pose: PoseWorker?

    // Projekt
    @Published var projectDir: URL { didSet { defaults.set(projectDir.path, forKey: "projectDir"); refreshCaptures() } }
    var store: CaptureStore { CaptureStore(project: projectDir) }

    // Kameras
    @Published var poses: [String: PoseObservation] = [:]
    @Published var poseReady = false
    @Published var poseError: String?
    @Published var mainCameraID: String? { didSet { defaults.set(mainCameraID, forKey: "mainCamera") } }
    @Published var excluded: Set<String> = []
    @Published var setups: [Setup] = [] { didSet { save(setups, "setups") } }
    @Published var message: String?

    // Aufnahme
    @Published var captureName = CaptureStore.suggestedName()
    @Published var heightCm: Double { didSet { defaults.set(heightCm, forKey: "heightCm") } }
    @Published var options = FlowOptions()
    @Published var mode = CaptureMode.body
    /// Im Modus Gesicht: die Koerper-Aufnahme, auf die der Kopf gesetzt wird.
    @Published var faceBody = ""
    @Published var run = RunState.idle
    @Published var phaseTitle = "Bereit"
    @Published var phaseProgress = 0.0
    @Published var phaseGood = false
    @Published var poseStale = false
    /// Beim Start der Aufnahme die Kameras selbst richtig einstellen: Handys auf Hauptkamera, 4K, hochkant,
    /// danach Belichtung, Fokus und Weissabgleich einpendeln lassen und sperren.
    @Published var autoConfigure: Bool { didSet { defaults.set(autoConfigure, forKey: "autoConfigure") } }
    @Published var announce: Announce { didSet { defaults.set(announce.rawValue, forKey: "announce") } }
    /// Laeuft gerade «Einrichten und sperren»?
    @Published var settingUp = false

    // Pipeline und Ablage
    @Published var captures: [CaptureEntry] = []
    @Published var pipelineLog = ""
    @Published var pipelineName: String?
    @Published var pipelineRunning = false
    @Published var reports: [String: QualityReport] = [:]

    // Tracking
    @Published var bridgeClients = 0
    @Published var bridgeError: String?
    @Published var baseline: Double { didSet { defaults.set(baseline, forKey: "baseline") } }
    @Published var serverRunning = false

    private let defaults = UserDefaults.standard
    private let runner = PipelineRunner()
    private let speaker = AVSpeechSynthesizer()
    private var localNodes: [String: CameraNode] = [:]
    private var taps: [String: UUID] = [:]
    private var bag: Set<AnyCancellable> = []
    private var lastConfigs: [String: CameraConfig] = [:]
    private var engine: FlowEngine?
    private var abortRequested = false
    private var faceModel = false
    private var lastPhase = PhaseInfo(title: "")
    private var server: Process?
    private var timer: Timer?
    private var activity: NSObjectProtocol?

    init() {
        let bundled = Bundle.main.object(forInfoDictionaryKey: "SplattwinProjectDir") as? String
        let path = defaults.string(forKey: "projectDir") ?? bundled ?? FileManager.default.homeDirectoryForCurrentUser.path
        projectDir = URL(fileURLWithPath: path).standardizedFileURL
        heightCm = defaults.object(forKey: "heightCm") as? Double ?? 175
        announce = Announce(rawValue: defaults.string(forKey: "announce") ?? "") ?? .mac
        autoConfigure = defaults.object(forKey: "autoConfigure") as? Bool ?? true
        baseline = defaults.double(forKey: "baseline")
        mainCameraID = defaults.string(forKey: "mainCamera")
        setups = load("setups") ?? []
        lastConfigs = load("lastConfigs") ?? [:]

        // Kameras und Koerpererkennung muessen auch laufen, wenn das Fenster nicht vorne ist oder niemand
        // am Mac sitzt (die Person steht waehrend der Aufnahme vor der Kamera): kein App Nap, Bildschirm bleibt an.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .latencyCritical, .idleDisplaySleepDisabled], reason: "Kameras und Körpererkennung laufen")

        hub.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &bag)
        hub.$cameras.sink { [weak self] in self?.attach($0) }.store(in: &bag)
        hub.startBrowsing()

        bridge.onClients = { [weak self] count in Task { @MainActor in self?.bridgeClients = count } }
        do { try bridge.start() } catch { bridgeError = error.localizedDescription }

        let pose = PoseWorker(port: bridge.port)
        pose.onState = { [weak self] ready, error in
            self?.poseReady = ready || (self?.poseReady ?? false) && error == nil
            self?.poseError = error
        }
        pose.onObservation = { [weak self] id, observation in self?.poses[id] = observation }
        self.pose = pose

        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        refreshCaptures()
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.server?.terminate()
                self?.runner.cancel()
            }
        }
        handleLaunchArguments()
    }

    // MARK: Kameras

    var cameras: [RemoteCamera] { hub.cameras }

    var mainCamera: RemoteCamera? {
        cameras.first { $0.id == mainCameraID } ?? cameras.first { localNodes[$0.id] == nil } ?? cameras.first
    }

    /// Kameras, die aufnehmen: Kamera A zuerst.
    var recordingCameras: [RemoteCamera] {
        guard let main = mainCamera else { return [] }
        return [main] + cameras.filter { $0.id != main.id && !excluded.contains($0.id) && $0.isConnected }
    }

    func key(of camera: RemoteCamera) -> String? {
        recordingCameras.firstIndex { $0.id == camera.id }.map { String(Array("abcdefgh")[min($0, 7)]) }
    }

    func isLocal(_ camera: RemoteCamera) -> Bool { localNodes[camera.id] != nil }

    private func attach(_ cameras: [RemoteCamera]) {
        for camera in cameras where taps[camera.id] == nil {
            let id = camera.id, bridge = bridge
            taps[id] = camera.frames.add { header, jpeg, hubTime in
                bridge.push(id: id, header: header, jpeg: jpeg, hubTime: hubTime)
            }
            // Einstellungen vom letzten Mal wiederverwenden (M-20).
            if let config = lastConfigs[id] {
                camera.config = config
                camera.apply()
            }
        }
        for id in taps.keys where !cameras.contains(where: { $0.id == id }) {
            taps[id] = nil
            poses[id] = nil
        }
    }

    private func lens(of camera: RemoteCamera) -> LensInfo? {
        let lenses = camera.hello?.lenses ?? []
        return lenses.first { camera.config.deviceID != nil ? $0.id == camera.config.deviceID : $0.lens == camera.config.lens } ?? lenses.first
    }

    /// Belichtung mit gleicher Helligkeit, aber kurzer Verschlusszeit: weniger Bewegungsunschaerfe beim Drehen (H-3).
    /// Reicht die ISO dafuer nicht, bleibt die Verschlusszeit so lang wie noetig.
    func exposure(for camera: RemoteCamera, shutter wanted: Double) -> (iso: Double, shutter: Double)? {
        guard let lens = lens(of: camera), lens.manualExposure,
              let iso = camera.config.iso ?? camera.status?.iso, let shutter = camera.config.shutter ?? camera.status?.shutter,
              iso > 0, shutter > 0 else { return nil }
        let light = iso * shutter
        let newISO = min(max(light / wanted, lens.minISO), lens.maxISO)
        return (newISO, min(light / newISO, 1 / Double(max(1, camera.config.fps))))
    }

    /// Feste Werte, die noch keine Zahl haben, aus dem aktuellen Zustand der Kamera fuellen. So gilt nach
    /// einem Neustart des Handys wieder genau dieselbe Einstellung, statt eines zufaelligen Startwerts.
    private func fill(_ camera: RemoteCamera) {
        let status = camera.status
        // «Gesperrt» heisst am Handy: genau die aktuellen Werte, als Zahlen.
        if let lens = lens(of: camera), status != nil {
            if camera.config.exposure == .locked, lens.manualExposure {
                camera.config.exposure = .manual
                camera.config.iso = status?.iso
                camera.config.shutter = status?.shutter
            }
            if camera.config.whiteBalance == .locked, lens.manualWhiteBalance { camera.config.whiteBalance = .manual; camera.config.temperature = nil }
            if camera.config.focus == .locked, lens.manualFocus { camera.config.focus = .manual; camera.config.lensPosition = nil }
        }
        if camera.config.exposure == .manual, camera.config.iso == nil || camera.config.shutter == nil {
            let current = camera.config.shutter ?? status?.shutter ?? 0.01
            if let values = exposure(for: camera, shutter: min(current, 0.01)) {
                camera.config.iso = values.iso
                camera.config.shutter = values.shutter
            }
        }
        if camera.config.whiteBalance == .manual, camera.config.temperature == nil {
            camera.config.temperature = status?.temperature
            camera.config.tint = status?.tint
        }
        if camera.config.focus == .manual, camera.config.lensPosition == nil {
            camera.config.lensPosition = status?.lensPosition
        }
    }

    /// Nach jeder Aenderung in der Bedienung: an die Kamera schicken und merken.
    func changed(_ camera: RemoteCamera) {
        fill(camera)
        camera.apply()
        lastConfigs[camera.id] = camera.config
        save(lastConfigs, "lastConfigs")
    }

    /// Belichtung, Fokus und Weissabgleich an der aktuellen Stelle festhalten (H-2).
    /// Wo das Geraet feste Werte kann, werden die aktuellen Zahlen uebernommen (und die Verschlusszeit auf
    /// hoechstens 1/100 s gekuerzt); sonst wird nur gesperrt.
    func lockAll(_ camera: RemoteCamera) {
        let lens = lens(of: camera)
        if camera.config.exposure == .auto { camera.config.exposure = lens?.manualExposure == true ? .manual : .locked }
        if camera.config.focus == .auto { camera.config.focus = lens?.manualFocus == true ? .manual : .locked }
        if camera.config.whiteBalance == .auto { camera.config.whiteBalance = lens?.manualWhiteBalance == true ? .manual : .locked }
        changed(camera)
    }

    /// Zwei feste Einstellungen fuer die beiden Aufgaben der App.
    enum Preset {
        /// Hauptkamera 1×, 4K, hochkant: moeglichst viele Pixel auf der Person.
        case scan
        /// Ultraweitwinkel: der ganze Koerper passt auch in kleinen Raeumen ins Bild.
        case tracking
    }

    /// Gibt es an diesem Geraet die Linsen eines Handys (und damit etwas umzustellen)?
    func hasPhoneLenses(_ camera: RemoteCamera) -> Bool {
        camera.hello?.lenses.contains { $0.lens == .wide || $0.lens == .ultraWide } ?? false
    }

    /// Linse und Format, die eine Voreinstellung an diesem Geraet ergibt.
    private func target(_ preset: Preset, for camera: RemoteCamera) -> (lens: LensInfo, format: FormatInfo?)? {
        guard let lenses = camera.hello?.lenses, hasPhoneLenses(camera) else { return nil }
        let wanted: Lens = preset == .scan ? .wide : .ultraWide
        guard let lens = lenses.first(where: { $0.lens == wanted }) ?? lenses.first(where: { $0.lens == .wide }) else { return nil }
        let sizes: [(Int, Int)] = preset == .scan ? [(3840, 2160)] : [(1920, 1440), (1920, 1080)]
        let format = sizes.lazy.compactMap { size in lens.formats.first { $0.width == size.0 && $0.height == size.1 && $0.maxFPS >= 30 } }.first
            ?? lens.formats.first { $0.maxFPS >= 30 } ?? lens.formats.first
        return (lens, format)
    }

    /// Steht die Kamera schon so, wie der Scan sie braucht?
    func isReadyForScan(_ camera: RemoteCamera) -> Bool {
        guard let target = target(.scan, for: camera) else { return true } // kein Handy: nichts umzustellen
        let c = camera.config
        return c.lens == target.lens.lens && c.rotation == 90 && c.fps == 30
            && (target.format.map { $0.width == c.width && $0.height == c.height } ?? true)
    }

    func apply(_ preset: Preset, to camera: RemoteCamera) {
        guard let (lens, format) = target(preset, for: camera) else { return }
        camera.config.lens = lens.lens
        camera.config.deviceID = nil
        if let format {
            camera.config.width = format.width
            camera.config.height = format.height
        }
        camera.config.fps = 30
        if preset == .scan { camera.config.rotation = 90 }
        camera.config.streamEnabled = true
        camera.config.streamMaxSide = 1280
        camera.config.streamFPS = 30
        // Andere Linse, anderes Licht auf dem Sensor: Belichtung und Weissabgleich neu einpendeln lassen.
        camera.config.exposure = .auto
        camera.config.focus = .auto
        camera.config.whiteBalance = .auto
        camera.config.iso = nil
        camera.config.shutter = nil
        camera.config.lensPosition = nil
        camera.config.temperature = nil
        camera.config.tint = nil
        changed(camera)
    }

    /// Laeuft an dieser Kamera noch etwas automatisch?
    /// Dazu zaehlt auch «gesperrt» ohne Zahlen: das haelt nur bis zum naechsten Start der Handy-App und friert
    /// dann ein, was die Kamera in dem Moment gerade sieht.
    func needsSetup(_ camera: RemoteCamera) -> Bool {
        let c = camera.config, lens = lens(of: camera)
        if c.exposure == .auto || c.whiteBalance == .auto || c.focus == .auto { return true }
        if lens?.manualExposure == true, c.exposure != .manual || c.iso == nil || c.shutter == nil { return true }
        if lens?.manualWhiteBalance == true, c.whiteBalance != .manual || c.temperature == nil { return true }
        return false
    }

    /// Die festgehaltenen Werte in Worten, oder nil, solange noch Automatik laeuft.
    func lockSummary(_ camera: RemoteCamera) -> String? {
        guard !needsSetup(camera), let status = camera.status else { return nil }
        var parts: [String] = []
        if let iso = status.iso, let shutter = status.shutter, shutter > 0 {
            parts.append("ISO \(Int(iso.rounded())), 1/\(Int((1 / shutter).rounded())) s")
        }
        if let kelvin = status.temperature { parts.append("\(Int((kelvin / 50).rounded()) * 50) K") }
        return parts.isEmpty ? "gesperrt" : parts.joined(separator: ", ")
    }

    /// Steht die Kamera an ihrem Platz: alles auf Automatik, einpendeln lassen, dann Belichtung, Fokus und
    /// Weissabgleich mit festen Zahlen sperren und die Lage als Ausgangslage merken (H-2, H-18).
    func setupCameras(_ list: [RemoteCamera]? = nil) async {
        let cameras = (list ?? recordingCameras).filter(\.isConnected)
        guard !cameras.isEmpty, !settingUp else { return }
        settingUp = true
        defer { settingUp = false }
        for camera in cameras {
            camera.config.exposure = .auto
            camera.config.focus = .auto
            camera.config.whiteBalance = .auto
            camera.config.iso = nil
            camera.config.shutter = nil
            camera.config.lensPosition = nil
            camera.config.temperature = nil
            camera.config.tint = nil
            changed(camera)
        }
        // Die Automatik braucht ein bis zwei Sekunden; der Zustand kommt einmal pro Sekunde vom Geraet.
        try? await Task.sleep(nanoseconds: 3_500_000_000)
        for camera in cameras {
            lockAll(camera)
            camera.confirmPosition()
        }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
    }

    func pair(_ found: Hub.Found, code: String) {
        let digits = code.filter(\.isNumber)
        guard digits.count == 6 else {
            message = "Der Kopplungscode hat sechs Ziffern und steht auf dem Bildschirm des Handys."
            return
        }
        hub.pair(found, code: digits)
    }

    func remove(_ camera: RemoteCamera) {
        hub.remove(camera)
        localNodes.removeValue(forKey: camera.id)?.stop()
    }

    func addMacCamera() {
        Task {
            guard await CameraSource.authorize() else {
                message = "Kein Zugriff auf die Kamera. In den Systemeinstellungen unter Datenschutz › Kamera für Splattwin erlauben."
                return
            }
            addLocal(id: "mac-\(localNodes.count + 1)", name: "Mac-Kamera", source: CameraSource())
        }
    }

    func addVideoFile(_ url: URL) {
        addLocal(id: "datei-\(url.deletingPathExtension().lastPathComponent)", name: "Datei \(url.lastPathComponent)", source: FileSource(url: url))
    }

    func addTestPattern() {
        addLocal(id: "test-\(localNodes.count + 1)", name: "Testbild", source: SyntheticSource())
    }

    private func addLocal(id: String, name: String, source: FrameSource) {
        guard localNodes[id] == nil else { return }
        let code = Link.randomCode()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Splattwin/\(id)")
        let node = CameraNode(name: name, model: "Mac", system: "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
                              source: source, code: code, directory: directory)
        node.onReady = { [weak self] port in
            Task { @MainActor in self?.hub.addLocal(id: id, name: name, port: port, code: code) }
        }
        do {
            try node.start(advertise: false, loopbackOnly: true)
            localNodes[id] = node
        } catch {
            message = "\(name) lässt sich nicht starten: \(error.localizedDescription)"
        }
    }

    /// Videodatei von vorne abspielen (nur fuer Tests mit einer Datei als Kamera).
    func restartFile(_ camera: RemoteCamera) {
        localNodes[camera.id]?.source.start()
    }

    func saveSetup(_ name: String) {
        let setup = Setup(name: name, configs: Dictionary(uniqueKeysWithValues: cameras.map { ($0.id, $0.config) }),
                          baseline: baseline, main: mainCameraID)
        setups.removeAll { $0.name == name }
        setups.append(setup)
    }

    func loadSetup(_ setup: Setup) {
        baseline = setup.baseline
        mainCameraID = setup.main ?? mainCameraID
        for (id, config) in setup.configs {
            lastConfigs[id] = config
            if let camera = hub.camera(id) {
                camera.config = config
                camera.apply()
            }
        }
        save(lastConfigs, "lastConfigs")
    }

    private func tick() {
        let infos = cameras.filter(\.isConnected).map { camera -> WebBridge.CameraInfo in
            let intrinsics = camera.status?.intrinsics
            return WebBridge.CameraInfo(
                id: camera.id, name: camera.name, lens: camera.status?.config.lens.label ?? "",
                width: camera.stats.width, height: camera.stats.height, fps: camera.stats.fps.rounded(),
                latencyMs: (camera.stats.latency * 200).rounded() * 5,
                k: intrinsics.map { [$0.fx, $0.fy, $0.cx, $0.cy].map { ($0 * 1000).rounded() / 1000 } },
                source: intrinsics?.source ?? "", distortion: intrinsics?.distortion ?? "unknown")
        }
        bridge.publish(cameras: infos, baseline: baseline > 0 ? baseline : nil)
        if case .saving = run { objectWillChange.send() }
    }

    // MARK: Aufnahme (M-4, A-1 bis A-7)

    /// Was vor dem Start nicht stimmt. Leere Liste = bereit (H-14, M-8).
    func preflight() -> [(ok: Bool, text: String)] {
        var list: [(Bool, String)] = []
        list.append((store.isValid, store.isValid ? "Projektordner gefunden" : "Projektordner ohne splat/process_capture.py – unter Aufnahmen wählen"))
        list.append((poseReady, poseReady ? "Körpererkennung bereit" : (poseError ?? "Körpererkennung lädt …")))
        guard !recordingCameras.isEmpty else { return list + [(false, "Keine Kamera verbunden")] }
        for camera in recordingCameras {
            let tag = "Kamera \(key(of: camera)?.uppercased() ?? "?") (\(camera.name))"
            guard camera.isConnected, let status = camera.status else {
                list.append((false, "\(tag): nicht verbunden"))
                continue
            }
            var problems: [String] = []
            if camera.stats.fps < 5 { problems.append("kein Livebild") }
            else if camera.stats.brightness < 0.08 { problems.append("Bild fast schwarz – Linse verdeckt?") }
            if let battery = status.battery, battery < 0.2, status.charging != true { problems.append("Akku \(Int(battery * 100)) %") }
            if status.freeBytes > 0, status.freeBytes < 3_000_000_000 { problems.append("nur \(status.freeBytes / 1_000_000_000) GB frei") }
            if status.thermal == "heiss" || status.thermal == "kritisch" { problems.append("Gerät ist \(status.thermal)") }
            if status.moved { problems.append("wurde bewegt") }
            if camera.clockOffset == nil { problems.append("Uhr noch nicht abgeglichen") }
            if status.hdr { problems.append("HDR ist an") }
            if status.stabilization { problems.append("Stabilisierung ist an") }
            if status.centerStage { problems.append("Center Stage ist an") }
            problems += status.warnings
            if !autoConfigure {
                if camera.id == mainCamera?.id, status.config.lens == .ultraWide {
                    problems.append("Ultraweitwinkel: die Person wird klein im Bild – für den Scan die Hauptkamera nehmen")
                }
                if problems.isEmpty, needsSetup(camera) { problems.append("noch nicht eingerichtet – «Einrichten und sperren» drücken, wenn die Kamera steht") }
            }
            let sync = (camera.roundTrip.map { String(format: ", Uhr ±%.1f ms", $0 * 500) } ?? "")
                + (autoConfigure ? (isReadyForScan(camera) ? ", wird beim Start gesperrt" : ", wird beim Start auf Hauptkamera 4K gestellt")
                   : (lockSummary(camera).map { ", fest: \($0)" } ?? ""))
            list.append((problems.isEmpty, problems.isEmpty
                ? "\(tag): \(status.width)×\(status.height), \(Int(status.fps.rounded())) B/s\(sync)"
                : "\(tag): " + problems.joined(separator: ", ")))
        }
        if mode == .body, let main = mainCamera, let pose = poses[main.id], pose.present, let size = pose.size, size < 0.5 {
            list.append((false, "Person nur \(Int(size * 100)) % der Bildhöhe: näher an Kamera A oder Kamera näher stellen"))
        }
        return list
    }

    /// Aufnahmen mit Koerperdrehung: zu einer davon gehoert ein Gesichtsscan.
    var bodyCaptures: [CaptureEntry] { captures.filter { $0.meta?.marks["turnStart"] != nil } }

    /// Die Phasen der gewaehlten Aufnahme.
    var activeOptions: FlowOptions {
        var o = options
        o.body = mode == .body
        o.face = mode == .face
        if mode == .face { o.motion = false }
        return o
    }

    func startCapture() {
        guard !run.isActive else { return }
        abortRequested = false
        Task { await runCapture() }
    }

    func abortCapture() {
        abortRequested = true
    }

    private func fresh(_ id: String, _ now: Double) -> PoseObservation? {
        guard let pose = poses[id], now - pose.time < 1 else { return nil }
        return pose
    }

    private func runCapture() async {
        let cameras = recordingCameras
        guard let main = cameras.first, main.isConnected else { return run = .failed("Kamera A ist nicht verbunden.") }
        guard CaptureStore.validName(captureName) else { return run = .failed("Name: nur Buchstaben, Ziffern, - und _ (höchstens 40 Zeichen).") }
        guard store.isValid else { return run = .failed("Im Projektordner fehlt splat/process_capture.py.") }
        guard poseReady else { return run = .failed("Die Körpererkennung ist noch nicht bereit.") }
        let options = activeOptions
        let body = mode == .face && !faceBody.isEmpty ? faceBody : nil
        let name = store.freeName(body.map { "\($0)-gesicht" } ?? captureName)
        run = .starting
        // Alles Automatische festhalten, damit Belichtung und Farben ueber die ganze Aufnahme gleich bleiben (H-2).
        // Kameras, die schon eingerichtet sind, bleiben unveraendert.
        if autoConfigure {
            // Alles selbst richtig stellen; das dauert ein paar Sekunden.
            let toSwitch = cameras.filter { !isReadyForScan($0) }
            if !toSwitch.isEmpty {
                phaseTitle = "Kameras auf Hauptkamera und 4K stellen …"
                toSwitch.forEach { apply(.scan, to: $0) }
                try? await Task.sleep(nanoseconds: 2_500_000_000) // die Kamera startet mit der neuen Linse neu
            }
            phaseTitle = "Belichtung und Farben einpendeln und sperren …"
            await setupCameras(cameras)
        } else {
            let open = cameras.filter(needsSetup)
            if !open.isEmpty {
                phaseTitle = "Kameras einrichten und sperren …"
                await setupCameras(open)
            }
        }
        // Nach dem Umstellen muss wieder ein Livebild da sein, sonst wuerde blind aufgenommen.
        for _ in 0 ..< 40 where cameras.contains(where: { $0.stats.fps < 5 || $0.status?.width == 0 }) {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        guard main.isConnected, main.stats.fps >= 5 else {
            return run = .failed("Kamera A liefert nach dem Einstellen kein Livebild. Unter «Kameras» nachsehen.")
        }

        // Ab jetzt gilt die Lage der Kameras als Ausgangslage: «bewegt» heisst danach, waehrend der Aufnahme bewegt (H-18).
        for camera in cameras { camera.confirmPosition() }

        // Alle Kameras beginnen auf dasselbe Signal (M-3).
        let start = Clock.now + 0.5
        let keys = cameras.indices.map { String(Array("abcdefgh")[min($0, 7)]) }
        for (camera, key) in zip(cameras, keys) { camera.startRecording(name: "\(name)_\(key)", at: start) }
        try? await Task.sleep(nanoseconds: UInt64(max(0, start - Clock.now) * 1e9))

        let engine = FlowEngine(options: options)
        engine.onSay = { [weak self] text in self?.say(text, main: main) }
        self.engine = engine
        engine.start(now: Clock.now)
        run = .running
        while engine.isRunning, !abortRequested {
            let now = Clock.now
            if let observation = fresh(main.id, now) {
                engine.update(now: now, main: observation, others: cameras.dropFirst().compactMap { fresh($0.id, now) })
                poseStale = false
            } else {
                poseStale = true // ohne frische Erkennung nichts entscheiden, sonst gaelte ein Ausfall als «leerer Raum»
            }
            // Im Gesichtsscan misst das Gesichtsmodell zusaetzlich die Kopfdrehung von Kamera A.
            if engine.faceMode != faceModel {
                faceModel = engine.faceMode
                pose?.setFaceCamera(faceModel ? main.id : nil)
            }
            showPhase(engine, cameras)
            try? await Task.sleep(nanoseconds: 33_000_000)
        }
        faceModel = false
        pose?.setFaceCamera(nil)
        self.engine = nil
        poseStale = false

        if abortRequested {
            for camera in cameras { _ = try? await camera.stopRecording() }
            sendPhase(PhaseInfo(title: "Abgebrochen"), to: cameras)
            phaseTitle = "Abgebrochen"
            phaseProgress = 0
            return run = .idle
        }
        showPhase(engine, cameras)
        await finishCapture(name: name, body: body, cameras: cameras, keys: keys, engine: engine)
    }

    private func finishCapture(name: String, body: String?, cameras: [RemoteCamera], keys: [String], engine: FlowEngine) async {
        run = .saving("Aufnahme abschliessen …")
        var notes = engine.notes
        // Alle gleichzeitig stoppen.
        var infos: [Int: RecordingInfo] = [:]
        await withTaskGroup(of: (Int, RecordingInfo?, String?).self) { group in
            for (index, camera) in cameras.enumerated() {
                group.addTask { @MainActor in
                    do { return (index, try await camera.stopRecording(), nil) }
                    catch { return (index, nil, error.localizedDescription) }
                }
            }
            for await (index, info, error) in group {
                if let info, info.error == nil { infos[index] = info }
                else { notes.append("Kamera \(keys[index].uppercased()): \(info?.error ?? error ?? "Aufnahme fehlgeschlagen")") }
            }
        }
        guard let mainInfo = infos[0] else {
            sendPhase(PhaseInfo(title: "Aufnahme fehlgeschlagen", color: "bad"), to: cameras)
            return run = .failed("Kamera A hat nichts aufgenommen. " + notes.joined(separator: " "))
        }
        sendPhase(PhaseInfo(title: "Übertrage Aufnahme …", detail: "Handy nicht wegnehmen", color: "wait"), to: cameras)

        // Rohdateien in voller Qualitaet auf den Mac holen (H-8, D-1).
        let startA = cameras[0].hubTime(mainInfo.firstFrame)
        var saved: [String: CaptureMeta.Saved] = [:]
        var entries: [CaptureMeta.Camera] = []
        var lines: [String] = []
        for index in infos.keys.sorted() {
            let camera = cameras[index], info = infos[index]!, key = keys[index]
            let file = "\(name)_\(key).mov", sidecar = "\(name)_\(key).frames.json"
            run = .saving("Übertrage Kamera \(key.uppercased()) (\(info.bytes / 1_000_000) MB) …")
            do {
                try await camera.fetch(info.file, to: store.captures.appendingPathComponent(file))
                try await camera.fetch(info.sidecar, to: store.captures.appendingPathComponent(sidecar))
            } catch {
                notes.append("Kamera \(key.uppercased()): Übertragung fehlgeschlagen (\(error.localizedDescription)). Die Datei liegt noch auf dem Gerät.")
                if index == 0 { return run = .failed(notes.joined(separator: " ")) }
                continue
            }
            if isLocal(camera) { // liegt sonst doppelt auf derselben Platte
                camera.deleteRemote(info.file)
                camera.deleteRemote(info.sidecar)
            }
            let first = camera.hubTime(info.firstFrame)
            saved[key] = .init(saved: file, width: info.width, height: info.height, seconds: (info.seconds * 100).rounded() / 100)
            entries.append(.init(key: key, device: camera.name, model: camera.hello?.model ?? "", file: file, sidecar: sidecar,
                                 frames: info.frames, dropped: info.dropped, firstFrame: first, offset: startA - first,
                                 syncErrorMs: (camera.roundTrip ?? 0) * 500, status: camera.status))
            lines.append("Kamera \(key.uppercased()) (\(camera.name)): \(file), \(info.width)×\(info.height), "
                + String(format: "%.1f s, %d Bilder", info.seconds, info.frames) + (info.dropped > 0 ? ", \(info.dropped) verworfen" : ""))
            if info.dropped > info.frames / 50 { notes.append("Kamera \(key.uppercased()): \(info.dropped) Bilder verworfen, das Gerät kam nicht nach.") }
        }

        // Zeiten als Sekunden im Video A, so wie process_capture.py sie erwartet.
        var marks = engine.marks.mapValues { (($0 - startA) * 1000).rounded() / 1000 }
        for (label, value) in engine.degrees { marks[label] = Double(value) }
        let meta = CaptureMeta(name: name, marks: marks, offset: entries.first { $0.key == "b" }?.offset ?? 0, saved: saved,
                               notes: notes, height: heightCm / 100, body: body,
                               app: .init(created: ISO8601DateFormatter().string(from: Date()), options: engine.options, cameras: entries))
        do { try store.write(meta) } catch { return run = .failed("Metadatei konnte nicht geschrieben werden: \(error.localizedDescription)") }

        if let s = marks["turnStart"], let e = marks["turnEnd"] {
            lines.append(String(format: "Körper: %d° in %.1f s", abs(engine.degrees["turnedDegrees"] ?? 0), e - s))
        }
        if let s = marks["motionStart"], let e = marks["motionEnd"] {
            lines.append(String(format: "Freie Bewegung: %.1f s", e - s))
        }
        if let s = marks["faceStart"], let e = marks["faceEnd"] {
            let swept = abs(engine.degrees["faceDegrees"] ?? 0)
            lines.append(String(format: "Gesicht: %.1f s, Kopf über %d° gedreht", e - s, swept) + (body.map { ", gehört zu \($0)" } ?? ""))
        }
        sendPhase(PhaseInfo(title: "Fertig", detail: name, color: "ok"), to: cameras)
        captureName = CaptureStore.suggestedName()
        refreshCaptures()
        run = .finished(CaptureSummary(name: name, lines: lines, notes: notes))
    }

    private func showPhase(_ engine: FlowEngine, _ cameras: [RemoteCamera]) {
        phaseTitle = poseStale ? "Körpererkennung liefert kein Bild von Kamera A" : engine.title
        phaseProgress = engine.progress
        phaseGood = engine.good
        var info = PhaseInfo(title: engine.title, color: engine.phase == .done ? "ok" : (engine.good ? "ok" : "bad"),
                             progress: (engine.progress * 50).rounded() / 50)
        if engine.phase == .turnBody || engine.phase == .turnFace || engine.phase == .motion { info.color = "rec" }
        guard info != lastPhase else { return }
        lastPhase = info
        sendPhase(info, to: cameras)
    }

    private func sendPhase(_ info: PhaseInfo, to cameras: [RemoteCamera]) {
        for camera in cameras where !isLocal(camera) { camera.send(info) }
    }

    /// Die Ansage kommt von dort, wohin die Person schaut: vom Handy, wenn es Kamera A ist, sonst vom Mac (H-13).
    private func say(_ text: String, main: RemoteCamera) {
        // Ist Kamera A kein Handy, kann nur der Mac sprechen.
        let phone = !isLocal(main)
        if announce != .phone || !phone {
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "de-DE")
            speaker.speak(utterance)
        }
        if phone, announce != .mac {
            var info = lastPhase
            info.speak = text
            main.send(info)
        }
    }

    /// Probe, ob man die Ansage dort hoert, wo man steht.
    func testAnnouncement() {
        guard let main = mainCamera else { return }
        if lastPhase.title.isEmpty { lastPhase = PhaseInfo(title: "Ansage-Test", color: "wait") }
        say("Das ist ein Test der Ansage.", main: main)
    }

    // MARK: Ablage und Pipeline (M-9, M-10, M-15)

    func refreshCaptures() {
        captures = store.list()
    }

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = "Ordner «projekt» wählen (darin liegen server.py und der Ordner splat)."
        if panel.runModal() == .OK, let url = panel.url { projectDir = url }
    }

    func runPipeline(_ name: String) {
        guard !pipelineRunning else { return }
        pipelineLog = ""
        pipelineName = name
        reports[name] = nil
        do {
            try runner.run(["uv", "run", "process_capture.py", "captures/\(name).json"], in: projectDir.appendingPathComponent("splat"),
                           onOutput: { [weak self] in self?.appendLog($0) },
                           onExit: { [weak self] code in
                               guard let self else { return }
                               self.pipelineRunning = false
                               var report = QualityReport(log: self.pipelineLog)
                               if code != 0, report.failure == nil { report.failure = "Pipeline mit Fehler beendet (Code \(code))" }
                               self.reports[name] = report
                               self.refreshCaptures()
                           })
            pipelineRunning = true
        } catch {
            pipelineLog = "Start fehlgeschlagen: \(error.localizedDescription)\n"
        }
    }

    func cancelPipeline() {
        runner.cancel()
    }

    /// Zeilen mit Wagenruecklauf (Fortschrittsanzeigen) ersetzen die vorige Zeile, statt sich zu stapeln.
    private func appendLog(_ text: String) {
        for (index, part) in text.components(separatedBy: "\r").enumerated() {
            if index > 0 {
                if let newline = pipelineLog.lastIndex(of: "\n") { pipelineLog = String(pipelineLog[...newline]) } else { pipelineLog = "" }
            }
            pipelineLog += part
        }
        if pipelineLog.count > 200_000 { pipelineLog = String(pipelineLog.suffix(150_000)) }
    }

    func export(_ name: String) {
        let files = store.exportFiles(name)
        guard !files.isEmpty else { return message = "Für \(name) gibt es noch keinen Splat. Zuerst die Pipeline laufen lassen." }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Hierhin exportieren"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        let target = folder.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            for file in files {
                let copy = target.appendingPathComponent(file.lastPathComponent)
                try? FileManager.default.removeItem(at: copy)
                try FileManager.default.copyItem(at: file, to: copy)
            }
            NSWorkspace.shared.activateFileViewerSelecting([target])
        } catch {
            message = "Export fehlgeschlagen: \(error.localizedDescription)"
        }
    }

    func reveal(_ name: String) {
        let run = store.runURL(name)
        let target = FileManager.default.fileExists(atPath: run.path) ? run : store.metaURL(name)
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    // MARK: Browser-Seiten (M-14, Tracking)

    /// Startet server.py, falls er nicht schon laeuft, und oeffnet eine Seite des Prototyps.
    func openPage(_ path: String) {
        Task {
            guard await ensureServer() else {
                message = "server.py lässt sich nicht starten. Im Projektordner einmal «uv sync» ausführen, dann «uv run server.py» testen."
                return
            }
            if let url = URL(string: "http://127.0.0.1:8931/\(path)") { NSWorkspace.shared.open(url) }
        }
    }

    func checkServer() async {
        serverRunning = await AppModel.reachable()
    }

    private static func reachable() async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8931/index.html")!)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 1
        return ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode == 200
    }

    private func ensureServer() async -> Bool {
        if await AppModel.reachable() { serverRunning = true; return true }
        let python = projectDir.appendingPathComponent(".venv/bin/python")
        guard FileManager.default.isExecutableFile(atPath: python.path) else { return false }
        let process = Process()
        process.executableURL = python
        process.arguments = ["server.py"]
        process.currentDirectoryURL = projectDir
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = PipelineRunner.searchPath // server.py ruft ffmpeg auf
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return false }
        server = process
        for _ in 0 ..< 30 {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if await AppModel.reachable() { serverRunning = true; return true }
        }
        return false
    }

    // MARK: Hilfen

    private func save<T: Encodable>(_ value: T, _ key: String) {
        defaults.set(try? JSONEncoder().encode(value), forKey: key)
    }

    private func load<T: Decodable>(_ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    /// Fuer Tests ohne Kamera: `--video <Datei>` spielt ein Video als Kamera ab, `--testbild` zeigt ein Testbild,
    /// `--auto` startet den Ablauf von selbst und schreibt den Verlauf ins Protokoll.
    private func handleLaunchArguments() {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--video"), index + 1 < arguments.count {
            addVideoFile(URL(fileURLWithPath: arguments[index + 1]))
        }
        if arguments.contains("--testbild") { addTestPattern() }
        if let index = arguments.firstIndex(of: "--name"), index + 1 < arguments.count { captureName = arguments[index + 1] }
        if arguments.contains("--ohne-bewegung") { options.motion = false }
        if arguments.contains("--nur-gesicht") { options.background = false; mode = .face }
        if let index = arguments.firstIndex(of: "--pose-log"), index + 1 < arguments.count {
            // Jede Beobachtung von Kamera A in eine Datei: Zeit, Person da, Blickrichtung, Hinweise.
            FileManager.default.createFile(atPath: arguments[index + 1], contents: nil)
            let handle = FileHandle(forWritingAtPath: arguments[index + 1])
            var seen = 0.0
            $poses.sink { [weak self] poses in
                guard let id = self?.mainCamera?.id, let pose = poses[id], pose.time != seen else { return }
                seen = pose.time
                let line = String(format: "%.3f %d %@ %@ [%@|%@]\n", pose.time, pose.present ? 1 : 0,
                                  pose.yaw.map { String(format: "%.0f", $0) } ?? "-",
                                  pose.headYaw.map { String(format: "%.0f", $0) } ?? "-", pose.hintBody, pose.hintFace)
                handle?.write(Data(line.utf8))
            }.store(in: &bag)
        }
        guard arguments.contains("--auto") else { return }
        setvbuf(stdout, nil, _IOLBF, 0)
        Task {
            // Warten, bis Kamera und Koerpererkennung bereit sind, dann die Datei von vorne beginnen und aufnehmen.
            for _ in 0 ..< 300 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                if poseReady, let main = mainCamera, main.isConnected, main.stats.fps > 5, poses[main.id] != nil { break }
            }
            print("AUTO bereit: Körpererkennung \(poseReady), Kamera \(mainCamera?.name ?? "keine"), Fehler \(poseError ?? "-")")
            if let main = mainCamera { restartFile(main) }
            startCapture()
            var last = ""
            while true {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if phaseTitle != last { last = phaseTitle; print("AUTO \(String(format: "%.1f", Clock.now)) \(phaseTitle)") }
                switch run {
                case .finished(let summary):
                    print("AUTO fertig: \(summary.name)\n" + (summary.lines + summary.notes).joined(separator: "\n"))
                    exit(0)
                case .failed(let text):
                    print("AUTO fehlgeschlagen: \(text)")
                    exit(1)
                default:
                    break
                }
            }
        }
    }
}
