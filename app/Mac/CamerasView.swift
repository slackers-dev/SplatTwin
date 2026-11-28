import SplattwinKit
import SwiftUI
import UniformTypeIdentifiers

/// Geraete koppeln, Livebilder sehen, jede Kamera einstellen (M-1, M-2, M-16, M-19, M-20).
struct CamerasView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selected: String?
    @State private var enlarged = false
    @State private var codes: [String: String] = [:]
    @State private var setupName = ""
    @State private var askSetupName = false
    @State private var pickFile = false

    private var selectedCamera: RemoteCamera? { model.cameras.first { $0.id == selected } ?? model.cameras.first }

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    discovery
                    if model.cameras.isEmpty {
                        ContentUnavailableView("Noch keine Kamera", systemImage: "iphone.gen3",
                                               description: Text("Die App «Splattwin Kamera» auf dem iPhone öffnen. Mac und iPhone müssen im selben WLAN sein oder Bluetooth und WLAN eingeschaltet haben."))
                            .frame(maxWidth: .infinity, minHeight: 300)
                    } else if enlarged, let camera = selectedCamera {
                        CameraTile(camera: camera, selected: true)
                            .frame(maxWidth: .infinity, minHeight: 520)
                            .onTapGesture(count: 2) { enlarged = false }
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 12)], spacing: 12) {
                            ForEach(model.cameras) { camera in
                                CameraTile(camera: camera, selected: camera.id == selectedCamera?.id)
                                    .frame(height: 340)
                                    .onTapGesture(count: 2) { selected = camera.id; enlarged = true }
                                    .onTapGesture { selected = camera.id }
                            }
                        }
                    }
                }
                .padding(16)
            }
            if let camera = selectedCamera {
                Divider()
                CameraInspector(camera: camera)
                    .frame(width: 330)
                    .id(camera.id)
            }
        }
        .navigationTitle("Kameras")
        .toolbar {
            ToolbarItemGroup {
                Toggle(isOn: $enlarged) { Label("Gross zeigen", systemImage: "arrow.up.left.and.arrow.down.right") }
                    .help("Ausgewählte Kamera gross zeigen (auch Doppelklick auf das Bild)")
                Menu {
                    Button("Mac-Kamera") { model.addMacCamera() }
                    Button("Videodatei als Kamera …") { pickFile = true }
                    Button("Testbild") { model.addTestPattern() }
                } label: { Label("Hinzufügen", systemImage: "plus") }
                Menu {
                    Button("Aktuellen Aufbau speichern …") { askSetupName = true }
                    if !model.setups.isEmpty { Divider() }
                    ForEach(model.setups) { setup in
                        Button("Laden: \(setup.name)") { model.loadSetup(setup) }
                    }
                    if !model.setups.isEmpty {
                        Divider()
                        Menu("Löschen") {
                            ForEach(model.setups) { setup in
                                Button(setup.name) { model.setups.removeAll { $0.name == setup.name } }
                            }
                        }
                    }
                } label: { Label("Aufbau", systemImage: "tray.full") }
            }
        }
        .fileImporter(isPresented: $pickFile, allowedContentTypes: [.movie]) { result in
            if case .success(let url) = result { model.addVideoFile(url) }
        }
        .alert("Aufbau speichern", isPresented: $askSetupName) {
            TextField("Name, z.B. Wohnzimmer", text: $setupName)
            Button("Speichern") { if !setupName.isEmpty { model.saveSetup(setupName) } }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Speichert Linse, Format, Belichtung, Fokus und Weissabgleich aller Kameras sowie den Kameraabstand.")
        }
    }

    /// Handys im Netz, die noch nicht gekoppelt sind.
    @ViewBuilder private var discovery: some View {
        let open = model.hub.found.filter { model.hub.camera($0.name) == nil }
        if !open.isEmpty {
            GroupBox("Geräte im Netz und am Kabel") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(open) { item in
                        HStack {
                            Image(systemName: item.wired ? "cable.connector" : "iphone.gen3")
                            Text(item.wired ? "\(item.name) (Kabel)" : item.name)
                            Spacer()
                            TextField("Code vom Handy", text: Binding(get: { codes[item.name] ?? "" }, set: { codes[item.name] = $0 }))
                                .frame(width: 130)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { model.pair(item, code: codes[item.name] ?? "") }
                            Button("Koppeln") { model.pair(item, code: codes[item.name] ?? "") }
                        }
                    }
                }
                .padding(6)
            }
        }
    }
}

struct CameraTile: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var camera: RemoteCamera
    var selected = false

    var body: some View {
        let alerts = CameraText.alerts(camera)
        VStack(spacing: 0) {
            LiveImage(camera: camera, pose: model.poses[camera.id])
                .overlay(alignment: .topLeading) {
                    HStack(spacing: 6) {
                        if let key = model.key(of: camera) {
                            Text(key.uppercased()).bold().padding(.horizontal, 7).padding(.vertical, 2)
                                .background(.green.opacity(0.85), in: RoundedRectangle(cornerRadius: 5))
                        }
                        Text(camera.wired ? "\(camera.name) · Kabel" : camera.name).padding(.horizontal, 7).padding(.vertical, 2)
                            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 5))
                    }
                    .foregroundStyle(.white)
                    .padding(8)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(CameraText.line(camera)).font(.caption).monospacedDigit()
                ForEach(alerts, id: \.self) { alert in
                    Label(alert, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(.background.secondary)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(selected ? Color.accentColor : Color.secondary.opacity(0.3), lineWidth: selected ? 3 : 1)
        }
        .contentShape(Rectangle())
    }
}

/// Fernsteuerung einer Kamera (H-2, H-3, H-16, T-2).
struct CameraInspector: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var camera: RemoteCamera

    private var lens: LensInfo? {
        let lenses = camera.hello?.lenses ?? []
        return lenses.first { camera.config.deviceID != nil ? $0.id == camera.config.deviceID : $0.lens == camera.config.lens } ?? lenses.first
    }

    /// Aenderung sofort an die Kamera schicken.
    private func bind<T>(_ path: WritableKeyPath<CameraConfig, T>) -> Binding<T> {
        Binding(get: { camera.config[keyPath: path] }, set: {
            camera.config[keyPath: path] = $0
            model.changed(camera)
        })
    }

    /// Fuer Schieberegler: erst beim Loslassen schicken.
    private func draft(_ path: WritableKeyPath<CameraConfig, Double?>, _ fallback: Double) -> Binding<Double> {
        Binding(get: { camera.config[keyPath: path] ?? fallback }, set: { camera.config[keyPath: path] = $0 })
    }

    private func commit(_ editing: Bool) {
        if !editing { model.changed(camera) }
    }

    var body: some View {
        Form {
            Section("Verbindung") {
                LabeledContent("Zustand", value: CameraText.state(camera))
                if let hello = camera.hello { LabeledContent("Gerät", value: "\(hello.model), \(hello.system)") }
                if let offset = camera.clockOffset, let trip = camera.roundTrip {
                    LabeledContent("Uhrenabgleich", value: String(format: "%+.1f ms, genau auf ±%.1f ms", offset * 1000, trip * 500))
                }
                Picker("Rolle", selection: Binding(get: { model.mainCamera?.id == camera.id ? 0 : (model.excluded.contains(camera.id) ? 2 : 1) },
                                                   set: { role in
                    model.excluded.remove(camera.id)
                    if role == 0 { model.mainCameraID = camera.id }
                    if role == 2 { model.excluded.insert(camera.id) }
                })) {
                    Text("Kamera A (vorne)").tag(0)
                    Text("nimmt mit auf").tag(1)
                    Text("nur ansehen").tag(2)
                }
                HStack {
                    if camera.status?.moved == true { Button("Lage bestätigen") { camera.confirmPosition() } }
                    if case .failed = camera.state { Button("Neu verbinden") { camera.connect() } }
                    Spacer()
                    Button("Entfernen", role: .destructive) { model.remove(camera) }
                }
            }
            if camera.isConnected { controls }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder private var controls: some View {
        let status = camera.status
        Section("Linse und Format") {
            Picker("Linse", selection: Binding(get: { lens?.id ?? "" }, set: selectLens)) {
                ForEach(camera.hello?.lenses ?? [], id: \.id) { Text($0.name).tag($0.id) }
            }
            if let formats = lens?.formats, !formats.isEmpty {
                Picker("Auflösung", selection: Binding(get: { "\(camera.config.width)x\(camera.config.height)" }, set: selectFormat)) {
                    ForEach(formats, id: \.self) { Text("\($0.width)×\($0.height)").tag("\($0.width)x\($0.height)") }
                }
                let top = formats.first { $0.width == camera.config.width && $0.height == camera.config.height }?.maxFPS ?? 30
                Picker("Bilder pro Sekunde", selection: bind(\.fps)) {
                    ForEach([24, 25, 30, 60, 120].filter { $0 <= top }, id: \.self) { Text("\($0)").tag($0) }
                }
            }
            Picker("Ausrichtung", selection: bind(\.rotation)) {
                Text("Hochformat").tag(90)
                Text("Querformat").tag(0)
                Text("Hochformat, kopfüber").tag(270)
                Text("Querformat, kopfüber").tag(180)
            }
            if let status { LabeledContent("Aufnahme", value: "\(status.width)×\(status.height), \(String(format: "%.0f", status.fps)) B/s") }
        }
        Section("Belichtung") {
            Picker("Belichtung", selection: bind(\.exposure)) {
                ForEach(LockMode.allCases.filter { $0 != .manual || lens?.manualExposure == true }, id: \.self) { Text($0.label).tag($0) }
            }
            if camera.config.exposure == .manual, let lens {
                Picker("Verschlusszeit", selection: Binding(get: { nearestShutter }, set: { wanted in
                    // Helligkeit behalten: kuerzere Verschlusszeit heisst hoehere ISO.
                    if let values = model.exposure(for: camera, shutter: wanted) {
                        camera.config.iso = values.iso
                        camera.config.shutter = values.shutter
                    } else {
                        camera.config.shutter = wanted
                    }
                    model.changed(camera)
                })) {
                    ForEach(CameraInspector.shutters, id: \.self) { Text(CameraText.shutter($0)).tag($0) }
                }
                Slider(value: draft(\.iso, status?.iso ?? lens.minISO), in: lens.minISO ... max(lens.minISO + 1, lens.maxISO), onEditingChanged: commit) {
                    Text("ISO")
                }
                Text("Kurze Verschlusszeit = weniger Bewegungsunschärfe. 1/50 und 1/100 s flimmern bei Kunstlicht nicht.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let iso = status?.iso { LabeledContent("Aktuell", value: "ISO \(Int(iso)), \(CameraText.shutter(status?.shutter))") }
        }
        Section("Fokus und Weissabgleich") {
            Picker("Fokus", selection: bind(\.focus)) {
                ForEach(LockMode.allCases.filter { $0 != .manual || lens?.manualFocus == true }, id: \.self) { Text($0.label).tag($0) }
            }
            if camera.config.focus == .manual {
                Slider(value: draft(\.lensPosition, status?.lensPosition ?? 0.7), in: 0 ... 1, onEditingChanged: commit) { Text("Nah – Fern") }
            }
            Picker("Weissabgleich", selection: bind(\.whiteBalance)) {
                ForEach(LockMode.allCases.filter { $0 != .manual || lens?.manualWhiteBalance == true }, id: \.self) { Text($0.label).tag($0) }
            }
            if camera.config.whiteBalance == .manual {
                Slider(value: draft(\.temperature, status?.temperature ?? 5000), in: 2500 ... 8000, onEditingChanged: commit) { Text("Kelvin") }
            }
            if let kelvin = status?.temperature {
                LabeledContent("Aktuell", value: "\(Int(kelvin)) K" + (kelvin < 4000 ? " (warmes Kunstlicht)" : kelvin > 5500 ? " (Tageslicht)" : ""))
            }
            Button("Jetzt alles sperren") { model.lockAll(camera) }
                .help("Hält Belichtung, Fokus und Weissabgleich an der aktuellen Stelle fest")
        }
        Section("Livebild") {
            Toggle("Livebild senden", isOn: bind(\.streamEnabled))
            Picker("Längere Seite", selection: bind(\.streamMaxSide)) {
                ForEach([640, 960, 1280, 1920], id: \.self) { Text("\($0) px").tag($0) }
            }
            Picker("Bilder pro Sekunde", selection: bind(\.streamFPS)) {
                ForEach([10, 15, 30, 60], id: \.self) { Text("\($0)").tag($0) }
            }
            Slider(value: Binding(get: { camera.config.streamQuality }, set: { camera.config.streamQuality = $0 }),
                   in: 0.3 ... 0.9, onEditingChanged: commit) { Text("Qualität") }
        }
        if let status {
            Section("Kameradaten und Gerät") {
                if let k = status.intrinsics {
                    LabeledContent("Öffnungswinkel", value: String(format: "%.1f° × %.1f°", k.fovX, k.fovY))
                    LabeledContent("Quelle", value: k.source == "device" ? "vom Gerät pro Bild gemessen" : "aus dem Format geschätzt")
                    LabeledContent("Verzeichnung", value: k.distortion == "corrected" ? "im Bild bereits entfernt" : "noch im Bild")
                } else {
                    LabeledContent("Kameradaten", value: "unbekannt – Schachbrett verwenden")
                }
                check("HDR aus", !status.hdr)
                check("Stabilisierung aus", !status.stabilization)
                check("Center Stage aus", !status.centerStage)
                LabeledContent("Farbraum", value: status.colorSpace)
                if let battery = status.battery {
                    LabeledContent("Akku", value: "\(Int(battery * 100)) %" + (status.charging == true ? ", lädt" : ""))
                }
                LabeledContent("Temperatur", value: status.thermal)
                LabeledContent("Freier Speicher", value: ByteCountFormatter.string(fromByteCount: status.freeBytes, countStyle: .file))
                if let gravity = status.gravity {
                    LabeledContent("Schwerkraft", value: gravity.map { String(format: "%.2f", $0) }.joined(separator: "  "))
                }
            }
        }
    }

    private func check(_ label: String, _ ok: Bool) -> some View {
        LabeledContent(label) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.octagon.fill").foregroundStyle(ok ? .green : .red)
        }
    }

    static let shutters: [Double] = [1.0 / 50, 1.0 / 100, 1.0 / 200, 1.0 / 400, 1.0 / 800]

    private var nearestShutter: Double {
        let current = camera.config.shutter ?? camera.status?.shutter ?? 0.01
        return CameraInspector.shutters.min { abs($0 - current) < abs($1 - current) } ?? 0.01
    }

    private func selectLens(_ id: String) {
        guard let info = camera.hello?.lenses.first(where: { $0.id == id }) else { return }
        camera.config.lens = info.lens
        camera.config.deviceID = info.lens == .external ? info.id : nil
        // Nicht jede Linse kann jedes Format: sonst das groesste nehmen.
        if !info.formats.contains(where: { $0.width == camera.config.width && $0.height == camera.config.height }),
           let format = info.formats.first(where: { $0.maxFPS >= 30 }) ?? info.formats.first {
            camera.config.width = format.width
            camera.config.height = format.height
            camera.config.fps = min(camera.config.fps, format.maxFPS)
        }
        // Mit der neuen Linse gelten Belichtung, Fokus und Weissabgleich von vorhin nicht mehr:
        // zurueck auf Automatik, danach neu sperren.
        camera.config.exposure = .auto
        camera.config.focus = .auto
        camera.config.whiteBalance = .auto
        camera.config.iso = nil
        camera.config.shutter = nil
        camera.config.lensPosition = nil
        camera.config.temperature = nil
        camera.config.tint = nil
        model.changed(camera)
    }

    private func selectFormat(_ tag: String) {
        let parts = tag.split(separator: "x").compactMap { Int($0) }
        guard parts.count == 2 else { return }
        camera.config.width = parts[0]
        camera.config.height = parts[1]
        if let top = lens?.formats.first(where: { $0.width == parts[0] && $0.height == parts[1] })?.maxFPS {
            camera.config.fps = min(camera.config.fps, top)
        }
        model.changed(camera)
    }
}
