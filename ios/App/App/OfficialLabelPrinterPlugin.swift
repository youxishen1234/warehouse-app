import Foundation

private struct OfficialLabelJob: Codable {
    let jobId: String
    let kind: String
    let businessId: String
    let profileId: String
    let profileSignature: String
    let createdAt: String
    let total: Int
    var phase: String
    var errorCode: String?
    var message: String
    var submissionAttempted: Bool
    var submissionAccepted: Bool
    var calibrationConfirmed: Bool
    var requiresResolution: Bool
    var diagnosticSignals: [String]
    var terminal: Bool { ["failed", "cancelled", "uncertain", "sdk-completed"].contains(phase) }
    var json: [String: Any] {
        var value: [String: Any] = ["jobId": jobId, "kind": kind, "businessId": businessId, "profileId": profileId,
            "createdAt": createdAt, "total": total, "phase": phase, "outcomeConfidence": "unknown", "message": message, "requiresResolution": requiresResolution]
        if let errorCode = errorCode { value["errorCode"] = errorCode }
        return value
    }
}

private struct OfficialLabelJournal: Codable {
    var profiles: [LabelMediaProfile] = []
    var jobs: [OfficialLabelJob] = []
    mutating func recoverInterruptedJobs() {
        for index in jobs.indices {
            if !jobs[index].terminal || jobs[index].requiresResolution {
                jobs[index].phase = "uncertain"
                jobs[index].errorCode = "APP_RESTARTED"
                jobs[index].message = "App 曾中断，任务结果未确认；请先检查实体标签，不会自动重印"
                jobs[index].requiresResolution = false
            }
        }
    }
}

// MARK: - iOS coordinator (the Foundation harness compiles everything above this marker)
import UIKit
import CoreBluetooth
import Capacitor

/// App lifetime owner. Pages only subscribe; navigation never cancels this coordinator.
private final class OfficialLabelCoordinator: NSObject, CBCentralManagerDelegate {
    static let shared = OfficialLabelCoordinator()
    // This is intentionally source-controlled, never a JS option or UserDefaults feature flag.
    private let productionEnabled = false
    private let gateReason = "K3 真机的字体、扫码路由、份数及任务结束语义尚未完成验收；仅可执行单张校准，正式打印保持关闭"
    private let sdk = NIIMBOTSDKAdapter.shared()
    private var journal = OfficialLabelJournal()
    private var storageURL: URL?
    private var storageError: String?
    private var central: CBCentralManager?
    private var bluetoothWait: ((Result<Void, LabelFailure>) -> Void)?
    private var permissionTimeout: DispatchWorkItem?
    private var operationTimeout: DispatchWorkItem?
    private var operationGeneration = 0
    private var taskGeneration = 0
    private var operation: String?
    private var hardwareBusy = false
    private var activeJobId: String?
    private var pendingCall: CAPPluginCall?
    private var scanned: [String: Int] = [:]
    private var scanAt: Date?
    private var observers: [NSObjectProtocol] = []
    var progress: (([String: Any]) -> Void)?

    private override init() {
        super.init()
        do {
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("OfficialLabelPrinter", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            storageURL = directory.appendingPathComponent("local-journal-v1.json")
            if let url = storageURL, FileManager.default.fileExists(atPath: url.path) { journal = try JSONDecoder().decode(OfficialLabelJournal.self, from: Data(contentsOf: url)) }
            journal.recoverInterruptedJobs()
            activeJobId = journal.jobs.first(where: { $0.phase == "uncertain" && !$0.calibrationConfirmed })?.jobId
            try persist()
        } catch { storageError = "本机任务日志不可用，禁止发起可能出纸的操作" }
        sdk.connectionChanged = { [weak self] connected in
            guard let self = self else { return }
            if !connected, self.hardwareBusy { self.failTask("PRINTER_DISCONNECTED", "打印机已断开；结果未确认，请检查实体标签") }
        }
        sdk.printingError = { [weak self] code in self?.sdkError(code) }
        sdk.diagnosticCount = { [weak self] values in
            // Native printing waits for this count before endPrint; the user
            // still confirms the paper itself before calibration is accepted.
            let signal = ["totalCount", "pageCount", "pageNO"].compactMap { key -> String? in
                guard let value = values[key] else { return nil }; return "\(key)=\(value)"
            }.joined(separator: ",")
            self?.recordSignal("count(unverified):\(signal)")
        }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            if self.hardwareBusy { self.failTask("APP_BACKGROUNDED", "App 进入后台，无法确认续打状态；请检查实体标签") }
            else if self.operation != nil { self.failOperation(LabelFailure("APP_BACKGROUNDED", "App 进入后台，请返回后重新操作")) }
        })
    }

    private func persist() throws {
        guard let url = storageURL, storageError == nil else { throw LabelFailure("STORAGE_UNAVAILABLE", storageError ?? "本机任务日志不可用") }
        try JSONEncoder().encode(journal).write(to: url, options: .atomic)
    }
    @discardableResult private func persistUpdate() -> Bool {
        do { try persist(); return true } catch {
            storageError = "任务日志写入失败；请检查实体标签，之后打印已阻止"
            hardwareBusy = false; taskGeneration += 1; operationTimeout?.cancel(); sdk.disconnect()
            if let index = currentIndex() {
                journal.jobs[index].phase = "uncertain"; journal.jobs[index].errorCode = "STORAGE_UNAVAILABLE"
                journal.jobs[index].message = storageError!; journal.jobs[index].requiresResolution = false
            }
            if let call = pendingCall { pendingCall = nil; call.reject(storageError!, "STORAGE_UNAVAILABLE") }
            emitCurrent(); return false
        }
    }
    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let issue = (error as? LabelFailure) ?? LabelFailure("NATIVE_OPERATION_FAILED", "本机标签操作失败，请检查配置与设备")
        call.reject(issue.message, issue.code)
    }
    private func requireSupported() throws {
        guard sdk.supported else { throw LabelFailure("UNSUPPORTED_PLATFORM", "仅支持安装官方 SDK 的 iOS 真机；模拟器不能连接或打印") }
    }
    private func requireIdle() throws {
        try requireSupported()
        guard operation == nil, !hardwareBusy else { throw LabelFailure("PRINTER_BUSY", "当前操作尚未结束；校准后请先确认实物或显式取消") }
        guard storageError == nil else { throw LabelFailure("STORAGE_UNAVAILABLE", storageError!) }
    }
    private func profile(_ id: String?) throws -> LabelMediaProfile {
        guard let id = id, let result = journal.profiles.first(where: { $0.profileId == id }) else { throw LabelFailure("MEDIA_NOT_CONFIGURED", "请先保存当前打印机的实测纸张配置") }
        return result
    }
    private func currentIndex(_ jobId: String? = nil) -> Int? {
        guard let id = jobId ?? activeJobId else { return nil }; return journal.jobs.firstIndex(where: { $0.jobId == id })
    }
    private func emitCurrent() { if let index = currentIndex() { progress?(journal.jobs[index].json) } }
    private func recordSignal(_ signal: String) {
        guard hardwareBusy, let index = currentIndex() else { return }
        journal.jobs[index].diagnosticSignals.append(signal)
        if journal.jobs[index].diagnosticSignals.count > 40 { journal.jobs[index].diagnosticSignals.removeFirst() }
        persistUpdate()
    }
    private func updateTask(_ phase: String, message: String, errorCode: String? = nil) {
        guard let index = currentIndex() else { return }
        journal.jobs[index].phase = phase; journal.jobs[index].message = message; journal.jobs[index].errorCode = errorCode
        persistUpdate(); emitCurrent()
    }
    private func failTask(_ code: String, _ message: String) {
        guard hardwareBusy else { return }
        taskGeneration += 1; operationTimeout?.cancel(); operationTimeout = nil
        hardwareBusy = false
        if let index = currentIndex() { journal.jobs[index].requiresResolution = false }
        updateTask("uncertain", message: message, errorCode: code)
        // Recovery disconnects; only an explicit user cancellation calls cancelJob.
        sdk.disconnect()
        if let call = pendingCall { pendingCall = nil; call.reject(message, code) }
    }
    private func sdkError(_ code: String) {
        let messages = ["1": "盒盖打开", "2": "缺纸", "5": "打印机手动停止", "6": "打印数据错误", "16": "纸型不支持",
            "17": "纸张设置失败", "19": "浓度未确认生效", "22": "通讯异常", "23": "打印机断开"]
        recordSignal("error:\(code)")
        failTask("SDK_\(code)", "\(messages[code] ?? "打印机未知错误（\(code)）")；结果未确认，请检查已出纸部分后再决定操作")
    }
    private func failOperation(_ issue: LabelFailure) {
        operationGeneration += 1; operationTimeout?.cancel(); operationTimeout = nil; permissionTimeout?.cancel(); permissionTimeout = nil
        bluetoothWait = nil; operation = nil; sdk.disconnect()
        if let call = pendingCall { pendingCall = nil; reject(call, issue) }
    }
    private func beginOperation(_ name: String, call: CAPPluginCall, timeout: TimeInterval, work: @escaping () -> Void) throws {
        try requireIdle(); operation = name; pendingCall = call; operationGeneration += 1
        let generation = operationGeneration
        let timer = DispatchWorkItem { [weak self] in
            guard let self = self, self.operationGeneration == generation, self.operation != nil else { return }
            self.failOperation(LabelFailure("OPERATION_TIMEOUT", "\(name)超时，请检查蓝牙、距离与设备占用后重试"))
        }
        operationTimeout = timer; DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timer)
        ensureBluetooth { [weak self] result in
            guard let self = self, self.operationGeneration == generation, self.operation != nil else { return }
            switch result { case .success: work(); case .failure(let error): self.failOperation(error) }
        }
    }
    private func finishOperation() { operation = nil; pendingCall = nil; operationTimeout?.cancel(); operationTimeout = nil }
    private func ensureBluetooth(_ completion: @escaping (Result<Void, LabelFailure>) -> Void) {
        bluetoothWait = completion
        if central == nil { central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: true]) }
        else if let central = central { centralManagerDidUpdateState(central) }
        if bluetoothWait != nil {
            let timer = DispatchWorkItem { [weak self] in
                guard let self = self, let wait = self.bluetoothWait else { return }; self.bluetoothWait = nil
                wait(.failure(LabelFailure("BLUETOOTH_UNAVAILABLE", "蓝牙状态未就绪；请在系统设置中允许蓝牙并打开开关")))
            }
            permissionTimeout = timer; DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timer)
        }
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state != .unknown, central.state != .resetting else { return }
        if central.state != .poweredOn, hardwareBusy { failTask("BLUETOOTH_UNAVAILABLE", "蓝牙已关闭或权限不可用，结果未确认") }
        guard let wait = bluetoothWait else { return }
        bluetoothWait = nil; permissionTimeout?.cancel(); permissionTimeout = nil
        if central.state == .poweredOn { wait(.success(())) }
        else { wait(.failure(LabelFailure("BLUETOOTH_UNAVAILABLE", central.state == .unauthorized ? "蓝牙权限被拒绝；请在 iPhone 设置中允许本 App 使用蓝牙" : "蓝牙未开启或设备不支持；请检查 iPhone 设置"))) }
    }

    func getState(_ call: CAPPluginCall) {
        var value: [String: Any] = ["supported": sdk.supported, "connected": sdk.connected, "mediaProfiles": journal.profiles.map { $0.json },
            "productionEnabled": productionEnabled, "maxCopies": 1, "hardwareBusy": hardwareBusy || operation != nil, "reason": storageError ?? (sdk.supported ? gateReason : "官方 K3 标签仅支持 iOS 真机，模拟器不支持")]
        if let name = sdk.connectedPrinterName { value["printerName"] = name }
        call.resolve(value)
    }
    func scanPrinters(_ call: CAPPluginCall) {
        do {
            guard !sdk.connected else { throw LabelFailure("ALREADY_CONNECTED", "请先断开当前打印机再扫描") }
            try beginOperation("扫描打印机", call: call, timeout: 25) { [weak self] in
                guard let self = self else { return }; let generation = self.operationGeneration
                self.sdk.scan { [weak self] names in
                    guard let self = self, self.operationGeneration == generation, self.operation != nil else { return }
                    self.scanned = Dictionary(grouping: names, by: { $0 }).mapValues { $0.count }; self.scanAt = Date()
                    let printers: [[String: Any]] = self.scanned.keys.sorted().map { ["printerName": $0, "connected": false, "ambiguous": self.scanned[$0, default: 0] > 1] }
                    self.finishOperation(); call.resolve(["printers": printers])
                }
            }
        } catch { reject(call, error) }
    }
    func connectPrinter(_ call: CAPPluginCall) {
        do {
            let name = try LabelInput.text(call.getString("printerName"), field: "打印机名称", limit: 120)
            guard call.getBool("modelConfirmed") == true else { throw LabelFailure("MODEL_NOT_CONFIRMED", "请对照铭牌确认是 K3 BLE，不能选择 K3_W") }
            let upper = name.uppercased()
            guard LabelInput.matches(upper, "^K3(?:[-_ ].*)?$"), !upper.hasPrefix("K3_W"), !upper.hasPrefix("K3-W"), !upper.hasPrefix("K3 W") else { throw LabelFailure("UNSUPPORTED_PRINTER", "首版只支持明确确认的 K3 BLE，不支持 K3_W 或其他型号") }
            guard scanned[name] == 1, let date = scanAt, Date().timeIntervalSince(date) < 120 else { throw LabelFailure("AMBIGUOUS_PRINTER", "设备未在最近扫描中唯一出现；同名设备请逐台关机排除后重试") }
            try beginOperation("连接打印机", call: call, timeout: 25) { [weak self] in
                guard let self = self else { return }; let generation = self.operationGeneration
                self.sdk.connect(printerName: name) { [weak self] accepted in
                    guard let self = self, self.operationGeneration == generation, self.operation != nil else { return }
                    guard accepted, self.sdk.errorListenerReady else { self.failOperation(LabelFailure("CONNECT_FAILED", "K3 未确认连接，请靠近设备并退出其他占用打印机的 App")); return }
                    self.finishOperation(); call.resolve()
                }
            }
        } catch { reject(call, error) }
    }
    func saveMediaProfile(_ call: CAPPluginCall) {
        do {
            try requireIdle()
            guard let raw = call.getObject("profile") else { throw LabelFailure("INVALID_PROFILE", "缺少媒体配置") }
            let saved = try LabelMediaProfile.parse(raw)
            guard sdk.connected, sdk.connectedPrinterName == saved.printerName else { throw LabelFailure("WRONG_PRINTER", "配置必须属于当前已连接、铭牌已确认的打印机") }
            var revised = journal; revised.profiles.removeAll { $0.profileId == saved.profileId }; revised.profiles.append(saved)
            guard revised.profiles.count <= 30 else { throw LabelFailure("PROFILE_LIMIT", "本机最多保存 30 个媒体配置") }
            let previous = journal; journal = revised
            do { try persist() } catch { journal = previous; throw error }
            call.resolve()
        } catch { reject(call, error) }
    }
    func previewLabel(_ call: CAPPluginCall) {
        do {
            try requireIdle(); let media = try profile(call.getString("profileId"))
            guard let kind = call.getString("kind"), let data = call.getObject("data"), let version = call.getInt("templateVersion") else { throw LabelFailure("INVALID_INPUT", "标签参数不完整") }
            let snapshot = try LabelSnapshot.parse(kind: kind, templateVersion: version, data: data)
            let result = try LabelTemplateRenderer.label(snapshot, profile: media)
            call.resolve(["imageBase64": result.imageBase64, "warnings": result.warnings])
        } catch { reject(call, error) }
    }
    func printLabel(_ call: CAPPluginCall) {
        // No caller-controlled opt-in can open this gate. Production activation requires a reviewed implementation
        // backed by real K3 completion, quantity, font, paper and camera-scan acceptance evidence.
        call.reject(gateReason, "PRODUCTION_NOT_ACCEPTED")
    }
    func getActiveJob(_ call: CAPPluginCall) { call.resolve(["job": currentIndex().map { journal.jobs[$0].json } as Any? ?? NSNull()]) }
    func getRecentJobs(_ call: CAPPluginCall) { call.resolve(["jobs": journal.jobs.map { $0.json }]) }

    func printCalibration(_ call: CAPPluginCall) {
        do {
            try requireIdle()
            guard call.getBool("acknowledged") == true else { throw LabelFailure("ACKNOWLEDGEMENT_REQUIRED", "校准可能实际出纸且 SDK 尚未验收，请明确确认后继续") }
            let id = try LabelInput.jobID(call.getString("jobId")); let media = try profile(call.getString("profileId"))
            guard !journal.jobs.contains(where: { $0.jobId == id }) else { throw LabelFailure("DUPLICATE_JOB", "此任务已存在，不能自动重发；请先检查原任务与实体标签") }
            guard sdk.connected, sdk.connectedPrinterName == media.printerName, sdk.errorListenerReady else { throw LabelFailure("PRINTER_NOT_READY", "请连接媒体配置对应的 K3，并确认蓝牙状态") }
            let bitmap = try LabelTemplateRenderer.calibrationBitmap(media)
            let job = OfficialLabelJob(jobId: id, kind: "calibration", businessId: "", profileId: media.profileId, profileSignature: media.signature,
                createdAt: ISO8601DateFormatter().string(from: Date()), total: 1, phase: "submitting",
                errorCode: nil, message: "正在配置单张校准任务；尚未确认出纸", submissionAttempted: false, submissionAccepted: false, calibrationConfirmed: false, requiresResolution: true, diagnosticSignals: [])
            // Atomically persist before any task configuration that could feed paper.
            let previous = journal; journal.jobs.insert(job, at: 0); journal.jobs = Array(journal.jobs.prefix(10))
            do { try persist() } catch { journal = previous; throw error }
            activeJobId = id; hardwareBusy = true; pendingCall = call; taskGeneration += 1
            let generation = taskGeneration; emitCurrent()
            let timeout = DispatchWorkItem { [weak self] in
                guard let self = self, self.taskGeneration == generation, self.hardwareBusy else { return }
                self.failTask("CALIBRATION_TIMEOUT", "校准任务等待超时，结果未确认；请检查实体标签，不会自动重试")
            }
            operationTimeout = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: timeout)
            recordSignal("bitmap:NO;cache:NO;total:1")
            guard taskGeneration == generation, hardwareBusy else { return }
            sdk.printBitmap(base64: bitmap, widthMm: media.widthMm, heightMm: media.heightMm,
                density: media.density) { [weak self] accepted in
                guard let self = self, self.taskGeneration == generation, self.hardwareBusy else { return }
                self.recordSignal("bitmapPrint:\(accepted)")
                guard self.taskGeneration == generation, self.hardwareBusy else { return }
                guard accepted else { self.failTask("BITMAP_PRINT_REJECTED", "SDK 未接受校准位图；请检查打印机、纸卷和蓝牙状态"); return }
                self.operationTimeout?.cancel(); self.operationTimeout = nil
                if let index = self.currentIndex() {
                    self.journal.jobs[index].submissionAttempted = true
                    self.journal.jobs[index].submissionAccepted = true
                }
                do { try self.persist() } catch { self.failTask("STORAGE_UNAVAILABLE", "无法写入提交日志"); return }
                self.updateTask("uncertain", message: "校准位图已提交，SDK 完成语义未经验证；请检查实物边界、中文、浓度及走纸，再明确确认或取消")
                self.pendingCall = nil; call.resolve()
            }
        } catch { reject(call, error) }
    }
    func confirmCalibration(_ call: CAPPluginCall) {
        do {
            try requireSupported()
            guard call.getBool("acknowledged") == true, let id = call.getString("jobId"),
                  let index = currentIndex(id), journal.jobs[index].kind == "calibration", journal.jobs[index].submissionAccepted,
                  journal.jobs[index].errorCode == nil, journal.jobs[index].profileId == call.getString("profileId"),
                  let profileIndex = journal.profiles.firstIndex(where: { $0.profileId == journal.jobs[index].profileId }),
                  journal.profiles[profileIndex].signature == journal.jobs[index].profileSignature
            else { throw LabelFailure("CALIBRATION_NOT_CONFIRMABLE", "只有已提交且无已知错误的本机校准任务可在检查实物后确认") }
            guard operation == nil, !hardwareBusy || activeJobId == id else { throw LabelFailure("PRINTER_BUSY", "另一个操作仍在进行") }
            if journal.jobs[index].calibrationConfirmed { call.resolve(); return }
            let previous = journal
            journal.profiles[profileIndex].calibrated = true; journal.jobs[index].calibrationConfirmed = true; journal.jobs[index].requiresResolution = false
            journal.jobs[index].message = "用户已检查校准样张；任务仍为结果未确认，正式打印需完整 K3 验收"
            do { try persist() } catch { journal = previous; throw error }
            taskGeneration += 1; operationTimeout?.cancel(); operationTimeout = nil; hardwareBusy = false; sdk.disconnect()
            progress?(journal.jobs[index].json); activeJobId = nil; call.resolve()
        } catch { reject(call, error) }
    }
    func cancelPrint(_ call: CAPPluginCall) {
        do {
            try requireSupported(); let id = try LabelInput.jobID(call.getString("jobId"))
            guard let index = currentIndex(id) else { throw LabelFailure("JOB_NOT_FOUND", "没有找到此本机任务") }
            guard activeJobId == id, hardwareBusy else { call.resolve(journal.jobs[index].json); return }
            taskGeneration += 1; let generation = taskGeneration; operationTimeout?.cancel()
            if let original = pendingCall { pendingCall = nil; original.reject("用户取消了校准操作，请检查实体标签", "USER_CANCELLED") }
            pendingCall = call
            updateTask("uncertain", message: "用户已请求取消；出纸结果仍未确认", errorCode: "USER_CANCELLED")
            guard taskGeneration == generation, hardwareBusy else { return }
            var finished = false
            let finish: (Bool) -> Void = { [weak self] acknowledged in
                guard let self = self, !finished, self.taskGeneration == generation else { return }; finished = true
                self.operationTimeout?.cancel(); self.operationTimeout = nil; self.hardwareBusy = false; self.sdk.disconnect()
                if let index = self.currentIndex(id) { self.journal.jobs[index].requiresResolution = false }
                self.updateTask("uncertain", message: acknowledged ? "SDK 已响应取消；仍需检查是否已有标签出纸" : "取消未获 SDK 确认，连接已清理；请检查实体标签", errorCode: "USER_CANCELLED")
                if let index = self.currentIndex(id) { call.resolve(self.journal.jobs[index].json) }
                else { call.reject("本机任务日志不可用", "STORAGE_UNAVAILABLE") }
                self.pendingCall = nil
            }
            let timeout = DispatchWorkItem { finish(false) }; operationTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
            sdk.cancel { finish($0) }
        } catch { reject(call, error) }
    }
    func disconnectPrinter(_ call: CAPPluginCall) {
        do {
            try requireSupported()
            guard !hardwareBusy, operation == nil else { throw LabelFailure("PRINTER_BUSY", "请先确认实物或显式取消当前任务，再断开连接") }
            operationGeneration += 1; sdk.disconnect(); call.resolve()
        } catch { reject(call, error) }
    }
}

@objc(OfficialLabelPrinterPlugin)
public final class OfficialLabelPrinterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OfficialLabelPrinterPlugin"
    public let jsName = "OfficialLabelPrinter"
    public let pluginMethods: [CAPPluginMethod] = [
        "getState", "scanPrinters", "connectPrinter", "saveMediaProfile", "previewLabel", "printLabel",
        "getActiveJob", "getRecentJobs", "cancelPrint", "disconnectPrinter", "printCalibration", "confirmCalibration"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private func perform(_ call: CAPPluginCall, _ work: @escaping (OfficialLabelCoordinator) -> Void) {
        DispatchQueue.main.async { [weak self] in
            let owner = OfficialLabelCoordinator.shared
            owner.progress = { [weak self] event in self?.notifyListeners("progress", data: event) }
            work(owner)
        }
    }
    @objc func getState(_ call: CAPPluginCall) { perform(call) { $0.getState(call) } }
    @objc func scanPrinters(_ call: CAPPluginCall) { perform(call) { $0.scanPrinters(call) } }
    @objc func connectPrinter(_ call: CAPPluginCall) { perform(call) { $0.connectPrinter(call) } }
    @objc func saveMediaProfile(_ call: CAPPluginCall) { perform(call) { $0.saveMediaProfile(call) } }
    @objc func previewLabel(_ call: CAPPluginCall) { perform(call) { $0.previewLabel(call) } }
    @objc func printLabel(_ call: CAPPluginCall) { perform(call) { $0.printLabel(call) } }
    @objc func getActiveJob(_ call: CAPPluginCall) { perform(call) { $0.getActiveJob(call) } }
    @objc func getRecentJobs(_ call: CAPPluginCall) { perform(call) { $0.getRecentJobs(call) } }
    @objc func cancelPrint(_ call: CAPPluginCall) { perform(call) { $0.cancelPrint(call) } }
    @objc func disconnectPrinter(_ call: CAPPluginCall) { perform(call) { $0.disconnectPrinter(call) } }
    @objc func printCalibration(_ call: CAPPluginCall) { perform(call) { $0.printCalibration(call) } }
    @objc func confirmCalibration(_ call: CAPPluginCall) { perform(call) { $0.confirmCalibration(call) } }
}
