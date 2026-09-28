# 阶段 0：现状核查与数据保护

日期：2026-09-25。实际服务器业务 API 逻辑快照与隔离恢复已完成；服务器原文件完整归档尚未取得。按用户最新指令已开始阶段 1 独立样稿，不进入数据迁移。

## 真实快照证据

- 来源：http://152.136.100.200，采集前后 revision 均为 4。
- 保存目录：E:/aoo/warehouse-app/release/stage0/server-2026-09-25T06-47-23-401Z。
- suppliers=1；products/customers/transactions/orders/ledger/stocktakes/delivery_notes/order_events 均为 0。
- products/customers/suppliers/transactions/orders/ledger/stocktakes/delivery-notes/stats/sync 均 HTTP 200。订单为空，没有逐单 events 请求。
- GET /api/audit 返回 403，未绕过权限、未改变服务器鉴权。
- 商品图片引用和下载图片数均为 0，不代表服务器没有孤儿图片。
- responses/ 保存成功接口原始响应；coverage.json 为接口覆盖；report.json 为恢复结果。
- snapshot/manifest.json 保存文件清单、字节数、SHA-256；inventory.json 覆盖响应、来源及恢复结果等 17 个文件，再次离线验证全部通过。
- 逻辑 data.json 为 634 字节，SHA-256：2ee926574224860bc95e0e79fb9d27222fdf04c61a96053dcdab777257fbc4e4。
- restored/data.json 与逻辑导出深比较通过；恢复到已有目录被拒绝；损坏副本被拒绝。corruption-test 是故意破坏的测试副本，未纳入正常清单。

## 临时脚本

E:/aoo/warehouse-app/release/stage0/server-snapshot.cjs 是本次唯一新增的游客调用脚本，已验证被 Git 忽略。静默无交互运行，凭据只在进程内存中，不保存到备份。正式代码没有加入游客调用。

再次采集可运行 node release/stage0/server-snapshot.cjs；每次创建独立时间目录，文件以 wx 排他写入。本次已经保存实际证据，无需重复访问服务器。脚本只能下载 API 引用图片，不能枚举服务器文件目录。

通用快照脚本 scripts/stage0-snapshot.cjs 不依赖鉴权；支持 capture DATA_JSON NEW_DIR UPLOADS_DIR、verify SNAPSHOT、restore SNAPSHOT NEW_DIR。通用快照单测 2/2 通过。

## 未覆盖范围与迁移门槛

这是实际服务器可读业务集合的逻辑备份，不是原 data.json 的逐字节副本，也没有证明旧后端能直接以逻辑文件启动。禁止据此覆盖生产文件。

未取得 GET /api/audit 权限、原 _meta 计数器、_collaboration 的审计/幂等收据、未知顶层字段、未引用图片。破坏性迁移前需通过 OrcaTerm 获取 WAREHOUSE_DATA_FILE 指向文件（未设置则 backend/data.json）与 backend/public/uploads/products 完整目录的一致归档。无需为备份添加登录或修改权限。

取得原始归档后先原字节 capture、verify、restore 到全新隔离目录，再隔离启动校验业务汇总。快照和临时脚本禁止进入 Git/CI 产物。

## 保留的现状基线

- HEAD：657a4d9a81fe60964f421cfc14e23e5208ac4a41；未提交、推送或部署。
- 保留原有修改：build.log、deploy/hotupdate 两个产物、package.json/lock、src/components/TeamAccess/index.tsx、tests/team-browser.cjs，以及 walkthrough-shots 目录和 ZIP。
- Node 24.19.0/npm 11.17.0；依赖清单已核对，未验证全新锁文件安装。
- 原后端测试通过；H5 构建通过（5779ms、入口 441KiB、2 个体积警告）。
- 原导航 Chromium/WebKit 通过，仍沿用旧鉴权及 50px 边缘断言。
- 下载测试 2 失败/2 跳过，备用 IPA 路径不一致；已有 TypeScript 诊断 43 个。
- 隔离旧应用 16 路由×390/1280px 共 32 图；首页有共享会话竞态错误，桌面未限制居中宽度。旧页面尚未逐图完成目视审核。
- 旧原生布局让 Web 内容止于底栏之上，不具备背景内容经过玻璃的条件。
- 日志和诊断报告位于 release/stage0；旧发布工作流含发布和上传行为，不用于本次原型。

## 阶段边界

用户授权实际快照演练后进入阶段 1：Token、四页 H5、P0 独立原生底栏。确认前不铺开业务、不集成、不推送或部署。最终重写彻底删除登录、鉴权及游客界面与流程；后端透明本地身份，保留 revision、幂等与操作记录。
