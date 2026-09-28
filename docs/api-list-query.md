# 列表排序与订单状态查询

更新：2026-09-27。对应优化清单 291、294；HTTP 回归见 `backend/list-query.test.cjs`，客户端契约见 `tests/api-query.test.cjs`。

## 兼容约定

- 未传 `sort`／`order` 时沿用原列表顺序；未传 `page`／`page_size` 时仍返回 `{ success: true, data: [...] }`。
- 可选 `sort` 指定当前资源的允许字段；`order` 仅接受 `asc`／`desc`。只传 `sort` 时按降序；只传 `order` 时，商品／客户／供应商用 `profile_updated_at`，其他资源用 `created_at`。
- 字符串按中文本地化比较；数字按数值比较。同值用 `id` 按同方向排序，保证连续翻页稳定。可选字段缺失时置后，旧数据的资料更新时间回退到 `updated_at`／`created_at`。
- 先筛选，再排序，最后分页。排序仅操作返回列表，不改变数据文件或 revision。
- `sort`／`order` 的空字符串、重复参数、嵌套对象、未在白名单中的字段和方向都返回 `400` 与中文 JSON。非法字段／方向提示允许值。

## 允许排序的字段

准确白名单来自 `backend/list-sort.js` 的 `SORT_FIELDS`；`src/services/api.ts` 以 type-only 导入获得相同的字段联合类型，该后端文件不会进入前端运行时。

| GET 路径 | 允许字段 |
| --- | --- |
| `/api/products` | id、name、specification、material、unit、price、stock、safety_stock、created_at、profile_updated_at、stock_updated_at |
| `/api/customers` | id、name、contact、phone、debt、created_at、profile_updated_at、balance_updated_at |
| `/api/suppliers` | id、name、contact、phone、payable、created_at、profile_updated_at、balance_updated_at |
| `/api/orders` | id、order_no、customer_name、quantity、unit_price、amount、status、delivery_date、created_at |
| `/api/transactions` | id、created_at、type、quantity、unit_price、amount、product_name、customer_name、supplier_name |
| `/api/ledger` | id、created_at、type、amount、party_name |
| `/api/stocktakes` | id、created_at、counted_at、before_stock、counted_stock、diff |
| `/api/delivery-notes` | id、created_at、date、work_order_no、freight、total_amount、total_square_meters |
| `/api/orders/:id/events` | id、created_at、from、to |

## 状态和类型

`GET /api/orders` 接受可选 `status`：`待生产`、`生产中`、`已发货`、`已完成`、`已取消`。未传则返回全部状态；空字符串不是“全部”，应省略参数。重复参数、嵌套对象及非法值返回 `400`，非法状态提示五个允许值。状态筛选先于分页，`total` 反映筛选后的条数。

订单新增／修改的状态校验共享同一白名单，原状态流转与终态限制继续生效。其他列表不接受 `status`。

流水 `type`：`in`、`out`、`adjustment`；账本 `type`：`income`、`expense`、`receivable`、`payable`、`settlement`。其他列表不接受 `type`；非法枚举继续返回 `400` 与允许值。

示例：`GET /api/orders?status=%E7%94%9F%E4%BA%A7%E4%B8%AD&sort=amount&order=desc&page=1&page_size=20`。

## 导出一致性

`GET /api/export/transactions.csv` 和 `GET /api/export/ledger.csv` 复用对应列表的筛选验证与排序白名单，导出顺序与列表一致。即使传了合法的 `page`／`page_size`，仍导出全部筛选结果，避免把分页误用为导出截断。UTF-8 BOM、字段顺序、转义与下载鉴权约定保持不变。
筛选结果为空时返回中文 `404` JSON（分别提示没有符合条件的流水或账本流水），不会下载只有表头的空文件。

## 日期范围

`from` 与 `to` 同时接受毫秒时间戳和本地日历日期 `YYYY-MM-DD`，两种格式可以混用。 `from` 从当天本地 00:00:00.000 开始，`to` 包含当天直到 23:59:59.999；倒置范围、无效日历日期、斜杠日期、浮点或文本值返回中文 `400`。未传日期时不增加过滤。

例如 `from=2026-09-27&to=2026-09-27` 等价于当天本地起止毫秒范围；现有前端传入的毫秒时间戳继续有效。
