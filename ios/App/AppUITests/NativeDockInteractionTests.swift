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
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments = ["--native-dock-ui-test"]
        if let variant = ProcessInfo.processInfo.environment["DOCK_UI_TEST_VARIANT"], !variant.isEmpty {
            app.launchArguments.append("--dock-variant=" + variant)
        }
        app.launch()
        // The very first WebView boot on a loaded macOS runner can be slow
        // (previous run observed ~19s before ready=1). Give launch a generous
        // window; in-test transitions keep the tighter 12s.
        assertRoute(0, predicateTimeout: 45)
    }

    override func tearDownWithError() throws {
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "final-" + name
        attachment.lifetime = .keepAlways
        add(attachment)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "accessibility-" + name
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private var bar: XCUIElement {
        let identified = app.tabBars["warehouse.native.tabbar"]
        return identified.exists ? identified : app.tabBars.firstMatch
    }

    private func tab(_ index: Int, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let nativeBar = bar
        XCTAssertTrue(nativeBar.exists || nativeBar.waitForExistence(timeout: 10), "Native tab bar is missing", file: file, line: line)
        let identified = nativeBar.buttons["warehouse.tab.\(index)"]
        let element = identified.exists ? identified : nativeBar.buttons.matching(NSPredicate(format: "label == %@", titles[index])).firstMatch
        XCTAssertTrue(element.exists || element.waitForExistence(timeout: 5), "Missing native tab \(index)", file: file, line: line)
        XCTAssertTrue(element.isHittable, "Tab \(index) is not hittable", file: file, line: line)
        return element
    }

    private func waitFor(_ predicate: NSPredicate, object: Any, timeout: TimeInterval) -> XCTWaiter.Result {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: object)], timeout: timeout)
    }

    private func assertRoute(_ index: Int, predicateTimeout: TimeInterval = 12, file: StaticString = #filePath, line: UInt = #line) {
        let state = app.staticTexts["warehouse.native.navigation.state"]
        XCTAssertTrue(state.exists || state.waitForExistence(timeout: 30), "Missing Debug navigation observer", file: file, line: line)
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
        XCTAssertEqual(waitFor(predicate, object: state, timeout: predicateTimeout), .completed,
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
        XCTAssertEqual(waitFor(visibleHeading, object: app, timeout: 12), .completed,
                       "Acknowledged route \(expectedRoute) has no visible WebView heading: \(heading)", file: file, line: line)
    }

    private func capture(_ label: String) {
        let layout = app.staticTexts["warehouse.native.layout.state"]
        let navigation = app.staticTexts["warehouse.native.navigation.state"]
        func observedRoute() -> String? {
            guard navigation.exists, let raw = navigation.value as? String else { return nil }
            let fields = raw.split(separator: ";").reduce(into: [String: String]()) { result, field in
                let pair = field.split(separator: "=", maxSplits: 1).map(String.init)
                if pair.count == 2 { result[pair[0]] = pair[1] }
            }
            guard fields["ready"] == "1", fields["pending"] == "-1" else { return nil }
            return fields["route"]
        }
        let expectedRoute = observedRoute()
        func isComplete(_ value: Any) -> Bool {
            guard let state = value as? [String: Any],
                  state["jsPending"] as? Bool == false,
                  let route = state["route"] as? String,
                  let expectedRoute = expectedRoute, route == expectedRoute,
                  observedRoute() == expectedRoute,
                  state["dom"] is [String: Any], state["jsError"] == nil else { return false }
            return true
        }
        let ready = NSPredicate { _, _ in
            guard layout.exists, let raw = layout.value as? String,
                  let data = raw.data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data) else { return false }
            return isComplete(value)
        }
        let waitResult = waitFor(ready, object: app, timeout: 12)
        // Preserve images and raw diagnostics even on timeout. Assert only after
        // attaching them, so an inaccessible label or pending JS stays visible.
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = label
        attachment.lifetime = .keepAlways
        add(attachment)

        // Keep both capture surfaces: a cropped application image alone cannot
        // distinguish a screenshot-orientation defect from actual screen layout.
        let screen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screen.name = "screen-" + label
        screen.lifetime = .keepAlways
        add(screen)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "accessibility-" + label
        hierarchy.lifetime = .keepAlways
        add(hierarchy)

        func frameJSON(_ frame: CGRect) -> [String: Double] {
            return ["x": Double(frame.origin.x), "y": Double(frame.origin.y),
                    "width": Double(frame.width), "height": Double(frame.height)]
        }
        var capturedLayoutReady = false
        var evidence: [String: Any] = [
            "label": label,
            "layoutWaitStatus": waitResult == .completed ? "completed" : "not_completed",
            "layoutWaitResult": waitResult.rawValue,
            "expectedRoute": expectedRoute.map { $0 as Any } ?? NSNull(),
            "appFrame": frameJSON(app.frame),
            "deviceOrientation": XCUIDevice.shared.orientation.rawValue,
            "layoutStateStatus": "missing_element",
            "layoutState": NSNull()
        ]
        let nativeBar = bar
        evidence["tabs"] = (0..<4).map { index -> [String: Any] in
            let element = nativeBar.buttons["warehouse.tab.\(index)"]
            guard element.exists else { return ["index": index, "exists": false] }
            return ["index": index, "exists": true, "frame": frameJSON(element.frame),
                    "isHittable": element.isHittable, "isSelected": element.isSelected]
        }
        if layout.exists {
            if let raw = layout.value as? String, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                evidence["layoutStateRaw"] = raw
                if let data = raw.data(using: .utf8),
                   let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
                    evidence["layoutStateStatus"] = "present"
                    evidence["layoutState"] = value
                    capturedLayoutReady = isComplete(value)
                } else {
                    evidence["layoutStateStatus"] = "invalid_json"
                }
            } else {
                evidence["layoutStateStatus"] = "missing_or_nonstring_value"
            }
        }
        evidence["capturedLayoutComplete"] = capturedLayoutReady
        let json: String
        do {
            let data = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
            json = String(decoding: data, as: UTF8.self)
        } catch {
            json = "{\"layoutStateStatus\":\"evidence_serialization_failed\"}"
        }
        let geometry = XCTAttachment(string: json)
        geometry.name = "layout-" + label + ".json"
        geometry.lifetime = .keepAlways
        add(geometry)
        XCTAssertEqual(waitResult, .completed,
                       "Layout diagnostics never completed for the acknowledged route; see layout-\(label).json")
        XCTAssertTrue(capturedLayoutReady,
                      "Captured layout diagnostics are missing, pending, stale, or contain a JS error; see layout-\(label).json")
    }

    private func assertViewport(isLandscape: Bool, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate { [app] _, _ in
            let frame = app.frame
            guard frame.width > 0, frame.height > 0 else { return false }
            return isLandscape ? frame.width > frame.height : frame.height > frame.width
        }
        XCTAssertEqual(waitFor(predicate, object: app, timeout: 15), .completed,
                       "Application did not rotate to \(isLandscape ? "landscape" : "portrait")", file: file, line: line)
    }

    private func assertAllTabsInsideApp(file: StaticString = #filePath, line: UInt = #line) {
        var previousFrames: [CGRect]?
        let nativeBar = bar
        let predicate = NSPredicate { [self] _, _ in
            let viewport = app.frame
            guard !viewport.isNull, !viewport.isEmpty else { return false }
            var frames = [viewport]
            for index in 0..<4 {
                let element = nativeBar.buttons["warehouse.tab.\(index)"]
                guard element.exists, element.isHittable else { previousFrames = nil; return false }
                let frame = element.frame
                guard !frame.isNull, !frame.isEmpty, viewport.contains(frame) else {
                    previousFrames = nil
                    return false
                }
                frames.append(frame)
            }
            let stable = previousFrames == frames
            previousFrames = frames
            return stable
        }
        // The immediate evaluation stores the first sample; the predicate can
        // only pass after a second independent sample has identical frames.
        let result = waitFor(predicate, object: app, timeout: 15)
        if result != .completed { capture("tabs-outside-app-or-unstable") }
        XCTAssertEqual(result, .completed,
                       "All four native tabs must have stable, complete hittable frames inside app.frame",
                       file: file, line: line)
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

    func testRotateAndTapNativeTabs() {
        // Run 36651423052 needed ~171s for all four landscape destinations,
        // paired app/screen images, AX/DOM diagnostics, and return to portrait.
        // Keep each route/layout deadline unchanged; the waitFor short-circuit
        // removes idle polling, but a loaded runner still needs headroom. Give
        // this richer test 240s (the runner's raised per-test cap); other tests
        // keep their default 120s.
        executionTimeAllowance = 240
        assertViewport(isLandscape: false)
        // setUpWithError already verified the initial acknowledged home page.
        XCUIDevice.shared.orientation = .landscapeLeft
        assertViewport(isLandscape: true)
        assertAllTabsInsideApp()
        for index in [1, 2, 3, 0] {
            tab(index).tap()
            assertRoute(index)
            assertAllTabsInsideApp()
            capture("landscape-tap-tab-\(index)")
        }
        XCUIDevice.shared.orientation = .portrait
        assertViewport(isLandscape: false)
        tab(0).tap()
        assertRoute(0)
        assertAllTabsInsideApp()
        capture("portrait-after-rotation-tab-0")
    }
}
