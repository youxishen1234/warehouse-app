# 阶段 1：设计评审交付

日期：2026-09-25。H5 可本地预览；iOS P0 已准备独立源代码和 CI，尚未编译、运行模拟器，不认定原生效果已达标。确认前不进入正式 App 集成。

## Token 与四页 H5

入口 E:/aoo/warehouse-app/prototypes/h5/index.html，可直接本地浏览器打开。切换四 Tab，顶部可选正常/加载/空/错误。明确使用示例数据，零外部请求；保存只演示反馈。

Token：prototypes/h5/tokens.css。品牌 #0F766E，浅底 #ECFDF5，按下 #0B5C56；成功/警告/危险/信息语义色；主文字 #0F172A、次要 #475569、弱化正文 #64748B、禁用 #94A3B8、背景 #F6F8FA、卡片白色。弱化正文适度加深以提高可读性。字号 12/14/16/17/20/26/30；4px 间距体系，页边距/卡片内边距16，圆角8/12/16/24/胶囊，三级阴影，最大列宽496，金额等宽数字，按压0.97。保留深色变量，不宣称完整深色主题。

- 首页：今日数据、成本口径概览、7/30天数量趋势、快捷入口、待办、3条库存预警、品类占比、最近单据。
- 入库：供应商与日期、多行明细、规格自由输入与候选、数量/价格重算、mm规格转面积、删除确认、固定合计与模拟提交。
- 出库：商品、规格/材质输入、8种单位、步进器、客户日期、金额、打印偏好与最近记录。
- 我的：业务工具、备份导入导出、更新下载、诊断、关于，无登录或游客入口。

未实现业务入口明确提示视觉样稿。不能视为打印、数据导入或业务保存已实现；全量业务联动、完整字段、金额趋势、下拉刷新、转场/性能测量待确认后实施。H5 导航不能替代原生玻璃验收。

## H5 验证

运行 node scripts/verify-stage1-h5.cjs：Chromium+WebKit ×360/390/430/1280px ×4页×4状态，共128张截图。无横向溢出，桌面496px列居中，无浏览器JS错误，外部请求为0。多行金额、删除取消/确认、规格面积重算/无效规格阻止、提交禁用、步进器、负数校验、弹层、30天双序列切换通过。

结果 E:/aoo/warehouse-app/release/stage1/h5/results.json，截图在同目录。图片查看工具输出异常，尚不能宣称逐图完成目视品质验收。请通过 HTML 或截图评审风格。

## iOS P0 独立原型

工程 prototypes/ios-glass/project.yml，XcodeGen、iOS14部署目标，独立 Sources/Resources/Tests，不依赖正式 App 或服务器。Windows 上未编译 Swift。

官方核查来源（2026-09-25）：
- https://developer.apple.com/documentation/uikit/uiglasseffect
- https://developer.apple.com/documentation/uikit/uivisualeffectview
- https://developer.apple.com/documentation/uikit/uicornerconfiguration-swift.struct
- https://developer.apple.com/documentation/uikit/uiglasscontainereffect
- https://developer.apple.com/documentation/uikit/uitabbarcontroller

采用 UIGlassEffect + UIVisualEffectView，cornerConfiguration = .capsule()；官方并非名为 UIGlassEffectView 的类。新 API 全部位于 if #available(iOS26.0,*) 及 compiler>=6.2 隔离内；旧系统或旧工具链使用 UIBlurEffect。

UITabBarController 是标准 Tab 的系统方案，--system-reference 提供系统对照。UIGlassContainerEffect 用于组合多个玻璃元素的渲染/融合，并非包含路由和选中交互的 Tab 控件。自定义胶囊实验用于保留网页握手；嵌套选中胶囊必须与系统对照实测，调用 API 不代表光学效果已达标。如差距明显，继续改原型，验收前不集成。

- 外胶囊与独立选中玻璃胶囊；图标文字完整包裹；弹性切换/轻微缩放；响应减少动态效果。
- WebView 延伸到底部，彩色内容实际经过底栏后方。原生测量并下发 --dock-inset，末条按钮可完整滚入可点区域。
- 底栏隐藏时仅保留安全区；由 ready、路由、键盘、模态及失败状态共同控制显示。
- epoch/sequence/requestId/ack 防陈旧状态；8秒超时隐藏；网页ack后更新选中；document-start注入重载epoch。
- Web数据不持久化，导航限制为本地内容；原型工具条提供键盘/详情/模态/重载测试。

## macOS CI：待推送授权

.github/workflows/verify-glass-prototype.yml + scripts/ios-glass-prototype-smoke.sh。仅手动或 codex/glass-prototype-review 分支相关路径触发；contents:read；不发布、不部署、不读业务备份、不用发布密钥；证据保留14天。

矩阵：Xcode26.2/iOS26.2、Xcode26.2/iOS18.5（新工具链构建在旧系统运行）、Xcode16.4/iOS18.5（旧工具链兼容）。版本缺失直接失败，不静默替换。官方环境清单：https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-15-Readme.md 。执行时保存真实环境信息，清单不等于运行成功证据。XcodeGen来源：https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md 。

产物契约：工具链/设备/runtime信息、build.log、test.log、tests.xcresult、PNG截图、interaction.mp4、result.json。smoke覆盖启动、4Tab、滚动、末条按钮、安全区、键盘/模态/详情、重载、旋转、前后台、强制模糊与系统对照。强制模糊不替代旧系统验证。

本地 JS/YAML/Bash语法检查通过；Swift编译、模拟器截图/录屏尚未执行。未创建提交或推送。需先获准将选定原型文件推至评审分支，才可运行新工作流。当前 main/master 上的发布工作流不参与。

## iOS 真机验证清单

逐项记录设备、系统、构建号、截图/视频及结论。全部标记“待真机验证”。本工作流只构建免签模拟器版本，真机还需签名安装。

| 步骤 | 预期 | 状态 |
| --- | --- | --- |
| iOS26冷启动，等首页完成 | 页面和底栏同步就绪，无错位闪现 | 待真机验证 |
| 彩色卡片/文字慢拖及快滚穿过底栏，与系统Tab模式比较 | 背景折射、高光边缘和厚度可见，不只是模糊 | 待真机验证 |
| 四Tab连续切换20次，按住后移出取消 | 高光完整包裹图标文字，弹性可中断，路由选中一致 | 待真机验证 |
| 滚到末条按钮并点击，覆盖刘海/灵动岛及指示条设备 | 内容、固定操作区、底栏不遮挡，末条完整可点 | 待真机验证 |
| 输入中文，开关键盘并切换输入法 | 底栏正确隐藏恢复，无重复留白 | 待真机验证 |
| 开关模态、进入详情再回首页 | 模态详情无残留底栏，返回后选中及间距正确 | 待真机验证 |
| 重载立即切Tab，前后台往返五次 | 陈旧ack不影响新页，不永久隐藏或白屏 | 待真机验证 |
| 旋转横竖屏；iPad调整窗口 | 安全区重算，胶囊居中，内容不裁切 | 待真机验证 |
| 减少动态效果、降低透明度、深色模式、VoiceOver | 材质可读、动画克制，Tab名称及选中可朗读，隐藏元素不可聚焦 | 待真机验证 |
| 新工具链构建安装到iOS26以下设备 | 自动模糊降级，四Tab/键盘/模态功能正常，无API崩溃 | 待真机验证 |
| 未来集成后断网恢复与H5回退 | 无登录游客界面，离线反馈明确，握手可恢复 | 待真机验证 |

## 文件范围与门槛

- Swift（未来重打IPA）：prototypes/ios-glass 的Sources四文件、Resources/content.html、UITests、project.yml及生成文件忽略配置，均为独立原型。
- H5（本次不热更新）：prototypes/h5/index.html、tokens.css、style.css、app.js、home-details.js。
- 后端（本次不重启）：生产代码未改；服务器采集脚本只在忽略目录。
- 工程化：stage0-snapshot、stage0-walkthrough、快照单测、verify-stage1-h5、iOS smoke和独立CI，以及阶段文档。
- 已有证据：实际可读业务快照/隔离恢复、Token/四页样稿、H5自动回归。
- 未完成：服务器原文件归档、iOS编译和模拟器证据、用户视觉确认、全部真机项。
- 下一步先授权原型分支CI，再一起评审H5与原生截图/录屏；确认后才推进正式集成，发布另行确认。
