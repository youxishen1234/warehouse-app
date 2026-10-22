import Foundation
import UIKit

final class NIIMBOTSDKAdapter {
    private static let instance = NIIMBOTSDKAdapter()
    static func shared() -> NIIMBOTSDKAdapter { instance }
    func render(width: Double, height: Double, elements: [[String: Any]]) -> [String: Any] {
        ["sdkJson": "{}", "imageBase64": "DIAGNOSTIC_STUB_NOT_AN_SDK_PREVIEW"]
    }
}

enum CalibrationBitmapDiagnostic {
    static func execute() {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        do {
            let profile = try LabelMediaProfile.parse([
                "profileId": "CALIBRATION-BITMAP-70X100",
                "printerName": "K3-DIAGNOSTIC",
                "widthMm": 70,
                "heightMm": 100,
                "paperStyle": "gap",
                "density": 3,
                "marginMm": ["top": 5, "right": 3, "bottom": 5, "left": 3],
                "calibrated": false,
            ])
            let encoded = try LabelTemplateRenderer.calibrationBitmap(profile)
            guard let data = Data(base64Encoded: encoded), let image = UIImage(data: data)?.cgImage else {
                throw LabelFailure("TEST_INVALID_PNG", "Calibration bitmap is not a PNG")
            }
            try data.write(to: directory.appendingPathComponent("calibration-70x100.png"), options: .atomic)
            guard image.width == 560, image.height == 800 else {
                throw LabelFailure("TEST_DIMENSION", "Expected 560 x 800 pixels, got \(image.width) x \(image.height)")
            }
            guard let context = CGContext(data: nil, width: image.width, height: image.height,
                    bitsPerComponent: 8, bytesPerRow: image.width, space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
                throw LabelFailure("TEST_BITMAP", "Cannot inspect pixels")
            }
            context.setFillColor(gray: 1, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            guard let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else {
                throw LabelFailure("TEST_BITMAP", "Cannot read pixels")
            }
            var ink = 0, edge = 0
            for y in 0..<image.height {
                for x in 0..<image.width where bytes[y * context.bytesPerRow + x] < 127 {
                    ink += 1
                    if x == 0 || y == 0 || x == image.width - 1 || y == image.height - 1 { edge += 1 }
                }
            }
            guard ink > 1000, edge == 0 else {
                throw LabelFailure("TEST_CALIBRATION_CONTENT", "Bitmap is blank or clipped")
            }
            let result: [String: Any] = [
                "status": "passed",
                "widthPx": image.width,
                "heightPx": image.height,
                "inkPixelsBelow127": ink,
                "edgeInkPixelsBelow127": edge,
                "physicalPrintingTested": false,
            ]
            try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("result.json"), options: .atomic)
        } catch {
            let result = ["status": "failed", "message": String(describing: error)]
            try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted])
                .write(to: directory.appendingPathComponent("result.json"), options: .atomic)
        }
    }
}

@objc(CalibrationBitmapDiagnosticDelegate)
final class CalibrationBitmapDiagnosticDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .white
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        DispatchQueue.main.async { CalibrationBitmapDiagnostic.execute() }
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil,
    NSStringFromClass(CalibrationBitmapDiagnosticDelegate.self))
