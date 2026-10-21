import Foundation
import UIKit
import CoreText

// This test double cannot connect, submit jobs, or access business services.
final class NIIMBOTSDKAdapter {
    private static let instance = NIIMBOTSDKAdapter()
    static func shared() -> NIIMBOTSDKAdapter { instance }
    var calls = 0
    var elements: [[String: Any]] = []
    func render(width: Double, height: Double, elements: [[String: Any]]) -> [String: Any] {
        calls += 1
        self.elements = elements
        return ["sdkJson": "{}", "imageBase64": "DIAGNOSTIC_STUB_NOT_AN_SDK_PREVIEW"]
    }
}

enum FontDiagnostic {
    static let pointsPerMm = 72.0 / 25.4
    static let dpi = 300.0

    static func line(_ text: String, font: UIFont) -> CTLine {
        let ctFont = CTFontCreateWithName(font.fontName as CFString, font.pointSize, nil)
        return CTLineCreateWithAttributedString(NSAttributedString(
            string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): ctFont,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): UIColor.black.cgColor
            ]))
    }

    static func mapped(_ text: String, font: CTFont) -> [String: Any] {
        let units = Array(text.utf16)
        var glyphs = [CGGlyph](repeating: 0, count: units.count)
        let covered = CTFontGetGlyphsForCharacters(font, units, &glyphs, units.count)
        return ["baseFontDirectMapping": covered, "utf16": units.map { Int($0) },
                "baseGlyphIDs": glyphs.map { Int($0) }]
    }

    static func runs(_ line: CTLine) -> [[String: Any]] {
        (CTLineGetGlyphRuns(line) as! [CTRun]).map { run in
            let attributes = CTRunGetAttributes(run) as NSDictionary
            let font = attributes[kCTFontAttributeName] as! CTFont
            let name = CTFontCopyPostScriptName(font) as String
            let count = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: count)
            var indices = [CFIndex](repeating: 0, count: count)
            if count > 0 {
                CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
                CTRunGetStringIndices(run, CFRange(location: 0, length: count), &indices)
            }
            let range = CTRunGetStringRange(run)
            return ["resolvedFont": name, "utf16Range": [range.location, range.length],
                    "glyphIDs": glyphs.map { Int($0) }, "stringIndicesUTF16": indices,
                    "zeroGlyphSourceIndices": glyphs.enumerated().filter { $0.element == 0 }.map { indices[$0.offset] },
                    "lastResort": name.lowercased().contains("lastresort"),
                    "colorFont": (CTFontGetSymbolicTraits(font).rawValue & (1 << 13)) != 0]
        }
    }

    static func preview(_ line: CTLine, widthMm: Double, heightMm: Double, file: URL) throws -> [String: Any] {
        let width = Int(ceil(widthMm * dpi / 25.4))
        let height = Int(ceil(heightMm * dpi / 25.4))
        guard width > 0, height > 0, width * height <= 4_000_000,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { throw LabelFailure("DIAGNOSTIC_BITMAP_FAILED", "Unable to allocate reference bitmap") }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        let advance = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
        let ink = CTLineGetBoundsWithOptions(line, [.useGlyphPathBounds])
        let minX = ink.isNull ? 0 : min(0, ink.minX)
        let maxX = ink.isNull ? CGFloat(advance) : max(CGFloat(advance), ink.maxX)
        let minY = ink.isNull ? -descent : min(-descent, ink.minY)
        let maxY = ink.isNull ? ascent : max(ascent, ink.maxY)
        let scale = dpi / 72.0
        let boxWidth = CGFloat(width) / scale, boxHeight = CGFloat(height) / scale
        let padding = 2.0 / scale
        let fits = maxX - minX + 2 * padding <= boxWidth && maxY - minY + 2 * padding <= boxHeight
        context.scaleBy(x: scale, y: scale)
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: padding - minX, y: (boxHeight - (maxY - minY)) / 2 - minY)
        CTLineDraw(line, context)
        guard let cgImage = context.makeImage(), let data = context.data,
              let png = UIImage(cgImage: cgImage, scale: 1, orientation: .up).pngData()
        else { throw LabelFailure("DIAGNOSTIC_PNG_FAILED", "Unable to encode reference bitmap") }
        let pixels = data.assumingMemoryBound(to: UInt8.self)
        var inkPixels = 0, edgeInkPixels = 0
        for y in 0..<height {
            for x in 0..<width where pixels[y * context.bytesPerRow + x] < 127 {
                inkPixels += 1
                if x == 0 || y == 0 || x == width - 1 || y == height - 1 { edgeInkPixels += 1 }
            }
        }
        try png.write(to: file, options: .atomic)
        return ["pixelSize": [width, height], "dpiIntermediate": dpi, "fitsReferenceBox": fits,
                "inkPixelsBelow127": inkPixels, "edgeInkPixelsBelow127": edgeInkPixels,
                "opaqueGrayscale": true,
                "scope": "Independent CoreText reference only; tofu may also produce ink. Not NIIMBOT output."]
    }

    static func diagnose(_ item: [String: Any], directory: URL) throws -> [String: Any] {
        let text = item["text"] as! String, id = item["id"] as! String
        let fontMm = (item["fontMm"] as! NSNumber).doubleValue
        guard let font = UIFont(name: "PingFangSC-Regular", size: fontMm * pointsPerMm)
        else { throw LabelFailure("FONT_UNAVAILABLE", "PingFangSC-Regular unavailable") }
        let base = CTFontCreateWithName("PingFangSC-Regular" as CFString, font.pointSize, nil)
        let shapedLine = line(text, font: font)
        var result = mapped(text, font: base)
        result["id"] = id
        result["text"] = text
        result["fullLineFallbackRuns"] = runs(shapedLine)
        result["graphemes"] = text.map { character -> [String: Any] in
            let value = String(character)
            var row = mapped(value, font: base)
            row["character"] = value
            row["unicodeScalars"] = value.unicodeScalars.map { String(format: "U+%04X", $0.value) }
            return row
        }
        let filename = id + ".png"
        result["referencePNG"] = filename
        result["referencePreview"] = try preview(shapedLine,
            widthMm: (item["widthMm"] as! NSNumber).doubleValue,
            heightMm: (item["heightMm"] as! NSNumber).doubleValue,
            file: directory.appendingPathComponent(filename))
        return result
    }

    static func bitmapEvidence(_ element: [String: Any], file: URL) throws -> [String: Any] {
        guard let base64 = element["imageBase64"] as? String,
              let data = Data(base64Encoded: base64), let image = UIImage(data: data)?.cgImage,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { throw LabelFailure("TEST_INVALID_PNG", "Renderer did not return a decodable PNG") }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else {
            throw LabelFailure("TEST_INVALID_PNG", "Cannot inspect raster pixels")
        }
        var ink = 0, edge = 0
        for y in 0..<image.height {
            for x in 0..<image.width where bytes[y * context.bytesPerRow + x] < 127 {
                ink += 1
                if x == 0 || y == 0 || x == image.width - 1 || y == image.height - 1 { edge += 1 }
            }
        }
        try data.write(to: file, options: .atomic)
        return ["png": file.lastPathComponent, "widthPx": image.width, "heightPx": image.height,
                "bitsPerPixel": image.bitsPerPixel, "alphaInfo": image.alphaInfo.rawValue,
                "grayscale": image.colorSpace?.model == .monochrome,
                "inkPixelsBelow127": ink, "edgeInkPixelsBelow127": edge]
    }

    // The vendor SDK rejects one full-page calibration bitmap and its line
    // primitive, so the sample uses only DrawLableImage: four thin border strips
    // plus one small text image per row. A border alone is never accepted as
    // proof that the calibration text survived.
    static func calibrationEvidence(_ elements: [[String: Any]], name: String, text: String,
                                    profile: LabelMediaProfile, directory: URL) throws -> [String: Any] {
        let contentWidthMm = profile.widthMm - profile.marginMm.left - profile.marginMm.right
        let contentHeightMm = profile.heightMm - profile.marginMm.top - profile.marginMm.bottom
        var borderCount = 0
        var images: [[String: Any]] = []
        var joined = ""
        for (index, element) in elements.enumerated() {
            let type = element["type"] as? String ?? ""
            let x = (element["x"] as? NSNumber)?.doubleValue ?? -1
            let y = (element["y"] as? NSNumber)?.doubleValue ?? -1
            let w = (element["w"] as? NSNumber)?.doubleValue ?? -1
            let h = (element["h"] as? NSNumber)?.doubleValue ?? -1
            guard x >= 0, y >= 0, w > 0, h > 0, x + w <= profile.widthMm + 0.01,
                  y + h <= profile.heightMm + 0.01 else {
                throw LabelFailure("TEST_CALIBRATION_LAYOUT", "Calibration element \(index) leaves the label")
            }
            guard type == "image" else {
                throw LabelFailure("TEST_CALIBRATION_LAYOUT", "Calibration must use only image elements, not \(type)")
            }
            let source = element["sourceText"] as? String ?? ""
            guard !source.isEmpty else {
                throw LabelFailure("TEST_CALIBRATION_IMAGE", "Calibration row \(index) lost its text")
            }
            let field = element["sourceField"] as? String ?? ""
            let isBorder = field.hasPrefix("校准边框")
            if isBorder {
                guard min(w, h) <= 1.5, w <= contentWidthMm + 0.01, h <= contentHeightMm + 0.01 else {
                    throw LabelFailure("TEST_CALIBRATION_IMAGE", "Calibration border \(index) is too large for the SDK")
                }
                borderCount += 1
            } else {
                guard h <= 12, w <= contentWidthMm + 0.01 else {
                    throw LabelFailure("TEST_CALIBRATION_IMAGE", "Calibration image \(index) is too large for the SDK")
                }
            }
            var info = try bitmapEvidence(element, file: directory.appendingPathComponent(
                "render-calibration-\(name)-\(index).png"))
            let ink = info["inkPixelsBelow127"] as! Int
            let edge = info["edgeInkPixelsBelow127"] as! Int
            guard ink > (isBorder ? 50 : 20), isBorder || edge == 0 else {
                throw LabelFailure("TEST_CALIBRATION_IMAGE", "Calibration row \(index) is blank or clipped")
            }
            let expectedWidth = Int(ceil(w * dpi / 25.4)), expectedHeight = Int(ceil(h * dpi / 25.4))
            guard info["widthPx"] as! Int == expectedWidth, info["heightPx"] as! Int == expectedHeight else {
                throw LabelFailure("TEST_CALIBRATION_IMAGE", "Calibration row \(index) pixels do not match its millimetres")
            }
            info["index"] = index
            info["sourceText"] = source
            info["sourceField"] = field
            info["x"] = x; info["y"] = y; info["w"] = w; info["h"] = h
            images.append(info)
            if !isBorder { joined += source }
        }
        guard borderCount == 4 else {
            throw LabelFailure("TEST_CALIBRATION_LAYOUT", "Calibration border must be four image strips")
        }
        guard images.count - borderCount >= 3 else {
            throw LabelFailure("TEST_CALIBRATION_LAYOUT", "Calibration text must use per-row images")
        }
        for token in ["校准", "中文", "成品", "纸板", "×", "g/m²"] {
            guard joined.contains(token) else {
                throw LabelFailure("TEST_CALIBRATION_TEXT", "Calibration text is missing \(token)")
            }
        }
        return ["schemaVersion": 2, "expectedText": text, "dpi": dpi,
            "contentWidthMm": contentWidthMm, "contentHeightMm": contentHeightMm,
            "borderImages": borderCount, "textElements": images.count - borderCount,
            "fitId": name, "images": images]
    }

    static func attempt(_ name: String, directory: URL,
                        calibration: (profile: LabelMediaProfile, text: String)? = nil,
                        action: () throws -> Void) -> [String: Any] {
        let adapter = NIIMBOTSDKAdapter.shared()
        let before = adapter.calls
        adapter.elements = []
        do {
            try action()
            let evidence = try adapter.elements.enumerated().map { index, element -> [String: Any] in
                var result = element
                if element["type"] as? String == "image" {
                    result["imageBase64"] = nil
                    result["bitmap"] = try bitmapEvidence(element, file: directory.appendingPathComponent("render-\(name)-\(index).png"))
                }
                return result
            }
            var result: [String: Any] = ["id": name, "outcome": "passed-font-and-layout-to-sdk-stub",
                    "sdkStubCalls": adapter.calls - before, "elements": evidence, "sdkVerified": false]
            if let calibration = calibration {
                result["calibrationEvidence"] = try calibrationEvidence(adapter.elements, name: name, text: calibration.text,
                    profile: calibration.profile, directory: directory)
            }
            return result
        } catch let error as LabelFailure {
            return ["id": name, "outcome": "production-renderer-error", "errorCode": error.code,
                    "message": error.message, "sdkStubCalls": adapter.calls - before]
        } catch {
            return ["id": name, "outcome": "unexpected-error", "message": String(describing: error),
                    "sdkStubCalls": adapter.calls - before]
        }
    }

    static func regression(_ item: [String: Any], directory: URL) -> [String: Any] {
        let id = item["id"] as! String, text = item["text"] as! String
        do {
            let width = (item["widthMm"] as! NSNumber).doubleValue
            let height = (item["heightMm"] as! NSNumber).doubleValue
            let lines = try LabelTextRasterizer.wrapped(text, widthMm: width,
                fontMm: (item["fontMm"] as! NSNumber).doubleValue, maxLines: 4, field: id)
            var images: [[String: Any]] = []
            for (index, line) in lines.enumerated() {
                let element = try LabelTextRasterizer.element(line, x: 0, y: 0, widthMm: width,
                    heightMm: max(height, line.heightMm), field: id)
                var info = try bitmapEvidence(element, file: directory.appendingPathComponent("fixed-\(id)-\(index).png"))
                info["sourceText"] = line.text
                info["w"] = width
                info["h"] = max(height, line.heightMm)
                images.append(info)
            }
            return ["id": id, "text": text, "outcome": "rasterized", "bitmaps": images]
        } catch let error as LabelFailure {
            return ["id": id, "text": text, "outcome": "rejected", "errorCode": error.code, "message": error.message]
        } catch {
            return ["id": id, "outcome": "unexpected-error", "message": String(describing: error)]
        }
    }

    static func execute() {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        do {
            let fixtureURL = Bundle.main.url(forResource: "fixtures", withExtension: "json")!
            let fixtureData = try Data(contentsOf: fixtureURL)
            let fixtures = try JSONSerialization.jsonObject(with: fixtureData) as! [String: Any]
            try fixtureData.write(to: directory.appendingPathComponent("fixtures.json"), options: .atomic)
            let texts = fixtures["textCases"] as! [[String: Any]]
            let profile = try LabelMediaProfile.parse(fixtures["screenshotProfile"] as! [String: Any])
            var production = [attempt("calibration-original", directory: directory,
                calibration: (profile: profile, text: fixtures["calibrationOriginalText"] as! String)) {
                _ = try LabelTemplateRenderer.calibration(profile)
            }]
            var wrappedProfileData = fixtures["screenshotProfile"] as! [String: Any]
            wrappedProfileData["profileId"] = "FONT-DIAGNOSTIC-WRAPPED-40X100"
            wrappedProfileData["widthMm"] = 40
            let wrappedProfile = try LabelMediaProfile.parse(wrappedProfileData)
            var wrappedCalibration = attempt("calibration-wrapped", directory: directory,
                calibration: (profile: wrappedProfile, text: fixtures["calibrationOriginalText"] as! String)) {
                _ = try LabelTemplateRenderer.calibration(wrappedProfile)
            }
            wrappedCalibration["profile"] = wrappedProfile.json
            var snapshots: [[String: Any]] = []
            for item in fixtures["templateCases"] as! [[String: Any]] {
                let snapshot = try LabelSnapshot.parse(kind: item["kind"] as! String,
                    templateVersion: item["templateVersion"] as! Int, data: item["data"] as! [String: Any])
                snapshots.append(["id": item["id"]!, "fields": snapshot.fields.map {
                    ["field": $0.label, "text": $0.text, "fontMm": $0.fontMm, "maxLines": $0.maxLines] as [String: Any]
                }])
                production.append(attempt(item["id"] as! String, directory: directory) {
                    _ = try LabelTemplateRenderer.label(snapshot, profile: profile)
                })
            }
            var regressionCases = texts
            regressionCases.append(["id": "long-wrapping", "text": String(repeating: "成品×²", count: 4),
                "fontMm": 3, "widthMm": 20, "heightMm": 10])
            regressionCases.append(["id": "default-ignorable", "text": "A\u{200D}B\u{FE0F} C", "fontMm": 3, "widthMm": 64, "heightMm": 10])
            regressionCases.append(["id": "overflow-negative", "text": String(repeating: "纸板", count: 30),
                "fontMm": 3, "widthMm": 10, "heightMm": 10])
            let clipping = attempt("clipping-negative", directory: directory) {
                let line = try LabelTextRasterizer.shape("校准×²", fontMm: 3, field: "clipping")
                _ = try LabelTextRasterizer.element(line, x: 0, y: 0, widthMm: 64, heightMm: 0.5, field: "clipping")
            }
            let report: [String: Any] = [
                "status": "completed", "runtimeVersion": UIDevice.current.systemVersion,
                "scope": fixtures["evidenceScope"]!, "fixtures": fixtures,
                "textResults": try texts.map { try diagnose($0, directory: directory) },
                "productionAttempts": production, "parsedSnapshots": snapshots,
                "calibrationRegressions": [wrappedCalibration],
                "rendererRegressions": regressionCases.map { regression($0, directory: directory) }, "clippingNegative": clipping,
                "interpretation": "CoreText regression uses the production rasterizer. SDK calls are a test double, not SDK preview or physical printing proof."
            ]
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("report.json"), options: .atomic)
        } catch {
            let report = ["status": "harness-error", "message": String(describing: error)]
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]) {
                try? data.write(to: directory.appendingPathComponent("report.json"), options: .atomic)
            }
        }
    }
}

@objc(FontDiagnosticsDelegate)
final class FontDiagnosticsDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .white
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        DispatchQueue.main.async { FontDiagnostic.execute() }
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(FontDiagnosticsDelegate.self))
