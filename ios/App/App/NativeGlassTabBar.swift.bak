import UIKit
import WebKit
import Capacitor

final class NativeGlassTabBarViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private let routes = [
        "/pages/home/index",
        "/pages/inbound/index",
        "/pages/outbound/index",
        "/pages/mine/index"
    ]
    private let symbols = ["house.fill", "tray.and.arrow.down.fill", "tray.and.arrow.up.fill", "person.crop.circle"]
    private let titles = ["首页", "入库", "出库", "我的"]
    private var glassView: UIVisualEffectView?
    private var tabButtons: [UIButton] = []
    private var selectedIndex = 0
    private var messageHandlerInstalled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        installGlassTabBar()
        installRouteBridge()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installRouteBridge()
        markWebViewAsNative(attempt: 0)
    }

    deinit {
        bridge?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "nativeTabSelected")
    }

    private func makeGlassEffect() -> UIVisualEffect {
        if #available(iOS 26.0, *) {
            return UIBlurEffect(style: .systemUltraThinMaterial)
        }
        return UIBlurEffect(style: .systemUltraThinMaterial)
    }

    private func installGlassTabBar() {
        guard glassView == nil else { return }
        let glass = UIVisualEffectView(effect: makeGlassEffect())
        glass.translatesAutoresizingMaskIntoConstraints = false
        glass.layer.cornerRadius = 34
        glass.clipsToBounds = true
        glass.accessibilityElement = false
        view.addSubview(glass)

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(stack)

        for index in routes.indices {
            let button = makeTabButton(index: index)
            tabButtons.append(button)
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

    private func makeTabButton(index: Int) -> UIButton {
        let button = UIButton(type: .system)
        if #available(iOS 15.0, *) {
            var config = UIButton.Configuration.plain()
            config.image = UIImage(systemName: symbols[index])
            config.title = titles[index]
            config.imagePlacement = .top
            config.imagePadding = 2
            config.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 2, bottom: 4, trailing: 2)
            config.baseForegroundColor = .secondaryLabel
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = .systemFont(ofSize: 10, weight: .medium)
                return outgoing
            }
            button.configuration = config
        } else {
            button.setImage(UIImage(systemName: symbols[index]), for: .normal)
            button.setTitle(titles[index], for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 10, weight: .medium)
            button.imageEdgeInsets = UIEdgeInsets(top: -14, left: 16, bottom: 0, right: -16)
            button.titleEdgeInsets = UIEdgeInsets(top: 26, left: -26, bottom: 0, right: 0)
        }
        button.tag = index
        button.accessibilityLabel = titles[index]
        button.addTarget(self, action: #selector(selectTab(_:)), for: .touchUpInside)
        return button
    }

    private func updateSelection() {
        for (index, button) in tabButtons.enumerated() {
            let color = index == selectedIndex ? UIColor.systemBlue : UIColor.secondaryLabel
            if #available(iOS 15.0, *) {
                button.configuration?.baseForegroundColor = color
            } else {
                button.tintColor = color
                button.setTitleColor(color, for: .normal)
            }
            button.backgroundColor = index == selectedIndex ? UIColor.white.withAlphaComponent(0.24) : .clear
            button.layer.cornerRadius = 28
        }
    }

    private func installRouteBridge() {
        guard !messageHandlerInstalled, let webView = bridge?.webView else { return }
        webView.configuration.userContentController.add(self, name: "nativeTabSelected")
        messageHandlerInstalled = true
    }

    private func markWebViewAsNative(attempt: Int) {
        guard attempt < 20, let webView = bridge?.webView else { return }
        webView.evaluateJavaScript("document.getElementById('app') ? (document.documentElement.classList.add('sg-native-ios'), 'ready') : ''") { [weak self] result, error in
            guard error != nil || (result as? String) != "ready", let self else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.markWebViewAsNative(attempt: attempt + 1)
            }
        }
    }

    @objc private func selectTab(_ sender: UIButton) {
        let index = sender.tag
        guard routes.indices.contains(index) else { return }
        selectedIndex = index
        updateSelection()
        let route = routes[index]
        let script = "window.dispatchEvent(new CustomEvent('sg-native-tab', { detail: '\(route)' }));"
        bridge?.webView?.evaluateJavaScript(script)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let route = message.body as? String,
              let index = routes.firstIndex(where: { route.contains($0.replacingOccurrences(of: "/pages", with: "")) || route == $0 }) else { return }
        DispatchQueue.main.async {
            self.selectedIndex = index
            self.updateSelection()
        }
    }
}
