# 每日服务器备份

## 日常使用

- 业务提交成功后仍按现有流程保存到服务器，不需要等到每天备份时才保存。
- API 服务额外在北京时间每天 02:00 留存一份快照，手机和电脑不必保持打开。
- 默认保留最近 30 份通过校验的每日副本；失败后约 15 分钟重试。
- 在现有“备份与恢复”页面查看最近成功时间、下次计划、失败原因，并下载最近可用副本。首页不新增备份入口。
- 状态来自服务器实时接口。页面显示“未连接”“定时任务未运行”或“未启用”时，不表示已正常备份。

这是同一台业务服务器上的备份，不是上传到另一台服务器或对象存储。服务器整盘丢失时，同机副本也可能丢失。当前没有配置异地备份目的地。

## 包含内容

快照包含数据库中的纸板批次与尺寸、纸箱及规格、生产记录、客户和供应商、客户尺寸本、库存、订单、账本、送货和打印单据、盘点等数据，并携带关联的票据照片原件和商品图片原件。实际存在的字段随当前数据库完整导出，不从界面演示数据生成。

缺失或损坏的原图、超出容量或校验不通过时，不会生成声称完整的新备份，也不会覆盖已有的每日文件。没有原图字段的旧版商品备份仍可按旧格式恢复，但旧文件本身不会凭空补出原图。

## 服务器配置

配置使用现有 API 服务的环境变量，修改后由既有服务管理器重启生效：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WAREHOUSE_DAILY_BACKUP_ENABLED` | 启用 | 仅设置为字符串 `false` 时关闭 |
| `WAREHOUSE_DAILY_BACKUP_HOUR` | `2` | 北京时间整点，范围 0–23 |
| `WAREHOUSE_DAILY_BACKUP_KEEP` | `30` | 保留已校验的每日副本数量，范围 1–365 |
| `WAREHOUSE_DAILY_BACKUP_DIR` | 备份根目录下的 `daily` | 每日副本所在目录 |
| `WAREHOUSE_BACKUP_DIR` | 数据库目录下的 `backups` | 启动保护、恢复保护及每日目录的默认根目录 |
| `WAREHOUSE_DATA_FILE` | `backend/data.json` | 现有业务数据库路径 |
| `WAREHOUSE_PRODUCT_IMAGE_DIR` | `backend/public/uploads/products` | 商品图片原件目录；使用自定义目录时由同一服务提供图片访问 |
| `WAREHOUSE_BACKUP_MAX_MB` | `64` | 未压缩 JSON 大小上限（MiB），允许 5–256；恢复接口也沿用此限制 |

备份目录须在公开网页目录之外，并允许 API 服务账号读写。应将自定义公开网页根目录配置为 `WAREHOUSE_WEB_ROOT`，以便目录检查。不要给备份目录配置 Nginx 静态公开访问。

## 调度和校验

- 时区固定为北京时间，不依赖操作系统时区。服务每分钟检查到期任务，执行时间允许有约一分钟偏差。
- 服务启动时会检查最近到期的计划；停机多日后只补一份当前数据，不伪造停机期间各天的历史状态。凌晨 02:00 前启动时，最近到期计划属于前一天，文件中的 `exportedAt` 仍是实际生成时间。
- 文件名为 `daily-YYYY-MM-DD.json.gz`，日期表示计划归属日，不一定等于实际生成日期。
- 快照先完整写入临时文件并同步，再以不覆盖已有文件的方式发布；同一天已有有效快照时不会重新导出业务数据或改写该文件。
- 下载和检查使用 gzip、SHA-256、日期、数据版本、业务关联及原图校验。`status.json` 只是尝试与重试记录，不能单独证明成功。
- 保留份数只计算有效、已到期的快照。损坏或未来日期文件保留供排查，不占有效副本名额，所以目录中的总文件数可能超过配置份数。
- 服务启动时的自动保护副本和恢复前保护副本也包含两类原图。恢复前保护失败时中止恢复。无法完整打包的原数据仅保留为文件名带 `-incomplete` 的排查证据，不宣称可直接恢复，也不会被当作成功的恢复前保护。

## 下载与恢复

1. 打开“备份与恢复”，确认最近副本已通过校验。
2. 点击“下载最近备份”，保存得到的 JSON 文件。手机是否能直接保存取决于系统文件分享支持；不支持时在浏览器下载。
3. 在同页选择 JSON 恢复并确认覆盖。后台会先保存当前数据的完整保护副本，再验证和恢复内容。

服务器上的 `.json.gz` 是内部容器，不直接交给页面的 JSON 恢复按钮。下载接口会转换为现有页面支持的 `{ exportedAt, data }` JSON 格式；当前“导出备份 JSON”功能仍保留。

两个新增接口为 `GET /api/backup/daily/status` 和 `GET /api/backup/daily/latest`，均需要当前仓库有效访客会话，下载沿用现有导出限流。该会话不是管理员账号，也不提供按用户划分的权限控制。

## 验证与发布

本地验证不会表示服务器已经启用。当前源码须完成测试、提交并集成到 `main`，按 `.github/workflows/publish-hotupdate.yml` 发布前端；禁止上传修改过的旧包、直接覆盖线上 `www.zip` / `manifest.json` 或使用临时部署脚本。

该工作流同时运行后端测试和构建后的备份页面浏览器验收，但它不复制 `backend/` 源码，也不重启服务进程。后端必须按实际部署流程同步源码并重启，重新加载 `server.js`、`team.js`、`db.js`、`daily-backup.js` 等依赖；仅发布前端时，每日接口可能仍是旧版本或 `404`，页面会退回现有手动导出。

后端使用独立发布包，不能把本地 `data.json`、票据照片、商品图片、`.env` 或开发依赖一起上传。先在已提交的源码上生成并校验，再在临时目录实际启动：

```powershell
$env:RELEASE_COMMIT = (git rev-parse HEAD)
npm.cmd run release:backend:bundle --silent | Set-Content -Encoding utf8 release/backend-bundle.json
npm.cmd run release:backend:verify -- release/backend-bundle.json $env:RELEASE_COMMIT
npm.cmd run release:backend:preflight
```

`release/backend-bundle.json` 只包含后端源码、锁文件和生产依赖内容，不包含业务数据。发布包里的每个文件都有 SHA-256；脚本会核验提交、依赖闭包和内容完整性，并在隔离目录真实启动服务后才允许上传。

## 后端发布与回滚

先上传发布包、发布器和校验脚本到服务器私有临时目录。以下三条命令须在同一目录执行；发布器会再次校验包内容并在隔离目录启动。

```bash
ssh 用户名@152.136.100.200 'mkdir -p /tmp/shuguang-backend-release'
scp release/backend-bundle.json scripts/publish-backend.py scripts/verify-backend-release.js 用户名@152.136.100.200:/tmp/shuguang-backend-release/
```

以能使用 `systemctl` 的发布账号执行：

```bash
cd /tmp/shuguang-backend-release
sudo python3 /tmp/shuguang-backend-release/publish-backend.py /tmp/shuguang-backend-release/backend-bundle.json \
  /opt/shuguang/backups/backend-release /tmp/backend-release-acceptance.json --restart
```

脚本会读取实际的 `shuguang.service` 工作目录和账号，拒绝根账号服务、未知目录和不安全路径；发布前保存被替换文件，发布后重启并实际请求 `/api/backup/daily/status`。服务未启动、接口失败或返回契约不符时，自动恢复旧文件并再次重启。验收失败时不得手动宣称已上线。

如果发布账号与服务账号不同，应让服务账号对工作目录及其依赖目录可读写，并给发布账号单独的 `sudo -n systemctl restart shuguang.service` 权限。不要把密码、令牌或数据库内容写入脚本和日志。发布完成后核对：

```bash
systemctl show shuguang.service --property=User --property=WorkingDirectory --no-pager
systemctl is-active shuguang.service
curl -fsS https://youxishen.online/api/backup/daily/status
```

最后一个请求在未登录时返回 `401` 也表示路由已加载；随后通过正常访客会话查看状态。接口 `404` 表示后端仍是旧版本。`--restart` 仅在需要重新加载后端文件时使用；文件完全一致时脚本只做只读接口验收，不重启服务。

上线验收须同时核对发布 manifest 的实际提交、后端实际运行版本、备份页面的真实服务器状态、服务器实际生成的快照，以及下载 JSON 在隔离数据库中的恢复结果。前端 manifest 正确只证明前端来源，仅前端热更新不能证明新版后端调度已经运行。
