import XCTest

// Only simulated XCUI taps/press-drags trigger navigation. The app's Debug-only
// state label observes the real JS route acknowledgement; it cannot navigate.
final class NativeDockInteractionTests: XCTestCase {
    private let app = XCUIApplication()
    private let titles = ["首页", "入库", "出库", "我的"]
    private let routes = ["/pages/home/index", "/pages/inbound/index", "/pages/outbound/index", "/pages/mine/index"]
    private let pageHeadings = ["仓库概览", "入库开单", "出库开单", "我的工作台"]

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["--native-dock-ui-test"]
        if let variant = ProcessInfo.processInfo.environment["DOCK_UI_TEST_VARIANT"], !variant.isEmpty {
            app.launchArguments.append("--dock-variant=" + variant)
        }
        app.launch()
        assertRoute(0)
    }

    override func tearDownWithError() throws {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "final-" + name
        attachment.lifetime = .keepAlways
        add(attachment)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "accessibility-" + name
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        app.terminate()
    }

    private var bar: XCUIElement {
        let identified = app.tabBars["warehouse.native.tabbar"]
        return identified.exists ? identified : app.tabBars.firstMatch
    }

    private func tab(_ index: Int, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "Native tab bar is missing", file: file, line: line)
        let identified = bar.buttons["warehouse.tab.\(index)"]
        let element = identified.exists ? identified : bar.buttons.matching(NSPredicate(format: "label == %@", titles[index])).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 5), "Missing native tab \(index)", file: file, line: line)
        XCTAssertTrue(element.isHittable, "Tab \(index) is not hittable", file: file, line: line)
        return element
    }

    private func assertRoute(_ index: Int, file: StaticString = #filePath, line: UInt = #line) {
        let state = app.staticTexts["warehouse.native.navigation.state"]
        XCTAssertTrue(state.waitForExistence(timeout: 30), "Missing Debug navigation observer", file: file, line: line)
        let expectedRoute = routes[index]
        let predicate = NSPredicate { object, _ in
            guard let element = object as? XCUIElement, let value = element.value as? String else { return false }
            let fields = value.split(separator: ";").reduce(into: [String: String]()) { result, field in
                let pair = field.split(separator: "=", maxSplits: 1).map(String.init)
                if pair.count == 2 { result[pair[0]] = pair[1] }
            }
            return fields["route"] == expectedRoute && fields["selected"] == String(index)
                && fields["pending"] == "-1" && fields["ready"] == "1"
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: state)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 12), .completed,
                       "Native selection and acknowledged page disagree: \(String(describing: state.value))", file: file, line: line)
        XCTAssertTrue(tab(index, file: file, line: line).isSelected, "Native accessibility selection is wrong", file: file, line: line)
        // Taro retains inactive pages. A matching element merely existing in
        // the WebView cannot establish that the acknowledged page is visible.
        let heading = pageHeadings[index]
        let visibleHeading = NSPredicate { [app] _, _ in
            let screen = app.frame
            return app.webViews.allElementsBoundByIndex.contains { webView in
                let viewport = webView.frame.intersection(screen)
                guard !viewport.isNull, !viewport.isEmpty else { return false }
                return webView.staticTexts.matching(NSPredicate(format: "label == %@", heading))
                    .allElementsBoundByIndex.contains { element in
                        let visibleFrame = element.frame.intersection(viewport)
                        return element.isHittable && !visibleFrame.isNull && !visibleFrame.isEmpty
                    }
            }
        }
        let pageExpectation = XCTNSPredicateExpectation(predicate: visibleHeading, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [pageExpectation], timeout: 12), .completed,
                       "Acknowledged route \(expectedRoute) has no visible WebView heading: \(heading)", file: file, line: line)
    }

    private func capture(_ label: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = label
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func drag(from: Int, to: Int, hold: TimeInterval = 0.08) {
        let start = tab(from).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = tab(to).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: hold, thenDragTo: end)
    }

    func testTapEveryNativeTab() {
        for index in [1, 2, 3, 0] {
            tab(index).tap()
            assertRoute(index)
            capture("tap-tab-\(index)")
        }
    }

    func testPressAndDragBothDirections() {
        drag(from: 0, to: 3, hold: 0.2)
        assertRoute(3)
        capture("drag-home-to-mine")
        drag(from: 3, to: 0, hold: 0.2)
        assertRoute(0)
        capture("drag-mine-to-home")
    }

    func testShortPressDragBetweenAdjacentTabs() {
        for (start, end) in [(0, 1), (1, 2), (2, 3), (3, 2)] {
            drag(from: start, to: end, hold: 0.05)
            assertRoute(end)
        }
        capture("short-press-adjacent-drag")
    }

    func testRapidRoundTripTapsEndOnLastDestination() {
        // No route waits between taps: only the final destination may settle.
        // XCTest still applies its normal accessibility synchronization.
        for index in [3, 0, 2, 1, 3, 0, 2] { tab(index).tap() }
        assertRoute(2)
        capture("rapid-roundtrip-final-outbound")
    }

    func testFastRoundTripDrags() {
        for (from, to) in [(0, 3), (3, 0), (0, 2), (2, 1)] {
            let start = tab(from).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let end = tab(to).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
            assertRoute(to)
        }
        capture("fast-roundtrip-drags")
    }

    func testRepeatedTapOnSelectedTab() {
        tab(1).tap()
        assertRoute(1)
        for _ in 0..<3 { tab(1).tap() }
        assertRoute(1)
        tab(2).tap()
        assertRoute(2)
        capture("repeat-selected-then-outbound")
    }

    func testTapImmediatelyAfterDrag() {
        drag(from: 0, to: 3)
        tab(1).tap()
        assertRoute(1)
        drag(from: 1, to: 2)
        tab(0).tap()
        assertRoute(0)
        capture("tap-after-drag-home")
    }
}
