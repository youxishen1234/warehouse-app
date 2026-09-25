import XCTest

final class GlassPrototypeUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    private func waitStatus(_ app: XCUIApplication, _ value: String) {
        expectation(for: NSPredicate(format: "label CONTAINS %@", value), evaluatedWith: app.staticTexts["prototype.status"])
        waitForExpectations(timeout: 12)
    }
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testGlassHandshakeLayoutNavigationAndScroll() throws {
        let app = XCUIApplication(); app.launch()
        waitStatus(app, "ready=true"); waitStatus(app, "visible=true")
        if #available(iOS 26.0, *) { waitStatus(app, "material=glass") }
        else { waitStatus(app, "material=blur") }
        let dock = app.otherElements["prototype.dock"]
        XCTAssertTrue(dock.exists)
        XCTAssertLessThan(dock.frame.maxY, app.frame.maxY)
        XCTAssertGreaterThan(dock.frame.minY, app.frame.midY)
        XCTAssertGreaterThanOrEqual(dock.frame.minX, app.frame.minX + 15)
        shot("01-startup")
        for (index, route) in ["home", "inbound", "outbound", "mine"].enumerated() {
            let tab = app.buttons["prototype.tab." + String(index)]
            tab.tap(); waitStatus(app, "route=" + route)
            XCTAssertTrue(tab.isSelected); shot("02-tab-" + route)
        }
        app.buttons["prototype.tab.0"].tap(); waitStatus(app, "route=home")
        let web = app.webViews.firstMatch
        dock.swipeLeft()
        app.buttons["prototype.tab.1"].tap()
        waitStatus(app, "route=inbound")
        shot("02-swipe-home-to-inbound")
        app.buttons["prototype.tab.0"].tap(); waitStatus(app, "route=home")
        for index in 0..<3 { web.swipeUp(velocity: .slow); shot("03-refraction-" + String(index)) }
        let last = app.buttons["末条操作 · 不应被遮挡"]
        for _ in 0..<24 {
            if last.isHittable && last.frame.maxY <= dock.frame.minY { break }
            web.swipeUp()
        }
        XCTAssertTrue(last.isHittable)
        XCTAssertLessThanOrEqual(last.frame.maxY, dock.frame.minY)
        last.tap(); XCTAssertTrue(app.buttons["末条操作已响应"].exists)
        shot("04-last-action-safe-area")
        app.buttons["prototype.tool.弹层"].tap(); waitStatus(app, "modal=true"); waitStatus(app, "visible=false")
        shot("05-modal")
        app.buttons["关闭弹层"].tap(); waitStatus(app, "visible=true")
        app.buttons["prototype.tool.详情"].tap(); waitStatus(app, "route=detail"); waitStatus(app, "visible=false")
        app.buttons["prototype.tool.首页"].tap(); waitStatus(app, "route=home"); waitStatus(app, "visible=true")
        let field = app.textFields["prototype.input"]
        field.tap(); field.typeText("123"); waitStatus(app, "keyboard=true"); waitStatus(app, "visible=false")
        shot("06-keyboard"); field.typeText("\n"); waitStatus(app, "keyboard=false")
        app.buttons["prototype.tool.重载"].tap(); waitStatus(app, "ready=true"); waitStatus(app, "visible=true")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        waitStatus(app, "visible=true")
        XCTAssertLessThan(dock.frame.maxY, app.frame.maxY); shot("07-landscape")
        XCUIDevice.shared.orientation = .portrait
        XCUIDevice.shared.press(.home); app.activate(); waitStatus(app, "visible=true"); shot("08-foreground")
        XCTAssertFalse(app.staticTexts["prototype.status"].label.contains("ERROR"))
    }
    func testForcedBlurIsExplicitAndFunctional() {
        let app = XCUIApplication(); app.launchArguments = ["--force-blur"]; app.launch()
        waitStatus(app, "material=blur"); waitStatus(app, "visible=true")
        app.buttons["prototype.tab.2"].tap(); waitStatus(app, "route=outbound")
        shot("09-forced-blur-not-old-os-proof")
    }
    func testUnmodifiedSystemTabReference() {
        let app = XCUIApplication(); app.launchArguments = ["--system-reference"]; app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10)); shot("10-system-reference")
        app.tables.firstMatch.swipeUp(velocity: .slow)
        app.tabBars.buttons["出库"].tap(); shot("11-system-reference-outbound")
    }
}
