# iOS 验收续办记录

## 已核实

- 源码提交：0648e4f；GitHub Actions run 36582832017 已结束。
- H5 资源构建、源码与构建产物回归、Swift 测试构建、实际 native taps/drags 步骤成功。
- 外观采集步骤为 failure；不能仅凭步骤状态确定是视觉失败还是脚本保留人工审核，必须读取原始报告。
- 最新原图 artifact 11039839740，SHA256：2f829f38eeb48f7dc818ffce1d0c64f670e3556757a3c6d2e34c0ecc4cfc79de。
- 完整证据 artifact 11041576150，SHA256：e46705664faf8b1b3eabf17e5a7a41bc0e8a4e0b84a91cfbe85a7520cbd37d95。
- 两份附件现已下载，SHA256 与 GitHub API 的 digest 均一致；分别归档 release/ios-appearance-run-36582832017 与 release/ios-acceptance-run-36582832017。
- 对 run 对应测试源码运行证据检查器：8/8 方法 started→passed，0 失败/跳过，30 个附件（22 PNG、8 可访问性文本）完整。独立代理复核一致。此结论只适用于 0648e4f，不适用于之后诊断改动。
- current 首页原图深色底栏与图标文字可读，启发式 backgroundSRGBMean=33.386，failures=[]。这是原始图检查，不是旧 web-dark 诊断黑带的结果。

## 本次修改及验证

- 发布 workflow 改为与验收一致的 sync-native-assets.ps1，保留源码管理的辅助资源。
- 资源构建启用 set -euo pipefail，构建失败立即终止。
- 缺少服务器地址、用户或认证配置时返回失败，避免未上传却显示成功。
- native-sync 测试 1/1 通过；workflow YAML 解析和 git diff --check 通过。
- 修改仅在当前工作区，未合并 main、未发布。视觉审核关卡未绕过。

## 当前阻塞和下一步

- GitHub 浏览器连接已恢复，已取得原图；之前的下载阻塞已解除。
- 横屏两个 app.screenshot 原图出现大黑区、内容裁切及浅色底栏。原始像素 2622×1206、EXIF Orientation=8；剥离或应用元数据都不能消除该现象。尚不能判定是 XCTest 应用捕获器还是实际窗口布局；不批准横屏视觉或发布。
- 新诊断保留应用截图，同时补充 XCUIScreen 全屏截图、窗口/WebView/TabBar/DOM 几何；横屏增加四个标签实际点击，检查全部按钮完整位于应用范围。必须在新 CI 中验证。
- 证据检查器新增强制全屏附件模式，不能用旧应用截图冒充新证据；14 项检查器单测、70 项产物测试通过。
- 之后完成与已审核证据绑定的发布关卡、实际 UI 测试衔接及版本递增，再执行发布和线上包核验。
- 最近核实的线上版本仍为 1.1.4 / Build 122；不是这次候选修复包。
