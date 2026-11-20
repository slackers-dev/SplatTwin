import SplattwinKit
import SwiftUI

/// Gefuehrte Aufnahme: leerer Raum, Pose, Drehung, optional Gesichtsscan (M-4, A-1 bis A-7).
struct CaptureView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            ScrollView { settings.padding(16) }
                .frame(width: 340)
            Divider()
            VStack(spacing: 12) {
                phase
                stage
            }
            .padding(16)
        }
        .navigationTitle("Aufnahme")
    }

    // MARK: Einstellungen und Pruefung

    private var settings: some View {
        VStack(alignment: .leading, spacing: 14) {
            GroupBox("Aufnahme") {
                Form {
                    Picker("Was", selection: $model.mode) {
                        ForEach(CaptureMode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if model.mode == .face {
                        Picker("Gehört zu", selection: $model.faceBody) {
                            Text("keiner Aufnahme").tag("")
                            ForEach(model.bodyCaptures) { Text($0.name).tag($0.name) }
                        }
                        Text("Nah an die Kamera setzen, bis Kopf und Schultern das Bild füllen. Die App führt: Kopf langsam zur einen Seite, zur anderen, zurück zur Mitte.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    TextField("Name", text: $model.captureName)
                        .disabled(model.mode == .face && !model.faceBody.isEmpty)
                    TextField("Körpergrösse (cm)", value: $model.heightCm, format: .number.precision(.fractionLength(0)))
                        .help("Legt den Massstab des Splats fest")
                    Toggle("Leerer Raum zuerst (\(Int(model.options.bgSeconds)) s)", isOn: $model.options.background)
                    if model.mode == .body {
                        TextField("Drehung etwa (s)", value: $model.options.turnSeconds, format: .number)
                            .help("Nur ein Richtwert für die Ansage «Langsamer»; langsamer drehen ist erlaubt")
                        Toggle("Danach frei bewegen (\(Int(model.options.motionSeconds)) s, für später)", isOn: $model.options.motion)
                    }
                }
                .padding(4)
                .disabled(model.run.isActive)
            }
            GroupBox("Kameras") {
                VStack(alignment: .leading, spacing: 6) {
                    if model.cameras.isEmpty { Text("Unter «Kameras» ein Gerät koppeln.").foregroundStyle(.secondary) }
                    Picker("Kamera A (vorne)", selection: Binding(get: { model.mainCamera?.id ?? "" }, set: { model.mainCameraID = $0 })) {
                        ForEach(model.cameras) { Text($0.name).tag($0.id) }
                    }
                    ForEach(model.cameras.filter { $0.id != model.mainCamera?.id }) { camera in
                        Toggle("\(camera.name) nimmt mit auf", isOn: Binding(
                            get: { !model.excluded.contains(camera.id) },
                            set: { if $0 { model.excluded.remove(camera.id) } else { model.excluded.insert(camera.id) } }))
                    }
                    Text("Zu Kamera A schaut die Person am Anfang. Weitere Kameras auf anderer Höhe ergeben saubereren Kopf und Schultern.")
                        .font(.caption).foregroundStyle(.secondary)
                    Divider()
                    Toggle("Kameras beim Start automatisch einstellen", isOn: $model.autoConfigure)
                    Text(model.autoConfigure
                         ? "Beim Klick auf «Aufnahme starten» stellt die App jedes Handy auf Hauptkamera, 4K und hochkant, lässt Belichtung, Fokus und Weissabgleich einpendeln und sperrt sie. Das dauert ein paar Sekunden. Vorher schon ansehen, wie das Bild wird: «Für Scan einstellen»."
                         : "Die Kameras bleiben so, wie sie eingestellt sind; was noch auf Automatik steht, wird beim Start gesperrt.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let main = model.mainCamera, model.hasPhoneLenses(main) {
                        Button("Für Scan einstellen: Hauptkamera, 4K, hochkant") { model.apply(.scan, to: main) }
                            .disabled(!main.isConnected || model.isReadyForScan(main))
                        Text("Mit der Hauptkamera etwa zwei Meter Abstand, Handy auf Brusthöhe und senkrecht: Kopf und Füsse sollen gerade noch im Bild sein.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button(model.settingUp ? "Richte ein …" : "Einrichten und sperren") { Task { await model.setupCameras() } }
                            .disabled(model.settingUp || model.recordingCameras.isEmpty)
                        if model.settingUp { ProgressView().controlSize(.small) }
                    }
                    Text("Zum Prüfen von Helligkeit und Farben vor dem Start; beim Start geschieht es ohnehin.")
                        .font(.caption).foregroundStyle(.secondary)
                    Divider()
                    HStack {
                        Picker("Ansage", selection: $model.announce) {
                            ForEach(Announce.allCases) { Text($0.rawValue).tag($0) }
                        }
                        Button("Testen") { model.testAnnouncement() }
                    }
                }
                .padding(4)
                .disabled(model.run.isActive)
            }
            GroupBox("Prüfung vor dem Start") {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(model.preflight().enumerated()), id: \.offset) { _, item in
                        Label(item.text, systemImage: item.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(item.ok ? Color.primary : Color.orange)
                            .font(.callout)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }
            result
        }
    }

    @ViewBuilder private var result: some View {
        switch model.run {
        case .finished(let summary):
            GroupBox("Gespeichert: \(summary.name)") {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(summary.lines, id: \.self) { Text($0).font(.callout) }
                    ForEach(summary.notes, id: \.self) { Label($0, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.callout) }
                    HStack {
                        Button("Splat rechnen") { model.runPipeline(summary.name) }.disabled(model.pipelineRunning)
                        Button("Im Finder zeigen") { model.reveal(summary.name) }
                    }
                    if model.pipelineName == summary.name {
                        Text(model.pipelineRunning ? "Pipeline läuft – Fortschritt unter «Aufnahmen»." : "Pipeline beendet – Ergebnis unter «Aufnahmen».")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }
        case .failed(let text):
            GroupBox("Fehlgeschlagen") {
                Text(text).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
        default:
            EmptyView()
        }
    }

    // MARK: Anzeige waehrend der Aufnahme

    private var phase: some View {
        VStack(spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                if model.run == .running { Image(systemName: "circle.fill").foregroundStyle(.red).font(.title2) }
                Text(title)
                    .font(.system(size: 34, weight: .semibold))
                    .lineLimit(2)
                    .minimumScaleFactor(0.5)
                Spacer()
                if model.run.isActive {
                    Button("Abbrechen", role: .cancel) { model.abortCapture() }
                        .disabled(model.run != .running)
                } else {
                    Button("Aufnahme starten") { model.startCapture() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.mainCamera?.isConnected != true)
                }
            }
            ProgressView(value: progress)
                .tint(model.phaseGood ? .green : .accentColor)
        }
    }

    private var title: String {
        switch model.run {
        case .idle, .finished, .failed: return model.run == .idle ? "Bereit" : model.phaseTitle
        case .starting, .running: return model.phaseTitle
        case .saving(let text): return text
        }
    }

    private var progress: Double {
        if case .saving = model.run { return model.recordingCameras.compactMap(\.transfer).first ?? 0 }
        return model.run.isActive ? model.phaseProgress : 0
    }

    private var stage: some View {
        HStack(spacing: 12) {
            if let main = model.mainCamera {
                CaptureTile(camera: main, label: "A")
            } else {
                ContentUnavailableView("Keine Kamera", systemImage: "camera", description: Text("Unter «Kameras» ein Gerät koppeln."))
            }
            let others = model.recordingCameras.dropFirst()
            if !others.isEmpty {
                VStack(spacing: 12) {
                    ForEach(Array(others)) { camera in
                        CaptureTile(camera: camera, label: model.key(of: camera)?.uppercased() ?? "")
                    }
                }
                .frame(maxWidth: 320)
            }
        }
        .frame(maxHeight: .infinity)
    }
}

/// Livebild mit dem Ergebnis der Live-Pruefung dieser Kamera (M-5).
private struct CaptureTile: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var camera: RemoteCamera
    let label: String

    var body: some View {
        let pose = model.poses[camera.id]
        let stale = pose.map { Clock.now - $0.time > 1 } ?? true
        LiveImage(camera: camera, pose: stale ? nil : pose, faceMode: model.mode == .face)
            .overlay(alignment: .topLeading) {
                Text("\(label) · \(text(pose, stale))")
                    .font(.headline)
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 6))
                    .foregroundStyle(.white)
                    .padding(8)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).stroke(border(pose, stale), lineWidth: 3) }
    }

    private func text(_ pose: PoseObservation?, _ stale: Bool) -> String {
        guard camera.isConnected else { return CameraText.state(camera) }
        guard let pose, !stale else { return camera.stats.fps > 0 ? "Körpererkennung wartet" : "kein Bild" }
        guard pose.present else { return "niemand" }
        let hint = pose.hint(face: model.mode == .face)
        return hint.isEmpty ? "gut im Bild" : hint
    }

    private func border(_ pose: PoseObservation?, _ stale: Bool) -> Color {
        guard let pose, !stale, pose.present else { return .secondary.opacity(0.4) }
        return pose.hint(face: model.mode == .face).isEmpty ? .green : .red
    }
}
