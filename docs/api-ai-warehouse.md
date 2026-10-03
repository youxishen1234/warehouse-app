# 仓库 AI 助手

AI 助手支持仓库业务查询、资料管理、商品入库/出库、订单、送货单、纸板批次、盘点、账目和打印。首页入口进入助手后，可在“可用功能”查看完整功能目录，也可以用自然语言描述操作。新增业务应登记在 `backend/ai-tools.js`：模型函数、参数校验、可编辑表单和执行接口共用这份目录。

普通商品送货单可拍照识别多行商品、计划数量、实收数量、单价等；纸板板厂送货单单独识别纸板尺寸、实收张数和计费平米。照片只生成待核对草稿。商品/往来方会在后端匹配现有资料；同名或未匹配时，助手显示候选给用户选择。只有用户核对并按“确认提交”后才会写入库存和账目。

AI Key 只存在服务端。模型只能解析已登记的工具参数；库存、单位、余额、版本和权限规则仍由仓库后端检查。打印接口生成单据 HTML，实际打印需要前端设备支持。

## 接口

| 方法与地址 | 用途 |
| --- | --- |
| `GET /api/ai/status` | 检查模型配置状态，不返回 Key |
| `GET /api/ai/tools` | 返回可用工具、参数 Schema、功能目录和执行约定 |
| `POST /api/ai/command` | 解析自然语言/图片，返回查询结果、追问或待确认草稿；不写业务数据 |
| `POST /api/ai/photo` | 专用照片接口：接收 1–3 张图片，可附文字和上下文，返回可核对草稿 |
| `POST /api/ai/voice` | 专用语音接口：本机转写录音后交给所选 AI 模型解析，返回识别文字和业务草稿 |
| `POST /api/ai/prepare` | 校验或修订草稿；请求为 `{ "intent": { "action": "...", "parameters": {} } }` |
| `POST /api/ai/execute` | 执行已确认操作，或生成打印预览 |

`/api/ai/tools` 同时包含兼容旧版的顶层 `stock_in`、`stock_out`、`print` 工具，以及登记目录中的扩展工具。扩展工具统一用 `{ "action": "receipt_in", "parameters": { ... } }` 一类请求结构。`read`、`navigate` 和 `print` 是只读模式；写入模式沿用仓库 API 的条件版本、幂等回执、审计和原子事务。

扩展目录覆盖：业务列表和统计查询；新增/修改/停用商品、客户、供应商；多商品出库、订单创建/修改/出库；多行送货入库单；纸板批次入库、领料、盘点、修改和删除；库存盘点；收入/支出和往来结算；作废流水、送货单和手工账目；送货单、订单及纸板批次打印；打开系统其他功能页面。实际工具名和字段以运行中的 `GET /api/ai/tools` 响应为准。

## 配置模型

服务端启动环境需要设置以下变量。应用不会自动读取项目根目录 `.env` 文件。

| 环境变量 | 说明 |
| --- | --- |
| `WAREHOUSE_AI_BASE_URL` | 模型接口根地址，服务端会追加 `/chat/completions` |
| `WAREHOUSE_AI_API_KEY` | 服务端模型 API Key |
| `WAREHOUSE_AI_MODEL` | 已开通、支持工具调用的模型 ID |
| `WAREHOUSE_AI_REASONING_EFFORT` | 可选；仅在供应商支持该字段时设置 |
| `WAREHOUSE_AI_RATE_LIMIT` | 每个来源 IP 每分钟解析次数，默认 20，上限 1000 |

前三项全部为空时，启用范围有限的基础规则模式；只设置了其中一部分会显示配置错误。基础模式支持少量明确指令和查询，不支持拍照。照片识别需要同时配置能接收图片输入的模型；兼容工具调用并不代表一定兼容图片输入，应使用供应商提供的视觉模型并实际联测。

生产服务器可用 systemd 私有环境文件保存密钥。首次设置时先创建权限受限的文件：

```bash
sudo install -m 600 /dev/null /etc/shuguang-ai.env
sudoedit /etc/shuguang-ai.env
```

在文件内填入服务端变量，例如：

```text
WAREHOUSE_AI_BASE_URL=https://模型服务商提供的接口根地址
WAREHOUSE_AI_API_KEY=替换为真实密钥
WAREHOUSE_AI_MODEL=替换为账号可用模型
WAREHOUSE_AI_RATE_LIMIT=20
```

然后运行 `sudo systemctl edit shuguang.service`，在 drop-in 中加入：

```ini
[Service]
EnvironmentFile=/etc/shuguang-ai.env
```

保存后运行 `sudo systemctl daemon-reload` 并重启服务。若 unit 已使用 `EnvironmentFile`，应将变量加到它现有的安全配置文件中，避免覆盖原服务设置。不要把密钥写入前端、仓库提交、构建产物或部署日志。

## 照片识别

助手可以在手机拍照或选择照片，最多附 3 张。前端会压缩图片；服务端只接受 JPEG、PNG、WebP，每张解码后不超过 2 MiB。上传照片会发送到所配置的模型服务进行识别。模型返回的信息只进入可编辑表单，日期、名称、规格、计划数量、实收数量、单价、供应商/板厂和计费平米都应对照原单检查。模糊内容留空，不要把推测值当成已确认数据。

普通商品的多行送货单使用 `receipt_in`，需要选定供应商、日期和至少一行商品明细。`quantity` 表示计划数量，`delivered_qty` 表示实际入库数量。纸板批次单使用 `board_receive`：实际库存以 `receivedQty`（实收张数）记账，计价以 `billedArea`（计费平米）乘 `unitPrice` 计算；两者不可互换。商品和板厂名称必须与现有资料匹配，AI 不会替用户创建缺失商品。

若模型将多行单据字段错误地放进单商品工具，服务端会在同一响应时限内要求模型重新解析一次；仍不符合参数规则则返回错误。不会删除单据行或绕过校验来强行提交。

## 语音和照片发送接口

两个接口均使用 JSON 和现有会话 `Authorization: Bearer <token>`；模型密钥只保留在服务器。示例中的 Base64 需替换为文件内容，不能传文件路径或下载链接。

```http
POST /api/ai/photo
Content-Type: application/json
Authorization: Bearer <仓库会话令牌>

{"images":["data:image/jpeg;base64,<图片Base64>"],"message":"请帮我整理这张入库单"}
```

`images` 必填，1–3 张，每张解码后最多 2 MiB，支持 JPEG/PNG/WebP。`message` 可省略，默认识别入库单；`context` 可选，为上一条草稿的 `intent`。JSON 请求上限 9 MiB。

```http
POST /api/ai/voice
Content-Type: application/json
Authorization: Bearer <仓库会话令牌>

{"audio":"data:audio/mp4;base64,<录音Base64>"}
```

`audio` 必填，每条最多 60 秒、6 MiB，支持 WAV/MP3/M4A/AAC/OGG/WebM。时长由服务器解码检查。可选 `message` 为文字补充说明，可选 `context` 为上一条 `intent`，也可同时提供 `images`。组合请求的 JSON 上限为 17 MiB。成功响应除普通草稿字段外，还含 `transcript`（实际识别文字）、`durationSeconds`、`input_type: "voice"`；照片响应含 `input_type: "photo"`。语音和照片都只准备草稿，修改库存仍须走原确认提交接口。

UI 提供“发语音 → 开始录音/上传语音 → 发送语音”，录音最多 60 秒，发送前可播放、移除、重录。麦克风仅在点开始录音后使用；取消、离开页面或切到后台会停止录音。旧 iOS 安装包未声明录音能力时使用“上传语音”，避免触发缺失原生权限的录音调用。iOS 的麦克风用途声明和 Android 的 RECORD_AUDIO 权限需包含在原生安装包中，热更新不能补充原生权限。照片提供拍摄和上传入口，选好后点“发送照片”。

语音转写使用服务端本机 SenseVoice CPU 模型，不要求所选对话模型原生支持音频。转写后的文字仍交给已配置的 `deepseek-v4-flash` 等模型解析；原始录音不持久保存。服务器一次只识别一条语音，忙时返回 429，每个来源 IP 每分钟最多 6 条语音，且与文本/照片共享模型请求次数限制。

Linux 部署先准备 `python3-venv` 和 `ffmpeg`，再以仓库服务账号运行 `python3 scripts/setup-ai-speech.py --root /opt/shuguang`。安装目录为 `runtime/speech`，可通过 `WAREHOUSE_AI_SPEECH_DIR` 和 `WAREHOUSE_AI_SPEECH_PYTHON` 指定目录及 Python。发布时还需部署 `ai-speech.js`、`ai-speech-worker.py`、更新 `ai.js` 和各媒体路由的 JSON 大小限制；反向代理对 `/api/ai/photo` 和 `/api/ai/voice` 的请求限制不得低于上述 JSON 上限，语音代理读取超时建议 120 秒。`GET /api/ai/status` 的 `voice.available` 表示本机语音依赖文件已就绪，真实识别仍需用录音联测。

## 解析、确认与提交

解析示例：

```http
POST /api/ai/command
Content-Type: application/json
X-Warehouse-Device: warehouse-chat

{"message":"请帮我把商品1入库20张"}
```

`status` 可能为：`needs_input`（需要补资料或选候选）、`ready`（写入草稿待确认）、`result`（查询结果）、`navigate`（可打开页面）或 `unsupported`。缺少业务字段不会自动猜测或写入。后续对话可以把上一响应的 `intent` 作为 `context` 继续补充。

写入前，前端将计划展示给用户，并允许再次编辑。确认后把计划中的 `command` 发送到执行接口。写操作需要 `Idempotency-Key`（16–100 个字母、数字、下划线或短横线）和从计划读取的 `If-Match: <revision>`：

```http
POST /api/ai/execute
Content-Type: application/json
X-Warehouse-Device: warehouse-chat
Idempotency-Key: ai-unique-request-0001
If-Match: 12

{"action":"receipt_in","parameters":{"supplier_id":2,"date":"2026-09-30","lines":[{"product_id":1,"quantity":20,"delivered_qty":19,"unit_price":2.5}]}}
```

同一请求超时后重试必须复用原请求体、提交编号和身份，不要生成新编号，否则可能重复入库。`409` 表示资料版本已变化或提交编号冲突：刷新资料、重新核对再创建新计划。删除、作废、结算等影响业务的操作也需用户在表单确认后提交。

打印使用已解析的明确单据编号。执行返回 `print_ready` 和 HTML 文档；客户端再打开预览并调用浏览器或设备打印能力。不能仅凭生成了 HTML 就提示用户“打印机已打印”。

## 上线与检查

代码已将助手页面注册在首页可用入口，并提供 `/api/ai/*` 接口。新页面代码本身不代表线上已更新，也不代表线上已有模型凭证。H5 热更新工作流会构建和发布前端页面；已安装 App 需成功获取该更新，或安装包含新页面的版本。当前仓库的前端热更新和 iOS/Android 构建工作流不部署 `backend/server.js` 等服务端源代码，也不配置模型变量。服务器部署需同步本次后端文件并重启 `shuguang.service`；仓库现有 `deploy.ps1` / `deploy.sh` 是旧的纸板页面专用脚本，不包含 AI 后端发布步骤，不能用它们来判断或完成 AI 上线。

部署前在项目根目录执行：

```powershell
npm run typecheck
npm run test:backend
npm run build:h5
```

服务重启后检查：

```bash
sudo systemctl is-active shuguang.service
curl -fsS https://你的域名/api/health
curl -fsS https://你的域名/api/ai/status
curl -fsS https://你的域名/api/ai/tools
```

`/api/ai/status` 应按实际配置显示 `model` 或 `rules`；目录应包含 `receipt_in`、`board_receive` 等工具。上线后先做查询与拍单识别，再用测试商品/供应商完成一笔小额、可核销入库，检查送货单、库存、应付和打印预览。真实模型联测必须使用服务端实际凭证；本地模拟测试不证明线上模型账号支持视觉输入。

错误响应使用 `{ "success": false, "message": "中文提示" }`。常见状态码：`400` 参数或业务规则错误，`404` 记录不存在，`409` 版本/幂等冲突，`429` 解析频率超限，`502` 上游错误，`503` 模型配置无效或拍照时未配置视觉模型，`504` 上游超时。
# 2026-10-03 接入设置

App 的首页和「我的」均保留 AI 助手入口。在助手中打开「接入设置」，使用现有仓库管理员账号验证身份，填写支持 Chat Completions 工具调用的服务地址、模型名称和 API Key，点击「检测并保存」。识别照片还要求模型支持图片输入。

保存接口会先用固定的「查询库存」指令检验模型工具调用，不读取或修改仓库业务数据；检测失败保留原配置。密钥只写入服务器 `runtime/ai-connection.json`，不返回客户端、不写浏览器缓存。更换服务地址时必须重新填写密钥，避免将原密钥发送给不同服务。未保存配置时仍兼容 `WAREHOUSE_AI_BASE_URL`、`WAREHOUSE_AI_MODEL`、`WAREHOUSE_AI_API_KEY` 环境变量。

- `GET /api/ai/config`：管理员读取地址、模型、是否已保存密钥。
- `POST /api/ai/config/test`：管理员测试待保存的 `{ baseUrl, model, apiKey }`。
- `PUT /api/ai/config`：管理员检测通过后保存配置并立即生效，无需重启服务。
- `POST /api/ai/connection-test`：已登录仓库用户检测当前模型，按用户限流。
- `GET /api/ai/status`：显示模型配置状态。`mode=model` 表示已配置，实际连接是否成功以检测结果为准。

发布前执行 `node scripts/verify-ai-bundle.cjs <构建目录>`，再执行浏览器回归 `AI_WEB_DIR=<构建目录> node tests/ai-assistant-browser.cjs`。自动热更新流程现在检查 AI 路由、页面及接入设置是否随包发布，并保留打包脚本生成的 SHA-256 清单。前端变更可通过已有热更新通道下发，不应仅凭原生 Build 635 判断必须重装。

## 语音/照片发布验证

热更新版本 `20261003164030` 已发布，助手底部标记为“界面 10.04”，所用对话模型保持 `deepseek-v4-flash`。HTTPS 与备用 HTTP 地址的清单、更新检查和更新包 SHA-256 均已核对。

线上 Chromium 390px 与 WebKit 320px 实测通过：分别发送约 3 MB WAV 和 M4A，识别为“请帮我查询库存。”并得到查询结果；上传合成两行入库单照片，保留计划 9、实收 7、单价 1.35 等字段。测试只生成草稿，未提交业务数据。36 项 AI 后端测试通过，前端的录音、权限拒绝、取消、旧 iOS 保护已有本地浏览器回归。

此次发布为服务端与网页热更新，未发布新的 iOS/Android 安装包，也未在用户的 Build 635 真机验证麦克风录制。没有原生录音权限的旧安装包仍使用“发语音 → 上传语音”。
