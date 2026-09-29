import UIKit
import WebKit
import Capacitor

// Let UIKit render and track the actual Liquid Glass tab selection on iOS 26.
// A single live Capacitor bridge moves between lightweight tab hosts; data and
// the JavaScript router survive every selection. Older systems use the web dock.
final class NativeGlassTabBarViewController: UIViewController, WKScriptMessageHandler, UITabBarControllerDelegate {
    private let routes = ["/pages/home/index", "/pages/inbound/index", "/pages/outbound/index", "/pages/mine/index"]
    private let titles = ["首页", "入库", "出库", "我的"]
    private lazy var tabImages = (0..<4).map { Self.tabIcon($0) }
    private let bridgeController = WarehouseBridgeController()
    private let tabsController = UITabBarController()
    private var hosts: [UIViewController] = []
    private var bridgeProxy: WeakTabMessageHandler?
    private var selectedIndex = 0
    private var applyingSelection = false
    private var pendingIndex: Int?
    private var requestSequence = 0
    private var selectionTimeout: DispatchWorkItem?
    private var routeIsTab = true
    private var webReady = false
    private var keyboardVisible = false
    private var modalVisible = false
    private var keyboardObservers: [NSObjectProtocol] = []
    private var smokeStarted = false
    private var nativeGlass = false
    private var smokeTrace: [String] = []
    private var dockBackdrop: UIView?
    private var dock: UITabBar { tabsController.tabBar }

    private func traceSmoke(_ message: String) {
        guard ProcessInfo.processInfo.arguments.contains("--native-dock-smoke") else { return }
        let entry = "[NativeDock] \(message)"
        smokeTrace.append(entry)
        if smokeTrace.count > 100 { smokeTrace.removeFirst() }
        print(entry)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .white
        view.accessibilityIdentifier = "warehouse.native.container"
        bridgeController.onBridgeLoaded = { [weak self] webView in self?.installMessaging(on: webView) }
        installDock()
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
        // iOS 26's detached glass compositor also reads the window's traits.
        // A dark tab-bar trait alone still produces a light platter. Keep the
        // native hierarchy consistent; the web pages own their light surfaces.
        view.window?.overrideUserInterfaceStyle = .dark
        installDarkGlassOverlay()
        publishCapability()
        if ProcessInfo.processInfo.arguments.contains("--native-dock-smoke"), !smokeStarted {
            smokeStarted = true
            runSmokeTest(step: 0, attempt: 0)
        }
    }

    override var childForStatusBarStyle: UIViewController? { tabsController }
    override var childForStatusBarHidden: UIViewController? { tabsController }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutDockBackdrop()
    }

    deinit {
        selectionTimeout?.cancel()
        keyboardObservers.forEach { NotificationCenter.default.removeObserver($0) }
        bridgeController.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nativeTabSelected")
    }

    private func installDock() {
        // Keep the native hierarchy dark, including the bridge controller.
        // A nested light trait leaks into the system glass compositor.
        tabsController.overrideUserInterfaceStyle = .dark
        bridgeController.overrideUserInterfaceStyle = .dark
        hosts = routes.indices.map { index in
            let host = UIViewController()
            host.overrideUserInterfaceStyle = .dark
            host.view.backgroundColor = .clear
            host.tabBarItem = UITabBarItem(title: titles[index], image: tabImages[index], tag: index)
            host.tabBarItem.accessibilityIdentifier = "warehouse.tab.\(index)"
            return host
        }
        tabsController.delegate = self
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            nativeGlass = true
            let items = routes.indices.map { index in
                let host = hosts[index]
                let tab = UITab(title: titles[index], image: tabImages[index], identifier: routes[index]) { _ in host }
                tab.accessibilityIdentifier = "warehouse.tab.\(index)"
                return tab
            }
            tabsController.tabs = items
            tabsController.mode = .tabBar
        } else {
            tabsController.viewControllers = hosts
        }
        #else
        tabsController.viewControllers = hosts
        #endif
        addChild(tabsController)
        let content = tabsController.view!
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.topAnchor.constraint(equalTo: view.topAnchor),
            content.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        tabsController.didMove(toParent: self)
        dock.accessibilityIdentifier = "warehouse.native.tabbar"
        dock.overrideUserInterfaceStyle = .dark
        dock.barStyle = .black
        dock.tintColor = UIColor(red: 36 / 255, green: 166 / 255, blue: 248 / 255, alpha: 1)
        dock.unselectedItemTintColor = .white
        // Keep UIKit's native tab/gesture machinery, but give the system bar
        // an explicit dark glass backing. On the iOS 26 simulator the default
        // appearance otherwise stays a bright platter even when the window
        // trait is dark. A material blur preserves the live backdrop and the
        // native selection morphing while matching the approved dark dock.
        if #available(iOS 13.0, *) {
            let appearance = UITabBarAppearance()
            appearance.configureWithTransparentBackground()
            appearance.backgroundEffect = UIBlurEffect(style: .systemMaterialDark)
            appearance.backgroundColor = UIColor(red: 10 / 255, green: 13 / 255, blue: 18 / 255, alpha: 0.84)
            appearance.shadowColor = .clear
            appearance.stackedLayoutAppearance.normal.iconColor = .white
            appearance.stackedLayoutAppearance.normal.titleTextAttributes = [.foregroundColor: UIColor.white]
            appearance.stackedLayoutAppearance.selected.iconColor = UIColor(red: 36 / 255, green: 166 / 255, blue: 248 / 255, alpha: 1)
            appearance.stackedLayoutAppearance.selected.titleTextAttributes = [.foregroundColor: UIColor(red: 91 / 255, green: 190 / 255, blue: 255 / 255, alpha: 1)]
            dock.standardAppearance = appearance
            if #available(iOS 15.0, *) { dock.scrollEdgeAppearance = appearance }
        }
        installDarkGlassOverlay()
        updateSelection()
        updateVisibility()
    }

    private func installDarkGlassOverlay() {
        guard nativeGlass else { return }
        guard dockBackdrop == nil else { layoutDockBackdrop(); return }
        let backdrop = UIView()
        backdrop.backgroundColor = UIColor(red: 8 / 255, green: 12 / 255, blue: 18 / 255, alpha: 1)
        backdrop.isUserInteractionEnabled = false
        backdrop.layer.cornerCurve = .continuous
        dockBackdrop = backdrop
        layoutDockBackdrop()
    }

    private func layoutDockBackdrop() {
        guard let backdrop = dockBackdrop, let root = bridgeController.view,
              root.window != nil, dock.window === root.window else { return }
        // The native platter samples its hosted page, not arbitrary siblings
        // of the controller's tab container. Keep this app-owned background
        // inside that page above the WebView, below all native tab content.
        if backdrop.superview !== root { root.addSubview(backdrop) }
        root.bringSubviewToFront(backdrop)
        let visibleSurface = dock.subviews.first { !$0.isHidden && $0.bounds.width > dock.bounds.width / 2 }
        let rect = visibleSurface.map { $0.convert($0.bounds, to: root) }
            ?? dock.convert(CGRect(x: 21, y: 0, width: max(0, dock.bounds.width - 42), height: 62), to: root)
        backdrop.frame = rect
        backdrop.layer.cornerRadius = rect.height / 2
        backdrop.isHidden = dock.isHidden
    }

    // Same 24-unit line drawings as the web assets, rendered as tintable images.
    // Inbound is a received package/check; outbound is a delivery truck.
    private static func tabIcon(_ index: Int) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 25, height: 25)).image { renderer in
            let context = renderer.cgContext
            context.scaleBy(x: 25.0 / 24.0, y: 25.0 / 24.0)
            context.setStrokeColor(UIColor.black.cgColor)
            context.setLineWidth(1.8)
            context.setLineCap(.round)
            context.setLineJoin(.round)
            func line(_ points: [(CGFloat, CGFloat)]) {
                guard let first = points.first else { return }
                context.beginPath()
                context.move(to: CGPoint(x: first.0, y: first.1))
                for point in points.dropFirst() { context.addLine(to: CGPoint(x: point.0, y: point.1)) }
                context.strokePath()
            }
            switch index {
            case 0:
                line([(3, 10.5), (12, 3), (21, 10.5)])
                line([(5, 9), (5, 21), (10, 21), (10, 15), (14, 15), (14, 21), (19, 21), (19, 9)])
            case 1:
                line([(3, 7), (10, 3), (17, 7), (10, 11), (3, 7)])
                line([(3, 7), (3, 16), (10, 20), (10, 11)])
                line([(17, 7), (17, 12)])
                line([(14, 17), (16.5, 19.5), (22, 14)])
            case 2:
                line([(2.5, 16.5), (2.5, 5.5), (14.5, 5.5), (14.5, 16.5)])
                line([(14.5, 9), (18.5, 9), (21.5, 13), (21.5, 16.5), (20, 16.5)])
                line([(14.5, 13), (21.5, 13)])
                line([(9, 16.5), (15, 16.5)])
                line([(2.5, 16.5), (4, 16.5)])
                context.strokeEllipse(in: CGRect(x: 4, y: 14.5, width: 5, height: 5))
                context.strokeEllipse(in: CGRect(x: 15, y: 14.5, width: 5, height: 5))
            default:
                context.strokeEllipse(in: CGRect(x: 8.5, y: 3, width: 7, height: 7))
                context.move(to: CGPoint(x: 5, y: 21))
                context.addLine(to: CGPoint(x: 5, y: 19))
                context.addCurve(to: CGPoint(x: 12, y: 13), control1: CGPoint(x: 5, y: 15.5), control2: CGPoint(x: 8, y: 13))
                context.addCurve(to: CGPoint(x: 19, y: 19), control1: CGPoint(x: 16, y: 13), control2: CGPoint(x: 19, y: 15.5))
                context.addLine(to: CGPoint(x: 19, y: 21))
                context.strokePath()
            }
        }.withRenderingMode(.alwaysTemplate)
    }

    private func mountBridge(in host: UIViewController) {
        guard bridgeController.parent !== host else { return }
        if bridgeController.parent != nil {
            bridgeController.willMove(toParent: nil)
            bridgeController.view.removeFromSuperview()
            bridgeController.removeFromParent()
        }
        host.addChild(bridgeController)
        let content = bridgeController.view!
        content.translatesAutoresizingMaskIntoConstraints = false
        host.view.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: host.view.trailingAnchor),
            content.topAnchor.constraint(equalTo: host.view.topAnchor),
            content.bottomAnchor.constraint(equalTo: host.view.bottomAnchor)
        ])
        bridgeController.didMove(toParent: host)
    }

    private func updateSelection() {
        applyNativeSelection(selectedIndex)
        mountBridge(in: hosts[selectedIndex])
    }

    private func applyNativeSelection(_ index: Int) {
        guard tabsController.selectedIndex != index else { return }
        // UITab's delegate also fires for a programmatic selectedIndex change.
        // Without this guard, one request allocates a second sequence inside
        // the setter, then sends the older sequence last and loses its ACK.
        applyingSelection = true
        defer { applyingSelection = false }
        tabsController.selectedIndex = index
    }

    private func updateVisibility() {
        dock.isHidden = !(nativeGlass && webReady && routeIsTab && !keyboardVisible && !modalVisible)
        layoutDockBackdrop()
        dockBackdrop?.isHidden = dock.isHidden
    }

    private func requestTab(_ index: Int) {
        guard webReady, routes.indices.contains(index) else { return }
        traceSmoke("request index=\(index) selected=\(selectedIndex) UIKit=\(tabsController.selectedIndex)")
        requestSequence += 1
        let sequence = requestSequence
        pendingIndex = index
        selectionTimeout?.cancel()
        applyNativeSelection(index)
        mountBridge(in: hosts[index])
        // Retain the string detail for installed web bundles. Newer bundles
        // return requestId as well, so an older in-flight route cannot win.
        bridgeController.webView?.evaluateJavaScript(
            "var e=new CustomEvent('sg-native-tab',{detail:'\(routes[index])'});e.requestId=\(sequence);window.dispatchEvent(e);"
        ) { [weak self] _, error in
            self?.traceSmoke("dispatch sequence=\(sequence) error=\(error?.localizedDescription ?? "none")")
            if error != nil { self?.cancelSelection(sequence) }
        }
        let timeout = DispatchWorkItem { [weak self] in self?.cancelSelection(sequence) }
        selectionTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
    }

    private func cancelSelection(_ sequence: Int) {
        guard requestSequence == sequence, pendingIndex != nil else { return }
        traceSmoke("cancel sequence=\(sequence) pending=\(pendingIndex ?? -1) selected=\(selectedIndex)")
        pendingIndex = nil
        selectionTimeout?.cancel()
        updateSelection()
        // Reconcile with the actual route after a failed or unacknowledged
        // selection, including compatibility with an older web bundle.
        publishCapability()
    }

    #if compiler(>=6.2)
    @available(iOS 18.0, *)
    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        guard webReady, !modalVisible else { return false }
        return true
    }

    @available(iOS 18.0, *)
    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        guard !applyingSelection, let index = routes.firstIndex(of: selectedTab.identifier) else { return }
        requestTab(index)
    }
    #endif

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
            // The smoke process is intentionally offline. Seed only its
            // isolated WebView storage so TeamAccess renders the real pages
            // without waiting on a network login before testing navigation.
            try {
              localStorage.setItem('warehouse_session_v1', JSON.stringify({token:'simulator',user:{id:'1',username:'preview',role:'viewer'}}));
              localStorage.setItem('warehouse_device_id_v1', 'simulator');
            } catch (_) {}
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
            "api": nativeGlass ? 2 : 0,
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
            "bottomSpace": 72,
            "layout": "overlay",
            "material": nativeGlass ? "system-liquid-glass" : "web-glass"
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

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeTabSelected", message.frameInfo.isMainFrame,
              let state = message.body as? [String: Any], let route = state["route"] as? String else { return }
        traceSmoke("state route=\(route) request=\(String(describing: state["requestId"])) failed=\(String(describing: state["navigationFailed"])) pending=\(pendingIndex ?? -1) sequence=\(requestSequence)")
        webReady = state["ready"] as? Bool ?? false
        modalVisible = state["modal"] as? Bool ?? false
        if let pending = pendingIndex {
            let acknowledged = state["requestId"] as? Int
            let matching = acknowledged == requestSequence
            let compatible = acknowledged == nil && route == routes[pending]
            guard matching || compatible else { updateVisibility(); return }
            guard route == routes[pending] || state["navigationFailed"] as? Bool == true else {
                updateVisibility()
                return
            }
            pendingIndex = nil
            selectionTimeout?.cancel()
        }
        routeIsTab = routes.contains(route)
        if let index = routes.firstIndex(of: route) {
            selectedIndex = index
            updateSelection()
        }
        updateVisibility()
    }

    // Invoked by the simulator job against the real storyboard and WebView.
    private func runSmokeTest(step: Int, attempt: Int) {
        if attempt == 0 { traceSmoke("step=\(step) webReady=\(webReady) selected=\(selectedIndex) UIKit=\(tabsController.selectedIndex)") }
        guard attempt < 300 else { finishSmokeTest("WebView did not acknowledge navigation"); return }
        let expected = step == routes.count + 2 ? 3 : (step < routes.count ? step : 0)
        guard webReady, pendingIndex == nil, selectedIndex == expected else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.runSmokeTest(step: step, attempt: attempt + 1) }
            return
        }
        view.layoutIfNeeded()
        guard bridgeController.parent === hosts[selectedIndex],
              bridgeController.view.bounds.height > view.bounds.height / 2,
              dock.isHidden == !nativeGlass else {
            finishSmokeTest("Tab host, bridge containment or dock visibility failed")
            return
        }
        let script = """
        JSON.stringify({
          native: document.documentElement.classList.contains('sg-native-ios'),
          fallback: !!document.querySelector('.sg-glass-dock'),
          pages: Array.from(document.querySelectorAll('.taro_page')).filter(function(p) {
            return p.getBoundingClientRect().height > 100 && getComputedStyle(p).display !== 'none';
          }).length
        })
        """
        bridgeController.webView?.evaluateJavaScript(script) { [weak self] result, error in
            guard let self = self else { return }
            guard error == nil, let json = result as? String, let data = json.data(using: .utf8),
                  let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  state["native"] as? Bool == self.nativeGlass,
                  self.nativeGlass || state["fallback"] as? Bool == true,
                  (state["pages"] as? Int ?? 0) > 0 else {
                self.finishSmokeTest("Web content or dock handshake failed")
                return
            }
            if step < self.routes.count {
                let snapshot = UIGraphicsImageRenderer(bounds: self.view.bounds).image { _ in
                    self.view.drawHierarchy(in: self.view.bounds, afterScreenUpdates: true)
                }
                let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                try? snapshot.pngData()?.write(to: directory.appendingPathComponent("native-dock-step-\(step).png"), options: .atomic)
            }
            if step < self.routes.count - 1 {
                self.requestTab(step + 1)
            } else if step == self.routes.count - 1 {
                self.requestTab(0)
            } else if step == self.routes.count {
                self.webReady = false
                self.bridgeController.webView?.reload()
            } else if step == self.routes.count + 1 {
                // Three destinations in one native turn exercise the pending
                // request queue and the final acknowledgment after reload.
                self.requestTab(1)
                self.requestTab(2)
                self.requestTab(3)
            } else if step == self.routes.count + 2 {
                self.requestTab(0)
            } else {
                self.finishSmokeTest(nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.runSmokeTest(step: step + 1, attempt: 0) }
        }
    }

    private func finishSmokeTest(_ error: String?) {
        var hierarchy: [String] = []
        func inspect(_ node: UIView, depth: Int) {
            guard depth < 12, hierarchy.count < 140 else { return }
            let frame = node.convert(node.bounds, to: view)
            if frame.maxY >= view.bounds.height - 150 {
                let effect = (node as? UIVisualEffectView)?.effect.map { String(describing: type(of: $0)) } ?? "none"
                hierarchy.append("\(depth) \(type(of: node)) frame=\(frame) hidden=\(node.isHidden) alpha=\(node.alpha) style=\(node.traitCollection.userInterfaceStyle.rawValue) effect=\(effect)")
            }
            node.subviews.forEach { inspect($0, depth: depth + 1) }
        }
        inspect(tabsController.view, depth: 0)
        var result: [String: Any] = ["success": error == nil, "error": error ?? "",
                                    "nativeHierarchy": hierarchy,
                                    "trace": smokeTrace,
                                    "controller": String(describing: type(of: self)),
                                    "material": nativeGlass ? "system-liquid-glass" : "web-glass",
                                    "dockStyle": dock.traitCollection.userInterfaceStyle.rawValue,
                                    "selectedIndex": selectedIndex,
                                    "dockFrame": ["x": dock.frame.minX, "y": dock.frame.minY,
                                                  "width": dock.frame.width, "height": dock.frame.height]]
        result["url"] = bridgeController.webView?.url?.absoluteString ?? "nil"
        bridgeController.webView?.evaluateJavaScript("""
          JSON.stringify({url:location.href, state:document.readyState, native:window.__sgNativeDock,
          errors:window.__sgStartupErrors, visibility:document.visibilityState,
          text:document.body.innerText.slice(0,5000)})
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
