import AVFoundation
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation

/// Ein Kamerabild mit seiner Aufnahmezeit auf der Systemuhr.
public struct VideoFrame {
    public let pixelBuffer: CVPixelBuffer
    public let time: Double
    /// [fx, fy, cx, cy] bezogen auf Breite und Hoehe, falls das Geraet sie liefert.
    public let k: [Double]?

    public init(pixelBuffer: CVPixelBuffer, time: Double, k: [Double]? = nil) {
        self.pixelBuffer = pixelBuffer
        self.time = time
        self.k = k
    }

    public var width: Int { CVPixelBufferGetWidth(pixelBuffer) }
    public var height: Int { CVPixelBufferGetHeight(pixelBuffer) }
}

/// Woher die Bilder kommen: echte Kamera, Videodatei oder Testbild.
public protocol FrameSource: AnyObject {
    /// Wird fuer jedes Bild auf einer eigenen Warteschlange der Quelle aufgerufen.
    var onFrame: ((VideoFrame) -> Void)? { get set }
    /// Einstellungen wurden uebernommen oder haben sich von selbst geaendert.
    var onChange: (() -> Void)? { get set }
    var lenses: [LensInfo] { get }
    func apply(_ config: CameraConfig)
    func fill(_ status: inout NodeStatus)
    func start()
    func stop()
}

/// Verkleinert ein Bild und packt es als JPEG. Jedes Bild steht fuer sich: geht eines
/// verloren, ist das naechste trotzdem vollstaendig, und der Browser kann es direkt lesen.
public final class JPEGEncoder {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    public init() {}

    public func encode(_ pixelBuffer: CVPixelBuffer, maxSide: Int, quality: Double) -> (data: Data, width: Int, height: Int)? {
        let width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer)
        let scale = min(1, Double(maxSide) / Double(max(width, height)))
        var image = CIImage(cvPixelBuffer: pixelBuffer)
        var outWidth = width, outHeight = height
        if scale < 1 {
            outWidth = max(2, Int((Double(width) * scale / 2).rounded()) * 2)
            outHeight = max(2, Int((Double(height) * scale / 2).rounded()) * 2)
            let transform = CGAffineTransform(scaleX: CGFloat(outWidth) / CGFloat(width), y: CGFloat(outHeight) / CGFloat(height))
            image = image.transformed(by: transform, highQualityDownsample: true)
                .cropped(to: CGRect(x: 0, y: 0, width: outWidth, height: outHeight))
        }
        let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
        guard let data = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else { return nil }
        return (data, outWidth, outHeight)
    }
}

/// Schreibt die Aufnahme in voller Qualitaet als HEVC und merkt sich die Zeit jedes Bildes (H-1, H-9).
final class Recorder {
    let name: String
    let url: URL
    let width: Int
    let height: Int
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private(set) var frameTimes: [Double] = []
    private(set) var frameIntrinsics: [[Double]] = []
    private(set) var dropped = 0

    init(name: String, url: URL, width: Int, height: Int, fps: Int) throws {
        self.name = name
        self.url = url
        self.width = width
        self.height = height
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        // Etwa 60 Mbit/s bei 4K: hoch genug, dass COLMAP feine Merkmale auf der Kleidung findet.
        let bitrate = max(8_000_000, Int(Double(width * height) * 7.2))
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps,
            ],
            // Fester Farbraum Rec. 709, kein HDR (H-4).
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else { throw NodeError("Aufnahme mit \(width)×\(height) wird nicht unterstützt") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? NodeError("Aufnahme konnte nicht starten") }
    }

    func append(_ frame: VideoFrame) {
        let time = CMTime(seconds: frame.time, preferredTimescale: 1_000_000)
        if frameTimes.isEmpty { writer.startSession(atSourceTime: time) }
        if let last = frameTimes.last, frame.time <= last { return }
        // Kommt der Encoder nicht nach, faellt das Bild weg; die Zahl steht nachher im Bericht.
        guard input.isReadyForMoreMediaData, adaptor.append(frame.pixelBuffer, withPresentationTime: time) else {
            dropped += 1
            return
        }
        frameTimes.append(frame.time)
        if let k = frame.k { frameIntrinsics.append(k) }
    }

    func finish(_ done: @escaping (String?) -> Void) {
        guard !frameTimes.isEmpty else {
            writer.cancelWriting()
            return done("Kein Bild aufgenommen")
        }
        input.markAsFinished()
        writer.finishWriting { [writer] in
            done(writer.status == .completed ? nil : (writer.error?.localizedDescription ?? "Aufnahme unvollständig"))
        }
    }
}

public struct NodeError: LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

// MARK: - Testbild

/// Erzeugt ein bewegtes Testbild. Damit laesst sich die ganze Kette ohne Kamera pruefen.
public final class SyntheticSource: FrameSource {
    public var onFrame: ((VideoFrame) -> Void)?
    public var onChange: (() -> Void)?
    private let queue = DispatchQueue(label: "splattwin.synthetic")
    private var timer: DispatchSourceTimer?
    private var config = CameraConfig()
    private var count = 0

    public init() {}

    public var lenses: [LensInfo] {
        [LensInfo(lens: .wide, id: "test", name: "Testbild",
                  formats: [FormatInfo(width: 1280, height: 720, maxFPS: 60), FormatInfo(width: 640, height: 360, maxFPS: 60)])]
    }

    public func apply(_ config: CameraConfig) {
        queue.async {
            self.config = config
            if self.timer != nil { self.schedule() }
            self.onChange?()
        }
    }

    public func fill(_ status: inout NodeStatus) {
        let (w, h) = size
        status.lensName = "Testbild"
        status.width = w
        status.height = h
        status.fps = Double(config.fps)
        status.colorSpace = "sRGB"
        status.intrinsics = Intrinsics(fx: 1.2 * Double(max(w, h)) / Double(w), fy: 1.2 * Double(max(w, h)) / Double(h),
                                       cx: 0.5, cy: 0.5, source: "fov", distortion: "corrected")
    }

    public func start() { queue.async { self.schedule() } }

    public func stop() {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
        }
    }

    private var size: (Int, Int) {
        config.rotation % 180 == 0 ? (config.width, config.height) : (config.height, config.width)
    }

    private func schedule() {
        timer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1.0 / Double(max(1, config.fps)), leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.emit() }
        timer.resume()
        self.timer = timer
    }

    private func emit() {
        let (w, h) = size
        var buffer: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary
        CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, attributes, &buffer)
        guard let buffer else { return }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: w, height: h, bitsPerComponent: 8,
                                   bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
            context.setFillColor(CGColor(red: 0.12, green: 0.14, blue: 0.18, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: w, height: h))
            // Ein Balken wandert einmal pro Sekunde durchs Bild.
            let phase = Double(count % max(1, config.fps)) / Double(max(1, config.fps))
            context.setFillColor(CGColor(red: 0.42, green: 0.77, blue: 0.63, alpha: 1))
            context.fill(CGRect(x: phase * Double(w), y: 0, width: Double(w) / 20, height: Double(h)))
            context.setFillColor(CGColor(red: 0.9, green: 0.9, blue: 0.9, alpha: 1))
            context.fill(CGRect(x: Double(w) * 0.4, y: Double(h) * 0.4, width: Double(w) * 0.2, height: Double(h) * 0.2))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        count += 1
        onFrame?(VideoFrame(pixelBuffer: buffer, time: Clock.now))
    }
}

// MARK: - Videodatei

/// Spielt eine Videodatei in Echtzeit als Kamerabild ab (zum Testen des Ablaufs ohne Person vor der Kamera).
public final class FileSource: FrameSource {
    public var onFrame: ((VideoFrame) -> Void)?
    public var onChange: (() -> Void)?
    public let url: URL
    private let lock = NSLock()
    private var generation = 0
    private var size = (0, 0)
    private var fps = 30.0

    public init(url: URL) {
        self.url = url
    }

    public var lenses: [LensInfo] {
        [LensInfo(lens: .external, id: "file", name: url.lastPathComponent, formats: [])]
    }

    public func apply(_ config: CameraConfig) { onChange?() }

    public func fill(_ status: inout NodeStatus) {
        status.lensName = url.lastPathComponent
        status.width = size.0
        status.height = size.1
        status.fps = fps
        status.colorSpace = "Datei"
    }

    /// Beginnt die Datei von vorne.
    public func start() {
        let generation = bump()
        Task.detached { await self.play(generation) }
    }

    public func stop() { _ = bump() }

    private func bump() -> Int {
        lock.lock()
        defer { lock.unlock() }
        generation += 1
        return generation
    }

    private func current(_ generation: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return generation == self.generation
    }

    private func play(_ generation: Int) async {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let composition = try? await AVVideoComposition.videoComposition(withPropertiesOf: asset),
              let reader = try? AVAssetReader(asset: asset) else { return }
        // Die Komposition dreht hochkant aufgenommene Videos richtig herum.
        let output = AVAssetReaderVideoCompositionOutput(
            videoTracks: [track], videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.videoComposition = composition
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { return }
        let rate = (try? await track.load(.nominalFrameRate)) ?? 30
        fps = Double(rate > 0 ? rate : 30)
        let start = Clock.now
        while current(generation), let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            let due = start + CMSampleBufferGetPresentationTimeStamp(sample).seconds
            let wait = due - Clock.now
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
            if size.0 != CVPixelBufferGetWidth(buffer) {
                size = (CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer))
                onChange?()
            }
            onFrame?(VideoFrame(pixelBuffer: buffer, time: due))
        }
        // Am Ende wieder von vorne, damit das Livebild nicht stehen bleibt.
        if current(generation) { await play(generation) }
    }
}
