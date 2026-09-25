import UIKit

// Independent experiment; do not merge into the business App until visually accepted.
final class GlassDock: UIView {
    let titles = ["首页", "入库", "出库", "我的"]
    private let symbols = ["house", "tray.and.arrow.down", "tray.and.arrow.up", "person.crop.circle"]
    private let body = UIVisualEffectView()
    private let selection = UIVisualEffectView()
    private let stack = UIStackView()
    private(set) var buttons: [UIButton] = []
    private(set) var selectedIndex = 0
    private(set) var material = "blur"
    var onSelect: ((Int) -> Void)?
    private var selectionAnimator: UIViewPropertyAnimator?
    private let brand = UIColor(red: 15 / 255, green: 118 / 255, blue: 110 / 255, alpha: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        accessibilityIdentifier = "prototype.dock"
        body.isUserInteractionEnabled = true
        addSubview(body)
        body.contentView.addSubview(selection)
        // The selected capsule moves beneath labels in the outer effect contentView.
        selection.isUserInteractionEnabled = false
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 4
        body.contentView.addSubview(stack)
        for index in titles.indices {
            let button = UIButton(type: .system)
            button.tag = index
            button.accessibilityIdentifier = "prototype.tab." + String(index)
            button.accessibilityLabel = titles[index]
            let content = UIStackView()
            content.axis = .vertical
            content.alignment = .center
            content.spacing = 3
            content.isUserInteractionEnabled = false
            let image = UIImageView(image: UIImage(systemName: symbols[index]))
            image.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 21, weight: .medium)
            let label = UILabel()
            label.text = titles[index]
            label.font = .systemFont(ofSize: 11, weight: .semibold)
            label.tag = 100
            content.addArrangedSubview(image)
            content.addArrangedSubview(label)
            content.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(content)
            NSLayoutConstraint.activate([content.centerXAnchor.constraint(equalTo: button.centerXAnchor), content.centerYAnchor.constraint(equalTo: button.centerYAnchor)])
            button.addTarget(self, action: #selector(pressed(_:)), for: .touchDown)
            button.addTarget(self, action: #selector(released(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
            button.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
            buttons.append(button)
            stack.addArrangedSubview(button)
        }
        applyMaterial()
        updateColors()
    }
    required init?(coder: NSCoder) { fatalError("Use programmatic initialization") }

    private func applyMaterial() {
        let forceBlur = ProcessInfo.processInfo.arguments.contains("--force-blur")
        // Compiler guard permits an Xcode 16 fallback build; runtime guard protects iOS <26.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), !forceBlur {
            let glass = UIGlassEffect(style: .regular)
            glass.isInteractive = true
            body.effect = glass
            body.cornerConfiguration = .capsule()
            let selectedGlass = UIGlassEffect(style: .regular)
            selectedGlass.isInteractive = true
            selection.effect = selectedGlass
            selection.cornerConfiguration = .capsule()
            material = "glass"
            return
        }
        #endif
        body.effect = UIBlurEffect(style: .systemMaterial)
        selection.effect = UIBlurEffect(style: .systemUltraThinMaterial)
        selection.contentView.backgroundColor = brand.withAlphaComponent(0.10)
        body.clipsToBounds = true
        selection.clipsToBounds = true
        material = "blur"
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        body.frame = bounds
        stack.frame = bounds.insetBy(dx: 7, dy: 6)
        stack.layoutIfNeeded()
        if material == "blur" { body.layer.cornerRadius = bounds.height / 2; selection.layer.cornerRadius = (bounds.height - 12) / 2 }
        if selectionAnimator?.isRunning != true { selection.frame = selectedFrame() }
    }
    private func selectedFrame() -> CGRect {
        guard buttons.indices.contains(selectedIndex) else { return .zero }
        return buttons[selectedIndex].convert(buttons[selectedIndex].bounds, to: body.contentView)
    }
    func acknowledge(index: Int, animated: Bool) {
        guard buttons.indices.contains(index) else { return }
        if let animator = selectionAnimator, animator.state == .active {
            animator.stopAnimation(false)
            animator.finishAnimation(at: .current)
        }
        selectionAnimator = nil
        selectedIndex = index
        updateColors()
        let target = selectedFrame()
        guard animated, !UIAccessibility.isReduceMotionEnabled else { selection.frame = target; return }
        let animator = UIViewPropertyAnimator(duration: 0.32, dampingRatio: 0.82) { self.selection.frame = target }
        selectionAnimator = animator
        animator.startAnimation()
    }
    private func updateColors() {
        for (index, button) in buttons.enumerated() {
            let active = index == selectedIndex
            button.tintColor = active ? brand : .secondaryLabel
            (button.viewWithTag(100) as? UILabel)?.textColor = active ? brand : .secondaryLabel
            button.isSelected = active
            button.accessibilityTraits = active ? [.button, .selected] : [.button]
        }
    }
    @objc private func tapped(_ sender: UIButton) { onSelect?(sender.tag) }
    @objc private func pressed(_ sender: UIButton) {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        UIView.animate(withDuration: 0.1, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) { sender.transform = CGAffineTransform(scaleX: 0.97, y: 0.97) }
    }
    @objc private func released(_ sender: UIButton) {
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.25, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: { sender.transform = .identity })
    }
}
