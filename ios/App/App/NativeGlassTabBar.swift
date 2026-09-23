import UIKit
import WebKit
import Capacitor

final class NativeGlassTabBarViewController: CAPBridgeViewController, WKScriptMessageHandler, UIGestureRecognizerDelegate {
    private let routes = ["/pages/home/index", "/pages/inbound/index", "/pages/outbound/index", "/pages/mine/index"]
    private let symbols = ["house.fill", "tray.and.arrow.down.fill", "tray.and.arrow.up.fill", "person.crop.circle"]
    private let titles = ["\u{9996}\u{9875}", "\u{5165}\u{5E93}", "\u{51FA}\u{5E93}", "\u{6211}\u{7684}"]
    private var glassView: UIVisualEffectView?
    private var buttons: [UIButton] = []
    private var selectedIndex = 0
    private var bridgeHandlerInstalled = false
    private var swipeRecognizer: UIPanGestureRecognizer?
    private var metricsHandlerInstalled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        installGlassBar()
        installBridgeHandler()
        installSwipeNavigation()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installBridgeHandler()
        installSwipeNavigation()
        markWebView(attempt: 0)
    }

    deinit {
        bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nativeTabSelected")
        bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nativeTabMetrics")
    }

    private func glassEffect() -> UIVisualEffect {
        if #available(iOS 26.0, *) {
            let effect = UIGlassEffect(style: .regular)
            effect.isInteractive = true
            return effect
        }
        return UIBlurEffect(style: .systemChromeMaterial)
    }

    private func installGlassBar() {
        guard glassView == nil else { return }
        let glass = UIVisualEffectView(effect: glassEffect())
        glass.translatesAutoresizingMaskIntoConstraints = true
        glass.layer.cornerRadius = 34
        glass.clipsToBounds = true
        view.addSubview(glass)

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fillEqually
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(stack)

        for index in routes.indices {
            let button = makeButton(index: index)
            buttons.append(button)
            stack.addArrangedSubview(button)
        }

        glass.frame = CGRect(x: 16, y: view.bounds.height - 80, width: max(0, view.bounds.width - 32), height: 58)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: glass.contentView.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor, constant: -3)
        ])
        glassView = glass
        updateSelection()
        glass.isHidden = true
    }

    private func makeButton(index: Int) -> UIButton {
        let button = UIButton(type: .system)
        if #available(iOS 15.0, *) {
            var config = UIButton.Configuration.plain()
            config.image = UIImage(systemName: symbols[index])
            config.title = titles[index]
            config.imagePlacement = .top
            config.imagePadding = 2
            config.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 2, bottom: 4, trailing: 2)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attrs in
                var result = attrs
                result.font = .systemFont(ofSize: 10, weight: .medium)
                return result
            }
            button.configuration = config
        } else {
            button.setImage(UIImage(systemName: symbols[index]), for: .normal)
            button.setTitle(titles[index], for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 10, weight: .medium)
        }
        button.tag = index
        button.accessibilityLabel = titles[index]
        button.addTarget(self, action: #selector(selectTab(_:)), for: .touchUpInside)
        return button
    }

    private func updateSelection() {
        for (index, button) in buttons.enumerated() {
            let color: UIColor = index == selectedIndex ? .systemBlue : .secondaryLabel
            if #available(iOS 15.0, *) {
                button.configuration?.baseForegroundColor = color
            } else {
                button.tintColor = color
                button.setTitleColor(color, for: .normal)
            }
            button.backgroundColor = index == selectedIndex ? UIColor.white.withAlphaComponent(0.28) : .clear
            button.layer.cornerRadius = 28
        }
    }

    private func installBridgeHandler() {
        guard let webView = bridge?.webView else { return }
        if !bridgeHandlerInstalled {
            webView.configuration.userContentController.add(self, name: "nativeTabSelected")
            bridgeHandlerInstalled = true
        }
        if !metricsHandlerInstalled {
            webView.configuration.userContentController.add(self, name: "nativeTabMetrics")
            metricsHandlerInstalled = true
        }
        installPageAnchorScript()
    }

    private func installPageAnchorScript() {
        let script = """
        (function(){
          if (window.__sgNativeAnchorInstalled) return;
          window.__sgNativeAnchorInstalled = true;
          var anchor = null;
          function report(){
            if (!anchor || !anchor.isConnected) return;
            var r = anchor.getBoundingClientRect();
            var h = window.innerHeight || document.documentElement.clientHeight;
            window.webkit.messageHandlers.nativeTabMetrics.postMessage({x:r.left,y:r.top,w:r.width,h:r.height,viewport:h});
          }
          function install(){
            var roots = Array.prototype.slice.call(document.querySelectorAll('taro-scroll-view-core'));
            var root = roots.find(function(el){ return el.offsetWidth > 0 && el.offsetHeight > 0; }) || document.querySelector('.taro_page.taro_tabbar_page') || document.body;
            if (!root) return;
            if (!anchor) { anchor = document.createElement('div'); anchor.id = 'sg-native-tabbar-anchor'; }
            if (anchor.parentNode !== root) root.appendChild(anchor);
            anchor.style.cssText = 'display:block;width:100%;height:76px;pointer-events:none;';
            report();
          }
          new MutationObserver(install).observe(document.body, {childList:true,subtree:true});
          document.addEventListener('scroll', report, true);
          window.addEventListener('resize', report);
          install();
          setInterval(report, 250);
        })();
        """
        bridge?.webView?.evaluateJavaScript(script)
    }

    private func installSwipeNavigation() {
        guard swipeRecognizer == nil, let webView = bridge?.webView else { return }
        let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        recognizer.delegate = self
        recognizer.cancelsTouchesInView = false
        webView.addGestureRecognizer(recognizer)
        swipeRecognizer = recognizer
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: view)
        return abs(velocity.x) > abs(velocity.y) * 1.35 && abs(velocity.x) > 45
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }

    @objc private func handleSwipe(_ recognizer: UIPanGestureRecognizer) {
        guard recognizer.state == .ended else { return }
        let translation = recognizer.translation(in: view)
        guard abs(translation.x) >= 60, abs(translation.x) > abs(translation.y) * 1.25 else { return }
        let next = translation.x < 0 ? selectedIndex + 1 : selectedIndex - 1
        guard routes.indices.contains(next) else { return }
        selectedIndex = next
        updateSelection()
        bridge?.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('sg-native-tab',{detail:'\(routes[next])'}));")
    }

    private func markWebView(attempt: Int) {
        guard attempt < 20, let webView = bridge?.webView else { return }
        webView.evaluateJavaScript("document.getElementById('app') ? (document.documentElement.classList.add('sg-native-ios'), 'ready') : ''") { [weak self] result, error in
            guard error != nil || (result as? String) != "ready", let self else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.markWebView(attempt: attempt + 1) }
        }
    }

    @objc private func selectTab(_ sender: UIButton) {
        guard routes.indices.contains(sender.tag) else { return }
        selectedIndex = sender.tag
        updateSelection()
        bridge?.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('sg-native-tab',{detail:'\(routes[sender.tag])'}));")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "nativeTabMetrics", let data = message.body as? [String: Any],
           let x = (data["x"] as? NSNumber)?.doubleValue,
           let y = (data["y"] as? NSNumber)?.doubleValue,
           let width = (data["w"] as? NSNumber)?.doubleValue {
            DispatchQueue.main.async { [weak self] in
                guard let self, let glass = self.glassView else { return }
                let origin = self.bridge?.webView?.convert(CGPoint(x: x, y: y + 8), to: self.view) ?? CGPoint(x: 16, y: self.view.bounds.height - 80)
                glass.frame = CGRect(x: 16, y: origin.y, width: max(0, min(CGFloat(width) - 32, self.view.bounds.width - 32)), height: 58)
                glass.isHidden = false
            }
            return
        }
        guard let route = message.body as? String,
              let index = routes.firstIndex(where: { route.contains($0.replacingOccurrences(of: "/pages", with: "")) || route == $0 }) else { return }
        DispatchQueue.main.async { self.selectedIndex = index; self.updateSelection() }
    }
}
