import XCTest
@testable import SplattwinKit

final class FlowTests: XCTestCase {
    private var now = 100.0
    private var said: [String] = []

    private func person(yaw: Double = 0, hintBody: String = "", hintFace: String = "", center: [Double] = [0.5, 0.3],
                        arms: [Double?] = [20, 20], head: Double? = nil) -> PoseObservation {
        var o = PoseObservation()
        o.headYaw = head
        o.present = true
        o.yaw = FlowEngine.wrap(yaw)
        o.hintBody = hintBody
        o.hintFace = hintFace
        o.center = center
        o.arms = arms
        return o
    }

    /// Laesst den Ablauf mit 30 Bildern pro Sekunde laufen: `seconds` lang oder bis die Phase wechselt.
    private func run(_ engine: FlowEngine, _ seconds: Double, others: [PoseObservation] = [],
                     _ make: (Double) -> PoseObservation) {
        let start = now, phase = engine.phase
        while now - start < seconds, engine.phase == phase {
            var observation = make(now - start)
            observation.time = now
            engine.update(now: now, main: observation, others: others)
            now += 1.0 / 30
        }
    }

    private func engine(_ change: (inout FlowOptions) -> Void = { _ in }) -> FlowEngine {
        var options = FlowOptions()
        options.motion = false // die freie Bewegung hat eigene Tests
        change(&options)
        let engine = FlowEngine(options: options)
        engine.onSay = { self.said.append($0) }
        return engine
    }

    func testFullFlowBodyAndFace() {
        let flow = engine()
        flow.start(now: now)
        XCTAssertEqual(flow.phase, .empty)
        // Die Person ist noch zwei Sekunden im Bild: der leere Raum zaehlt erst danach.
        run(flow, 2) { _ in self.person() }
        XCTAssertEqual(flow.phase, .empty)
        XCTAssertFalse(flow.good)
        let leftAt = now
        run(flow, 10) { _ in PoseObservation() }
        XCTAssertEqual(flow.phase, .poseBody)
        XCTAssertEqual(flow.marks["bgStart"]!, leftAt, accuracy: 0.05)
        XCTAssertEqual(flow.marks["bgEnd"]! - flow.marks["bgStart"]!, 4, accuracy: 0.05)

        // Fuesse fehlen zuerst, dann schaut die Person weg, dann stimmt alles.
        run(flow, 2) { _ in self.person(hintBody: "Füsse nicht im Bild") }
        XCTAssertEqual(flow.title, "Füsse nicht im Bild")
        run(flow, 2) { _ in self.person(yaw: 50) }
        XCTAssertEqual(flow.title, "Dreh dich zur Kamera")
        XCTAssertEqual(flow.phase, .poseBody)
        run(flow, 3) { _ in self.person() }
        XCTAssertEqual(flow.phase, .turnBody)

        // Eine volle Drehung in 24 Sekunden.
        let turnStart = now
        run(flow, 60) { t in self.person(yaw: t * 15) }
        XCTAssertEqual(flow.phase, .poseFace)
        XCTAssertEqual(flow.marks["turnStart"]!, turnStart, accuracy: 0.05)
        XCTAssertEqual(flow.marks["turnEnd"]! - turnStart, 360 * 0.985 / 15, accuracy: 0.2)
        XCTAssertEqual(Double(flow.degrees["turnedDegrees"]!), 355, accuracy: 2)

        // Gesichtsscan: zuerst zu weit weg, dann nah; Drehung in die andere Richtung.
        run(flow, 2) { _ in self.person(hintFace: "Näher kommen") }
        XCTAssertEqual(flow.title, "Näher kommen")
        run(flow, 3) { _ in self.person(hintBody: "Füsse nicht im Bild") }
        XCTAssertEqual(flow.phase, .turnFace)
        // Im Gesichtsscan zaehlt die Zeit, nicht der Winkel: nach 20 Sekunden ist Schluss, auch wenn
        // die Erkennung in der Nahaufnahme kaum eine Drehung sieht.
        let faceStart = now
        run(flow, 60) { t in self.person(yaw: sin(t) * 10, hintBody: "Füsse nicht im Bild") }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(flow.marks["faceEnd"]! - faceStart, 20, accuracy: 0.1)
        XCTAssertTrue(flow.notes.isEmpty, "\(flow.notes)")
        XCTAssertLessThan(flow.marks["turnEnd"]!, flow.marks["faceStart"]!)

        XCTAssertEqual(said.first, "Aufnahme läuft. Geh aus dem Bild.")
        XCTAssertEqual(said.filter { $0 == "Halb" }.count, 2)
        XCTAssertEqual(said.last, "Fertig.")
        XCTAssertFalse(said.contains("Langsamer"))
    }

    func testEmptyRoomNeedsAllCameras() {
        let flow = engine()
        flow.start(now: now)
        // Kamera A sieht niemanden, Kamera B aber schon: kein gueltiger leerer Raum (A-1).
        run(flow, 6, others: [person()]) { _ in PoseObservation() }
        XCTAssertEqual(flow.phase, .empty)
        run(flow, 5, others: [PoseObservation()]) { _ in PoseObservation() }
        XCTAssertEqual(flow.phase, .poseBody)
    }

    func testTimeoutsAreNoted() {
        let flow = engine { $0.face = false }
        flow.start(now: now)
        run(flow, 31) { _ in self.person() } // geht nie aus dem Bild
        XCTAssertEqual(flow.phase, .poseBody)
        XCTAssertNil(flow.marks["bgStart"])
        run(flow, 41) { t in self.person(center: [0.5 + 0.1 * sin(t * 3), 0.3]) } // steht nie still
        XCTAssertEqual(flow.phase, .turnBody)
        run(flow, 40) { _ in self.person() } // dreht sich nicht
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(flow.notes.count, 3)
        XCTAssertTrue(flow.notes[0].contains("leerer Raum"))
        XCTAssertTrue(flow.notes[1].contains("nicht still"))
        XCTAssertTrue(flow.notes[2].contains("Drehung nicht vollständig"))
    }

    func testTooFastAndMovingArmsAreCalledOut() {
        let flow = engine { $0.background = false; $0.face = false }
        flow.start(now: now)
        XCTAssertEqual(flow.phase, .poseBody)
        run(flow, 3) { _ in self.person() }
        XCTAssertEqual(flow.phase, .turnBody)
        // 36 Grad pro Sekunde statt 12, und der linke Arm hebt sich nach fuenf Sekunden.
        run(flow, 30) { t in self.person(yaw: t * 36, arms: [t > 5 ? 70 : 20, 20]) }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertTrue(said.contains("Langsamer"))
        XCTAssertTrue(said.contains("Arme ruhig halten"))
        XCTAssertEqual(flow.notes, ["Körper: Die Arme haben sich während der Drehung bewegt."])
    }

    func testShoulderSwapIsNotCountedAsTurn() {
        let flow = engine { $0.background = false; $0.face = false }
        flow.start(now: now)
        run(flow, 3) { _ in self.person() }
        // Jede Sekunde vertauscht die Erkennung kurz die Schultern (Sprung um 180 Grad).
        run(flow, 60) { t in self.person(yaw: t * 15 + (Int(t * 30) % 30 == 0 ? 180 : 0)) }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(Double(flow.degrees["turnedDegrees"]!), 355, accuracy: 20)
    }

    func testFreeMovementAfterBodyTurn() {
        let flow = engine { $0.background = false; $0.face = false; $0.motion = true }
        flow.start(now: now)
        run(flow, 3) { _ in self.person() }
        run(flow, 60) { t in self.person(yaw: t * 15) }
        XCTAssertEqual(flow.phase, .motion)
        XCTAssertTrue(said.last!.contains("frei bewegen"))
        // Die Arme bewegen sich jetzt absichtlich; zwischendurch geraten die Fuesse aus dem Bild.
        run(flow, 60) { t in self.person(yaw: sin(t) * 40, hintBody: t > 12 && t < 14 ? "Füsse nicht im Bild" : "", arms: [20 + 60 * abs(sin(t)), 90]) }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(flow.marks["motionEnd"]! - flow.marks["motionStart"]!, 20, accuracy: 0.1)
        XCTAssertEqual(flow.marks["motionStart"]!, flow.marks["turnEnd"]!, accuracy: 0.05)
        XCTAssertTrue(said.contains("Noch 10 Sekunden."))
        XCTAssertTrue(said.contains("Füsse nicht im Bild"))
        XCTAssertFalse(said.contains("Arme ruhig halten"))
        XCTAssertTrue(flow.notes.isEmpty, "\(flow.notes)")
    }

    func testSlowTurnIsNotCutOff() {
        let flow = engine { $0.background = false; $0.face = false }
        flow.start(now: now)
        run(flow, 3) { _ in self.person() }
        // Eine Runde in 72 Sekunden, wie in der Aufnahme scan-1209: frueher wurde nach 36 Sekunden abgebrochen.
        let start = now
        run(flow, 200) { t in self.person(yaw: t * 5) }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(now - start, 360 * 0.985 / 5, accuracy: 0.5)
        XCTAssertEqual(Double(flow.degrees["turnedDegrees"]!), 355, accuracy: 2)
        XCTAssertTrue(flow.notes.isEmpty, "\(flow.notes)")
    }

    func testTurnStoppingHalfwayEndsAfterStall() {
        let flow = engine { $0.background = false; $0.face = false }
        flow.start(now: now)
        run(flow, 3) { _ in self.person() }
        let start = now
        run(flow, 200) { t in self.person(yaw: min(t * 12, 180)) } // bleibt nach einer halben Runde stehen
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(now - start, 15 + 15, accuracy: 1.5)
        XCTAssertTrue(flow.notes.first?.contains("nicht vollständig (180 Grad") ?? false, "\(flow.notes)")
    }

    /// Kopfdrehung, wie das Gesichtsmodell sie liefert: jenseits von 60 Grad sieht es das Gesicht nicht mehr.
    private func seen(_ yaw: Double) -> Double? { abs(yaw) > 60 ? nil : yaw }

    func testFaceScanIsGuidedSideToSide() {
        let flow = engine { $0.background = false; $0.body = false }
        flow.start(now: now)
        run(flow, 2) { _ in self.person(head: 40) }
        XCTAssertEqual(flow.title, "Schau gerade in die Kamera")
        run(flow, 3) { _ in self.person(head: 3) }
        XCTAssertEqual(flow.phase, .turnFace)
        XCTAssertTrue(said.last!.contains("zur Seite drehen"))
        // Zur einen Seite bis 70 Grad (ab 60 unsichtbar), zur anderen, zurueck: je 10 Grad pro Sekunde.
        let start = now
        run(flow, 90) { t in
            let yaw = t < 7 ? t * 10 : t < 21 ? 70 - (t - 7) * 10 : min(0, -70 + (t - 21) * 10)
            return self.person(head: self.seen(3 + yaw))
        }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(now - start, 27.2, accuracy: 1)
        XCTAssertEqual(said.filter { $0 == "Gut. Jetzt langsam zur anderen Seite." }.count, 1)
        XCTAssertEqual(said.filter { $0 == "Gut. Und zurück zur Mitte." }.count, 1)
        XCTAssertFalse(said.contains("Langsamer"))
        XCTAssertGreaterThan(flow.degrees["faceDegrees"]!, 100)
        XCTAssertTrue(flow.notes.isEmpty, "\(flow.notes)")
    }

    func testFaceScanOnlyOneSideIsNoted() {
        let flow = engine { $0.background = false; $0.body = false }
        flow.start(now: now)
        run(flow, 3) { _ in self.person(head: 0) }
        // Dreht nur zu einer Seite und zu schnell, dann bleibt der Kopf in der Mitte.
        run(flow, 90) { t in self.person(head: t < 1.2 ? t * 45 : t < 2.4 ? 54 - (t - 1.2) * 45 : 0) }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertTrue(said.contains("Langsamer"))
        XCTAssertTrue(flow.notes.first?.contains("nicht vollständig") ?? false, "\(flow.notes)")
    }

    func testOldMetadataStillDecodes() throws {
        let old = #"{"background":true,"bgSeconds":4,"body":true,"emptyTimeout":30,"face":true,"gateTimeout":40,"hold":1.5,"turnSeconds":30}"#
        let options = try JSONDecoder().decode(FlowOptions.self, from: Data(old.utf8))
        XCTAssertFalse(options.motion)
        XCTAssertEqual(options.faceSeconds, 20)
    }

    func testFaceOnlyRepeat() {
        let flow = engine { $0.background = false; $0.body = false }
        flow.start(now: now)
        XCTAssertEqual(flow.phase, .poseFace)
        run(flow, 3) { _ in self.person() }
        run(flow, 40) { t in self.person(yaw: t * 15) }
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(flow.marks["faceEnd"]! - flow.marks["faceStart"]!, 20, accuracy: 0.1)
        XCTAssertNil(flow.marks["turnStart"])
        XCTAssertNotNil(flow.marks["faceEnd"])
    }
}

final class StoreTests: XCTestCase {
    func testMetaMatchesWhatThePipelineReads() throws {
        let project = FileManager.default.temporaryDirectory.appendingPathComponent("splattwin-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: project) }
        let store = CaptureStore(project: project)
        let camera = CaptureMeta.Camera(key: "a", device: "iPhone", model: "iPhone17,1", file: "scan_a.mov", sidecar: "scan_a.frames.json",
                                        frames: 2700, dropped: 0, firstFrame: 50, offset: 0, syncErrorMs: 1.5, status: nil)
        let meta = CaptureMeta(name: "scan", marks: ["bgStart": 3.3, "bgEnd": 7.3, "turnStart": 17, "turnEnd": 60, "turnedDegrees": 355],
                               offset: 0, saved: ["a": .init(saved: "scan_a.mov", width: 2160, height: 3840, seconds: 90)],
                               notes: [], height: 1.82,
                               app: .init(created: "2026-11-19T21:00:00Z", options: FlowOptions(), cameras: [camera]))
        try store.write(meta)

        // So liest process_capture.py die Datei: meta["marks"], meta["name"], meta["saved"]["a"]["saved"].
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: store.metaURL("scan"))) as! [String: Any]
        XCTAssertEqual(json["name"] as? String, "scan")
        XCTAssertEqual((json["marks"] as? [String: Double])?["turnStart"], 17)
        XCTAssertEqual(((json["saved"] as? [String: Any])?["a"] as? [String: Any])?["saved"] as? String, "scan_a.mov")
        XCTAssertEqual(json["height"] as? Double, 1.82)

        // Eine Aufnahme aus capture.html (ohne App-Teil) erscheint trotzdem in der Liste.
        try Data(#"{"name":"alt","marks":{"turnStart":1},"offset":0,"saved":{"a":{"saved":"alt_a.mp4"}},"notes":[]}"#.utf8)
            .write(to: store.metaURL("alt"))
        try Data("{}".utf8).write(to: store.captures.appendingPathComponent("scan_a.frames.json"))
        let list = store.list()
        XCTAssertEqual(Set(list.map(\.name)), ["scan", "alt"])
        XCTAssertEqual(list.first { $0.name == "scan" }?.meta, meta)
        XCTAssertNil(list.first { $0.name == "alt" }?.meta)
        XCTAssertEqual(store.freeName("scan"), "scan-2")
        XCTAssertEqual(store.freeName("neu"), "neu")
        XCTAssertTrue(CaptureStore.validName("scan-2101"))
        XCTAssertFalse(CaptureStore.validName("scan 2101"))
    }

    func testQualityReportFromPipelineLog() {
        let log = """
        scan_a.mov: 90.5s @ 30fps -> 120 Frames, Hintergrundbild: ja
        Video a: Person bedeckt im Schnitt 23% des Bildes.

        Registriert: 118 von 120 Frames
        Video a: 118 Frames, Kamerabahn 352 Grad Bogen, Radius schwankt um 4%, Abweichung aus der Ebene 3%
        Gut ist: fast alle Frames registriert, etwa 360 Grad, kleine Schwankungen.
        === Kopf-Splat
        Registriert: 40 von 120 Frames
        """
        let report = QualityReport(log: log)
        XCTAssertEqual(report.registered, 118)
        XCTAssertEqual(report.total, 120)
        XCTAssertEqual(report.arcs["a"], 352)
        XCTAssertEqual(report.cover["a"], 23)
        XCTAssertEqual(report.verdict, "gut")
        XCTAssertEqual(QualityReport(log: "Registriert: 80 von 120 Frames\nVideo a: 80 Frames, Kamerabahn 280 Grad Bogen").verdict, "brauchbar")
        XCTAssertEqual(QualityReport(log: "Koerper-Splat fehlgeschlagen.").verdict, "wiederholen")
        XCTAssertEqual(QualityReport(log: "").verdict, "unbekannt")
    }
}

final class BridgeTests: XCTestCase {
    func testOnlyLocalPagesMayConnect() {
        XCTAssertTrue(WebBridge.allowed(origin: "http://127.0.0.1:8931"))
        XCTAssertTrue(WebBridge.allowed(origin: "http://localhost:8931"))
        XCTAssertTrue(WebBridge.allowed(origin: nil))
        XCTAssertFalse(WebBridge.allowed(origin: "https://boese.example"))
        XCTAssertFalse(WebBridge.allowed(origin: "http://127.0.0.1.boese.example"))
        XCTAssertFalse(WebBridge.allowed(origin: "null"))
    }

    func testBrowserReceivesListAndFrames() async throws {
        let bridge = WebBridge(port: 18932)
        try bridge.start()
        defer { bridge.stop() }
        let info = WebBridge.CameraInfo(id: "iPhone", name: "iPhone", lens: "Hauptkamera 1×", width: 720, height: 1280, fps: 30,
                                        latencyMs: 60, k: [1.4, 0.8, 0.5, 0.5], source: "device", distortion: "corrected")
        bridge.publish(cameras: [info], baseline: 1.25)
        try await Task.sleep(nanoseconds: 200_000_000)

        var request = URLRequest(url: URL(string: "ws://127.0.0.1:18932/")!)
        request.setValue("http://127.0.0.1:8931", forHTTPHeaderField: "Origin")
        let socket = URLSession.shared.webSocketTask(with: request)
        socket.resume()
        defer { socket.cancel() }

        guard case .string(let text) = try await socket.receive() else { return XCTFail("Liste erwartet") }
        let listing = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        XCTAssertEqual(listing["baseline"] as? Double, 1.25)
        XCTAssertEqual(((listing["cameras"] as? [[String: Any]])?.first)?["id"] as? String, "iPhone")

        // Uhrenabgleich der Seite.
        try await socket.send(.string(#"{"type":"ping","c":123.5}"#))
        guard case .string(let pongText) = try await socket.receive() else { return XCTFail("Antwort erwartet") }
        let pong = try JSONSerialization.jsonObject(with: Data(pongText.utf8)) as! [String: Any]
        XCTAssertEqual(pong["c"] as? Double, 123.5)
        XCTAssertEqual((pong["s"] as! Double) / 1000, Clock.now, accuracy: 0.5)

        // Ohne Abo kommt kein Bild, mit Abo genau das abonnierte.
        try await socket.send(.string(#"{"type":"subscribe","id":"iPhone","maxFps":30}"#))
        try await Task.sleep(nanoseconds: 100_000_000)
        let jpeg = Data([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
        bridge.push(id: "andere", header: FrameHeader(seq: 1, time: 0, width: 4, height: 4, k: nil), jpeg: jpeg, hubTime: 5)
        bridge.push(id: "iPhone", header: FrameHeader(seq: 9, time: 0, width: 720, height: 1280, k: [1.4, 0.8, 0.5, 0.5]), jpeg: jpeg, hubTime: 7.25)
        guard case .data(let frame) = try await socket.receive() else { return XCTFail("Bild erwartet") }
        let count = Int(frame[0]) | Int(frame[1]) << 8 | Int(frame[2]) << 16 | Int(frame[3]) << 24
        let head = try JSONSerialization.jsonObject(with: frame.subdata(in: 4 ..< 4 + count)) as! [String: Any]
        XCTAssertEqual(head["id"] as? String, "iPhone")
        XCTAssertEqual(head["seq"] as? Int, 9)
        XCTAssertEqual(head["t"] as? Double, 7250)
        XCTAssertEqual(head["k"] as? [Double], [1.4, 0.8, 0.5, 0.5])
        XCTAssertEqual(frame.subdata(in: 4 + count ..< frame.count), jpeg)
    }

    func testForeignWebsiteIsRejected() async throws {
        let bridge = WebBridge(port: 18933)
        try bridge.start()
        defer { bridge.stop() }
        try await Task.sleep(nanoseconds: 200_000_000)
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:18933/")!)
        request.setValue("https://boese.example", forHTTPHeaderField: "Origin")
        request.timeoutInterval = 3
        let socket = URLSession.shared.webSocketTask(with: request)
        socket.resume()
        defer { socket.cancel() }
        do {
            _ = try await socket.receive()
            XCTFail("Fremde Seite haette abgewiesen werden muessen")
        } catch {}
    }
}
