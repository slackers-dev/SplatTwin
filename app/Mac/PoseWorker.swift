import Foundation
import SplattwinKit
import WebKit

/// Koerpererkennung in einer unsichtbaren Webansicht: dasselbe MediaPipe-Modell wie im
/// Browser-Prototyp, damit Ablauf und Winkelzaehlung gleich bleiben (M-4 bis M-6).
/// Die Seite holt die Livebilder ueber die lokale Bruecke und meldet die Ergebnisse hierher.
@MainActor
final class PoseWorker: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    var onObservation: ((String, PoseObservation) -> Void)?
    var onState: ((Bool, String?) -> Void)?
    private let port: UInt16

    init(port: UInt16) {
        self.port = port
        let configuration = WKWebViewConfiguration()
        // Die Seite ist absichtlich unsichtbar. WebKit bremst unsichtbare Seiten stark; das wuerde die
        // Erkennung mitten in der Aufnahme anhalten, sobald das Fenster verdeckt ist oder der Bildschirm schlaeft.
        for (key, setter) in [("hiddenPageDOMTimerThrottlingEnabled", "_setHiddenPageDOMTimerThrottlingEnabled:"),
                              ("pageVisibilityBasedProcessSuppressionEnabled", "_setPageVisibilityBasedProcessSuppressionEnabled:")]
        where configuration.preferences.responds(to: Selector((setter))) {
            configuration.preferences.setValue(false, forKey: key)
        }
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 64, height: 64), configuration: configuration)
        super.init()
        configuration.userContentController.add(self, name: "pose")
        webView.navigationDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        load()
    }

    func load() {
        guard let url = Bundle.main.url(forResource: "pose", withExtension: "html"),
              let html = try? String(contentsOf: url, encoding: .utf8) else {
            onState?(false, "pose.html fehlt in der App")
            return
        }
        // Als lokale Seite laden, damit sie die Bruecke auf diesem Rechner erreichen darf.
        webView.loadHTMLString(html, baseURL: URL(string: "http://127.0.0.1:\(port)/"))
    }

    /// Fuer diese Kamera zusaetzlich die Kopfdrehung messen (Gesichtsscan); nil schaltet es wieder ab.
    func setFaceCamera(_ id: String?) {
        let argument = id.map { "'\($0.replacingOccurrences(of: "'", with: ""))'" } ?? "null"
        webView.evaluateJavaScript("window.setFaceCamera && window.setFaceCamera(\(argument))")
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let text = message.body as? String, let data = text.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            switch json["type"] as? String {
            case "ready":
                onState?(true, nil)
            case "error":
                onState?(false, json["text"] as? String)
            case "pose":
                guard let id = json["id"] as? String, let raw = json["observation"],
                      let body = try? JSONSerialization.data(withJSONObject: raw),
                      let observation = try? JSONDecoder().decode(PoseObservation.self, from: body) else { return }
                onObservation?(id, observation)
            default:
                break
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { onState?(false, error.localizedDescription) }
    }

    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        MainActor.assumeIsolated {
            onState?(false, "Körpererkennung neu gestartet")
            load()
        }
    }
}
