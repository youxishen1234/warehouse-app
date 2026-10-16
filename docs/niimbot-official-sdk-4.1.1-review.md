# 精臣 iOS SDK 接入资料核对

核对日期：2026-10-09。

## 当前状态

已收到并检查用户提供的 `IOS_4.1.1_20260729(1).zip`，已接入配套 Demo 头文件和原始静态库。当前 App 使用官方 SDK；历史原生壳可能仍使用原社区协议。模拟器显式关闭官方打印能力。原生编译、发布及 K3 真机验收应以实际构建和验收结果为准，浏览器模拟通过不代表实体打印已通过。

原压缩包 SHA-256：

```text
d5958d5d1cd8fe4c2f4c3bd224b6225a0c4ec32f83e93c888983f0a8dddf50ff
```

本机已解包目录（位于 Git 忽略的 `release/` 中）：

```text
release/niimbot-sdk-review-01a11ec6/IOS_4.1.1_20260729/
```

## 包内资料与适用性

- `IOS端 SDK接入包使用说明.pdf`：接入用途及开发说明。
- `接口文档/IOS端SDK 接口说明文档 V4.1.1.pdf`：28 页；第 5 页明确列出 K3 使用蓝牙 BLE，K3_W 单独列为 SPP/Wi-Fi，不能直接把两种机型视为相同的 BLE 接入。
- `SDK接入包/Headers/JCAPI.h`、`SDK接入包/Libs/`：Objective-C 头文件及静态库。
- `SDKDemoOC/`：示例工程，内部另有一套头文件及静态库。
- `注意事项/`：iOS 蓝牙权限及开启蓝牙说明。
- `排版相关/`：原生绘制及精臣 PC 端排版说明。

可用于此前讨论的仓库 iPhone App 直接连接 K3，打印 70 × 100 mm 的成品和纸板标签。具体尺寸、走纸和打印效果仍需真机验收。

## 已核对的接口

| 操作 | SDK 接口 | 接入注意事项 |
| --- | --- | --- |
| 搜索蓝牙打印机 | `scanBluetoothPrinter:` | 回调提供设备名称；当前 App 使用 CoreBluetooth UUID，桥接层需适配 |
| 连接 | `openPrinter:completion:` | 以名称连接；连接回调也需处理断开 |
| 连接状态 | `isConnectingState` | 原生层确认状态后再开放打印 |
| 开始任务 | `startJob:withPaperStyle:withCompletion:` | K3 浓度范围 1-5，默认 3；间隙纸类型为 1 |
| 标签内容 | `initDrawingBoard:`、`DrawLableImage:`、`GenerateLableJson` | 可将现有标签画布输出交给 SDK；保持 70 × 100 mm 尺寸 |
| 提交 | `commit:withOnePageNumbers:withComplete:` | 文档示例设置缓存和总份数；不要把提交成功等同于物理打印完成 |
| 打印进度 | `getPrintingCountInfo:` | 等待 `totalCount` 达到本次任务目标 |
| 结束 | `endPrint:` | 文档示例在份数完成后调用，之后检查返回结果 |
| 错误 | `getPrintingErrorInfo:` | 处理缺纸、开盖、断开、超时；错误后不自动重印 |
| 断开 | `closePrinter` | 离开标签页时清理连接及等待中的调用 |

上述顺序来自接口文档第 7-10 页及 Demo。现有前端的 `write` 和原始协议握手不能原样用于 SDK 连接，应新增原生打印方法并同步适配前端。

## 库文件差异与构建要求

压缩包和 PDF 标为 4.1.1，但两份头文件首行版本注释不同：

- `SDK接入包/Headers/JCAPI.h`：`version 3.2.8 20250315`。
- `SDKDemoOC/SDKDemoOC/JCAPI.h`：`version 4.0.3 20251226`。

两套 `JCAPI.a` 与 `libSkiaRenderLibrary.a` 的 SHA-256 不同；`JCLPAPI.a` 相同。此次选用 `SDKDemoOC/SDKDemoOC` 的配套头文件和库，保存于 `ios/App/App/Vendor/NIIMBOT`，原始字节及来源记录在 `provenance.json`，通过 `node scripts/verify-niimbot-sdk.cjs` 核对。

已遍历静态库内 Mach-O 对象：两套库均为 arm64 iOS 真机目标，未发现模拟器切片。现有 CI 含模拟器验收，应为模拟器明确禁用 SDK 打印，或获得厂家提供的模拟器库；不要将真机库强行链接到模拟器。

接口文档第 6 页要求 `-ObjC`，并展示 AVFoundation、CoreMedia、bz2、iconv 等依赖。文档说明仅接入 K3 时无需 B50/B11 系列使用的 `JCLPAPI.a`；最终依赖仍需通过 Xcode 链接确认。

使用说明第 2 页说明 Demo 字体仅供接口学习测试，不代表授予商用权。复用当前标签画布输出时无需复制这些示例字体。

## 对现有项目的接入位置

- `ios/App/App/NativeGlassTabBar.swift`：当前注册 `OfficialLabelPrinterPlugin`，由官方 SDK 适配层负责扫描、连接、绘制和完成判断。
- 旧版社区协议代码仅作为历史参考，不属于当前官方 SDK 打印链路。
- `ios/App/App.xcodeproj/project.pbxproj`：需要增加所选 SDK 的原生编译、链接和桥接配置。
- `tests/label-resolver-browser.cjs`：验证标签链接、在线实时读取、字段白名单和异常恢复；原生官方桥接另由 `scripts/verify-label-print-ios.cjs` 静态校验。

官方 SDK 含原生代码，首次接入必须重新构建并安装 iOS App，单独热更新网页无法加入这些库。原生包走 `.github/workflows/build-ios.yml`；涉及热更新时仍须遵守 `.github/workflows/publish-hotupdate.yml` 和项目的提交、发布门禁。

## 本次验证记录

- 已将标签功能从其他工作区改动中隔离，当前提交只包含标签页面、实时解析、官方 iOS 桥接、验证脚本和必要的入口/请求接线。
- H5 构建、TypeScript 类型检查、ESLint 检查通过；标签领域、强制实时读取和 Chromium 标签解析回归通过。
- 标签验证覆盖成品/纸板字段白名单、二维码链接、实时刷新、删除/网络失败、匿名连接恢复和窄屏布局。
- SDK 原始文件 SHA-256、2,071 个 arm64 iOS 真机对象及真机专属链接配置核对通过。
- 原生 Swift 状态机测试位于 `tests/official-label-native-harness.swift`，由 `python3 scripts/test-official-label-native.py` 执行。Windows 本机尚未执行 macOS/Xcode 编译，也尚未完成 K3 实机打印验收。
- `build-ios.yml` 会在 macOS 上验证 SDK 输入、桥接注册、模拟器编译和 unsigned IPA；正式热更新仍只走 `publish-hotupdate.yml`。
- 官方静态库已按 `provenance.json` 保留原始字节并纳入提交；正式 iOS 编译仍由 macOS 工作流执行，K3 真机验收仍是独立门槛。
