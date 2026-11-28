import AVFoundation
import XCTest
@testable import SplattwinKit

/// Kameraseite und Mac-Seite laufen im selben Prozess und reden ueber die echte, verschluesselte Verbindung.
@MainActor
final class LinkTests: XCTestCase {
    private var node: CameraNode!
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("splattwin-test-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        node?.stop()
        try? FileManager.default.removeItem(at: directory)
    }

    private func startNode(code: String) async throws -> UInt16 {
        node = CameraNode(name: "Testkamera", model: "Test", system: "Test", source: SyntheticSource(),
                          code: code, directory: directory.appendingPathComponent("node"))
        let ready = expectation(description: "Dienst bereit")
        var port: UInt16 = 0
        node.onReady = { port = $0; ready.fulfill() }
        try node.start(advertise: false, loopbackOnly: true)
        await fulfillment(of: [ready], timeout: 5)
        return port
    }

    private func wait(_ seconds: Double = 8, _ what: String, until condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > end { return XCTFail("Zeitüberschreitung: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testStreamRecordAndFetch() async throws {
        let port = try await startNode(code: "246810")
        let camera = Hub(defaults: UserDefaults(suiteName: "splattwin-test")!)
            .addLocal(id: "test", name: "Test", port: port, code: "246810")
        try await wait(8, "verbinden") { camera.isConnected }
        XCTAssertEqual(camera.hello?.name, "Testkamera")
        XCTAssertEqual(camera.hello?.lenses.first?.lens, .wide)

        // Livebild: hochkant, verkleinert, mit Aufnahmezeit. Ohne Quittung vom Mac kaemen nur zwei Bilder.
        camera.config.streamMaxSide = 1280
        camera.apply()
        var headers: [FrameHeader] = []
        var hubTimes: [Double] = []
        let tap = camera.frames.add { header, _, hubTime in
            DispatchQueue.main.async { headers.append(header); hubTimes.append(hubTime) }
        }
        try await wait(8, "Livebild") { camera.image != nil && headers.count > 20 }
        XCTAssertEqual(camera.image?.width, 720)
        XCTAssertEqual(camera.image?.height, 1280)
        XCTAssertEqual(headers.last?.width, 720)
        XCTAssertEqual(camera.status?.width, 720)
        XCTAssertEqual(camera.status?.config.rotation, 90)

        // Uhrenabgleich: beide Seiten laufen auf demselben Rechner, der Abstand muss nahe null sein.
        try await wait(8, "Uhrenabgleich") { camera.clockOffset != nil }
        XCTAssertLessThan(abs(camera.clockOffset!), 0.005)
        XCTAssertLessThan(abs(Clock.now - hubTimes.last!), 0.5)

        // Einstellungen aendern: Querformat, kleineres Livebild (T-2, T-5).
        camera.config.rotation = 0
        camera.config.streamMaxSide = 320
        camera.apply()
        try await wait(8, "neue Einstellung") { camera.status?.config.rotation == 0 && headers.last?.width == 320 }
        XCTAssertEqual(headers.last?.height, 180)

        // Aufnahme auf ein gemeinsames Startsignal, eine Sekunde lang.
        let start = Clock.now + 0.3
        camera.startRecording(name: "probe_a", at: start)
        try await wait(8, "Aufnahme läuft") { camera.status?.recording == true }
        try await Task.sleep(nanoseconds: 1_400_000_000)
        let info = try await camera.stopRecording()
        XCTAssertNil(info.error)
        XCTAssertEqual(info.width, 1280)
        XCTAssertEqual(info.height, 720)
        XCTAssertGreaterThan(info.frames, 20)
        XCTAssertGreaterThanOrEqual(camera.hubTime(info.firstFrame), start - 0.001)
        XCTAssertLessThan(camera.hubTime(info.firstFrame), start + 0.1)

        // Dateien abholen und pruefen.
        let video = directory.appendingPathComponent("mac/probe_a.mov")
        try await camera.fetch(info.file, to: video)
        let size = try video.resourceValues(forKeys: [.fileSizeKey]).fileSize
        XCTAssertEqual(Int64(size ?? 0), info.bytes)
        let track = try await AVURLAsset(url: video).loadTracks(withMediaType: .video).first
        let natural = try await track?.load(.naturalSize)
        XCTAssertEqual(natural, CGSize(width: 1280, height: 720))

        let sidecarURL = directory.appendingPathComponent("mac/probe_a.frames.json")
        try await camera.fetch(info.sidecar, to: sidecarURL)
        let sidecar = try JSONDecoder().decode(RecordingSidecar.self, from: Data(contentsOf: sidecarURL))
        XCTAssertEqual(sidecar.frameTimes.count, info.frames)
        XCTAssertEqual(sidecar.frameTimes.first, info.firstFrame)
        XCTAssertEqual(sidecar.frameTimes, sidecar.frameTimes.sorted())

        // Eine Datei, die es nicht gibt, und ein Pfad nach aussen muessen scheitern.
        for bad in ["fehlt.mov", "../geheim"] {
            do {
                try await camera.fetch(bad, to: directory.appendingPathComponent("mac/x"))
                XCTFail("\(bad) haette scheitern muessen")
            } catch {}
        }
        camera.frames.remove(tap)
        camera.disconnect()
    }

    func testWrongCodeIsRejected() async throws {
        let port = try await startNode(code: "111111")
        let hub = Hub(defaults: UserDefaults(suiteName: "splattwin-test")!)
        let camera = hub.addLocal(id: "test", name: "Test", port: port, code: "222222")
        try await wait(12, "Ablehnung") { if case .failed = camera.state { return true } else { return false } }
        XCTAssertEqual(camera.state, .failed("Kopplungscode stimmt nicht"))
        XCTAssertNil(camera.hello)
        camera.disconnect()
    }

    func testReconnectKeepsSettings() async throws {
        let port = try await startNode(code: "135790")
        let camera = Hub(defaults: UserDefaults(suiteName: "splattwin-test")!)
            .addLocal(id: "test", name: "Test", port: port, code: "135790")
        try await wait(8, "verbinden") { camera.isConnected }
        camera.config.streamFPS = 10
        camera.config.rotation = 0
        camera.apply()
        try await wait(8, "Einstellung") { camera.status?.config.streamFPS == 10 }

        // Die Kameraseite startet neu (wie ein Handy, das kurz weg war) und vergisst alles.
        node.stop()
        try await wait(8, "Abbruch bemerkt") { !camera.isConnected }
        node = CameraNode(name: "Testkamera", model: "Test", system: "Test", source: SyntheticSource(),
                          code: "135790", directory: directory.appendingPathComponent("node"))
        try startOnPort(port)
        try await wait(15, "wieder verbunden") { camera.isConnected && camera.status?.config.streamFPS == 10 }
        XCTAssertEqual(camera.status?.config.rotation, 0)
        camera.disconnect()
    }

    private func startOnPort(_ port: UInt16) throws {
        try node.start(advertise: false, loopbackOnly: true, port: port)
    }
}

final class WireTests: XCTestCase {
    func testPacketRoundTrip() throws {
        let header = FrameHeader(seq: 7, time: 12.5, width: 720, height: 1280, k: [1.1, 0.6, 0.5, 0.5])
        let packet = Packet(.frame, header: header, body: Data([1, 2, 3, 4, 5]))
        let data = packet.encoded
        let prefix = try XCTUnwrap(Packet.parsePrefix(data.prefix(Packet.prefixLength)))
        XCTAssertEqual(prefix.kind, .frame)
        XCTAssertEqual(prefix.body, 5)
        let headerData = data.dropFirst(Packet.prefixLength).prefix(prefix.header)
        XCTAssertEqual(try JSONDecoder().decode(FrameHeader.self, from: headerData), header)
        XCTAssertEqual(Data(data.suffix(5)), Data([1, 2, 3, 4, 5]))
    }

    func testPrefixRejectsNonsense() {
        XCTAssertNil(Packet.parsePrefix(Data([9, 0, 0, 0, 1, 0, 0, 0, 1])))            // unbekannte Art
        XCTAssertNil(Packet.parsePrefix(Data([1, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]))) // Kopf viel zu gross
        XCTAssertNil(Packet.parsePrefix(Data([1, 0, 0])))                              // zu kurz
    }

    func testMessagesSurviveEncoding() throws {
        var config = CameraConfig()
        config.lens = .ultraWide
        config.exposure = .manual
        config.shutter = 1.0 / 200
        let messages: [Message] = [
            .hello(HubHello(name: "Mac", role: "control")), .configure(config), .stopRecording,
            .phase(PhaseInfo(title: "Leerer Raum", color: "rec", speak: "Geh aus dem Bild")),
            .startRecording(RecordRequest(name: "scan_a", startAt: 100.25, clockOffset: -3.5)),
            .frameAck(FrameAck(seq: 42)),
        ]
        for message in messages {
            XCTAssertEqual(Packet(message).decode(Message.self), message)
        }
    }

    func testClockSyncPrefersShortestRoundTrip() {
        var sync = ClockSync()
        let offset = 42.0 // Geraeteuhr geht 42 s vor
        // Langsamer, einseitig verzoegerter Austausch: verfaelscht den Abstand um 40 ms.
        sync.add(t1: 10, t2: 10.09 + offset, t3: 10.09 + offset, t4: 10.10)
        XCTAssertEqual(sync.offset!, offset + 0.04, accuracy: 1e-9)
        // Schneller Austausch mit gleichen Laufzeiten: der gilt.
        sync.add(t1: 20, t2: 20.002 + offset, t3: 20.003 + offset, t4: 20.005)
        XCTAssertEqual(sync.offset!, offset, accuracy: 1e-9)
        XCTAssertEqual(sync.roundTrip!, 0.004, accuracy: 1e-9)
    }

    func testFileNamesCannotLeaveTheFolder() {
        XCTAssertTrue(CameraNode.validName("scan-2101_a.mov"))
        XCTAssertFalse(CameraNode.validName("../scan.mov"))
        XCTAssertFalse(CameraNode.validName("ordner/scan.mov"))
        XCTAssertFalse(CameraNode.validName(".versteckt"))
        XCTAssertFalse(CameraNode.validName(""))
    }

    func testJPEGEncoderScalesToMaxSide() throws {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, 3840, 2160, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
        let encoder = JPEGEncoder()
        _ = encoder.encode(buffer!, maxSide: 1280, quality: 0.6) // erster Aufruf baut die Grafikkette auf
        let start = Clock.now
        let jpeg = try XCTUnwrap(encoder.encode(buffer!, maxSide: 1280, quality: 0.6))
        print("JPEG 4K -> 1280: \(Int((Clock.now - start) * 1000)) ms, \(jpeg.data.count / 1024) KB")
        XCTAssertEqual(jpeg.width, 1280)
        XCTAssertEqual(jpeg.height, 720)
        XCTAssertEqual(RemoteCamera.decode(jpeg.data)?.width, 1280)
    }
}
