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
    private var panStartFrame = CGRect.zero
    private let selectedBlue = UIColor.systemBlue
    private let darkGlass = UIColor.black.withAlphaComponent(0.46)
    var onSwipe: ((Int) -> Void)?

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
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.maximumNumberOfTouches = 1
        pan.cancelsTouchesInView = false
        addGestureRecognizer(pan)
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
            glass.tintColor = darkGlass
            body.effect = glass
            body.cornerConfiguration = .capsule()
            let selectedGlass = UIGlassEffect(style: .regular)
            selectedGlass.isInteractive = true
            selectedGlass.tintColor = selectedBlue.withAlphaComponent(0.96)
            selection.effect = selectedGlass
            selection.cornerConfiguration = .capsule()
            material = "glass"
            return
        }
        #endif
        body.effect = UIBlurEffect(style: .systemChromeMaterialDark)
        selection.effect = UIBlurEffect(style: .systemMaterialDark)
        selection.contentView.backgroundColor = selectedBlue.withAlphaComponent(0.72)
        body.clipsToBounds = true
        selection.clipsToBounds = true
        material = "blur"
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        body.frame = bounds
        body.layer.shadowColor = UIColor.black.cgColor
        body.layer.shadowOpacity = 0.34
        body.layer.shadowRadius = 14
        body.layer.shadowOffset = CGSize(width: 0, height: 6)
        stack.frame = bounds.insetBy(dx: 7, dy: 6)
        stack.layoutIfNeeded()
        selection.layer.shadowColor = UIColor.systemBlue.cgColor
        selection.layer.shadowOpacity = 0.42
        selection.layer.shadowRadius = 8
        selection.layer.shadowOffset = CGSize(width: 0, height: 3)
        if material == "blur" {
            body.layer.cornerRadius = bounds.height / 2
            selection.layer.cornerRadius = selection.bounds.height / 2
            selection.layer.borderColor = UIColor.systemBlue.withAlphaComponent(0.85).cgColor
            selection.layer.borderWidth = 0.75
        }
        if selectionAnimator?.isRunning != true { selection.frame = selectedFrame() }
    }
    private func selectedFrame() -> CGRect {
        guard buttons.indices.contains(selectedIndex) else { return .zero }
        let buttonFrame = buttons[selectedIndex].convert(buttons[selectedIndex].bounds, to: body.contentView)
        let diameter = min(56, buttonFrame.height - 2)
        return CGRect(x: buttonFrame.midX - diameter / 2, y: buttonFrame.midY - diameter / 2, width: diameter, height: diameter)
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
            button.tintColor = active ? .white : .white.withAlphaComponent(0.92)
            (button.viewWithTag(100) as? UILabel)?.textColor = active ? .white : .white.withAlphaComponent(0.92)
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
    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        switch gesture.state {
        case .began:
            selectionAnimator?.stopAnimation(false)
            panStartFrame = selection.frame
        case .changed:
            var frame = panStartFrame
            frame.origin.x += gesture.translation(in: body.contentView).x
            selection.frame = frame
        case .ended, .cancelled:
            let dx = gesture.translation(in: body.contentView).x
            let next = dx < -28 ? min(selectedIndex + 1, buttons.count - 1) : dx > 28 ? max(selectedIndex - 1, 0) : selectedIndex
            if next != selectedIndex { onSwipe?(next) } else { acknowledge(index: selectedIndex, animated: true) }
        default:
            break
        }
    }
}
