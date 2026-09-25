import UIKit
import WebKit
import Capacitor

// A real UIKit container owns the WebView and dock as siblings. Never insert
// application chrome into WKWebView's private, scrollable view hierarchy.
final class NativeGlassTabBarViewController: UIViewController, WKScriptMessageHandler {
    private let routes = ["/pages/home/index", "/pages/inbound/index", "/pages/outbound/index", "/pages/mine/index"]
    private let titles = ["首页", "入库", "出库", "我的"]
    private let symbols = ["house.fill", "tray.and.arrow.down.fill", "tray.and.arrow.up.fill", "person.fill"]
    private let bridgeController = WarehouseBridgeController()
    private let dock = UIView()
    private var glass: UIVisualEffectView!
    private var buttons: [UIButton] = []
    private var bridgeProxy: WeakTabMessageHandler?
    private var selectedIndex = 0
    private var routeIsTab = true
    private var webReady = false
    private var keyboardVisible = false
    private var modalVisible = false
    private var keyboardObservers: [NSObjectProtocol] = []
    private var smokeStarted = false
    private var contentAboveDock: NSLayoutConstraint!
    private var contentFullHeight: NSLayoutConstraint!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "warehouse.native.container"
        bridgeController.onBridgeLoaded = { [weak self] webView in
            self?.installMessaging(on: webView)
        }
        addChild(bridgeController)
        let content = bridgeController.view!
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        installDock()
        contentAboveDock = content.bottomAnchor.constraint(equalTo: dock.topAnchor)
        contentFullHeight = content.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.topAnchor.constraint(equalTo: view.topAnchor),
            contentFullHeight
        ])
        bridgeController.didMove(toParent: self)
        updateVisibility()
        keyboardObservers = [
            NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
                self?.keyboardVisible = true
                self?.updateVisibility()
            },
            NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
                self?.keyboardVisible = false
                self?.updateVisibility()
            }
        ]
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        publishCapability()
        if ProcessInfo.processInfo.arguments.contains("--native-dock-smoke"), !smokeStarted {
            smokeStarted = true
            runSmokeTest(step: 0, attempt: 0)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Content ends at dock.topAnchor and cannot scroll beneath the bar.
    }

    override var childForStatusBarStyle: UIViewController? { bridgeController }
    override var childForStatusBarHidden: UIViewController? { bridgeController }

    deinit {
        keyboardObservers.forEach { NotificationCenter.default.removeObserver($0) }
        bridgeController.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nativeTabSelected")
    }

    private func installDock() {
        dock.translatesAutoresizingMaskIntoConstraints = false
        dock.accessibilityIdentifier = "warehouse.native.tabbar"
        dock.backgroundColor = .systemBackground
        view.addSubview(dock)

        // Keep compatibility with the deployment target and older Xcode SDKs.
        glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        glass.translatesAutoresizingMaskIntoConstraints = false
        dock.addSubview(glass)

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(stack)
        for index in routes.indices {
            let button = UIButton(type: .system)
            button.tag = index
            button.accessibilityLabel = titles[index]
            button.accessibilityIdentifier = "warehouse.tab.\(index)"
            // Native image/label layout also works on iOS 13 and 14.
            let icon = UIImageView(image: UIImage(systemName: symbols[index]))
            icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 21, weight: .semibold)
            icon.contentMode = .scaleAspectFit
            icon.translatesAutoresizingMaskIntoConstraints = false
            let label = UILabel()
            label.text = titles[index]
            label.font = .systemFont(ofSize: 11, weight: .semibold)
            label.textAlignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            label.tag = 101
            button.addSubview(icon)
            button.addSubview(label)
            NSLayoutConstraint.activate([
                icon.centerXAnchor.constraint(equalTo: button.centerXAnchor),
                icon.topAnchor.constraint(equalTo: button.topAnchor, constant: 5),
                icon.heightAnchor.constraint(equalToConstant: 23),
                icon.widthAnchor.constraint(equalToConstant: 26),
                label.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 2),
                label.leadingAnchor.constraint(equalTo: button.leadingAnchor),
                label.trailingAnchor.constraint(equalTo: button.trailingAnchor),
                label.bottomAnchor.constraint(lessThanOrEqualTo: button.bottomAnchor, constant: -3)
            ])
            button.layer.cornerRadius = 20
            button.addTarget(self, action: #selector(selectTab(_:)), for: .touchUpInside)
            buttons.append(button)
            stack.addArrangedSubview(button)
        }
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            dock.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            dock.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            dock.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            dock.topAnchor.constraint(equalTo: safe.bottomAnchor, constant: -60),
            glass.leadingAnchor.constraint(equalTo: dock.leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: dock.trailingAnchor),
            glass.topAnchor.constraint(equalTo: dock.topAnchor),
            glass.bottomAnchor.constraint(equalTo: dock.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 5),
            stack.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -5),
            stack.topAnchor.constraint(equalTo: glass.contentView.topAnchor, constant: 4),
            stack.heightAnchor.constraint(equalToConstant: 52)
        ])
        updateSelection()
    }

    private func updateSelection() {
        for (index, button) in buttons.enumerated() {
            let selected = index == selectedIndex
            let color: UIColor = selected ? .systemBlue : .label
            button.tintColor = color
            (button.viewWithTag(101) as? UILabel)?.textColor = color
            button.backgroundColor = selected ? UIColor.systemBlue.withAlphaComponent(0.17) : .clear
            button.isSelected = selected
            button.accessibilityTraits = selected ? [.button, .selected] : [.button]
        }
    }

    private func updateVisibility() {
        let visible = webReady && routeIsTab && !keyboardVisible && !modalVisible
        dock.isHidden = !visible
        // Deactivate first to avoid conflicting bottom constraints.
        contentAboveDock.isActive = false
        contentFullHeight.isActive = false
        if visible { contentAboveDock.isActive = true }
        else { contentFullHeight.isActive = true }
    }

    private func installMessaging(on webView: WKWebView) {
        let proxy = WeakTabMessageHandler(self)
        bridgeProxy = proxy
        let controller = webView.configuration.userContentController
        controller.add(proxy, name: "nativeTabSelected")
        if ProcessInfo.processInfo.arguments.contains("--native-dock-smoke") {
            controller.addUserScript(WKUserScript(source: """
            window.__sgStartupErrors = [];
            window.addEventListener('error', function(e) {
              window.__sgStartupErrors.push(String(e.message || (e.target && e.target.src) || 'resource error'));
            }, true);
            window.addEventListener('unhandledrejection', function(e) { window.__sgStartupErrors.push(String(e.reason)); });
            const realFetch = window.fetch.bind(window);
            window.fetch = function(input, options) {
              const url = typeof input === 'string' ? input : input.url;
              if (url.indexOf('/api/') < 0) return realFetch(input, options);
              let data = [];
              if (url.indexOf('/auth/guest') >= 0) data = {token:'simulator',user:{id:'1',username:'preview',role:'viewer'}};
              if (url.indexOf('/stats') >= 0) data = {todayIn:0,todayOut:0,totalProducts:0,totalStock:0,lowStock:0,totalValue:0};
              if (url.indexOf('/sync') >= 0) data = {revision:1};
              return Promise.resolve(new Response(JSON.stringify({success:true,data:data}), {status:200,headers:{'Content-Type':'application/json'}}));
            };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        controller.addUserScript(WKUserScript(source: capabilityScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    private var capabilityScript: String {
        let info: [String: Any] = [
            "api": 2,
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
            "bottomSpace": 0,
            "layout": "inset"
        ]
        let data = try! JSONSerialization.data(withJSONObject: info)
        let json = String(data: data, encoding: .utf8)!
        return """
        window.__sgNativeDock = \(json);
        window.dispatchEvent(new Event('sg-native-ready'));
        """
    }

    private func publishCapability() {
        bridgeController.webView?.evaluateJavaScript(capabilityScript, completionHandler: nil)
    }

    @objc private func selectTab(_ sender: UIButton) {
        guard webReady, routes.indices.contains(sender.tag) else { return }
        // Highlight changes only after Taro acknowledges the actual route.
        let route = routes[sender.tag]
        bridgeController.webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('sg-native-tab',{detail:'\(route)'}));",
            completionHandler: nil
        )
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeTabSelected", message.frameInfo.isMainFrame else { return }
        if let state = message.body as? [String: Any], let route = state["route"] as? String {
            webReady = state["ready"] as? Bool ?? false
            routeIsTab = routes.contains(route)
            modalVisible = state["modal"] as? Bool ?? false
            if let index = routes.firstIndex(of: route) { selectedIndex = index }
            updateSelection()
            updateVisibility()
        }
    }

    // Executed only by the simulator job, against the compiled storyboard and WebView.
    private func runSmokeTest(step: Int, attempt: Int) {
        guard attempt < 300 else { finishSmokeTest("WebView did not acknowledge navigation"); return }
        let expected = step < routes.count ? step : 0
        guard webReady, selectedIndex == expected else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.runSmokeTest(step: step, attempt: attempt + 1)
            }
            return
        }
        view.layoutIfNeeded()
        guard dock.superview === view, bridgeController.view.superview === view,
              dock.superview !== bridgeController.webView,
              !dock.isHidden, abs(dock.bounds.height - 60 - view.safeAreaInsets.bottom) < 1,
              abs(bridgeController.view.frame.maxY - dock.frame.minY) < 1,
              dock.frame.minY > view.bounds.height / 2,
              abs(dock.frame.maxY - view.bounds.maxY) < 1,
              dock.hitTest(CGPoint(x: dock.bounds.midX, y: dock.bounds.midY), with: nil) != nil else {
            finishSmokeTest("Native dock hierarchy, bounds or hit testing failed")
            return
        }
        let script = """
        JSON.stringify({
          native: document.documentElement.classList.contains('sg-native-ios'),
          search: !!document.querySelector('.sg-home-search'),
          pages: Array.from(document.querySelectorAll('.taro_page')).filter(function(p) {
            return p.getBoundingClientRect().height > 100 && getComputedStyle(p).display !== 'none';
          }).length
        })
        """
        bridgeController.webView?.evaluateJavaScript(script) { [weak self] result, error in
            guard let self = self else { return }
            guard error == nil, let json = result as? String, let data = json.data(using: .utf8),
                  let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  state["native"] as? Bool == true, state["search"] as? Bool == false,
                  (state["pages"] as? Int ?? 0) > 0 else {
                self.finishSmokeTest("Web content, handshake or search removal failed")
                return
            }
            if step < self.routes.count - 1 {
                self.buttons[step + 1].sendActions(for: .touchUpInside)
            } else if step == self.routes.count - 1 {
                self.buttons[0].sendActions(for: .touchUpInside)
            } else if step == self.routes.count {
                self.webReady = false
                self.bridgeController.webView?.reload()
            } else {
                self.finishSmokeTest(nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.runSmokeTest(step: step + 1, attempt: 0)
            }
        }
    }

    private func finishSmokeTest(_ error: String?) {
        var result: [String: Any] = ["success": error == nil, "error": error ?? "",
                                    "controller": String(describing: type(of: self)),
                                    "selectedIndex": selectedIndex,
                                    "dockFrame": ["x": dock.frame.minX, "y": dock.frame.minY,
                                                  "width": dock.frame.width, "height": dock.frame.height]]
        result["url"] = bridgeController.webView?.url?.absoluteString ?? "nil"
        result["loading"] = bridgeController.webView?.isLoading ?? false
        result["progress"] = bridgeController.webView?.estimatedProgress ?? 0
        result["webFrame"] = String(describing: bridgeController.webView?.frame)
        bridgeController.webView?.evaluateJavaScript("""
          JSON.stringify({url:location.href, state:document.readyState, native:window.__sgNativeDock,
          errors:window.__sgStartupErrors, html:document.documentElement.outerHTML.slice(0,14000)})
        """) { value, jsError in
            result["webState"] = value as? String ?? jsError?.localizedDescription ?? "no JS result"
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted) {
                try? data.write(to: directory.appendingPathComponent("native-dock-smoke.json"), options: .atomic)
            }
        }
    }
}

private final class WarehouseBridgeController: CAPBridgeViewController {
    var onBridgeLoaded: ((WKWebView) -> Void)?
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        if let webView = webView { onBridgeLoaded?(webView) }
    }
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // Keep simulator verification offline and on the bundled revision.
        if ProcessInfo.processInfo.arguments.contains("--native-dock-smoke") {
            descriptor.appLocation = Bundle.main.bundleURL.appendingPathComponent("public")
        }
        return descriptor
    }
}

private final class WeakTabMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
