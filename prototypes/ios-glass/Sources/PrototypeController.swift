import UIKit
import WebKit

final class PrototypeController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, UITextFieldDelegate {
    private let routes = ["home", "inbound", "outbound", "mine"]
    private var web: WKWebView!
    private let dock = GlassDock()
    private let diagnostic = UILabel()
    private let tools = UIStackView()
    private let field = UITextField()
    private var proxy: PrototypeMessageProxy?
    private var observers: [NSObjectProtocol] = []
    private var webReady = false
    private var route = "home"
    private var modal = false
    private var keyboard = false
    private var lastInset = -1.0
    private var epoch = 0
    private var lastSequence = -1
    private var pendingRequest: String?
    private var watchdog: DispatchWorkItem?
    private var failed = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let proxy = PrototypeMessageProxy(self); self.proxy = proxy
        configuration.userContentController.add(proxy, name: "dockState")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.accessibilityIdentifier = "prototype.web"
        view.addSubview(web)
        diagnostic.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
        diagnostic.textColor = .secondaryLabel
        diagnostic.numberOfLines = 2
        diagnostic.accessibilityIdentifier = "prototype.status"
        view.addSubview(diagnostic)
        tools.axis = .horizontal; tools.spacing = 8; tools.distribution = .fillEqually
        for (title, selector) in [("弹层", #selector(openModal)), ("详情", #selector(openDetail)), ("首页", #selector(goHome)), ("重载", #selector(reloadContent))] {
            let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.titleLabel?.font = .systemFont(ofSize: 13)
            button.addTarget(self, action: selector, for: .touchUpInside); button.accessibilityIdentifier = "prototype.tool." + title
            tools.addArrangedSubview(button)
        }
        view.addSubview(tools)
        field.placeholder = "点此测试键盘握手"; field.borderStyle = .roundedRect; field.returnKeyType = .done
        field.font = .systemFont(ofSize: 14); field.delegate = self; field.accessibilityIdentifier = "prototype.input"
        view.addSubview(field)
        view.addSubview(dock)
        dock.onSelect = { [weak self] index in self?.requestRoute(index) }
        observers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let local = self.view.convert(frame, from: nil)
            self.keyboard = self.view.bounds.intersection(local).height > 0
            self.updateVisibility()
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in self?.keyboard = false; self?.updateVisibility() })
        reloadContent()
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaInsets, width = view.bounds.width
        diagnostic.frame = CGRect(x: safe.left + 16, y: safe.top + 4, width: width - safe.left - safe.right - 32, height: 30)
        tools.frame = CGRect(x: safe.left + 16, y: diagnostic.frame.maxY + 2, width: width - safe.left - safe.right - 32, height: 36)
        field.frame = CGRect(x: safe.left + 16, y: tools.frame.maxY + 4, width: width - safe.left - safe.right - 32, height: 36)
        web.frame = CGRect(x: 0, y: field.frame.maxY + 8, width: width, height: view.bounds.height - field.frame.maxY - 8)
        // WebView extends behind the glass, rather than ending at its top edge.
        let dockWidth = min(460, width - safe.left - safe.right - 32)
        dock.frame = CGRect(x: (width - dockWidth) / 2, y: view.bounds.height - safe.bottom - 12 - 68, width: dockWidth, height: 68)
        dock.layoutIfNeeded()
        publishInset()
        updateDiagnostic()
    }
    private func updateVisibility() {
        dock.isHidden = !webReady || !routes.contains(route) || modal || keyboard || failed
        publishInset(); updateDiagnostic()
    }
    private func publishInset() {
        guard web != nil else { return }
        let inset = dock.isHidden ? Double(view.safeAreaInsets.bottom) : Double(view.bounds.maxY - dock.frame.minY + 12)
        guard inset != lastInset else { return }
        lastInset = inset
        web.evaluateJavaScript("window.setDockInset && window.setDockInset(" + String(inset) + ");", completionHandler: nil)
    }
    private func updateDiagnostic() {
        diagnostic.text = "material=" + dock.material + " route=" + route + " ready=" + String(webReady) + " visible=" + String(!dock.isHidden) + " inset=" + String(Int(max(lastInset, 0))) + " keyboard=" + String(keyboard) + " modal=" + String(modal) + (failed ? " ERROR" : "")
    }
    @objc private func reloadContent() {
        webReady = false; modal = false; failed = false; lastSequence = -1; pendingRequest = nil; epoch += 1; lastInset = -1
        watchdog?.cancel(); updateVisibility()
        guard let file = Bundle.main.url(forResource: "content", withExtension: "html"), let html = try? String(contentsOf: file, encoding: .utf8) else { failed = true; updateVisibility(); return }
        let scripts = web.configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: "window.prototypeEpoch=" + String(epoch) + ";", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web.loadHTMLString(html, baseURL: Bundle.main.bundleURL)
        startWatchdog()
    }
    private func startWatchdog() {
        watchdog?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.failed = true; self?.updateVisibility() }
        watchdog = item; DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: item)
    }
    private func requestRoute(_ index: Int) {
        guard webReady, routes.indices.contains(index) else { return }
        let request = UUID().uuidString; pendingRequest = request
        let payload: [String: Any] = ["route": routes[index], "requestId": request]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        startWatchdog()
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('native-tab', {detail:" + json + "}));", completionHandler: nil)
    }
    @objc private func openModal() { web.evaluateJavaScript("window.openPreviewModal();", completionHandler: nil) }
    @objc private func openDetail() { web.evaluateJavaScript("window.openDetail();", completionHandler: nil) }
    @objc private func goHome() { requestRoute(0) }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { textField.resignFirstResponder(); return true }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.name == "dockState", let state = message.body as? [String: Any], let messageEpoch = state["epoch"] as? Int, messageEpoch == epoch, let sequence = state["sequence"] as? Int, sequence > lastSequence, let newRoute = state["route"] as? String else { return }
        if let expected = pendingRequest, state["requestId"] as? String != expected { return }
        lastSequence = sequence; pendingRequest = nil; watchdog?.cancel()
        webReady = state["ready"] as? Bool == true
        route = newRoute; modal = state["modal"] as? Bool == true
        failed = false
        if let index = routes.firstIndex(of: route) { dock.acknowledge(index: index, animated: true) }
        updateVisibility()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { lastInset = -1; publishInset() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed = true; updateVisibility() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed = true; updateVisibility() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webReady = false; failed = true; updateVisibility() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme
        decisionHandler(scheme == "about" || scheme == "file" ? .allow : .cancel)
    }
    deinit {
        watchdog?.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "dockState")
    }
}
private final class PrototypeMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { target?.userContentController(userContentController, didReceive: message) }
}
