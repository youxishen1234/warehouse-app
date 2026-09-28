import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ProcessInfo.processInfo.arguments.contains("--system-reference") ? SystemReferenceController() : PrototypeController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
