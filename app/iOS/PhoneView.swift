import AVFoundation
import SplattwinKit
import SwiftUI

@main
struct SplattwinKameraApp: App {
    @StateObject private var model = PhoneModel()

    var body: some Scene {
        WindowGroup {
            PhoneView()
                .environmentObject(model)
                .task { await model.start() }
                .preferredColorScheme(.dark)
                .statusBarHidden()
        }
    }
}

/// Der Bildschirm des Handys: aus drei Metern erkennbar, was zu tun ist (H-13).
struct PhoneView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var confirmDelete = false

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            VStack(spacing: 14) {
                header
                Spacer(minLength: 0)
                if model.cameraDenied {
                    message("Kein Zugriff auf die Kamera", "In den Einstellungen unter Splattwin Kamera die Kamera erlauben.")
                } else if let error = model.startError {
                    message("Start fehlgeschlagen", error)
                } else {
                    Text(model.phase.title)
                        .font(.system(size: 76, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.25)
                        .lineLimit(4)
                        .multilineTextAlignment(.center)
                    if !model.phase.detail.isEmpty {
                        Text(model.phase.detail).font(.title2).multilineTextAlignment(.center).opacity(0.85)
                    }
                    if let progress = model.phase.progress {
                        ProgressView(value: min(max(progress, 0), 1)).tint(.white).scaleEffect(y: 3).padding(.horizontal, 30).padding(.top, 10)
                    }
                }
                Spacer(minLength: 0)
                footer
            }
            .padding(18)
            .foregroundStyle(.white)
            // Abgedunkelt: schwarzer Bildschirm, ein Tipp holt die Anzeige zurueck (H-19).
            if model.dimmed {
                Color.black.ignoresSafeArea()
                Text("Tippen zum Aufwecken").font(.footnote).foregroundStyle(.gray)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.touched() }
        .confirmationDialog("Alle Aufnahmen auf diesem Handy löschen?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Löschen", role: .destructive) { model.deleteFiles() }
        } message: {
            Text("Nur löschen, wenn die Aufnahmen auf dem Mac angekommen sind.")
        }
    }

    private var background: Color {
        switch model.phase.color {
        case "ok": return Color(red: 0.05, green: 0.45, blue: 0.25)
        case "bad": return Color(red: 0.62, green: 0.14, blue: 0.12)
        case "rec": return Color(red: 0.42, green: 0.05, blue: 0.08)
        case "wait": return Color(red: 0.08, green: 0.22, blue: 0.42)
        default: return Color(red: 0.08, green: 0.09, blue: 0.1)
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Label(model.connected ? "Verbunden mit \(model.hubName)" : "Nicht verbunden",
                      systemImage: model.connected ? "checkmark.circle.fill" : "wifi.slash")
                    .font(.headline)
                if model.status.recording {
                    Label("Aufnahme läuft · \(model.status.recordedFrames) Bilder", systemImage: "record.circle.fill").foregroundStyle(.red)
                }
                Text(lensLine).font(.footnote).opacity(0.8)
            }
            Spacer()
            if !model.connected {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Kopplungscode").font(.footnote).opacity(0.8)
                    Text(model.formattedCode).font(.system(size: 34, weight: .bold, design: .monospaced))
                    Button("Neuer Code") { model.newCode() }.font(.footnote)
                }
            }
        }
    }

    private var lensLine: String {
        let s = model.status
        guard s.width > 0 else { return "Kamera startet …" }
        return "\(s.config.lens.label) · \(s.width)×\(s.height) · \(Int(s.fps.rounded())) B/s"
            + (s.iso.map { " · ISO \(Int($0))" } ?? "")
            + (s.shutter.map { $0 > 0 ? " · 1/\(Int((1 / $0).rounded())) s" : "" } ?? "")
    }

    private var footer: some View {
        HStack(alignment: .bottom, spacing: 12) {
            if model.showPreview, !model.cameraDenied {
                CameraPreview(session: model.source.session)
                    .frame(width: 96, height: 150)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay { RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.4)) }
                    .onTapGesture { model.showPreview = false }
            } else {
                Button { model.showPreview = true } label: { Label("Vorschau", systemImage: "eye") }
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(model.checks.enumerated()), id: \.offset) { _, check in
                    Label(check.text, systemImage: check.ok ? "checkmark.circle" : "exclamationmark.triangle.fill")
                        .foregroundStyle(check.ok ? .white.opacity(0.8) : .yellow)
                        .font(.footnote)
                }
                ForEach(model.status.warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.yellow).font(.footnote)
                }
            }
            Spacer()
            if !model.files.isEmpty, !model.status.recording {
                Button(role: .destructive) { confirmDelete = true } label: {
                    Label("\(ByteCountFormatter.string(fromByteCount: model.storedBytes, countStyle: .file)) löschen", systemImage: "trash")
                }
                .font(.footnote)
            }
        }
    }

    private func message(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 50)).foregroundStyle(.yellow)
            Text(title).font(.largeTitle).bold().multilineTextAlignment(.center)
            Text(detail).font(.title3).multilineTextAlignment(.center)
        }
    }
}

/// Kleines Kontrollbild direkt von der Kamera, um das Handy auszurichten.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}
