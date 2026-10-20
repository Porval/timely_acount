# 手工订单、手动付款与管理端审核接口

订单功能合并在 extrasAccount，继续使用同一登录身份和 SQLite 数据库。extrasWeb 是发起方页面，已有管理端由它自己的服务器调用下列管理接口；本项目不建设管理端页面，也不提供线上支付。

业务流程：手工建单 → 提交手动付款信息 → 管理端确认收款 → 管理端审核 → 本后台调用履约接口建单 → Web 查看履约。

`order.id` 是本项目结算订单 ID，`referenceId` 是选填的外部订单号（省略或空字符串表示未填写），`external.timelyOrderId` 是审核通过后关联的履约订单 ID。所有本项目 API 金额均为整数分，时间均为 Unix 毫秒。

## 发起方接口

使用现有 HttpOnly `account_session` Cookie。身份由后台读取，请求里不能指定创建人或订单归属。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/order-options` | 城市、品牌、平台；`demo:true` 表示测试目录 |
| POST | `/api/orders` | 手工创建；必须带唯一 `Idempotency-Key` 请求头 |
| GET | `/api/orders` | 当前账号订单；支持 page/pageSize/date/contacts/reference/item/stage |
| GET | `/api/orders/:id` | 当前账号订单详情及最新履约情况 |
| POST | `/api/orders/:id/manual-payment` | 提交手动付款信息；不代表确认收款 |

建单示例，`Idempotency-Key` 建议为 UUID；网络重试必须使用相同编号和内容：

```json
{
  "cityId": "实际城市ID", "cityName": "上海",
  "brandId": "实际品牌ID", "brandName": "实际品牌",
  "plateId": "实际平台ID", "platformName": "美团",
  "items": [{ "itemName": "商品", "spec": "500g", "salesPrice": 1234, "quantity": 2 }],
  "contacts": "收件人、手机号和完整地址", "messages": "配送备注",
  "referenceId": "外部订单号（选填）", "payPrice": 2468, "arrivedTime": 30
}
```

返回 `{ "order": {...}, "created": true }`；同一建单请求重试返回同一订单及 `created:false`。填写外部订单号时，同一个账号不能重复创建相同编号；未填写时可创建多笔订单。履约系统需要关联编号时，后台使用本项目订单 ID，不会伪造用户的外部订单号。

提交手动付款信息：

```json
{ "reference": "银行或支付平台流水号", "description": "手动付款说明" }
```

订单变为 `payment.status=submitted`，页面显示待收款确认。只有管理端可以确认收款和审核。

## 管理端接口

服务端请求头：

```http
Authorization: Bearer <ORDER_MANAGEMENT_TOKEN>
Content-Type: application/json
```

专用密钥已保存在后台未提交的 `.env`。管理端服务器配置相同值；密钥不能放在浏览器、VITE_* 或源代码中。正式环境使用 HTTPS。未配置密钥返回 503，错误密钥返回 401。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/order-management/orders` | 管理端查询订单；支持 `reviewStatus=pending` 与分页 |
| GET | `/api/order-management/orders/:id` | 查询订单、付款信息和审核状态 |
| POST | `/api/order-management/orders/:id/receipt` | 确认实际收款 |
| POST | `/api/order-management/orders/:id/review` | 审核结果；通过后后台自动发起履约建单 |
| POST | `/api/order-management/orders/:id/fulfillment` | 写入关联履约订单的状态 |
| POST | `/api/order-management/orders/:id/link` | 建单结果未确认时，人工核对已有履约订单后关联，避免重复创建 |

`eventId` 是管理端的唯一事件编号。同一事件重发相同内容返回 `replayed:true`；同编号不同内容返回 409。事件和订单状态在同一数据库事务中保存。

### 1. 确认实际收款

```json
{ "eventId": "receipt-20261008-001", "transactionId": "实际收款流水号", "amount": 2468, "collectedAt": 1791460800000 }
```

金额必须等于订单应付金额，同一收款流水不能用于两个订单。收款后页面显示已收款待审核，此时不调用履约建单接口。

### 2. 审核

```json
{ "eventId": "review-20261008-001", "status": "approved", "reviewerName": "审核人员", "reviewedAt": 1791460860000, "reason": "核实到账" }
```

`status` 为 `approved` 或 `rejected`。拒绝必须填写原因，审核时间不能早于收款时间。审核结果不能直接覆盖。拒绝不会创建履约订单，也不会自动退款或让发起方重复付款。

通过后，在事务内建立唯一履约建单任务，返回 `external.status=queued`。后台调用履约系统，成功取得真实 ID 后保存 `external.timelyOrderId`。只返回审核成功不代表已成功创建履约订单。

### 3. 履约状态回传

```json
{ "eventId": "fulfillment-001", "timelyOrderId": "真实履约订单ID", "status": "delivering", "occurredAt": 1791460920000 }
```

状态支持 `waiting`、`accepted`、`delivering`、`delivered`。必须与已关联订单 ID 一致；过时或回退进度返回 409。

正常情况下，Web 读取详情时后台也会请求参考履约接口 `GET /admin/order/:id`，展示外部状态。同步暂时失败时保留已有状态并提示。

### 4. 人工核对关联

```json
{ "eventId": "link-001", "timelyOrderId": "已在履约系统核实的订单ID", "description": "建单超时后核实已经成功，不再重复建单" }
```

只允许收款并审核通过的订单；不能覆盖已有不同 ID，不能将同一履约订单关联两个结算订单。

## 履约配置

仅在后台 `.env` 配置：

```dotenv
TIMELY_ORDER_HOST=https://实际履约系统基础地址/
TIMELY_ORDER_KEY=实际appKey
TIMELY_ORDER_SECRET=实际签名密钥
TIMELY_ORDER_SERVICE=实际平台服务商ID
TIMELY_CREATOR_ID=实际创建人员ID
```

适配参考 `warehouse_order/src/timelyClient.ts`、`src/auth.ts` 和 warehouse_shop 创建订单代码：向 `POST /admin/timelyOrders/` 发送 `orderInfo` 同类字段，`items` 为 JSON 字符串，商品单价保持分，`payPrice` 由本地分转换为原接口的元；带 appKey/date/SHA256 sign。支持直接返回 `{id:...}` 或 `{data:{id:...}}`，未返回有效 ID 不会标为已建单。

未配置上述参数时不发真实请求，审核通过的任务留在数据库等待配置。目录尚未配置时明确提供测试选项，测试目录订单不会发送至真实履约系统。没有复制旧系统环境或密钥。

每个建单请求带稳定的 `Idempotency-Key`。参考旧接口未证明支持幂等，因此默认在失败或请求中断后保留任务供管理端核对，不盲目重发。只有确认履约系统支持此幂等编号后，才设置 `TIMELY_IDEMPOTENCY_SUPPORTED=true`，开启后台自动重试。

接口校验失败为 400，未登录/鉴权失败为 401，不属于当前账号的订单为 404，状态或编号冲突为 409。

## 渠道与登录人员

渠道是委托本方履约的服务商，每个渠道可有多个人员账号。使用同一服务端 Bearer 管理鉴权：

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET/POST | `/api/channel-management/channels` | 查询/新增渠道 |
| PATCH | `/api/channel-management/channels/:id` | 修改名称、启用状态 |
| GET/POST | `/api/channel-management/accounts` | 查询/新增渠道人员 |
| PATCH | `/api/channel-management/accounts/:id` | 姓名、手机号、渠道及启用状态 |

新增接口必须携带唯一 `Idempotency-Key`（16 至 120 位字母、数字、下划线、连字符）；重复相同请求返回同一结果。新增渠道内容为 `{ "name": "服务商名称" }`；新增人员为 `{ "channelId": "渠道ID", "personName": "姓名", "mobile": "11位手机号" }`。人员身份固定为 member。手机号全局唯一，渠道名称不重复。

账号查询支持 page/pageSize/channelId/search，返回 `{accounts,total,page,pageSize}`；渠道查询返回 `{channels}`，含 accountCount。编辑人员不能指定 role 或 providerName，所属服务商由渠道决定。

原账号自动按服务商名称归入渠道，账号ID、会话和订单归属保留。更名只更新当前服务商名称，历史订单名称保留。停用渠道会撤销所属人员会话与验证码，但保留每个人员自身启用标记；重新启用后须重新登录。变更手机号、换渠道或停用账号同样撤销原会话。含启用管理员的渠道不能直接停用，渠道人员接口不能创建或修改管理员。

已有及时达管理端的新菜单通过独立管理转发模块调用此处接口，详见 timely_order/docs/service-provider-orders.md。浏览器中不会配置 ORDER_MANAGEMENT_TOKEN。

本地真实目录沿用旧工程 pageSize=0 获取完整城市、品牌和平台，品牌限定 locked=true。TIMELY_PLATFORM_ID 可限制为平台服务商所属平台，后台在创建履约订单前再次校验；外部请求字段为 plateFormId，本系统内仍使用 plateId。

## 付款截图与标准商品库

POST /api/orders/:id/manual-payment 新增必填 screenshot：{contentType: 'image/png', data: '原图文件的纯 base64 内容，不含 data: 前缀'}，支持 image/jpeg、image/png、image/webp，解码后单张最多 5 MB，请求体上限 8 MB。截图二进制存入同一 SQLite 的 payment_screenshots 表，与付款状态在同一事务提交。订单接口仅返回截图元信息；GET /api/orders/:id/payment-screenshot 仅允许订单所有者的有效会话读取。管理端使用 GET /api/order-management/orders/:id/payment-screenshot，必须持有原管理鉴权。图片响应为私有且禁止缓存。旧的已提交但无截图的订单可保留原流水和说明补充截图，提交后的截图不能替换。

GET /api/products?query=关键词&page=1 必须登录。商品统一查询标准库 /admin/items/，固定 status=0、pageSize=20；UPC 使用 upc 参数，名称使用 searchIndex，query 留空可浏览商品。前端页码从 1 开始，转为上游从 0 开始的分页。不维护本地商品库，不使用本地商品作为失败回退。返回 id、name、upc、spec、price（整数分或 null）、brandId、brandName、imageUrl（HTTPS 主图或空字符串）、page、hasMore。STANDARD_ITEM_HOST、STANDARD_ITEM_KEY、STANDARD_ITEM_SECRET 仅由后台配置，浏览器不持有商品库签名。订单商品可携带 upc、catalogId、imageUrl 作为快照；imageUrl 为选填的 HTTPS 图片地址（最多 2048 字符，不含用户名密码），随订单入库并在列表和详情返回，无图商品可省略。该展示字段不转发给履约建单接口。单价继续由建单人确认。


## 履约状态、备注与配送信息同步

审核建单成功后立即读取现有 `GET /admin/order/:id` 数据接口，后台每 15 秒分批同步已关联订单（每批最多 10 单、并发 2）。发起方和管理端共用数据库中的履约快照；关闭页面后仍继续同步。

`fulfillment` 除进度外，返回 `sourceCode/sourceStatus`、`messages`（配送订单留言）、`memos`（客服备注及时间）、`deliveries`（平台、物流单号、配送状态、配送员姓名电话、取收件信息、配送提示）、`syncedAt`（最近成功同步时间）。读取接口实际的 `memos` 和 `logiticsOrder` / `deliveryLogistics`，只保存所需字段。状态相同仍同步备注及配送变化；相同快照不会重复写进度事件。同步失败保留上次数据并返回 `syncMessage`，后台继续重试。原建单 `messages/contacts` 保留为原始快照。
