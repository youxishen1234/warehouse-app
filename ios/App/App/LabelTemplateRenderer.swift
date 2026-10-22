import Foundation
import CoreFoundation

struct LabelFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

/// These rules are Foundation-only so the acceptance harness can exercise the same code.
enum LabelInput {
    static func keys(_ value: [String: Any], allowed: Set<String>) throws {
        guard Set(value.keys).isSubset(of: allowed) else { throw LabelFailure("INVALID_INPUT", "标签参数包含未允许的字段") }
    }
    static func text(_ value: Any?, field: String, limit: Int = 120) throws -> String {
        guard let text = value as? String, !text.isEmpty, text == text.trimmingCharacters(in: .whitespacesAndNewlines),
              text.utf16.count <= limit, !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0.value == 0xFFFD })
        else { throw LabelFailure("INVALID_FIELD", "请检查\(field)：不能为空、包含控制字符或超过 \(limit) 字") }
        return text
    }
    static func number(_ value: Any?, field: String, minimum: Double = 0, maximum: Double = 100_000_000, integer: Bool = false) throws -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw LabelFailure("INVALID_FIELD", "\(field)必须是有效数字") }
        let result = number.doubleValue
        guard result.isFinite, result >= minimum, result <= maximum, !integer || result.rounded() == result else { throw LabelFailure("INVALID_FIELD", "\(field)数值超出范围") }
        return result
    }
    static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
    static func jobID(_ value: Any?) throws -> String {
        let id = try text(value, field: "任务 ID", limit: 100)
        guard matches(id, "^[A-Za-z0-9_-]{8,100}$") else { throw LabelFailure("INVALID_INPUT", "任务 ID 无效") }
        return id
    }
    static func labelURL(_ value: Any?, kind: String, id: String) throws -> String {
        let raw = try text(value, field: "二维码链接", limit: 400)
        guard let outer = URLComponents(string: raw), outer.scheme == "https", outer.host == "youxishen.online",
              outer.user == nil, outer.password == nil, outer.port == nil, outer.path == "/", outer.query == nil,
              let fragment = outer.fragment, let route = URLComponents(string: fragment),
              route.path == "/pages/label-resolver/index", route.fragment == nil, let items = route.queryItems, items.count == 3,
              Set(items.map { $0.name }) == Set(["v", "kind", "id"]),
              items.first(where: { $0.name == "v" })?.value == "1",
              items.first(where: { $0.name == "kind" })?.value == kind,
              items.first(where: { $0.name == "id" })?.value == id
        else { throw LabelFailure("INVALID_QR_URL", "二维码必须指向正式站点的版本化标签详情，且与当前记录一致") }
        return raw
    }
    static func decimal(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal; formatter.usesGroupingSeparator = false; formatter.maximumFractionDigits = 6
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

struct LabelMediaProfile: Codable {
    struct Margins: Codable { let top: Double; let right: Double; let bottom: Double; let left: Double }
    let profileId: String
    let printerName: String
    let widthMm: Double
    let heightMm: Double
    let paperStyle: String
    let density: Int
    let marginMm: Margins
    var calibrated: Bool

    static func parse(_ value: [String: Any]) throws -> LabelMediaProfile {
        try LabelInput.keys(value, allowed: ["profileId", "printerName", "widthMm", "heightMm", "paperStyle", "density", "marginMm", "calibrated"])
        let id = try LabelInput.text(value["profileId"], field: "媒体配置 ID", limit: 100)
        let name = try LabelInput.text(value["printerName"], field: "打印机名称", limit: 120)
        guard value["paperStyle"] as? String == "gap", let margin = value["marginMm"] as? [String: Any] else { throw LabelFailure("INVALID_PROFILE", "首版只支持实测间隙纸及完整边距") }
        try LabelInput.keys(margin, allowed: ["top", "right", "bottom", "left"])
        let width = try LabelInput.number(value["widthMm"], field: "纸宽 mm", minimum: 20, maximum: 120)
        let height = try LabelInput.number(value["heightMm"], field: "纸高 mm", minimum: 20, maximum: 200)
        let margins = try Margins(top: LabelInput.number(margin["top"], field: "上边距 mm", minimum: 0.5, maximum: 30),
            right: LabelInput.number(margin["right"], field: "右边距 mm", minimum: 0.5, maximum: 30),
            bottom: LabelInput.number(margin["bottom"], field: "下边距 mm", minimum: 0.5, maximum: 30),
            left: LabelInput.number(margin["left"], field: "左边距 mm", minimum: 0.5, maximum: 30))
        guard margins.left + margins.right < width - 10, margins.top + margins.bottom < height - 10 else { throw LabelFailure("INVALID_PROFILE", "边距必须为内容留下有效版面") }
        return LabelMediaProfile(profileId: id, printerName: name, widthMm: width, heightMm: height, paperStyle: "gap",
            density: Int(try LabelInput.number(value["density"], field: "浓度", minimum: 1, maximum: 5, integer: true)), marginMm: margins, calibrated: false)
    }
    var json: [String: Any] {
        ["profileId": profileId, "printerName": printerName, "widthMm": widthMm, "heightMm": heightMm, "paperStyle": paperStyle,
         "density": density, "calibrated": calibrated, "marginMm": ["top": marginMm.top, "right": marginMm.right, "bottom": marginMm.bottom, "left": marginMm.left]]
    }
    var signature: String {
        [printerName, String(widthMm), String(heightMm), paperStyle, String(density), String(marginMm.top),
         String(marginMm.right), String(marginMm.bottom), String(marginMm.left)].joined(separator: "|")
    }
}

struct LabelSnapshot {
    struct Field { let label: String; let text: String; let fontMm: Double; let maxLines: Int }
    let kind: String
    let businessID: String
    let fields: [Field]
    let url: String

    static func parse(kind: String, templateVersion: Int, data: [String: Any]) throws -> LabelSnapshot {
        guard templateVersion == 1 else { throw LabelFailure("UNSUPPORTED_TEMPLATE", "不支持此标签模板版本") }
        var fields: [Field] = []
        func add(_ label: String, _ text: String, font: Double = 2.8, lines: Int = 2) { fields.append(Field(label: label, text: text, fontMm: font, maxLines: lines)) }
        func optionalText(_ key: String, _ label: String) throws { if let value = data[key] { add(label, "\(label)：\(try LabelInput.text(value, field: label))") } }
        func optionalNumber(_ key: String, _ label: String, unit: String, zeroAllowed: Bool = false, integer: Bool = false) throws {
            if let value = data[key] { let number = try LabelInput.number(value, field: label, minimum: zeroAllowed ? 0 : Double.leastNonzeroMagnitude, integer: integer); add(label, "\(label)：\(LabelInput.decimal(number)) \(unit)") }
        }
        switch kind {
        case "finished-product":
            try LabelInput.keys(data, allowed: ["productId", "name", "specification", "unit", "material", "corrugation", "layers", "weight", "productUrl", "stockSnapshot", "printedAt"])
            let id = String(Int64(try LabelInput.number(data["productId"], field: "商品 ID", minimum: 1, maximum: 9_007_199_254_740_991, integer: true)))
            let name = try LabelInput.text(data["name"], field: "商品名称", limit: 160)
            let specification = try LabelInput.text(data["specification"], field: "商品规格", limit: 240)
            // A unit may be absent in historical product data unless stock is explicitly included.
            guard let unit = data["unit"] as? String else { throw LabelFailure("INVALID_FIELD", "库存单位必须为字符串") }
            if !unit.isEmpty { _ = try LabelInput.text(unit, field: "库存单位", limit: 24) }
            add("标签类型", "成品", font: 3.2, lines: 1); add("商品名称", name, font: 4, lines: 2)
            add("商品规格", specification, font: 3.5, lines: 3); add("商品 ID", "商品 ID：\(id)", lines: 1)
            try optionalText("material", "材质"); try optionalText("corrugation", "楞型")
            try optionalNumber("layers", "层数", unit: "层", integer: true); try optionalNumber("weight", "克重", unit: "g/m²")
            if let stock = data["stockSnapshot"] {
                guard !unit.isEmpty else { throw LabelFailure("INVALID_FIELD", "打印时库存必须同时包含商品单位") }
                add("打印时库存", "打印时库存：\(LabelInput.decimal(try LabelInput.number(stock, field: "打印时库存"))) \(unit)")
            }
            if let timestamp = data["printedAt"] {
                let value = try LabelInput.text(timestamp, field: "打印日期", limit: 40)
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard LabelInput.matches(value, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"),
                      let parsed = formatter.date(from: value), formatter.string(from: parsed) == value
                else { throw LabelFailure("INVALID_FIELD", "打印日期必须为冻结的 ISO 时间") }
                add("打印日期", "打印日期：\(value)")
            }
            return LabelSnapshot(kind: kind, businessID: id, fields: fields, url: try LabelInput.labelURL(data["productUrl"], kind: kind, id: id))
        case "paperboard-batch":
            try LabelInput.keys(data, allowed: ["batchId", "boardLength", "boardWidth", "fluteType", "layers", "faceGsm", "linerGsm", "flutingGsm", "cartonLength", "cartonWidth", "cartonHeight", "supplier", "receivedDate", "location", "receivedQty", "remainingQtySnapshot", "batchUrl"])
            let id = try LabelInput.text(data["batchId"], field: "批次 ID", limit: 80)
            guard LabelInput.matches(id, "^BOARD-[0-9]{8}-[A-F0-9]{12}$") else { throw LabelFailure("INVALID_FIELD", "批次 ID 格式无效") }
            let length = try LabelInput.number(data["boardLength"], field: "纸板长度 cm", minimum: Double.leastNonzeroMagnitude)
            let width = try LabelInput.number(data["boardWidth"], field: "纸板宽度 cm", minimum: Double.leastNonzeroMagnitude)
            add("标签类型", "纸板批次", font: 3.2, lines: 1)
            add("纸板规格", "\(LabelInput.decimal(length)) × \(LabelInput.decimal(width)) cm", font: 4, lines: 2)
            add("楞型", "楞型：\(try LabelInput.text(data["fluteType"], field: "楞型", limit: 12))")
            add("批次 ID", id, font: 3, lines: 2)
            add("板厂", "板厂：\(try LabelInput.text(data["supplier"], field: "板厂"))")
            try optionalNumber("layers", "层数", unit: "层", integer: true); try optionalNumber("faceGsm", "面纸克重", unit: "g/m²")
            try optionalNumber("linerGsm", "里纸克重", unit: "g/m²"); try optionalNumber("flutingGsm", "楞纸克重", unit: "g/m²")
            let cartonKeys = ["cartonLength", "cartonWidth", "cartonHeight"]
            let cartonCount = cartonKeys.filter { data[$0] != nil }.count
            if cartonCount > 0 {
                guard cartonCount == 3 else { throw LabelFailure("INVALID_FIELD", "纸箱尺寸必须同时提供完整长宽高") }
                let sizes = try cartonKeys.map { LabelInput.decimal(try LabelInput.number(data[$0], field: "纸箱尺寸 cm", minimum: Double.leastNonzeroMagnitude)) }
                add("纸箱尺寸", "纸箱：\(sizes.joined(separator: " × ")) cm")
            }
            if let date = data["receivedDate"] {
                let value = try LabelInput.text(date, field: "入库日期", limit: 10)
                let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
                formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
                formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
                guard LabelInput.matches(value, "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"), let parsed = formatter.date(from: value), formatter.string(from: parsed) == value else { throw LabelFailure("INVALID_FIELD", "入库日期无效") }
                add("入库日期", "入库日期：\(value)")
            }
            try optionalText("location", "库位")
            try optionalNumber("receivedQty", "实收数量", unit: "张", zeroAllowed: true, integer: true)
            try optionalNumber("remainingQtySnapshot", "打印时余量", unit: "张", zeroAllowed: true, integer: true)
            return LabelSnapshot(kind: kind, businessID: id, fields: fields, url: try LabelInput.labelURL(data["batchUrl"], kind: kind, id: id))
        default: throw LabelFailure("INVALID_KIND", "未知标签类型")
        }
    }
}

// MARK: - iOS renderer (the Foundation harness compiles everything above this marker)
#if canImport(UIKit)
import UIKit
import CoreText
import CoreImage

struct RenderedOfficialLabel { let sdkJSON: String; let imageBase64: String; let warnings: [String] }

/// Shape, measure and draw the same fallback-enabled line; the SDK never resolves text fonts.
enum LabelTextRasterizer {
    static let pointsPerMm = 72.0 / 25.4
    static let dpi = 300.0 // Intermediate sampling, not an assertion about the printer's native DPI.
    static let k3PixelsPerMm = 8.0 // K3 is a 200 dpi, 8 dots/mm printer.
    static let paddingPoints = 2.0 * 72.0 / dpi

    struct Line {
        let text: String
        let shaped: CTLine
        let bounds: CGRect
        var widthPoints: Double { Double(bounds.width) + 2 * paddingPoints }
        var heightMm: Double { (Double(bounds.height) + 2 * paddingPoints) / pointsPerMm }
    }

    static func shape(_ text: String, fontMm: Double, field: String) throws -> Line {
        guard fontMm.isFinite, fontMm > 0, fontMm <= 20,
              let font = UIFont(name: "PingFangSC-Regular", size: fontMm * pointsPerMm)
        else { throw LabelFailure("FONT_UNAVAILABLE", "系统中文字体不可用；不能生成标签") }
        let ctFont = CTFontCreateWithName(font.fontName as CFString, font.pointSize, nil)
        let shaped = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): ctFont,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): UIColor.black.cgColor
        ]))
        // Source indices are UTF-16 offsets, not Swift Character indices or one glyph per code unit.
        var ignorableOffsets = Set<Int>(), offset = 0
        for scalar in text.unicodeScalars {
            if scalar.properties.isDefaultIgnorableCodePoint || CharacterSet.whitespacesAndNewlines.contains(scalar) {
                for index in offset..<(offset + scalar.utf16.count) { ignorableOffsets.insert(index) }
            }
            offset += scalar.utf16.count
        }
        for run in CTLineGetGlyphRuns(shaped) as! [CTRun] {
            let attributes = CTRunGetAttributes(run) as NSDictionary
            let resolved = attributes[kCTFontAttributeName] as! CTFont
            let name = CTFontCopyPostScriptName(resolved) as String
            guard !name.lowercased().contains("lastresort") else {
                throw LabelFailure("FONT_GLYPH_MISSING", "\(field)包含系统字体无法显示的字符")
            }
            guard (CTFontGetSymbolicTraits(resolved).rawValue & (1 << 13)) == 0 else {
                throw LabelFailure("FONT_COLOR_UNSUPPORTED", "\(field)包含彩色表情；请使用文字以保证黑白标签清晰")
            }
            let count = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: count)
            var indices = [CFIndex](repeating: 0, count: count)
            if count > 0 {
                CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
                CTRunGetStringIndices(run, CFRange(location: 0, length: count), &indices)
            }
            guard !glyphs.enumerated().contains(where: { $0.element == 0 && !ignorableOffsets.contains(indices[$0.offset]) }) else {
                throw LabelFailure("FONT_GLYPH_MISSING", "\(field)包含系统字体无法显示的字符")
            }
        }
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        let advance = CTLineGetTypographicBounds(shaped, &ascent, &descent, &leading)
        let ink = CTLineGetBoundsWithOptions(shaped, [.useGlyphPathBounds])
        let minX = ink.isNull ? 0 : min(0, ink.minX)
        let maxX = ink.isNull ? CGFloat(advance) : max(CGFloat(advance), ink.maxX)
        let minY = ink.isNull ? -descent : min(-descent, ink.minY)
        let maxY = ink.isNull ? ascent : max(ascent, ink.maxY)
        return Line(text: text, shaped: shaped, bounds: CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY))
    }

    static func wrapped(_ text: String, widthMm: Double, fontMm: Double, maxLines: Int, field: String) throws -> [Line] {
        _ = try shape(text, fontMm: fontMm, field: field)
        let maxWidth = widthMm * pointsPerMm
        var lines: [Line] = [], current: Line?
        for character in text {
            let candidate = try shape((current?.text ?? "") + String(character), fontMm: fontMm, field: field)
            if candidate.widthPoints <= maxWidth {
                current = candidate
            } else {
                guard let previous = current else { throw LabelFailure("LAYOUT_OVERFLOW", "\(field)无法放入当前纸宽") }
                lines.append(previous)
                let next = try shape(String(character), fontMm: fontMm, field: field)
                guard next.widthPoints <= maxWidth else { throw LabelFailure("LAYOUT_OVERFLOW", "\(field)无法放入当前纸宽") }
                current = next
            }
        }
        if let current = current { lines.append(current) }
        guard lines.count <= maxLines else { throw LabelFailure("LAYOUT_OVERFLOW", "\(field)超过 \(maxLines) 行；请选择更大标签或关闭可选字段") }
        return lines
    }

    static func element(_ line: Line, x: Double, y: Double, widthMm: Double, heightMm: Double, field: String) throws -> [String: Any] {
        let boxWidth = widthMm * pointsPerMm, boxHeight = heightMm * pointsPerMm
        guard widthMm.isFinite, heightMm.isFinite, widthMm > 0, widthMm <= 120, heightMm > 0, heightMm <= 200,
              line.widthPoints <= boxWidth + 0.000001, line.heightMm <= heightMm + 0.000001 else {
            throw LabelFailure("LAYOUT_OVERFLOW", "\(field)无法完整放入文字区域")
        }
        let width = Int(ceil(widthMm * dpi / 25.4)), height = Int(ceil(heightMm * dpi / 25.4))
        guard width * height <= 4_000_000,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { throw LabelFailure("TEXT_RASTER_FAILED", "\(field)文字图像创建失败") }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: CGFloat(width) / boxWidth, y: CGFloat(height) / boxHeight)
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: paddingPoints - Double(line.bounds.minX),
            y: (boxHeight - Double(line.bounds.height)) / 2 - Double(line.bounds.minY))
        CTLineDraw(line.shaped, context)
        guard let image = context.makeImage(), let png = UIImage(cgImage: image, scale: 1, orientation: .up).pngData() else {
            throw LabelFailure("TEXT_RASTER_FAILED", "\(field)文字图像编码失败")
        }
        return ["type": "image", "x": x, "y": y, "w": widthMm, "h": heightMm,
            "imageBase64": png.base64EncodedString(), "sourceText": line.text, "sourceField": field]
    }
}

/// Produces only app-owned drawing elements from typed data.
enum LabelTemplateRenderer {
    private static func render(_ profile: LabelMediaProfile, elements: [[String: Any]], warnings: [String]) throws -> RenderedOfficialLabel {
        let output = NIIMBOTSDKAdapter.shared().render(width: profile.widthMm, height: profile.heightMm, elements: elements)
        if let code = output["errorCode"] as? String { throw LabelFailure(code, output["message"] as? String ?? "官方 SDK 绘制失败") }
        guard let json = output["sdkJson"] as? String, let image = output["imageBase64"] as? String else { throw LabelFailure("PREVIEW_FAILED", "官方 SDK 未返回有效预览") }
        return RenderedOfficialLabel(sdkJSON: json, imageBase64: image, warnings: warnings)
    }
    private static func borderImage(x: Double, y: Double, w: Double, h: Double, field: String) throws -> [String: Any] {
        let width = Int(ceil(w * LabelTextRasterizer.dpi / 25.4))
        let height = Int(ceil(h * LabelTextRasterizer.dpi / 25.4))
        guard width > 0, height > 0, width * height <= 1_000_000,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { throw LabelFailure("TEXT_RASTER_FAILED", "\(field)图像创建失败") }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage(), let png = UIImage(cgImage: image, scale: 1, orientation: .up).pngData() else {
            throw LabelFailure("TEXT_RASTER_FAILED", "\(field)图像编码失败")
        }
        return ["type": "image", "x": x, "y": y, "w": w, "h": h,
            "imageBase64": png.base64EncodedString(), "sourceText": "边框", "sourceField": field,
            "optional": true]
    }
    static func label(_ snapshot: LabelSnapshot, profile: LabelMediaProfile) throws -> RenderedOfficialLabel {
        let x = profile.marginMm.left, width = profile.widthMm - x - profile.marginMm.right
        let bottom = profile.heightMm - profile.marginMm.bottom
        var y = profile.marginMm.top, elements: [[String: Any]] = []
        for field in snapshot.fields {
            let lines = try LabelTextRasterizer.wrapped(field.text, widthMm: width, fontMm: field.fontMm, maxLines: field.maxLines, field: field.label)
            for line in lines {
                let lineHeight = max(field.fontMm * 1.45, line.heightMm)
                guard y + lineHeight <= bottom else { throw LabelFailure("LAYOUT_OVERFLOW", "\(field.label)超出当前纸高") }
                elements.append(try LabelTextRasterizer.element(line, x: x, y: y, widthMm: width, heightMm: lineHeight, field: field.label))
                y += lineHeight
            }
            y += 0.8
        }
        guard let generator = CIFilter(name: "CIQRCodeGenerator") else { throw LabelFailure("QR_VALIDATION_FAILED", "无法验证二维码物理尺寸") }
        generator.setValue(snapshot.url.data(using: .utf8), forKey: "inputMessage"); generator.setValue("M", forKey: "inputCorrectionLevel")
        guard let image = generator.outputImage else { throw LabelFailure("QR_VALIDATION_FAILED", "二维码内容无效") }
        let modules = Double(image.extent.width)
        let codeSize = max(20, modules * 0.4)
        let quiet = max(2, codeSize / modules * 4)
        let outerSize = codeSize + 2 * quiet
        guard width >= outerSize, y + outerSize <= bottom else { throw LabelFailure("LAYOUT_OVERFLOW", "内容和二维码无法完整放入当前标签；请选择更大纸卷或关闭可选字段") }
        elements.append(["type": "qr", "x": x + quiet, "y": y + quiet, "w": codeSize, "h": codeSize, "text": snapshot.url])
        return try render(profile, elements: elements, warnings: ["系统文字图像、对位及二维码必须经 K3 实物验证；正式打印尚未开放"])
    }
    static func calibration(_ profile: LabelMediaProfile) throws -> RenderedOfficialLabel {
        let x = profile.marginMm.left, y = profile.marginMm.top
        let w = profile.widthMm - x - profile.marginMm.right, h = profile.heightMm - y - profile.marginMm.bottom
        guard w >= 15, h >= 15 else { throw LabelFailure("LAYOUT_OVERFLOW", "当前纸张过小，无法生成校准样张") }

        // NIIMBOT rejects both a full-page calibration bitmap and its line
        // primitive. Use only DrawLableImage: four thin border strips plus one
        // small text image per row, matching the normal per-line label path.
        let stroke = 1.0
        var elements: [[String: Any]] = [
            try borderImage(x: x, y: y, w: w, h: stroke, field: "校准边框上"),
            try borderImage(x: x, y: y + h - stroke, w: w, h: stroke, field: "校准边框下"),
            try borderImage(x: x, y: y, w: stroke, h: h, field: "校准边框左"),
            try borderImage(x: x + w - stroke, y: y, w: stroke, h: h, field: "校准边框右")
        ]
        let text = "校准样张 中文 成品 纸板纸箱 × ÷ ± g/m²"
        let texts = ["校准样张", "中文：纸板纸箱成品", "符号：× ÷ ± g/m²",
            String(format: "纸张 %.0f × %.0f mm", profile.widthMm, profile.heightMm)]
        let inset = 3.0
        let textWidth = w - inset * 2
        let fontMm = 3.6
        let lineHeight = fontMm * 1.9
        guard textWidth >= 10 else { throw LabelFailure("LAYOUT_OVERFLOW", "当前纸张过窄，无法生成校准文字") }
        var rows: [LabelTextRasterizer.Line] = []
        for entry in texts {
            rows.append(contentsOf: try LabelTextRasterizer.wrapped(entry, widthMm: textWidth, fontMm: fontMm, maxLines: 2, field: "校准文字"))
        }
        let blockHeight = lineHeight * Double(rows.count)
        guard blockHeight + inset * 2 <= h else { throw LabelFailure("LAYOUT_OVERFLOW", "当前标签无法放下校准文字，请检查纸卷尺寸") }
        var cursor = y + (h - blockHeight) / 2
        for line in rows {
            elements.append(try LabelTextRasterizer.element(line, x: x + inset, y: cursor,
                widthMm: textWidth, heightMm: lineHeight, field: "校准文字"))
            cursor += lineHeight
        }
        return try render(profile, elements: elements,
            warnings: ["校准样张由四条边框图片和逐行文字组成；请目视确认边界、中文、浓度和走纸，SDK 回调不代表实物完成（样例：\(text)）"])
    }

    /// Full-page bitmap for the SDK's direct bitmap print channel. This path
    /// never uses DrawLableImage, which the K3 rejects for calibration content.
    static func calibrationBitmap(_ profile: LabelMediaProfile) throws -> String {
        let left = profile.marginMm.left, right = profile.marginMm.right
        let bottom = profile.marginMm.bottom, top = profile.marginMm.top
        let w = profile.widthMm - left - right
        let h = profile.heightMm - bottom - top
        guard w >= 15, h >= 15 else { throw LabelFailure("LAYOUT_OVERFLOW", "当前纸张过小，无法生成校准样张") }
        // JCAPI prints the direct bitmap at its native pixel size. A 70 mm
        // K3 page is 560 pixels wide, so the bitmap must cover the whole page
        // rather than only the printable margins or the head will clip it.
        let width = Int(ceil(profile.widthMm * LabelTextRasterizer.k3PixelsPerMm))
        let height = Int(ceil(profile.heightMm * LabelTextRasterizer.k3PixelsPerMm))
        guard width > 0, height > 0, width * height <= 8_000_000,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { throw LabelFailure("TEXT_RASTER_FAILED", "校准位图创建失败，请检查纸张尺寸") }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let pointsPerMm = LabelTextRasterizer.pointsPerMm
        let boxWidth = profile.widthMm * pointsPerMm, boxHeight = profile.heightMm * pointsPerMm
        context.scaleBy(x: CGFloat(width) / boxWidth, y: CGFloat(height) / boxHeight)
        let border = max(0.6, 0.8 * pointsPerMm)
        context.setStrokeColor(gray: 0, alpha: 1)
        context.setLineWidth(border)
        context.stroke(CGRect(x: left * pointsPerMm + border / 2, y: bottom * pointsPerMm + border / 2,
            width: w * pointsPerMm - border, height: h * pointsPerMm - border))
        let text = "校准样张\n中文：纸板纸箱成品\n符号：× ÷ ± g/m²\n" +
            String(format: "纸张 %.0f × %.0f mm", profile.widthMm, profile.heightMm)
        let fontMm = min(5.0, max(3.2, h / 16))
        let maxWidth = w - 8
        let lineHeight = fontMm * 1.9
        var rows: [LabelTextRasterizer.Line] = []
        for entry in text.split(separator: "\n") {
            rows.append(contentsOf: try LabelTextRasterizer.wrapped(String(entry),
                widthMm: maxWidth, fontMm: fontMm, maxLines: 2, field: "校准文字"))
        }
        let blockHeight = lineHeight * Double(rows.count)
        guard blockHeight + 8 <= h else { throw LabelFailure("LAYOUT_OVERFLOW", "当前标签无法放下校准文字，请检查纸卷尺寸") }
        var cursor = bottom + (h - blockHeight) / 2 + blockHeight
        for line in rows {
            context.textMatrix = .identity
            context.textPosition = CGPoint(x: left * pointsPerMm + 4 * pointsPerMm + LabelTextRasterizer.paddingPoints - Double(line.bounds.minX),
                y: cursor * pointsPerMm - (lineHeight * pointsPerMm + Double(line.bounds.height)) / 2 - Double(line.bounds.minY))
            CTLineDraw(line.shaped, context)
            cursor -= lineHeight
        }
        guard let image = context.makeImage(), let png = UIImage(cgImage: image, scale: 1, orientation: .up).pngData() else {
            throw LabelFailure("TEXT_RASTER_FAILED", "校准位图编码失败")
        }
        return png.base64EncodedString()
    }
}
#endif
