import Foundation

/// Was die Koerpererkennung in einem Bild einer Kamera sieht (M-5). Die Erkennung selbst
/// laeuft auf dem Mac mit demselben Modell wie im Browser-Prototyp.
public struct PoseObservation: Codable, Equatable, Sendable {
    public var present = false
    /// Leer = fuer die Koerperaufnahme gut im Bild, sonst der Grund.
    public var hintBody = ""
    /// Leer = fuer den Gesichtsscan gut im Bild, sonst der Grund.
    public var hintFace = ""
    /// Blickrichtung aus der Schulterlinie in 3D, 0 Grad = schaut in die Kamera.
    public var yaw: Double?
    /// Kopfdrehung aus dem Gesichtsmodell, 0 Grad = schaut in die Kamera. Nur im Gesichtsscan, und nur
    /// solange das Gesicht zu sehen ist (etwa bis 70 Grad zur Seite); von hinten nil.
    public var headYaw: Double?
    /// Schultermitte im Bild, 0…1.
    public var center: [Double]?
    /// Koerperhoehe im Bild als Anteil der Bildhoehe.
    public var size: Double?
    /// Winkel zwischen Oberkoerper und linkem bzw. rechtem Arm in Grad, falls sichtbar.
    public var arms: [Double?]?
    /// Gelenke fuer die Anzeige: je [x, y, Sichtbarkeit].
    public var points: [[Double]]?
    /// Aufnahmezeit des Bildes auf der Mac-Uhr.
    public var time = 0.0

    public init() {}

    public func hint(face: Bool) -> String { face ? hintFace : hintBody }
}

public struct FlowOptions: Codable, Equatable, Sendable {
    /// Phase «leerer Raum» (A-1), «Koerper» (A-2), «Gesicht» (A-3): einzeln abschaltbar, um eine Phase zu wiederholen (A-6).
    public var background = true
    public var body = true
    public var face = true
    /// Phase «frei bewegen» nach der Koerperdrehung: Daten fuer spaetere, bewegliche Avatar-Verfahren.
    /// Die heutige Pipeline wertet sie nicht aus. Setzt die Koerper-Phase voraus.
    public var motion = true
    public var motionSeconds = 20.0
    public var bgSeconds = 4.0
    /// Richtzeit fuer eine Koerperdrehung. Kurz ist wichtig: je laenger die Drehung, desto mehr
    /// schwankt der Koerper und wandern die Arme, und der Splat wird verschmiert (scan-1222: 77 s).
    public var turnSeconds = 20.0
    /// Dauer des Gesichtsscans, falls das Gesichtsmodell den Kopf nicht sieht. Sonst fuehrt die gemessene
    /// Kopfdrehung durch den Scan: zur einen Seite, zur anderen, zurueck zur Mitte.
    public var faceSeconds = 20.0
    /// So lange muss die Pose stimmen, bevor die Drehung beginnt.
    public var hold = 1.5
    /// Danach geht es auch ohne erfuellte Bedingung weiter.
    public var gateTimeout = 40.0
    public var emptyTimeout = 30.0

    public init() {}

    /// Aeltere Metadateien kennen neuere Felder noch nicht: was fehlt, bekommt den Standardwert.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        background = try c.decodeIfPresent(Bool.self, forKey: .background) ?? true
        body = try c.decodeIfPresent(Bool.self, forKey: .body) ?? true
        face = try c.decodeIfPresent(Bool.self, forKey: .face) ?? true
        motion = try c.decodeIfPresent(Bool.self, forKey: .motion) ?? false
        motionSeconds = try c.decodeIfPresent(Double.self, forKey: .motionSeconds) ?? 20
        bgSeconds = try c.decodeIfPresent(Double.self, forKey: .bgSeconds) ?? 4
        turnSeconds = try c.decodeIfPresent(Double.self, forKey: .turnSeconds) ?? 20
        faceSeconds = try c.decodeIfPresent(Double.self, forKey: .faceSeconds) ?? 20
        hold = try c.decodeIfPresent(Double.self, forKey: .hold) ?? 1.5
        gateTimeout = try c.decodeIfPresent(Double.self, forKey: .gateTimeout) ?? 40
        emptyTimeout = try c.decodeIfPresent(Double.self, forKey: .emptyTimeout) ?? 30
    }
}

/// Der gefuehrte Ablauf aus capture.html als Zustandsmaschine: leerer Raum, Pose, Drehung,
/// optional Gesichtsscan (M-4, M-6, M-7). Rechnet nur; Kameras und Ansagen haengen aussen dran.
public final class FlowEngine {
    public enum Phase: String, Sendable { case idle, empty, poseBody, turnBody, motion, poseFace, turnFace, done }

    public let options: FlowOptions
    public private(set) var phase = Phase.idle
    public private(set) var title = "Bereit"
    public private(set) var progress = 0.0
    /// Zeitpunkte auf der Mac-Uhr: bgStart, bgEnd, turnStart, turnEnd, motionStart, motionEnd, faceStart, faceEnd.
    public private(set) var marks: [String: Double] = [:]
    /// Gezaehlte Grad: turnedDegrees, faceDegrees.
    public private(set) var degrees: [String: Int] = [:]
    public private(set) var notes: [String] = []
    /// Stimmt gerade, was die Phase verlangt? Fuer die Farbe der Anzeige.
    public private(set) var good = false
    public var onSay: ((String) -> Void)?

    private var phaseStart = 0.0
    private var since: Double?
    private var reference: [Double]?
    private var lastSaid = (text: "", at: -Double.infinity)
    private var turned = 0.0
    private var previousYaw: Double?
    private var previousTime = 0.0
    private var lastObservation = -1.0
    private var speed = 0.0
    private var calls: [(Double, String)] = []
    private var halfSaid = false
    private var progressAngle = 0.0
    private var progressTime = 0.0
    // Gesichtsscan nach Winkel
    private var faceByAngle = false
    private var faceStartYaw = 0.0
    private var faceRelative = 0.0
    private var faceSeenAt = 0.0
    private var faceMin = 0.0
    private var faceMax = 0.0
    private var sweepStage = 0
    private var sweepSide = 1.0
    private var armReference: [Double?]?
    private var armsOffSince: Double?
    private var armsNoted = false

    public init(options: FlowOptions = FlowOptions()) {
        self.options = options
    }

    public var isRunning: Bool { phase != .idle && phase != .done }
    public var faceMode: Bool { phase == .poseFace || phase == .turnFace }

    public func start(now: Double) {
        marks = [:]
        degrees = [:]
        notes = []
        if options.background { enter(.empty, now) }
        else if options.body { enter(.poseBody, now) }
        else { enter(.poseFace, now) }
    }

    public func abort() {
        phase = .idle
        title = "Abgebrochen"
        progress = 0
    }

    /// Mit dem neuesten Stand aller Kameras aufrufen, etwa 30-mal pro Sekunde.
    public func update(now: Double, main: PoseObservation, others: [PoseObservation] = []) {
        switch phase {
        case .idle, .done:
            return
        case .empty:
            let empty = !main.present && others.allSatisfy { !$0.present }
            title = empty ? "Leerer Raum – draussen bleiben" : "Geh aus dem Bild – ich sehe dich noch"
            good = empty
            switch wait(empty, hold: options.bgSeconds, timeout: options.emptyTimeout, now: now) {
            case .held(let from):
                marks["bgStart"] = from
                marks["bgEnd"] = now
                enter(options.body ? .poseBody : .poseFace, now)
            case .timedOut:
                notes.append("Kein leerer Raum erkannt: ohne Hintergrundbild.")
                enter(options.body ? .poseBody : .poseFace, now)
            case .waiting:
                break
            }
        case .poseBody, .poseFace:
            let label = phase == .poseBody ? "Körper" : "Gesicht"
            let trouble = problem(main)
            let ready = trouble.isEmpty && still(main)
            title = trouble.isEmpty ? "Gut so – kurz stillhalten" : trouble
            good = trouble.isEmpty
            if !trouble.isEmpty { say(trouble, now, gap: 6) }
            switch wait(ready, hold: options.hold, timeout: options.gateTimeout, now: now) {
            case .held:
                enter(phase == .poseBody ? .turnBody : .turnFace, now, main)
            case .timedOut:
                notes.append("\(label): Pose nicht bestätigt (\(trouble.isEmpty ? "nicht still" : trouble)), Drehung trotzdem gestartet.")
                enter(phase == .poseBody ? .turnBody : .turnFace, now, main)
            case .waiting:
                break
            }
        case .turnBody:
            turn(now, main)
        case .turnFace:
            if faceByAngle { sweepFace(now, main) } else { turn(now, main) }
        case .motion:
            move(now, main)
        }
    }

    // MARK: Phasen

    private func enter(_ next: Phase, _ now: Double, _ main: PoseObservation? = nil) {
        phase = next
        phaseStart = now
        since = nil
        reference = nil
        progress = 0
        good = false
        switch next {
        case .empty:
            title = "Geh aus dem Bild"
            say("Aufnahme läuft. Geh aus dem Bild.", now)
        case .poseBody:
            title = "Komm ins Bild und schau zur Kamera"
            say("Komm ins Bild. Schau zur Kamera. Arme leicht vom Körper weg.", now)
        case .poseFace:
            title = "Komm nah an die Kamera"
            say("Gut. Jetzt komm nah an die Kamera, bis Kopf und Schultern das Bild füllen.", now)
        case .motion:
            marks["motionStart"] = now
            halfSaid = false
            title = "Frei bewegen"
            say("Gut. Jetzt \(Int(options.motionSeconds)) Sekunden frei bewegen: Arme heben, Knie beugen, am Ort gehen. Bleib ganz im Bild.", now)
        case .turnBody, .turnFace:
            marks[next == .turnBody ? "turnStart" : "faceStart"] = now
            progressAngle = 0
            progressTime = now
            faceByAngle = next == .turnFace && main?.headYaw != nil
            faceStartYaw = main?.headYaw ?? 0
            faceRelative = 0
            faceSeenAt = now
            faceMin = 0
            faceMax = 0
            sweepStage = 0
            turned = 0
            previousYaw = main?.yaw
            previousTime = now
            lastObservation = main?.time ?? -1
            speed = 0
            calls = [(0.25, "Viertel"), (0.5, "Halb"), (0.75, "Drei Viertel")]
            armReference = main?.arms
            armsOffSince = nil
            good = true
            say(next == .turnBody ? "Jetzt zügig und gleichmässig drehen, Arme ruhig."
                : faceByAngle ? "Jetzt den Kopf langsam zur Seite drehen, bis ich gut sage."
                : "Jetzt eine Runde drehen, in \(Int(options.faceSeconds)) Sekunden. Kopf und Schultern zusammen.", now)
        case .done:
            title = notes.isEmpty ? "Fertig" : "Fertig – mit Hinweisen"
            say("Fertig.", now)
        case .idle:
            break
        }
    }

    private func problem(_ main: PoseObservation) -> String {
        if !main.present { return "Ich sehe dich noch nicht" }
        let hint = main.hint(face: phase == .poseFace)
        if !hint.isEmpty { return hint }
        // Im Gesichtsscan ist die Kopfdrehung aus dem Gesichtsmodell genauer als die Schulterlinie.
        if phase == .poseFace, let head = main.headYaw { return abs(head) > 20 ? "Schau gerade in die Kamera" : "" }
        if abs(main.yaw ?? 0) > 25 { return "Dreh dich zur Kamera" }
        return ""
    }

    /// Steht die Person still? Die Schultermitte darf sich um hoechstens 3 % des Bildes bewegen.
    private func still(_ main: PoseObservation) -> Bool {
        guard let center = main.center, center.count == 2 else { return false }
        if let reference, hypot(center[0] - reference[0], center[1] - reference[1]) <= 0.03 { return true }
        reference = center
        return false
    }

    private enum Wait { case waiting, held(Double), timedOut }

    /// Gilt die Bedingung `hold` Sekunden ununterbrochen? Liefert den Beginn dieser Strecke.
    private func wait(_ condition: Bool, hold: Double, timeout: Double, now: Double) -> Wait {
        if condition { since = since ?? now } else { since = nil }
        progress = since.map { min(1, (now - $0) / hold) } ?? 0
        if let since, now - since >= hold { return .held(since) }
        if now - phaseStart > timeout { return .timedOut }
        return .waiting
    }

    /// Zaehlt den Drehwinkel aus der Schulterlinie mit, bis 360 Grad voll sind.
    private func turn(_ now: Double, _ main: PoseObservation) {
        let label = phase == .turnBody ? "Körper" : "Gesicht"
        let elapsed = now - phaseStart
        if main.time != lastObservation {
            lastObservation = main.time
            if let yaw = main.yaw, main.present {
                if let previousYaw, now > previousTime {
                    let delta = FlowEngine.wrap(yaw - previousYaw)
                    // Spruenge um fast 180 Grad sind vertauschte Schultern, keine echte Drehung.
                    if abs(delta) < 60 {
                        turned += delta
                        let dt = now - previousTime
                        speed += (abs(delta) / dt - speed) * (1 - exp(-dt / 0.33))
                    }
                }
                previousYaw = yaw
                previousTime = now
            }
            if phase == .turnBody { watchArms(now, main) }
        }
        // Koerper: der gezaehlte Winkel bestimmt das Ende. Gesicht: die Zeit, die Viertel werden als Takt angesagt.
        let byTime = phase == .turnFace
        let fraction = byTime ? elapsed / options.faceSeconds : abs(turned) / 360
        progress = min(1, fraction)
        title = byTime ? "\(label): eine Runde drehen – noch \(max(0, Int((options.faceSeconds - elapsed).rounded(.up)))) s"
            : "\(label): gleichmässig drehen – \(Int(abs(turned).rounded()))°"
        while let call = calls.first, fraction >= call.0 {
            say(call.1, now)
            calls.removeFirst()
        }
        var finished = byTime ? fraction >= 1 : fraction >= 0.985
        if !byTime {
            let target = 360 / options.turnSeconds
            if speed > target * 1.8, elapsed > 2 { say("Langsamer", now, gap: 5) }
            // Zu langsam schadet mehr als zu schnell: der Koerper bleibt nicht so lange starr.
            else if speed < target * 0.6, elapsed > 4, now - progressTime < 5 { say("Schneller", now, gap: 6) }
            // Abgebrochen wird trotzdem nur, wenn es 15 Sekunden lang nicht mehr vorwaerts geht,
            // oder nach dem Vierfachen der Richtzeit.
            if abs(turned) > progressAngle + 10 {
                progressAngle = abs(turned)
                progressTime = now
            }
            if !finished, now - progressTime > 15 || elapsed > options.turnSeconds * 4 {
                notes.append("\(label): Drehung nicht vollständig (\(Int(abs(turned).rounded())) Grad gezählt), nach Zeit beendet.")
                finished = true
            }
        }
        guard finished else { return }
        if phase == .turnBody {
            if elapsed > options.turnSeconds * 1.5 {
                notes.append("Körper: Drehung zu langsam (\(Int(elapsed.rounded())) s statt etwa \(Int(options.turnSeconds)) s), der Splat wird unscharf.")
            }
            marks["turnEnd"] = now
            degrees["turnedDegrees"] = Int(turned.rounded())
            enter(options.motion ? .motion : (options.face ? .poseFace : .done), now)
        } else {
            marks["faceEnd"] = now
            degrees["faceDegrees"] = Int(turned.rounded())
            enter(.done, now)
        }
    }

    /// Freie Bewegung nach fester Zeit. Geprueft wird nur, ob die Person ganz im Bild bleibt.
    private func move(_ now: Double, _ main: PoseObservation) {
        let elapsed = now - phaseStart
        progress = min(1, elapsed / options.motionSeconds)
        title = "Frei bewegen: Arme, Knie, Schritte – noch \(max(0, Int((options.motionSeconds - elapsed).rounded(.up)))) s"
        good = main.present && main.hintBody.isEmpty
        if !main.present { say("Bleib im Bild", now, gap: 6) }
        else if !main.hintBody.isEmpty { say(main.hintBody, now, gap: 6) }
        if !halfSaid, elapsed >= options.motionSeconds / 2 {
            halfSaid = true
            say("Noch \(Int((options.motionSeconds / 2).rounded())) Sekunden.", now)
        }
        guard elapsed >= options.motionSeconds else { return }
        marks["motionEnd"] = now
        enter(options.face ? .poseFace : .done, now)
    }

    /// Gesichtsscan mit gemessener Kopfdrehung: Kopf langsam zur einen Seite, zur anderen und zurueck zur Mitte.
    /// Das ist bequemer als eine ganze Runde nah an der Kamera, und das Gesichtsmodell sieht den Kopf dabei
    /// die ganze Zeit (es verliert ihn erst jenseits von etwa 60 Grad).
    private func sweepFace(_ now: Double, _ main: PoseObservation) {
        let elapsed = now - phaseStart
        if main.time != lastObservation {
            lastObservation = main.time
            if let yaw = main.headYaw {
                let relative = FlowEngine.wrap(yaw - faceStartYaw)
                let dt = now - faceSeenAt
                // Am Rand des Sichtbaren springt die Schaetzung gelegentlich auf die andere Seite: verwerfen.
                if dt > 0.5 || abs(relative - faceRelative) <= 60 {
                    if dt > 0, dt < 0.5 { speed += (abs(relative - faceRelative) / dt - speed) * (1 - exp(-dt / 0.5)) }
                    faceRelative = relative
                    faceSeenAt = now
                    faceMin = min(faceMin, relative)
                    faceMax = max(faceMax, relative)
                }
            }
        }
        let visible = now - faceSeenAt < 0.4
        // Seite erreicht: 50 Grad gemessen, oder das Gesicht ist jenseits von 40 Grad aus der Sicht gedreht.
        func reached(_ side: Double) -> Bool {
            let turned = faceRelative * side
            return turned >= 50 || (!visible && turned >= 40)
        }
        let shown = Int(abs(faceRelative).rounded())
        switch sweepStage {
        case 0:
            title = "Gesicht: Kopf langsam zur Seite drehen – \(shown)°"
            progress = min(abs(faceRelative) / 50, 1) / 3
            if reached(1) || reached(-1) {
                sweepSide = faceRelative > 0 ? 1 : -1
                sweepStage = 1
                say("Gut. Jetzt langsam zur anderen Seite.", now)
            }
        case 1:
            title = "Gesicht: langsam zur anderen Seite – \(shown)°"
            progress = (1 + min(max((50 + faceRelative * sweepSide) / 100, 0), 1)) / 3
            if reached(-sweepSide) {
                sweepStage = 2
                say("Gut. Und zurück zur Mitte.", now)
            }
        default:
            title = "Gesicht: zurück zur Mitte – \(shown)°"
            progress = (2 + min(max(1 - abs(faceRelative) / 50, 0), 1)) / 3
        }
        good = true
        if visible, speed > 35, elapsed > 1 { say("Langsamer", now, gap: 5) }
        var finished = sweepStage == 2 && visible && abs(faceRelative) < 10
        if !finished, elapsed > max(60, options.faceSeconds * 3) {
            notes.append("Gesicht: Kopfdrehung nicht vollständig (\(Int(-faceMin.rounded()))° und \(Int(faceMax.rounded()))° erreicht), nach Zeit beendet.")
            finished = true
        }
        guard finished else { return }
        marks["faceEnd"] = now
        degrees["faceDegrees"] = Int((faceMax - faceMin).rounded())
        enter(.done, now)
    }

    /// Bewegte Arme sind die Hauptursache fuer verwaschene Stellen im Splat (M-7).
    private func watchArms(_ now: Double, _ main: PoseObservation) {
        guard let reference = armReference, let arms = main.arms else { return }
        let off = zip(reference, arms).contains { pair in
            guard let was = pair.0, let current = pair.1 else { return false }
            return abs(current - was) > 30
        }
        guard off else {
            armsOffSince = nil
            return
        }
        armsOffSince = armsOffSince ?? now
        guard now - armsOffSince! > 0.7 else { return }
        say("Arme ruhig halten", now, gap: 6)
        if !armsNoted {
            armsNoted = true
            notes.append("Körper: Die Arme haben sich während der Drehung bewegt.")
        }
    }

    private func say(_ text: String, _ now: Double, gap: Double = 0) {
        if text == lastSaid.text, now - lastSaid.at < gap { return }
        lastSaid = (text, now)
        onSay?(text)
    }

    static func wrap(_ degrees: Double) -> Double {
        var value = (degrees + 540).truncatingRemainder(dividingBy: 360)
        if value < 0 { value += 360 }
        return value - 180
    }
}
