import UIKit
import WebKit
import Capacitor

final class NativeGlassTabBarViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private let routes = ["/pages/home/index", "/pages/inbound/index", "/pages/outbound/index", "/pages/mine/index"]
    private let symbols = ["house.fill", "tray.and.arrow.down.fill", "tray.and.arrow.up.fill", "person.crop.circle"]
    private let titles = ["首页", "入库", "出库", "我的"]
    private var glassView: UIVisualEffectView?
    private var buttons: [UIButton] = []
    private var selectedIndex = 0
    private var bridgeHandlerInstalled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        installGlassBar()
        installBridgeHandler()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installBridgeHandler()
        markWebView(attempt: 0)
    }

    deinit {
        bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nativeTabSelected")
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
        glass.translatesAutoresizingMaskIntoConstraints = false
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

        NSLayoutConstraint.activate([
            glass.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            glass.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            glass.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            glass.heightAnchor.constraint(equalToConstant: 68),
            stack.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: glass.contentView.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor, constant: -4)
        ])
        glassView = glass
        updateSelection()
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
        guard !bridgeHandlerInstalled, let webView = bridge?.webView else { return }
        webView.configuration.userContentController.add(self, name: "nativeTabSelected")
        bridgeHandlerInstalled = true
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
        guard let route = message.body as? String,
              let index = routes.firstIndex(where: { route.contains($0.replacingOccurrences(of: "/pages", with: "")) || route == $0 }) else { return }
        DispatchQueue.main.async { self.selectedIndex = index; self.updateSelection() }
    }
}
