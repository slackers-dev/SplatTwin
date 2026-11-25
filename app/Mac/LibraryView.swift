import SplattwinKit
import SwiftUI

/// Aufnahmen verwalten, Pipeline starten, Ergebnis ansehen und exportieren (M-9, M-10, M-14, M-15).
struct LibraryView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selected: String?

    private var entry: CaptureEntry? { model.captures.first { $0.name == selected } ?? model.captures.first }

    var body: some View {
        HSplitView {
            List(model.captures, selection: $selected) { item in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(item.name).font(.headline)
                        if item.hasSplat { Image(systemName: "cube.fill").foregroundStyle(.green).help("Splat vorhanden") }
                        if model.pipelineRunning, model.pipelineName == item.name { ProgressView().controlSize(.small) }
                    }
                    Text(item.date.formatted(date: .abbreviated, time: .shortened) + (item.fromApp ? "" : " · aus dem Browser"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                .tag(item.name)
            }
            .frame(minWidth: 220, idealWidth: 250, maxWidth: 320)
            if let entry {
                CaptureDetail(entry: entry).frame(minWidth: 480)
            } else {
                ContentUnavailableView("Noch keine Aufnahme", systemImage: "square.stack.3d.up",
                                       description: Text(model.store.isValid ? "Unter «Aufnahme» die erste Drehung aufnehmen."
                                                         : "Projektordner wählen: darin liegen python/, web/ und data/."))
            }
        }
        .navigationTitle("Aufnahmen")
        .toolbar {
            ToolbarItemGroup {
                Button { model.refreshCaptures() } label: { Label("Neu laden", systemImage: "arrow.clockwise") }
                Button { model.chooseProject() } label: { Label("Projektordner …", systemImage: "folder") }
                    .help(model.projectDir.path)
            }
        }
        .onAppear { model.refreshCaptures() }
    }
}

private struct CaptureDetail: View {
    @EnvironmentObject private var model: AppModel
    let entry: CaptureEntry

    private var isCurrent: Bool { model.pipelineName == entry.name }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(entry.name).font(.title2).bold()
                Spacer()
                if model.pipelineRunning, isCurrent {
                    Button("Pipeline abbrechen", role: .destructive) { model.cancelPipeline() }
                } else {
                    Button(entry.meta?.body != nil ? "Kopf rechnen und aufsetzen" : entry.hasSplat ? "Neu rechnen" : "Splat rechnen") { model.runPipeline(entry.name) }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.pipelineRunning)
                }
                Button("Splat ansehen") { model.openPage("viewer.html?run=\(entry.name)") }.disabled(!entry.hasSplat)
                Button("Avatar testen") { model.openPage("tracking.html?run=\(entry.name)") }.disabled(!entry.hasSplat)
                Menu {
                    Button("Exportieren …") { model.export(entry.name) }
                    Button("Im Finder zeigen") { model.reveal(entry.name) }
                    Button("Mit denselben Einstellungen wiederholen") { model.captureName = entry.name }
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
            }
            if let report = model.reports[entry.name] { ReportView(report: report) }
            if let meta = entry.meta { facts(meta) } else {
                Text("Aufnahme aus capture.html: nur die Zeiten sind bekannt, keine Kameradaten.").foregroundStyle(.secondary)
            }
            if isCurrent {
                LogView(text: model.pipelineLog)
            } else {
                Spacer()
            }
        }
        .padding(16)
    }

    private func facts(_ meta: CaptureMeta) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(meta.app.cameras, id: \.key) { camera in
                let saved = meta.saved[camera.key]
                Text("Kamera \(camera.key.uppercased()) · \(camera.device) · \(saved?.width ?? 0)×\(saved?.height ?? 0) · "
                    + String(format: "%.1f s · %d Bilder", saved?.seconds ?? 0, camera.frames)
                    + (camera.dropped > 0 ? " · \(camera.dropped) verworfen" : "")
                    + (camera.key == "a" ? "" : String(format: " · Versatz %+.3f s (±%.1f ms)", camera.offset, camera.syncErrorMs)))
                    .font(.callout).monospacedDigit()
            }
            let marks = meta.marks
            Text([
                marks["bgStart"].map { String(format: "Leerer Raum %.1f–%.1f s", $0, marks["bgEnd"] ?? 0) },
                marks["turnStart"].map { String(format: "Körper %.1f–%.1f s (%.0f°)", $0, marks["turnEnd"] ?? 0, abs(marks["turnedDegrees"] ?? 0)) },
                marks["motionStart"].map { String(format: "Bewegung %.1f–%.1f s", $0, marks["motionEnd"] ?? 0) },
                marks["faceStart"].map { String(format: "Gesicht %.1f–%.1f s", $0, marks["faceEnd"] ?? 0) },
                meta.body.map { "Gesicht zu \($0)" },
                String(format: "Körpergrösse %.2f m", meta.height),
            ].compactMap { $0 }.joined(separator: " · "))
                .font(.callout).foregroundStyle(.secondary).monospacedDigit()
            ForEach(meta.notes, id: \.self) { Label($0, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.callout) }
        }
    }
}

/// Qualitaetsbericht der Pipeline mit Ampel (M-10, D-4).
private struct ReportView: View {
    let report: QualityReport

    var body: some View {
        HStack(spacing: 14) {
            Label(report.verdict.capitalized, systemImage: "circle.fill")
                .foregroundStyle(color)
                .font(.headline)
            if let registered = report.registered, let total = report.total {
                Text("\(registered) von \(total) Bildern registriert")
            }
            ForEach(report.arcs.keys.sorted(), id: \.self) { key in
                Text("Kamerabahn \(key.uppercased()): \(report.arcs[key] ?? 0)°")
            }
            ForEach(report.cover.keys.sorted(), id: \.self) { key in
                Text("Person füllt \(report.cover[key] ?? 0) % (\(key.uppercased()))")
            }
            if let failure = report.failure { Text(failure).foregroundStyle(.red).lineLimit(2) }
            Spacer()
        }
        .padding(10)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var color: Color {
        switch report.verdict {
        case "gut": return .green
        case "brauchbar": return .yellow
        case "wiederholen": return .red
        default: return .secondary
        }
    }
}

private struct LogView: View {
    let text: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? "Noch keine Ausgabe." : text)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
                Color.clear.frame(height: 1).id("ende")
            }
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
            .onChange(of: text) { proxy.scrollTo("ende") }
        }
    }
}

/// Livebetrieb: Kameras der App im Browser nutzen, Kameraabstand eintragen (T-1, T-3, T-7 bis T-9).
struct TrackingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Live-Avatar im Browser") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Die Tracking-Seite läuft weiter im Browser. Die Kameras dieser App erscheinen dort in der Kameraliste als «Splattwin: …» und bringen Aufnahmezeit und Kameradaten zu jedem Bild mit.")
                        HStack {
                            Button("Live-Avatar öffnen") { model.openPage("tracking.html") }.buttonStyle(.borderedProminent)
                            Label(model.serverRunning ? "Server läuft" : "Server wird beim Öffnen gestartet",
                                  systemImage: model.serverRunning ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(model.serverRunning ? .green : .secondary)
                            Spacer()
                            if let error = model.bridgeError {
                                Label("Brücke nicht gestartet: \(error)", systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                            } else {
                                Label("\(model.bridgeClients) Seite(n) verbunden", systemImage: "point.3.connected.trianglepath.dotted")
                                    .foregroundStyle(model.bridgeClients > 0 ? .green : .secondary)
                            }
                        }
                    }
                    .padding(6)
                }
                GroupBox("Massstab") {
                    HStack {
                        Text("Abstand zwischen den beiden Kameras (Messband)")
                        TextField("Meter", value: $model.baseline, format: .number.precision(.fractionLength(2)))
                            .frame(width: 80)
                            .textFieldStyle(.roundedBorder)
                        Text("m")
                        Spacer()
                        Text(model.baseline > 0 ? "Die Stereo-Kalibrierung der Seite wird auf diesen Abstand skaliert." : "0 = Massstab wie bisher aus der Körperschätzung.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(6)
                }
                GroupBox("Kameras") {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                        GridRow {
                            Text("Kamera"); Text("Linse"); Text("Livebild"); Text("Verzögerung"); Text("Öffnungswinkel"); Text("Verzeichnung")
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        ForEach(model.cameras) { TrackingRow(camera: $0) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                    let phones = model.cameras.filter { $0.isConnected && model.hasPhoneLenses($0) }
                    if !phones.isEmpty {
                        HStack {
                            Button("Für Tracking einstellen: Ultraweitwinkel") { phones.forEach { model.apply(.tracking, to: $0) } }
                            Text("Danach die Stereo-Kalibrierung auf der Seite neu machen.").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 6).padding(.bottom, 6)
                    }
                }
                Text("Ändert sich Linse, Format oder Ausrichtung, meldet die App das der Seite: sie verwirft dann die alte Stereo-Kalibrierung. Wurde ein Handy bewegt, steht das unter «Kameras».")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(16)
        }
        .navigationTitle("Tracking")
        .task { await model.checkServer() }
    }
}

private struct TrackingRow: View {
    @ObservedObject var camera: RemoteCamera

    var body: some View {
        let k = camera.status?.intrinsics
        GridRow {
            Text(camera.name)
            Text(camera.status?.config.lens.label ?? "–")
            Text(camera.isConnected ? String(format: "%d×%d, %.0f B/s", camera.stats.width, camera.stats.height, camera.stats.fps) : CameraText.state(camera))
            Text(camera.isConnected ? String(format: "%.0f ms", camera.stats.latency * 1000) : "–")
            Text(k.map { String(format: "%.1f° × %.1f° (%@)", $0.fovX, $0.fovY, $0.source == "device" ? "gemessen" : "geschätzt") } ?? "unbekannt")
            Text(k.map { $0.distortion == "corrected" ? "entfernt" : "im Bild" } ?? "–")
        }
        .monospacedDigit()
    }
}
