import SplattwinKit
import SwiftUI
import WebKit

@main
struct SplattwinApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Splattwin") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 1080, minHeight: 700)
        }
    }
}

enum Pane: String, CaseIterable, Identifiable {
    case cameras = "Kameras"
    case capture = "Aufnahme"
    case library = "Aufnahmen"
    case tracking = "Tracking"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .cameras: return "camera"
        case .capture: return "record.circle"
        case .library: return "square.stack.3d.up"
        case .tracking: return "figure.walk.motion"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var section: Pane? = .cameras

    var body: some View {
        NavigationSplitView {
            List(Pane.allCases, selection: $section) { item in
                Label(item.rawValue, systemImage: item.icon).tag(item)
            }
            .navigationSplitViewColumnWidth(min: 150, ideal: 170, max: 220)
        } detail: {
            switch section ?? .cameras {
            case .cameras: CamerasView()
            case .capture: CaptureView()
            case .library: LibraryView()
            case .tracking: TrackingView()
            }
        }
        // Die Koerpererkennung laeuft in einer Webansicht, die im Fenster haengen muss, damit sie nicht pausiert.
        .background(alignment: .bottomTrailing) {
            if let pose = model.pose { WebHost(view: pose.webView).frame(width: 4, height: 4).opacity(0.02) }
        }
        .alert("Hinweis", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
            Button("OK") { model.message = nil }
        } message: {
            Text(model.message ?? "")
        }
    }
}

struct WebHost: NSViewRepresentable {
    let view: WKWebView
    func makeNSView(context: Context) -> WKWebView { view }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

// MARK: - Livebild

/// Gelenke der Koerpererkennung als Strichfigur ueber dem Bild.
struct Skeleton: Shape {
    let points: [[Double]]
    static let lines = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28)]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        for (a, b) in Skeleton.lines where a < points.count && b < points.count {
            let p = points[a], q = points[b]
            guard p.count >= 3, q.count >= 3, p[2] > 0.4, q[2] > 0.4 else { continue }
            path.move(to: CGPoint(x: rect.minX + p[0] * rect.width, y: rect.minY + p[1] * rect.height))
            path.addLine(to: CGPoint(x: rect.minX + q[0] * rect.width, y: rect.minY + q[1] * rect.height))
        }
        return path
    }
}

struct LiveImage: View {
    @ObservedObject var camera: RemoteCamera
    var pose: PoseObservation?
    var faceMode = false

    var body: some View {
        ZStack {
            Color.black
            if let image = camera.image, camera.isConnected {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .overlay {
                        if let pose, pose.present, let points = pose.points {
                            Skeleton(points: points)
                                .stroke(pose.hint(face: faceMode).isEmpty ? Color.green : Color.red, lineWidth: 3)
                        }
                    }
            } else {
                Text(camera.isConnected ? "Kein Bild" : CameraText.state(camera))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
            }
        }
    }
}

enum CameraText {
    @MainActor static func state(_ camera: RemoteCamera) -> String {
        switch camera.state {
        case .idle: return "Getrennt"
        case .connecting: return "Verbinde …"
        case .connected: return "Verbunden"
        case .failed(let reason): return reason == "Kopplungscode stimmt nicht" ? reason : "\(reason) – neuer Versuch läuft"
        }
    }

    /// Zustand der Verbindung in einer Zeile (M-16).
    @MainActor static func line(_ camera: RemoteCamera) -> String {
        guard camera.isConnected else { return state(camera) }
        let s = camera.stats
        guard s.fps > 0 else { return "Verbunden, kein Livebild" }
        return String(format: "%.0f B/s · %d×%d · %.0f ms · %.1f Mbit/s · verloren %d · Helligkeit %.0f %%",
                      s.fps, s.width, s.height, s.latency * 1000, s.megabits, s.lost, s.brightness * 100)
    }

    /// Was der Mensch am Aufbau pruefen sollte.
    @MainActor static func alerts(_ camera: RemoteCamera) -> [String] {
        guard camera.isConnected, let status = camera.status else { return [] }
        var list = status.warnings
        if camera.stats.fps > 0, camera.stats.brightness < 0.08 { list.append("Bild fast schwarz – ist die Linse verdeckt?") }
        if status.moved { list.append("Kamera wurde bewegt – neu kalibrieren") }
        if status.thermal == "heiss" || status.thermal == "kritisch" { list.append("Gerät ist \(status.thermal)") }
        if let battery = status.battery, battery < 0.2, status.charging != true { list.append("Akku \(Int(battery * 100)) %") }
        if let error = camera.lastError { list.append(error) }
        return list
    }

    static func shutter(_ seconds: Double?) -> String {
        guard let seconds, seconds > 0 else { return "–" }
        return seconds >= 1 ? String(format: "%.1f s", seconds) : "1/\(Int((1 / seconds).rounded())) s"
    }
}
