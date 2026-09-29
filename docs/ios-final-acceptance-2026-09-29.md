# iOS 统一验收记录 · 2026-09-29

截至 2026-09-29 22:08（UTC+08:00），已核读 run `36576067423` 下载的原始证据：网页与业务回归通过，macOS `verify:fast` 通过，原生 XCUITest **7 项通过、0 失败**，六种外观场景原始 PNG 已收齐。该 run 的 `current` 底栏仍然偏浅；`web-dark` 虽达到启发式深色指标，但使用了遮住页面底部的 180px 诊断黑带，不能发布。后续 DOM 精确胶囊候选已写入源码，等待新的 CI 验证。**交互已通过与视觉仍需修复必须分开记录；本报告不代表全部验收完成，也不代表已发布新版。**

验收分支为 `codex/ios-final-acceptance`，本报告已核验的 CI 提交为 `db9b4b45e2dd77f9968cc55570b9b292fe41a5f7`，run 为 `36576067423`（attempt 1）。原始证据已归档到 `release/ios-acceptance-run-36576067423/`。主控已核对下载 ZIP 的 SHA256 与 GitHub artifact 摘要一致：`d138a2d1f17fc9149676e09dcfa5c0fd7163a458f53f8406f09860d767fb0857`。该 run 的证据只对应这一提交，不能当作后续 DOM 胶囊候选已经通过的证明。

现有线上 IPA `1.1.4/122` 是之前的包，**不是本次验收新版**。之前的截图审查曾发现图标偏暗，相关背景见 `docs/ios-ui-rebuild-2026-09-29.md`。本次工作流名为 `iOS Final Acceptance (no publish)`，只进行构建、诊断和测试；没有新版 IPA 发布、热更新发布或生产业务数据写入。验收分支上的提交和 CI 运行不等于对外发布。

用户已有的发布授权继续有效；达到既定验收条件后按该授权继续执行，不增加再次授权要求。当前不能发布的原因是视觉问题仍未修复并验证，不是缺少用户授权。

本文证据路径均相对仓库根目录。`release/` 中的 JSON、日志和截图是本地验收产物，需在交付时另行保留；不能假定它们随 Git 文档一起保存。以下只记录断言和状态，不复制会话凭据或真实业务记录。

**本轮实际修复与验证范围**

| 问题 | 已实施修复 | 当前证据与边界 |
| --- | --- | --- |
| 网页底栏在动画未结束时点击相邻标签、滑动后立即点击可能落到错误目标 | 点按保留实际按钮目标；区分轻微抖动和拖动；松手位置参与滑动判定；底栏主动点击不再被页面滑动后的合成点击抑制误拦截 | `src/services/glass-tabbar.ts`、`src/services/tab-navigation.ts`；此前 `navigation-browser` 已通过 Chromium/WebKit；不能替代 UIKit 原生手势验收 |
| 记录页快速重复刷新可能用空数组冒充成功，盖住真实加载失败 | 删除短间隔返回空结果的分支，保留真实 API 结果并交给序列保护处理旧响应 | `src/pages/records/index.tsx`；f9 的 `party-snapshot-browser` 两引擎验证失败、快速重复重试、恢复后记录及历史名称快照 |
| 新增商品成功后，返回列表可能仍读到旧缓存 | 商品缓存失效后触发共享刷新 | `src/pages/product-edit/index.tsx`；f9 的 `team-browser` 两引擎确认只新增一次、返回列表可见、另一会话可见 |
| 客户、记录、流水、团队、打印和商品选择器存在问号文案或货币占位错误 | 恢复中文显示与重试说明，商品选项使用统一金额格式，非有限金额预览恢复为 `¥--` | f9 显示修复后的 4 次相关调用，以及 party/team/orders/secondary 6 次调用均通过，见下表 |
| 旧浏览器断言已落后于页面和匿名访问契约 | 更新 HTTPS 主线路顺序、首页页脚和“我的”标题、展开入库补充信息后定位备注、匿名用户无账户角色的断言；库存测试只等待当前页面业务请求，排除持续 sync/health | 保留入出库、CSV、作废、重复提交、字符限制、认证来源和错误重试等业务断言；原始失败日志仍保留 |
| CI 在新检出环境缺少构建产物，macOS 测试调用 Windows 专用 PowerShell 名称 | H5 构建与资源同步先于产物回归；Windows 使用 `powershell.exe`，其他平台使用 `pwsh`；增加根目录 `index.html` 复制断言 | 当前 CI 源码与产物回归步骤已成功；本地 `verify:fast` 全部适用项通过 |
| 原生诊断需要区分程序驱动导航、实际 UI 手势和视觉结果 | 增加独立模拟器、超时约束、7 个 XCUITest 方法、六种外观诊断场景和原始截图保存；Swift 保留 UIKit 原生控件与手势 | run `36576067423` 已实际运行 XCUITest 并获得 7/0；原始 PNG 已收齐，`current` 视觉仍不满足要求；后续 DOM 胶囊候选待新 CI |

首次失败证据包括 `release/ui-final-regression/results.json`、`SUMMARY.md`、`stock-chromium-diagnostics.log` 和 `party-team-final-team-before-cache-fix.log`。其中旧 `SUMMARY.md` 记录的是第一次运行的 7 个失败，不是当前结论；本报告通过下列后续证据逐项更新状态，没有删除原始失败记录。

**构建和证据版本**

| 证据批次 | H5 主资源 | 内容与时间 | 使用方式 |
| --- | --- | --- | --- |
| 此前完整业务回归 | `app.3ea69244.js` | 2026-09-29 21:16–21:18，`final-reruns.json` 中 18 次浏览器脚本调用全部 exit 0 | 已含商品返回刷新、记录加载和网页手势修复。后续显示修复前的业务实现证据；未受影响的用例未重复全跑，不能写成 f9 的 18 项全跑 |
| 本轮显示修复后统一构建 | `app.f9dda872.js` | 2026-09-29 21:28:21 构建完成，随后进行受影响用例复测 | 最新网页显示修复的直接证据；本轮仅统一构建一次 |

最新构建主资源为 `dist/js/app.f9dda872.js`，SHA256 为 `7baf92030323b0b3f7040bdda30d3434ea9f526d01b1f7a7ee6b0eedb1f76459`。汇总见 `release/ui-final-regression/display-final-summary.json`，构建日志为 `build-h5-display-final.log`。构建 exit 0，保留 webpack 的资源体积与入口体积两项警告。

`final-reruns.json` 的“18”表示脚本调用次数，不是 18 个断言或 18 个独立浏览器场景。部分脚本内部运行两种引擎。此前 18 次调用均通过，具体覆盖如下：

| 此前调用 | 引擎 / 次数 | 已验证内容 | 与最新 f9 的关系 |
| --- | --- | --- | --- |
| `home-origin-browser` | Chromium、WebKit / 2 | 跨月日期、隐藏标签、后台恢复、金额符号、业务故障切换、CSV 来源和鉴权、sync 来源 | 保留此前相同业务实现证据，f9 未单独重跑 |
| `stock-browser` | Chromium、WebKit / 2 | 本地真实入出库、金额和面积、超收确认、库存不足与溢出、CSV、双击去重、作废还原；18 路由、390/1280 宽度 | f9 另跑 Chromium；WebKit 的完整库存业务证据为此前结果 |
| `inbound-remark-length-browser` | Chromium / 1 | 展开配送信息后，备注粘贴按 500 字符限制 | 保留此前结果 |
| `navigation-browser` | 脚本内部 Chromium、WebKit / 1 | 四标签、桥接握手、快速切换、滑动边界与取消、键盘、计算器、旋转布局 | 保留此前相同手势源码结果 |
| `stock-forms-load-browser` | Chromium / 1 | 并行加载失败不进入可提交状态，重试后恢复 | 保留此前结果 |
| `workflow-ui-browser` | 脚本内部 Chromium、WebKit / 1 | 320/390/430 宽度、四主页、可见操作、标签、提交与底栏间距、连接对话框 | 保留此前结果，不宣称已逐页重验 f9 的全部显示文案 |
| `reporting-browser` | Chromium、WebKit / 2 | 报表分页失败后重试、打印、CSV、备份取消与恢复 | f9 两引擎均已重新验证 |
| `order-query-browser` | Chromium、WebKit / 2 | 订单查询与输入时请求稳定性 | 保留此前相同订单查询实现结果；f9 的加载失败重试另有测试 |
| `carton-calculator-browser` | Chromium / 1 | 纸箱计算交互 | 保留此前结果 |
| `customer-edit-money-browser` | Chromium / 1 | 客户编辑金额格式及文本长度限制 | 保留此前结果；f9 的客户列表结算由 team 验证 |
| `ledger-money-input-browser` | Chromium / 1 | 流水金额输入与预览 | f9 已重新验证 |
| `order-number-length-browser`、`product-name-length-browser` | Chromium / 各 1 | 订单号、商品名称长度限制 | 保留此前结果 |
| `live-api-cors-browser` | 脚本内部 Chromium、WebKit / 1 | 浏览器实际跨域读请求和重复 sync，失败请求数为 0 | 线上只读连通性证据；不证明线上已经部署本次网页或原生版本 |

该批逐项日志使用 `release/ui-final-regression/final-source-*.log` 命名，准确命令、环境变量、起止时间和 exit code 记录在 `final-reruns.json`。其中 reporting、ledger、stock Chromium 的结论以更新的 f9 复测为准；其余保留为未变更业务用例的此前证据，不隐含重新运行。

**最新 f9 的直接复测结果**

| 脚本与引擎 | 结果 | 证据文件，均位于 `release/ui-final-regression/` |
| --- | --- | --- |
| reporting Chromium | 通过；包含 Chromium PDF 多页检查、打印样式、分页重试、CSV、备份与恢复 | `display-final-reporting-browser.log` |
| reporting WebKit | 通过；打印媒体、分页重试、CSV、备份与恢复。PDF 生成仅 Chromium 支持，没有把该项记成 WebKit 通过 | `display-final-reporting-browser-webkit.log` |
| ledger 金额输入 Chromium | 通过 | `display-final-ledger-money-input-browser.log` |
| stock Chromium | 通过；商品选择、入出库、溢出、CSV、去重、作废和路由布局 | `display-final-stock-browser.log` |
| party-snapshot Chromium、WebKit | 两引擎通过；实际请求失败、重复重试、恢复、历史/当前往来方名称及快照不变 | `party-team-f9-party.log` |
| team Chromium | 通过；匿名连接、唯一新增商品、返回列表、客户部分结算、另一会话同步 | `party-team-f9-team-chromium.log` |
| team WebKit | 同上，通过 | `party-team-f9-team-webkit.log` |
| orders-load Chromium、WebKit | 两引擎通过；请求失败显示错误，点击重试后恢复 | `party-team-f9-orders.log` |
| secondary-routes Chromium | 通过；15 个路由、14 个二级页面资源；日志明确包含 `f9dda872` | `party-team-f9-secondary-chromium.log` |
| secondary-routes WebKit | 同上，通过 | `party-team-f9-secondary-webkit.log` |

上表共 10 次脚本调用，其中前 4 次的执行元数据保存在 `display-final-reruns.json`。所有业务新增、结算、收发、作废、备份恢复均使用隔离的本地 fixture；浏览器中显示的生产 API 域名会由这些业务测试拦截并转发到本地。唯一直接访问线上 API 的 `live-api-cors-browser` 仅检查读取和匿名会话建立，没有执行生产业务写入。

**快速回归的实际计数**

| 环境与证据 | TypeScript / ESLint | 后端测试 | 产物与单元测试 |
| --- | --- | --- | --- |
| Windows，f9 构建后，`verify-fast-display-final.log` | 均通过 | 共 108：106 通过、0 失败、2 跳过 | 70 通过、0 失败、0 跳过 |
| 先前 macOS CI run `36573738049` / job `109423895430` | 由该 CI 原始 job log 核对 | 共 108：107 通过、0 失败、1 跳过 | 该次随后因缺少 `dist` 和调用 `powershell.exe` 失败；不能记为整次 `verify:fast` 成功 |
| 当前 macOS CI run `36576067423` / 提交 `db9b4b4`，已核读归档 `verify-fast.log` | 均通过 | 共 108：107 通过、0 失败、1 跳过 | 70 通过、0 失败、0 跳过 |

Windows 比 macOS 多一个跳过项是 `backend/server-shutdown-process.test.cjs` 的真实进程 SIGTERM 测试：Windows 的 `child_process.kill` 不具备 POSIX SIGTERM 语义。macOS 执行该项，因此是 107 通过、1 跳过。两平台共有的跳过项为 `backend/package-download.test.cjs` 中依赖部署专用原生 IPA fixture 的下载审计用例。跳过项没有被写成通过；API 元数据与错误契约仍由其他测试覆盖。

先前 macOS 的 107+1 数字来自主控已核读的旧 CI job log；当前 run 的相同计数已独立从 `release/ios-acceptance-run-36576067423/verify-fast.log` 核实。当前 macOS 的产物测试 70 项也全部通过，已修复先前缺少 `dist` 和 PowerShell 命令名称导致的失败。Windows 结果仍以本地完整日志和 `display-final-summary.json` 为准。

**run 36576067423 的原生实际结果**

以下路径除特别说明外，均相对已下载归档目录 `release/ios-acceptance-run-36576067423/`。`environment.log` 和 `toolchain.log` 记录 macOS 15.7.9 arm64、Xcode 26.2、iPhone Simulator SDK 26.2。归档的模拟器 ID 与 UI 附件 manifest 一致。

| 项目 | 当前状态 | 原始证据 |
| --- | --- | --- |
| 源码与构建产物回归 | 通过；后端 107 通过/1 跳过，产物 70 通过 | `verify-fast.log` |
| 原生依赖准备 | 成功 | `native-setup.log`、`toolchain.log` |
| Swift 应用与 UI 测试编译 | `build-for-testing` 成功 | `build.log` |
| 独立 iOS 26+ 模拟器 | 已创建并完成本轮测试 | `device-id.txt`、`device-setup.log`、UI 附件 manifest |
| 原生点按与拖动 XCUITest | **7 项通过、0 失败，exit 0** | `ui-tests/NativeDock.xcresult`、`ui-tests/xcodebuild.log`、`ui-tests/exit-status.txt` |
| UI 原始附件 | 7 个方法共 25 个附件：18 张 PNG、7 份可访问性层级文本，manifest 所列文件全部存在 | `ui-tests/attachments/manifest.json` 及同目录附件；独立 iOS 验证代理另已核对 |
| 六种外观场景原始 PNG | 已收齐；六张 `simulator.png` 均为 1206×2622，并保留各场景四标签步骤截图 | `appearance/<variant>/simulator.png`、`native-dock-step-0.png` 至 `native-dock-step-3.png` |
| 本 run 的 `current` 底栏视觉 | **未通过最终验收**；实际原图仍为浅灰底栏，启发式背景均值 195.571 | `appearance/current/simulator.png`、`appearance/current/appearance-report.json` |
| `web-dark` 诊断候选 | 深色启发式未报失败，但 180px 黑带遮住页面底部，不能发布 | `appearance/web-dark/simulator.png`、对应报告；不是生产实现 |
| 后续 DOM 精确胶囊候选 | 已写入源码，**新 CI 编译、XCUITest 和原始图验证待完成** | 本 run 没有该候选的证据，不借用 7/0 或 `web-dark` 的数值作为其通过结论 |
| 实体 iPhone 手指操作 | 没有本轮证据 | 若要求实体机验收，需另行记录设备、系统、操作及结果；模拟器结果不替代实体机 |
| 新版发布 | **未发布** | 发布授权沿用用户已有授权；先完成剩余视觉修复与验收，再记录新包版本、摘要与实际发布结果 |

7 个原生测试方法均在原始 `xcodebuild.log` 中显示 passed：`testTapEveryNativeTab`、`testPressAndDragBothDirections`、`testShortPressDragBetweenAdjacentTabs`、`testRapidRoundTripTapsEndOnLastDestination`、`testFastRoundTripDrags`、`testRepeatedTapOnSelectedTab`、`testTapImmediatelyAfterDrag`。测试套件总计 498.253 秒，0 unexpected failures。它们通过实际 XCUI 点按、按压拖动，以及 native selected、已确认 JS route、无 pending 请求和实际可见 WebView 标题交叉验证交互。该结果证明本提交在本次模拟器上的操作通过，不证明下一候选、实体机或视觉全部通过。

**六种原图的启发式诊断数值**

以下数值直接读取 `appearance/summary.json`，指标是采样区域的 `backgroundSRGBMean`，不是感知亮度、文字对比度合规值或完整视觉评分。阈值 180 只是当前脚本判定“背景偏浅”的启发式条件。

| variant | backgroundSRGBMean | 报告 status | failures | 结论范围 |
| --- | ---: | --- | --- | --- |
| `system` | 245.509 | `failed` | 背景偏浅及 Tab 0 图标/标签结构、对比度启发式警告 | 无生产视觉通过结论 |
| `edge-off` | 250.589 | `failed` | 同类启发式警告 | 无生产视觉通过结论 |
| `web-dark` | 28.896 | `needs_review` | `[]` | 证明诊断黑色页面背景能使底栏采样变暗；180px 黑带遮挡页面，不能作为可发布界面 |
| `native-white` | 251.871 | `failed` | 背景偏浅及 Tab 0 图标/标签结构、对比度启发式警告 | 无生产视觉通过结论 |
| `native-dark` | 192.983 | `failed` | 同类启发式警告 | 仍未达到当前深色背景条件 |
| 本 run 的 `current` | 195.571 | `failed` | 同类启发式警告 | 原始图仍浅；本候选视觉未通过 |

六份报告均保留 `reviewReasons`：每个标签的图标和文字存在两个层级候选，缺少可信 glyph mask，估计值不能独立证明可读性。`failures: []` 因此仍会产生 `needs_review`，不能升级成“完整视觉验收通过”。这些图像报告自身的 `interactionAcceptance` 仍写着未评估；交互结论须读取独立的 XCUITest 7/0 证据，不能从图片报告推断。

本次已直接查看 `current/simulator.png` 和 `web-dark/simulator.png` 原图：前者底栏为浅灰；后者在胶囊周围还有覆盖页面底部的整块黑色区域。源码中的 `web-dark` 注入样式明确为 `height:180px;background:black`，属于排查采样来源的诊断手段。后续候选将背景限制在精确 DOM 胶囊范围；它已经写入源码，但尚未获得新的 CI 原图、交互及视觉结论，不能用诊断图代替该候选交付图。

总报告为 `status: requires_review`、`productionAcceptance: false`。外观脚本完整收集后以诊断退出码 2 保留人工审核要求，与 XCUITest exit 0 是不同步骤的结果；不能只看 job 颜色，也不能把任一步成功推广为整体验收完成。

主控后续补充位置：DOM 精确胶囊候选的准确提交与 run `[待填]`；该候选编译及 XCUITest 方法通过/失败/未执行数 `[待填]`；原始 PNG 和 xcresult 新归档路径 `[待填]`；胶囊边界、四标签可读性、业务内容遮挡和实际页面状态的逐图结论 `[待填]`；满足既有授权下发布条件后的新包摘要及实际发布结果 `[待填]`。保留当前结论：本 run 交互 7/0，视觉修复仍在继续，未发布新版。

**本地复现命令**

以下命令从仓库根目录执行，依赖项目依赖与 Playwright 浏览器已安装。构建在前，回归在后。业务脚本自行建立本地隔离环境；不需要填入真实业务数据或会话凭据。命令用于复现，本报告整理阶段没有再触发构建、提交、推送或发布。

```powershell
$env:TARO_PUBLIC_PATH = './'
npm.cmd run build:h5
npm.cmd run verify:fast

# f9 受影响显示与业务回归：默认 Chromium。
node tests/reporting-browser.cjs
$env:REPORT_BROWSER = 'webkit'
node tests/reporting-browser.cjs
Remove-Item Env:REPORT_BROWSER
node tests/ledger-money-input-browser.cjs
node tests/stock-browser.cjs

# f9 记录、商品返回、结算、订单失败重试与二级路由。
node tests/party-snapshot-browser.cjs
node tests/team-browser.cjs
$env:TEAM_BROWSER = 'webkit'
node tests/team-browser.cjs
Remove-Item Env:TEAM_BROWSER
node tests/orders-load-browser.cjs
node tests/secondary-routes-browser.cjs
$env:SECONDARY_BROWSER = 'webkit'
node tests/secondary-routes-browser.cjs
Remove-Item Env:SECONDARY_BROWSER
```

此前 18 次调用的逐项 `command` 和 `environment` 可直接从 `release/ui-final-regression/final-reruns.json` 读取；本地批跑脚本为 `release/ui-final-regression/run-final-reruns.cjs`。如确需重跑全部，可执行 `node release/ui-final-regression/run-final-reruns.cjs`；它包含一次直接线上读取的 CORS 脚本，不执行生产业务写入。复跑会更新该本地批次结果，复跑前应先归档既有证据。

原生复现需 macOS、Xcode 26.2、iOS 26+ simulator runtime、CocoaPods、Ruby `xcodeproj` 和可用 `pwsh`。以下对应当前 workflow 的无发布流程；使用新的证据输出目录，避免覆盖已有 xcresult：

```bash
TARO_PUBLIC_PATH=./ npm run build:h5
pwsh -NoProfile -NonInteractive -File scripts/sync-native-assets.ps1 -Source dist -Target www
npm run verify:fast
npx cap copy ios
(cd ios/App && pod install)
ruby scripts/setup-ios-ui-tests.rb
xcodebuild -workspace ios/App/App.xcworkspace -scheme NativeDockUITests \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath release/ios-acceptance-derived \
  CODE_SIGNING_ALLOWED=NO build-for-testing
python3 scripts/prepare-ios-acceptance-device.py
ACCEPTANCE_DEVICE="$(cat release/ios-final-acceptance/device-id.txt)"
bash scripts/run-ios-ui-tests.sh "$ACCEPTANCE_DEVICE" \
  release/ios-acceptance-derived release/ios-final-acceptance/ui-tests current
```

外观收集另需装有 Pillow 的独立 Python 环境，执行 `scripts/ios-dock-diagnostics.sh`，传入已构建的 `App.app`、新的输出目录和同一已安装模拟器 ID。该脚本完整收集后仍要求原始 PNG 人工审核。详细参数、超时和证据归档约定以 `.github/workflows/ios-final-acceptance.yml` 为准。复现结束后只清理本次 `prepare-ios-acceptance-device.py` 创建并记录的模拟器，不操作其他设备。
