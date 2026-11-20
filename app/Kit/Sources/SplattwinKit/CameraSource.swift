import AVFoundation
import CoreMedia
import Foundation
import simd

/// Die echte Kamera. Waehlt eine einzelne Linse, sperrt alles Automatische und liefert
/// jedes Bild mit Aufnahmezeit und Kameradaten (H-1 bis H-5, H-10, H-16, H-17).
public final class CameraSource: NSObject, FrameSource, AVCaptureVideoDataOutputSampleBufferDelegate {
    public var onFrame: ((VideoFrame) -> Void)?
    public var onChange: (() -> Void)?
    /// Fuer die Vorschau auf dem Handy.
    public let session = AVCaptureSession()

    private let sessionQueue = DispatchQueue(label: "splattwin.camera.session")
    private let videoQueue = DispatchQueue(label: "splattwin.camera.video")
    private let output = AVCaptureVideoDataOutput()
    private let lock = NSLock()
    private var device: AVCaptureDevice?
    private var config = CameraConfig()
    private var warnings: [String] = []
    private var dropped = 0
    private var frameSize = (0, 0)
    private var lastK: [Double]?
    private var fovK: [Double]?
    private var corrected = false
    private var fps = 0.0
    private var fpsCount = 0
    private var fpsStart = 0.0
    private var observers: [NSObjectProtocol] = []
    private var generation = 0

    public override init() {
        super.init()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: videoQueue)
        observers.append(NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] _ in
                // Nach einem Fehler der Kamera (z.B. anderer Prozess greift zu) neu starten.
                self?.sessionQueue.asyncAfter(deadline: .now() + 1) { self?.session.startRunning() }
        })
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    public static func authorize() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }

    // MARK: Linsen

    /// Einzelne Linsen statt der kombinierten Kamera: so wechselt das Handy nie von selbst die Linse (H-5).
    static func devices() -> [(lens: Lens, device: AVCaptureDevice)] {
        #if os(iOS)
        let back = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video, position: .back).devices
        let front = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .front).devices
        var found: [(Lens, AVCaptureDevice)] = back.map { device in
            switch device.deviceType {
            case .builtInUltraWideCamera: return (.ultraWide, device)
            case .builtInTelephotoCamera: return (.tele, device)
            default: return (.wide, device)
            }
        }
        found += front.prefix(1).map { (.front, $0) }
        let order: [Lens] = [.ultraWide, .wide, .tele, .front]
        return found.sorted { order.firstIndex(of: $0.0)! < order.firstIndex(of: $1.0)! }
        #else
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video, position: .unspecified).devices.map { (.external, $0) }
        #endif
    }

    public var lenses: [LensInfo] {
        CameraSource.devices().map { lens, device in
            var best: [String: FormatInfo] = [:]
            for format in device.formats where CameraSource.usable(format) {
                let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                let maxFPS = Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0)
                let key = "\(size.width)x\(size.height)"
                if maxFPS > best[key]?.maxFPS ?? 0 {
                    best[key] = FormatInfo(width: Int(size.width), height: Int(size.height), maxFPS: maxFPS)
                }
            }
            var info = LensInfo(lens: lens, id: device.uniqueID, name: lens == .external ? device.localizedName : lens.label,
                                formats: best.values.sorted { $0.width * $0.height > $1.width * $1.height })
            #if os(iOS)
            let formats = device.formats.filter(CameraSource.usable)
            info.minISO = Double(formats.map(\.minISO).min() ?? 0)
            info.maxISO = Double(formats.map(\.maxISO).max() ?? 0)
            info.minShutter = formats.map(\.minExposureDuration.seconds).min() ?? 0
            info.maxShutter = formats.map(\.maxExposureDuration.seconds).max() ?? 0
            info.manualExposure = device.isExposureModeSupported(.custom)
            info.manualFocus = device.isLockingFocusWithCustomLensPositionSupported
            info.manualWhiteBalance = device.isLockingWhiteBalanceWithCustomDeviceGainsSupported
            #endif
            return info
        }
    }

    /// Nur 8-Bit-Formate: die 10-Bit-Formate sind HDR (H-4).
    private static func usable(_ format: AVCaptureDevice.Format) -> Bool {
        #if os(iOS)
        let type = CMFormatDescriptionGetMediaSubType(format.formatDescription)
        return type == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || type == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        #else
        return true
        #endif
    }

    // MARK: Einstellungen

    public func apply(_ config: CameraConfig) {
        sessionQueue.async {
            self.configure(config)
            self.onChange?()
        }
    }

    public func start() {
        sessionQueue.async {
            if self.device == nil { self.configure(self.config) }
            if !self.session.isRunning {
                #if os(macOS)
                // Am Mac stellt die Sitzung beim Start sonst ihr eigenes Format ein und verwirft das gewaehlte.
                let locked = (try? self.device?.lockForConfiguration()) != nil
                self.session.startRunning()
                if locked { self.device?.unlockForConfiguration() }
                #else
                self.session.startRunning()
                #endif
            }
            self.onChange?()
        }
    }

    public func stop() {
        sessionQueue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    private func configure(_ wanted: CameraConfig) {
        var notes: [String] = []
        let all = CameraSource.devices()
        let match = all.first { wanted.deviceID != nil ? $0.device.uniqueID == wanted.deviceID : $0.lens == wanted.lens }
        guard let chosen = match ?? all.first(where: { $0.lens == .wide }) ?? all.first else {
            setWarnings(["Keine Kamera gefunden"])
            return
        }
        if match == nil { notes.append("\(wanted.lens.label) gibt es an diesem Gerät nicht, verwende \(chosen.lens.label)") }
        let device = chosen.device

        // Center Stage gilt systemweit pro App: von hier aus fest ausschalten (H-17).
        AVCaptureDevice.centerStageControlMode = .app
        AVCaptureDevice.isCenterStageEnabled = false

        session.beginConfiguration()
        #if os(iOS)
        // Sobald unten ein Format gesetzt wird, uebernimmt die Sitzung es unveraendert (statt eines eigenen Presets).
        session.automaticallyConfiguresCaptureDeviceForWideColor = false
        #endif
        // Frisch gestartete Kamera, neue Linse oder neues Format: Belichtung und Weissabgleich muessen sich
        // erst einpendeln. Sofort sperren wuerde die Startwerte einfrieren (Blaustich, falsche Helligkeit).
        var fresh = self.device?.uniqueID != device.uniqueID || !session.isRunning
        if self.device?.uniqueID != device.uniqueID {
            session.inputs.forEach(session.removeInput)
            guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
                session.commitConfiguration()
                setWarnings(["Kamera \(device.localizedName) lässt sich nicht öffnen"])
                return
            }
            session.addInput(input)
            self.device = device
        }
        if !session.outputs.contains(output), session.canAddOutput(output) { session.addOutput(output) }

        do {
            try device.lockForConfiguration()
            let before = device.activeFormat
            notes += setFormat(device, wanted)
            if device.activeFormat != before { fresh = true }
            notes += setControls(device, wanted, settling: fresh)
            device.unlockForConfiguration()
        } catch {
            notes.append("Kamera lässt sich nicht einstellen: \(error.localizedDescription)")
        }

        if let connection = output.connection(with: .video) {
            let angle = CGFloat(wanted.rotation)
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
            else if wanted.rotation != 0 { notes.append("Bild lässt sich nicht um \(wanted.rotation)° drehen") }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false
            }
            #if os(iOS)
            // Stabilisierung aendert Bildausschnitt und Brennweite pro Bild (H-5).
            if connection.isVideoStabilizationSupported { connection.preferredVideoStabilizationMode = .off }
            // Kameradaten pro Bild direkt vom Geraet (H-10, T-3).
            if connection.isCameraIntrinsicMatrixDeliverySupported { connection.isCameraIntrinsicMatrixDeliveryEnabled = true }
            #endif
        }
        session.commitConfiguration()

        lock.lock()
        config = wanted
        warnings = notes
        lastK = nil
        generation += 1
        let generation = generation
        lock.unlock()

        guard fresh, CameraSource.needsSettling(wanted) else { return }
        sessionQueue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = generation == self.generation
            self.lock.unlock()
            guard current, (try? device.lockForConfiguration()) != nil else { return }
            let late = self.setControls(device, wanted, settling: false)
            device.unlockForConfiguration()
            self.lock.lock()
            self.warnings += late
            self.lock.unlock()
            self.onChange?()
        }
    }

    /// Verlangt die Einstellung, etwas am aktuellen Wert festzuhalten (gesperrt, oder fest ohne Zahl)?
    private static func needsSettling(_ c: CameraConfig) -> Bool {
        c.exposure == .locked || (c.exposure == .manual && (c.iso == nil || c.shutter == nil))
            || c.whiteBalance == .locked || (c.whiteBalance == .manual && c.temperature == nil)
            || c.focus == .locked || (c.focus == .manual && c.lensPosition == nil)
    }

    private func setFormat(_ device: AVCaptureDevice, _ wanted: CameraConfig) -> [String] {
        var notes: [String] = []
        let fps = Double(wanted.fps)
        func size(_ f: AVCaptureDevice.Format) -> (Int, Int) {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return (Int(d.width), Int(d.height))
        }
        func supports(_ f: AVCaptureDevice.Format) -> Bool {
            f.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= fps + 0.01 && $0.maxFrameRate >= fps - 0.01 }
        }
        let candidates = device.formats.filter(CameraSource.usable)
        var format = candidates.first { size($0) == (wanted.width, wanted.height) && supports($0) }
        if format == nil {
            // Naechstkleineres Format mit dem gleichen Seitenverhaeltnis, sonst das groesste ueberhaupt.
            let sorted = candidates.filter(supports).sorted { size($0).0 * size($0).1 > size($1).0 * size($1).1 }
            let ratio = Double(wanted.width) / Double(wanted.height)
            format = sorted.first { size($0).0 <= wanted.width && abs(Double(size($0).0) / Double(size($0).1) - ratio) < 0.02 } ?? sorted.first
            if let format {
                notes.append("\(wanted.width)×\(wanted.height) mit \(wanted.fps) B/s gibt es nicht, verwende \(size(format).0)×\(size(format).1)")
            }
        }
        guard let format else { return ["Kein passendes Bildformat gefunden"] }
        if device.activeFormat != format { device.activeFormat = format }
        if supports(format) {
            let duration = CMTime(value: 1, timescale: CMTimeScale(wanted.fps))
            device.activeVideoMinFrameDuration = duration
            device.activeVideoMaxFrameDuration = duration
        }
        #if os(iOS)
        if format.isVideoHDRSupported {
            device.automaticallyAdjustsVideoHDREnabled = false
            device.isVideoHDREnabled = false
        }
        if format.supportedColorSpaces.contains(.sRGB) { device.activeColorSpace = .sRGB }
        else { notes.append("Farbraum sRGB / Rec. 709 nicht verfügbar") }
        device.videoZoomFactor = 1
        // Das Ultraweitwinkel verzeichnet stark; das Geraet rechnet das auf Wunsch heraus (T-4).
        corrected = false
        if device.isGeometricDistortionCorrectionSupported {
            device.isGeometricDistortionCorrectionEnabled = true
            corrected = true
        }
        let fov = Double(corrected ? format.geometricDistortionCorrectedVideoFieldOfView : format.videoFieldOfView)
        if fov > 1 {
            let focal = 0.5 / tan(fov * .pi / 360) // in Einheiten der langen Bildseite
            let (w, h) = size(format)
            let upright = wanted.rotation % 180 != 0
            let (rw, rh) = upright ? (h, w) : (w, h)
            fovK = [focal * Double(w) / Double(rw), focal * Double(w) / Double(rh), 0.5, 0.5]
        } else { fovK = nil }
        #endif
        return notes
    }

    /// `settling`: Die Kamera ist frisch. Alles, was am aktuellen Wert festgehalten werden soll, laeuft
    /// zuerst automatisch und wird anderthalb Sekunden spaeter mit einem zweiten Aufruf gesperrt.
    private func setControls(_ device: AVCaptureDevice, _ wanted: CameraConfig, settling: Bool) -> [String] {
        var wanted = wanted
        if settling {
            if wanted.exposure == .locked || (wanted.exposure == .manual && (wanted.iso == nil || wanted.shutter == nil)) { wanted.exposure = .auto }
            if wanted.whiteBalance == .locked || (wanted.whiteBalance == .manual && wanted.temperature == nil) { wanted.whiteBalance = .auto }
            if wanted.focus == .locked || (wanted.focus == .manual && wanted.lensPosition == nil) { wanted.focus = .auto }
        }
        var notes: [String] = []
        // Belichtung
        switch wanted.exposure {
        case .auto:
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        case .locked:
            if device.isExposureModeSupported(.locked) { device.exposureMode = .locked }
            else { notes.append("Belichtung lässt sich an dieser Kamera nicht sperren") }
        case .manual:
            #if os(iOS)
            if device.isExposureModeSupported(.custom) {
                let format = device.activeFormat
                let iso = min(max(Float(wanted.iso ?? Double(device.iso)), format.minISO), format.maxISO)
                let longest = min(format.maxExposureDuration.seconds, 1 / Double(max(1, wanted.fps)))
                let seconds = min(max(wanted.shutter ?? device.exposureDuration.seconds, format.minExposureDuration.seconds), longest)
                device.setExposureModeCustom(duration: CMTime(seconds: seconds, preferredTimescale: 1_000_000), iso: iso)
            } else { notes.append("Feste Belichtung wird nicht unterstützt") }
            #else
            if device.isExposureModeSupported(.locked) { device.exposureMode = .locked }
            notes.append("Feste Belichtungswerte gibt es nur am Handy, Belichtung gesperrt")
            #endif
        }
        // Fokus
        switch wanted.focus {
        case .auto:
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        case .locked:
            if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
        case .manual:
            #if os(iOS)
            if device.isLockingFocusWithCustomLensPositionSupported {
                device.setFocusModeLocked(lensPosition: Float(min(max(wanted.lensPosition ?? Double(device.lensPosition), 0), 1)))
            } else if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
            #else
            if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
            #endif
        }
        // Weissabgleich
        switch wanted.whiteBalance {
        case .auto:
            if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
        case .locked:
            if device.isWhiteBalanceModeSupported(.locked) { device.whiteBalanceMode = .locked }
            else { notes.append("Weissabgleich lässt sich an dieser Kamera nicht sperren") }
        case .manual:
            #if os(iOS)
            if device.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
                let current = device.temperatureAndTintValues(for: device.deviceWhiteBalanceGains)
                let values = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(
                    temperature: Float(wanted.temperature ?? Double(current.temperature)), tint: Float(wanted.tint ?? Double(current.tint)))
                var gains = device.deviceWhiteBalanceGains(for: values)
                let top = device.maxWhiteBalanceGain
                gains.redGain = min(max(gains.redGain, 1), top)
                gains.greenGain = min(max(gains.greenGain, 1), top)
                gains.blueGain = min(max(gains.blueGain, 1), top)
                device.setWhiteBalanceModeLocked(with: gains)
            } else if device.isWhiteBalanceModeSupported(.locked) { device.whiteBalanceMode = .locked }
            #else
            if device.isWhiteBalanceModeSupported(.locked) { device.whiteBalanceMode = .locked }
            #endif
        }
        return notes
    }

    private func setWarnings(_ list: [String]) {
        lock.lock()
        warnings = list
        lock.unlock()
    }

    public func fill(_ status: inout NodeStatus) {
        lock.lock()
        defer { lock.unlock() }
        status.config = config
        status.warnings = warnings
        status.width = frameSize.0
        status.height = frameSize.1
        status.fps = fps
        status.droppedFrames = dropped
        guard let device else { return }
        status.lensName = device.localizedName
        status.centerStage = device.isCenterStageActive
        if let k = lastK {
            status.intrinsics = Intrinsics(fx: k[0], fy: k[1], cx: k[2], cy: k[3], source: "device",
                                           distortion: corrected ? "corrected" : "uncorrected")
        } else if let k = fovK {
            status.intrinsics = Intrinsics(fx: k[0], fy: k[1], cx: k[2], cy: k[3], source: "fov",
                                           distortion: corrected ? "corrected" : "uncorrected")
        }
        #if os(iOS)
        status.iso = Double(device.iso)
        status.shutter = device.exposureDuration.seconds
        status.lensPosition = Double(device.lensPosition)
        let white = device.temperatureAndTintValues(for: device.deviceWhiteBalanceGains)
        status.temperature = Double(white.temperature)
        status.tint = Double(white.tint)
        status.hdr = device.isVideoHDREnabled
        switch device.activeColorSpace {
        case .sRGB: status.colorSpace = "sRGB / Rec. 709"
        case .P3_D65: status.colorSpace = "P3"
        default: status.colorSpace = "HDR"
        }
        status.stabilization = (output.connection(with: .video)?.activeVideoStabilizationMode ?? .off) != .off
        #else
        status.colorSpace = "Rec. 709"
        #endif
    }

    // MARK: Bilder

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        // Die Kamera stempelt auf der Uhr der Sitzung; umrechnen auf die Systemuhr, die auch der Abgleich nutzt.
        var pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let clock = session.synchronizationClock {
            pts = CMSyncConvertTime(pts, from: clock, to: CMClockGetHostTimeClock())
        }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        var k: [Double]?
        if let data = CMGetAttachment(sampleBuffer, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, attachmentModeOut: nil) as? Data,
           data.count >= MemoryLayout<matrix_float3x3>.size {
            let m = data.withUnsafeBytes { $0.loadUnaligned(as: matrix_float3x3.self) }
            k = [Double(m.columns.0.x) / Double(width), Double(m.columns.1.y) / Double(height),
                 Double(m.columns.2.x) / Double(width), Double(m.columns.2.y) / Double(height)]
        }
        let time = pts.seconds
        lock.lock()
        frameSize = (width, height)
        if let k { lastK = k }
        fpsCount += 1
        if time - fpsStart >= 1 {
            fps = Double(fpsCount) / (time - fpsStart)
            fpsCount = 0
            fpsStart = time
        }
        lock.unlock()
        onFrame?(VideoFrame(pixelBuffer: buffer, time: time, k: k))
    }

    public func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        lock.lock()
        dropped += 1
        lock.unlock()
    }
}
