# 仓库应用全流程深入实跑报告

日期：2026-10-08。检查对象：当前共享工作区，HEAD 为 1e9402f31c86db8055470c8384e4e3b72a0dcdee，包含原有未提交功能。本轮没有修改业务源码、提交或发布，没有访问生产业务数据。用户要求无需登录，全部建议以保持免登录为前提。

## 覆盖与结果

| 范围 | 结果 |
| --- | --- |
| TypeScript | 通过 |
| lint | 1 个错误：dot-matrix-print.ts:167 嵌套回调参数遮蔽第 163 行同名变量 |
| 后端已有测试 | 168 项：166 通过、2 跳过、0 失败。跳过为部署 IPA fixture 与 Windows 不支持的 POSIX 信号场景 |
| artifact 已有测试 | 105 项全部通过 |
| 全新 H5 构建 | 通过；2 个体积警告，入口总资源约 455 KiB，非压缩传输大小 |
| 构建产物检查 | 70 个文件通过源码映射和凭据样式扫描；未发布 |
| 主业务 UI | Chromium、WebKit 各 13 组：11 组正常流程通过，2 组缺陷复现一致 |
| 页面遍历 | 两引擎各 25 条注册路由 × 390/1280 像素，共 100 次访问；常规遍历无未捕获 JS 异常、脚本样式 404、页面级横向溢出。纸板详情缺少 id 为空，标签页跳转独立页 |
| 纸板 UI | 两引擎各 11 组：8 组通过、3 组缺陷；另补并发盘点与实际打印 PDF 渲染。覆盖 320/390/768/1440 宽度和暗色模式 |
| 后端业务 | 26 项匿名场景实跑，覆盖完整生命周期、失败回滚、重试和业务边界 |
| 纸板/备份定向测试 | 34 项通过，与全量测试重叠，不额外累加 |
| 账单照片 | 两引擎上传多页多类型原图、响应丢失重试、草稿隔离、刷新、放大、下载原图；正常路径通过，原图字节一致，库存账务未改变 |
| 打印 | HTML/浏览器预览和纸板 PDF 渲染。出库按钮正确带入打印中心并自动选中原单，transaction_id=1，此项不是缺陷 |
| 免登录 | 新浏览器不输入账号密码即可完成正常流程，后端 authentication:false；异常联网和跨服务重启另见下文 |

主业务 UI 实际链路：新增客户、供应商、商品 → 入库 20 件 × 2.50 元，应付 50 → 创建 10 件 × 3 元订单 → 转生产中 → 超量被阻止 → 刷新保留草稿 → 双击第一批 4 件只记一笔 → 第二批 6 件 → 库存剩 10，应收 30，订单已发货 → 收款 10 后余额 20 → 供应商付款 50 后余额 0 → 手工收入保存和作废 → CSV → JSON 备份下载恢复 → 尺寸本公司规格、标签二维码、交接出库。

早期测试调整过 Taro 包装元素选择器与自动化导航方式；脚本适配失败未算产品缺陷。最终主链路在两个引擎均得到相同结果。

## 优先修复的数据一致性问题

### 1. P1：响应中途断开，再提交重复扣库存

真实 request.ts、隔离 server.js 和本地代理复现：库存 10，出库 3 成功；代理收到 HTTP 200 后截断 JSON，前端显示“请求失败”；原样再次提交生成新编号，库存最终 4、两笔出库。根代理再次独立验证 10 → 7 → 4。

原因：[request.ts:218](E:/aoo/warehouse-app/src/services/request.ts:218) 吞掉 JSON 读取异常；[request.ts:350](E:/aoo/warehouse-app/src/services/request.ts:350) 在确定业务结果前清除重试编号。

修复：响应体不完整时保留编号并查询回执，确认最终结果后才清除；补“已提交、200 响应体中途断开”的行为回归。

### 2. P1：匿名会话跨重启失去身份，重试可能重复执行

真实路由初始化前后：访客入库 10，原编号重试仍为 10；服务重启后旧 token 从 guest 变为另一 anonymous actor，回执 200 → 404；原编号返回 409，按提示重新提交新编号，库存变 20、两条流水。写请求带设备头，回执 GET 不带相同设备头，还会造成查询身份不一致。

位置：[team.js:86](E:/aoo/warehouse-app/backend/team.js:86)、[db.js:538](E:/aoo/warehouse-app/backend/db.js:538)、[request.ts:282](E:/aoo/warehouse-app/src/services/request.ts:282)。修复：稳定匿名设备身份和回执归属，跨重启恢复原操作，统一读写身份头；不需要登录。

### 3. P1：纸板旧表单和盘点覆盖最新库存

两引擎实测：A 打开数量 100 的批次只改库位，B 改实收为 120；自动刷新后 A 数量输入仍为 100，保存成功将库存回退为 100。

另测：A 清点填 98，B 随后领走 20，库存变 80；刷新后旧实盘 98 仍可提交，产生盘盈 +18。若 98 是领料前清点值，后续实际应剩 78；库存变动后必须要求复核。

位置：[request.ts:318](E:/aoo/warehouse-app/src/services/request.ts:318)、[request.ts:353](E:/aoo/warehouse-app/src/services/request.ts:353)、[board-outbound/index.tsx:14](E:/aoo/warehouse-app/src/pages/board-outbound/index.tsx:14)。修复：表单保存编辑/清点时的资源版本和库存基准；背景刷新不能替用户确认新版本，冲突时保留草稿并要求重数。纸板字符串 ID 也纳入版本策略。

### 4. P1/P2：恢复旧备份后仍重放失效的成功回执

库存 10 备份 → 入库 3 → 恢复旧备份，库存 10、交易清空 → 原编号重试返回 200、库存 13、交易 #1，真实库仍为 10、零交易。纸板同样返回成功但原批次查询 404。

位置：[db.js:548](E:/aoo/warehouse-app/backend/db.js:548)、[db.js:1169](E:/aoo/warehouse-app/backend/db.js:1169)。修复：恢复创建数据代次，旧代次回执明确失效并要求重新核对。

### 5. P1：商品详情加载失败仍可覆盖资料

两引擎注入商品详情 GET 失败后，填写名称保存，真实数据库被默认表单覆盖。位置：[product-edit/index.tsx:54](E:/aoo/warehouse-app/src/pages/product-edit/index.tsx:54)。修复：成功加载前禁止编辑保存并提供重试；失败不能按新增表单处理。

## 订单和结算

| 问题 | 实际结果 | 修复方向 |
| --- | --- | --- |
| 结算撤销死路 | 出库 20 并结清，作废提示先撤销结算；删结算又报余额与账本不一致 | 原子结算冲销，恢复余额、保留历史；[db.js:195](E:/aoo/warehouse-app/backend/db.js:195) |
| 完成订单作废后不能补发 | 发货量为 0，订单仍完成，再发货被拒 | 明确纠错重开流程；[db.js:902](E:/aoo/warehouse-app/backend/db.js:902) |
| 已发 6 件可把订单改为 2 件 | API 与真实 AI execute 均成功 | 数量不得低于有效已发量；[db.js:362](E:/aoo/warehouse-app/backend/db.js:362) |
| 发货后可更换客户 | 前 4 件计 A、后 6 件计 B，同单账务分属两客户 | 已发订单锁定往来对象，换客户拆单/冲销；[db.js:372](E:/aoo/warehouse-app/backend/db.js:372) |
| 零价赠品关联客户/供应商失败 | 零金额或舍入为零报账本不一致 | 统一零金额库存与账本规则；[db.js:224](E:/aoo/warehouse-app/backend/db.js:224)、[db.js:319](E:/aoo/warehouse-app/backend/db.js:319) |
| 带余额客户停用后无收款入口 | 欠款仍计总应收，列表隐藏、AI 找不到客户 | 未结清阻止停用，或提供停用对象结算恢复入口；[db.js:697](E:/aoo/warehouse-app/backend/db.js:697) |
| 数字未来盘点日期被接受 | 提交 30 天后时间戳，库存立即变动却记到未来 | 日期统一转换校验；[db.js:379](E:/aoo/warehouse-app/backend/db.js:379) |

数量/客户修改的普通订单页没有对应表单，范围为 API/AI 工具。不能误写成日常页面任意点击都会发生。

待统一业务语义：无出库流水也能在订单列表手动改“已发货→已完成”。若状态代表仓库履约，应由有效发货量推进；若允许外部历史状态，应明确不改变库存账务。

## 备份恢复

1. 导出成功但不能恢复：配置有效 5 MiB 上限，12000 条无照片商品导出 200、9,170,361 字节；原文件立即恢复 413。无照片时 [ledger-attachments.js:104](E:/aoo/warehouse-app/backend/ledger-attachments.js:104) 跳过体积检查。统一导入导出容量口径，大数据支持流式压缩。
2. 不完整纸板备份被接受：去掉 date 恢复 200，库存页 startsWith 报错。位置：[boards.js:77](E:/aoo/warehouse-app/backend/boards.js:77)、[board-stock/index.tsx:21](E:/aoo/warehouse-app/src/pages/board-stock/index.tsx:21)。导入完整验证必填字段，前端防御异常旧数据。
3. 安全备份失败仍恢复：模拟备份目录写失败，只 warning，仍 200 并覆盖数据。位置：[db.js:110](E:/aoo/warehouse-app/backend/db.js:110)、[db.js:1163](E:/aoo/warehouse-app/backend/db.js:1163)。破坏性恢复必须先成功保留当前快照。
4. 有效跨数据集备份误拒：当前商品 #1 期初 10，另一正常备份 #1 期初 25，无流水；恢复报库存与流水不一致。[db.js:562](E:/aoo/warehouse-app/backend/db.js:562)。完整恢复验证目标快照内部一致性，不能用旧期初约束新数据集。

同数据集正常恢复、损坏库存数量原子拒绝已通过；不能替代上述容量、代次和失败注入测试。

## 打印、图片与纸板界面

- 预印模板漏行：6 条各 10 元只显示前 4 条，合计 60，仍可打印。[dot-matrix-print.ts:227](E:/aoo/warehouse-app/src/utils/dot-matrix-print.ts:227) 容量校验和实际行数不一致。统一容量或分页，核对每行和各页合计。
- 预印 7 条使打印中心消失：渲染直接抛错，无法切换模板。[DotMatrixPrint/index.tsx:64](E:/aoo/warehouse-app/src/components/DotMatrixPrint/index.tsx:64)。改为可恢复错误状态。
- 预印关闭价格仍输出合计数字和大写金额。[dot-matrix-print.ts:238](E:/aoo/warehouse-app/src/utils/dot-matrix-print.ts:238)。统一隐藏明细与合计。
- 纸板标签打印裁掉二维码：手机尺寸正常滚到打印按钮，scrollTop=453，实际 PDF 无二维码；滚回顶部恢复，下载 PNG 可扫码。[BoardUI/style.scss:71](E:/aoo/warehouse-app/src/components/BoardUI/style.scss:71)、[board-detail/index.tsx:39](E:/aoo/warehouse-app/src/pages/board-detail/index.tsx:39)。独立打印节点/iframe 避免父滚动裁剪。
- 纸板金额半分错误：1.005 × 1 存 1.00，主账本为 1.01。[boards.js:16](E:/aoo/warehouse-app/backend/boards.js:16)。统一十进制金额规则。
- 规格预警不能降低关闭：旧阈值 600、新同规格设 0、合计库存 501 仍待补货。[board-stock/index.tsx:16](E:/aoo/warehouse-app/src/pages/board-stock/index.tsx:16) 取历史最大值；应将预警独立存为规格设置。
- 单据标题改不动：自定义输入立即恢复默认。[dot-matrix-print.ts:50](E:/aoo/warehouse-app/src/utils/dot-matrix-print.ts:50) 强制覆盖值。尊重输入或移除无效控件。
- 商品图片不能上传：两引擎选择有效 PNG 后没有上传请求，读取 blob URL 被页面和服务器 CSP 阻止。测试浏览器内改用直接读 Blob 后上传成功。位置：[products/index.tsx:144](E:/aoo/warehouse-app/src/pages/products/index.tsx:144)、[server.js:17](E:/aoo/warehouse-app/backend/server.js:17)、[index.html:13](E:/aoo/warehouse-app/src/index.html:13)。直接读原始 File 与 FileReader，保持必要 CSP。
- 损坏凭证图片被确认保存：35 字节只有 PNG 头的损坏文件上传 200，照片数增加但不能解码。[ledger-attachments.js:11](E:/aoo/warehouse-app/backend/ledger-attachments.js:11) 仅验文件头。保存前验证可解码和像素尺寸。
- 照片详情反复下载全部原图做缩略图：应服务端生成缩略图、原图按需加载。20 张 × 12 MiB 的 base64 约 320 MiB 是上限推算，本轮未做该规模压力测试。

## 免登录与页面入口

- 首次断网后不重连：两个 auth/guest 候选失败后恢复网络，online、可见性变化、刷新按钮未重新申请；整页刷新才恢复。[TeamAccess/index.tsx:15](E:/aoo/warehouse-app/src/components/TeamAccess/index.tsx:15)、[request.ts:302](E:/aoo/warehouse-app/src/services/request.ts:302)。自动重连或移除普通业务对临时 token 的硬依赖。
- 访客过期仍提示重新登录：照片上传 401 后系统会自动重建访客，再点重试可成功，无密码框。将 [request.ts:349](E:/aoo/warehouse-app/src/services/request.ts:349) 改为符合免登录的连接恢复文案并自动续接。
- 首页尺寸本和库存入口：两引擎点击地址改变但仍显示首页，路由未注册；独立尺寸本 HTML 的完整链路正常。[app.config.ts](E:/aoo/warehouse-app/src/app.config.ts)、[home/index.tsx](E:/aoo/warehouse-app/src/pages/home/index.tsx)。修复路由和入口再验真实点击。
- 客户/供应商操作文案为问号：结算真实可执行，但必须按位置/代码识别按钮。[customers/index.tsx:45](E:/aoo/warehouse-app/src/pages/customers/index.tsx:45)。恢复中文名称。
- team 直达页仍有密码/退出登录；AI 接入设置仍要求管理员验证，但登录路径已删除。按免登录需求移除无效入口，模型密钥可采用服务器配置或专门本机设置；不能简单放开服务端配置权限。

## 改进顺序和验证原则

先修重复写入、旧表单覆盖、恢复代次、打印漏行；再修结算冲销、订单约束、备份失败保护；之后处理入口、图片、提示和预警。

已有套件通过不代表业务边界通过。部分测试仅匹配源码字符串，例如请求重试测试检查存在提交编号和回执函数，却没模拟已提交后响应体断开。补实际行为测试：匿名身份跨重启、清点期间领料、恢复跨数据集与代次、打印行完整性、真实 CSP 下上传文件。

性能优化：订单列表避免逐单读状态历史，长流水分页，明确刷新绕过旧库存缓存，数据增长时避免全 JSON 同步重写。应以相同数据量前后测量，构建体积不等于真实网速耗时。

## 范围与清理

未做线上发布/恢复，未连接实体打印机、手机相机/Bluetooth 或实际付费 AI。WebKit 与模拟原生入口不能替代 iOS 真机。纸板 PDF 已实际输出渲染，其他打印验证预览和调用。

所有本轮本地 HTTP 服务和测试浏览器已关闭；最终进程检查未发现本轮 Node 测试服务。业务源码的已有改动状态与本轮开始时一致，隔离 backend 副本与源文件哈希一致。

已确认删除的临时目录：release/deep-board-ui-20261008-b12f、release/deep-checks-20261008-2d71。

其余删除操作被自动审批策略拒绝，返回 blocked by policy，没有更详细原因。根代理也对已核验精确范围、无链接、无运行测试进程的主临时目录执行了 PowerShell Remove-Item，仍在执行前被拒绝；没有绕过。以下 5 个目录仍存在，共 599 个文件、23,388,089 字节（约 22.3 MiB）：

- [主测试产物](E:/aoo/warehouse-app/release/deep-e2e-20261008-84c2)：303 文件。
- [业务生命周期测试](E:/aoo/warehouse-app/release/deep-business-20261008-7bc3)：75 文件。
- [备份与纸板测试](E:/aoo/warehouse-app/release/deep-backup-boards-20261008-b71d)：83 文件。
- [匿名重试与打印测试](E:/aoo/warehouse-app/release/deep-guest-print-20261008-c47e)：16 文件。
- [照片测试](E:/aoo/warehouse-app/release/deep-photo-ui-20261008-f84d)：122 文件。

上述为本轮隔离的模拟业务数据、源副本、截图、脚本和构建产物。此报告已独立保存在 docs，可在工具允许时删除上述精确目录。原有任务文件、前两轮报告与业务数据不在此次删除范围。不能将当前清理状态描述成“全部已删除”。
