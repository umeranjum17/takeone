// Task-owned Simulator fixture. Deep links drive only fictional Tidewater data.
import UIKit
import WebKit

@main class App: UIResponder, UIApplicationDelegate, WKNavigationDelegate {
    var window: UIWindow?
    let web = WKWebView()
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let controller = UIViewController()
        controller.view = web
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = controller
        window?.makeKeyAndVisible()
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.93, alpha: 1)
        web.scrollView.isScrollEnabled = false
        web.loadFileURL(Bundle.main.url(forResource: "scene", withExtension: "html")!, allowingReadAccessTo: Bundle.main.bundleURL)
        return true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ProcessInfo.processInfo.arguments.contains("--demo") else { return }
        // App-owned navigation changes only demo data, never emits input events.
        for step in 1...6 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5 + Double(step - 1) * 3) {
                self.web.evaluateJavaScript("navigate(\(step))")
            }
        }
    }
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == "takeone-ios-camera", let step = Int(url.lastPathComponent), (1...6).contains(step) else { return false }
        web.evaluateJavaScript("navigate(\(step))")
        return true
    }
}
