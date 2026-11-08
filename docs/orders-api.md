# 手工订单、报价、手动付款与到账确认接口

订单功能合并在 extrasAccount，继续使用同一登录身份和 SQLite 数据库。extrasWeb 是发起方页面，已有管理端由它自己的服务器调用下列管理接口；本项目不建设管理端页面，也不提供线上支付。

启用报价后，服务商手工建单，管理端报价，服务商付款并提交资料，管理端确认到账。到账后后台自动建单，服务商可查看履约。付款资料有误时可退回重提。

`order.id` 是本项目结算订单 ID，`referenceId` 是选填的外部订单号（省略或空字符串表示未填写），`external.timelyOrderId` 是建单成功后关联的履约订单 ID。所有本项目 API 金额均为整数分，时间均为 Unix 毫秒。

## 发起方接口

使用现有 HttpOnly `account_session` Cookie。身份由后台读取，请求里不能指定创建人或订单归属。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/order-options` | 城市、品牌、平台；`requiresQuote` 表示新单是否需报价，`demo:true` 表示测试目录 |
| POST | `/api/orders` | 手工创建；必须带唯一 `Idempotency-Key` 请求头 |
| GET | `/api/orders` | 当前账号订单；支持 page/pageSize/date/contacts/reference/item/stage/quoteStatus；顶层返回布尔值 `requiresQuote` |
| GET | `/api/orders/:id` | 当前账号订单详情及最新履约情况 |
| POST | `/api/orders/:id/manual-payment` | 提交手动付款信息；不代表确认收款 |

启用报价时的建单示例，`Idempotency-Key` 建议为 UUID；网络重试必须使用相同编号和内容：

```json
{
  "cityId": "实际城市ID", "cityName": "上海",
  "brandId": "实际品牌ID", "brandName": "实际品牌",
  "plateId": "实际平台ID", "platformName": "美团",
  "items": [{ "itemName": "商品", "spec": "500g", "salesPrice": 1234, "quantity": 2 }],
  "contacts": "收件人、手机号和完整地址", "messages": "配送备注",
  "referenceId": "外部订单号（选填）", "arrivedTime": 30
}
```

返回 `{ "order": {...}, "created": true }`；同一建单请求重试返回同一订单及 `created:false`。填写外部订单号时，同一个账号不能重复创建相同编号；未填写时可创建多笔订单。履约系统需要关联编号时，后台使用本项目订单 ID，不会伪造用户的外部订单号。

当 `requiresQuote=true`，服务商无需填写应付金额；后端忽略传入的 `payPrice`，保存 `quote:{"status":"pending"}` 与占位的 `payPrice:0`，进度为待报价。商品单价仅供报价参考。报价成功后，订单返回 `quote.status=quoted`，应付金额由管理端报价写入。服务商列表和详情使用当前登录账号读取报价。列表返回的 `requiresQuote` 表示新建订单当前是否需报价；关闭开关后仍可查询已有的待报价订单。未开启报价时，仍需传入大于零的 `payPrice`。历史订单不追加报价要求。

提交手动付款信息（待报价订单返回 409）：

```json
{ "reference": "银行或支付平台流水号", "description": "手动付款说明", "screenshot": { "contentType": "image/png", "data": "原图纯base64内容" } }
```

订单变为 `payment.status=submitted`，页面显示「付款待审核」。管理员核实到账后确认，系统自动建单。

订单列表可按 `stage=付款待审核`、`待接单`、`已接单`、`配送中`、`已完成` 查询。旧版的 `待收款确认` 和 `待履约` 分别对应 `付款待审核` 和 `待接单`，`履约中` 包含 `已接单` 和 `配送中`。

## 管理端接口

服务端请求头：

```http
Authorization: Bearer <ORDER_MANAGEMENT_TOKEN>
Content-Type: application/json
```

专用密钥已保存在后台未提交的 `.env`。管理端服务器配置相同值；密钥不能放在浏览器、VITE_* 或源代码中。正式环境使用 HTTPS。未配置密钥返回 503，错误密钥返回 401。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/order-management/orders` | 管理端查询订单，支持分页、`date`、`reviewStatus`、`stage=待报价`、`quoteStatus=pending\|quoted` |
| GET | `/api/order-management/orders?export=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | 按北京时间的创建日期范围导出，排除待报价订单 |
| GET | `/api/order-management/orders?date=YYYY-MM-DD&export=1` | 兼容单日导出，排除待报价订单 |
| GET | `/api/order-management/orders/:id` | 查询订单、付款信息和履约进度 |
| POST | `/api/order-management/orders/:id/quote` | 提交整单报价，待报价订单仅能报价一次 |
| POST | `/api/order-management/orders/:id/receipt` | 确认实际到账并自动发起履约建单，建议始终携带当前 noteId |
| POST | `/api/order-management/orders/:id/reject-payment` | 收款前退回付款资料，必须填写原因，可由原账号重新提交 |
| POST | `/api/order-management/orders/:id/review` | 兼容旧流程中已收款、仍待处理的历史订单 |
| POST | `/api/order-management/orders/:id/fulfillment` | 写入关联履约订单的状态 |
| POST | `/api/order-management/orders/:id/link` | 建单结果未确认时，人工核对已有履约订单后关联，避免重复创建 |

`eventId` 是管理端的唯一事件编号。同一事件重发相同内容返回 `replayed:true`；同编号不同内容返回 409。事件和订单状态在同一数据库事务中保存。

范围导出要求同时传有效的 `startDate` 和 `endDate`，允许同一天，开始日期须早于或等于结束日期。按创建时间倒序返回 `{ orders, total, startDate, endDate }`，包含北京时间的开始日和结束日。传入任一范围参数时按范围校验，两者均未传时兼容 `date` 单日查询，返回 `{ orders, total }`。

导出覆盖所有服务商，跳过 `quote.status=pending` 的待报价订单，兼容没有报价字段的历史订单。导出查询忽略分页和其他列表筛选。

### 服务商退款申请

`ORDER_REFUND_ENABLED` 默认关闭。启用时还需可用的履约退款适配器。

| 使用方 | 方法与路径 | 请求和返回 |
| --- | --- | --- |
| 服务商 | `GET /api/orders/:id` | 返回 `{order,canRequestRefund}`。当前账号拥有订单、已确认到账且已关联履约单、没有退款申请时才可提交。 |
| 服务商 | `POST /api/orders/:id/refund-request` | 请求 `{reason}` 和 `Idempotency-Key`，返回 `{order}`。原因去除首尾空白后长度为 1–200 个 UTF-16 码元。同账号以同一个键重发相同申请时返回当前结果，同键改内容返回 409。 |
| 管理端 | `GET /api/order-management/orders?refundOnly=1` | 分页查询已有退款申请的服务商订单。 |
| 管理端 | `POST /api/order-management/orders/:id/refund-mark` | 请求 `{refundId,eventId,operatorName}`，返回 `{order,replayed}`。写入待核对状态后调用旧履约标识接口。 |
| 履约确认桥 | `POST /api/order-management/fulfillment-refunds/:refundId/confirm` | 仅服务端持管理密钥调用。桥从履约人员登录态注入 `{operatorId,operatorName}`，履约适配器核对旧单的接单人员，返回 `{status}`。 |
| 管理端 | `POST /api/order-management/orders/:id/refund-initiate` | 请求 `{refundId,eventId,operatorName}`，返回 `{order,replayed}`。首次操作重新核验履约标识已确认，随后登记发起退款。 |

退款独立记录在订单的 `refund` 字段，包含 `id`、`status`、`reason`、`requestedAt`，以及各步骤的 `markedAt`、`confirmedAt`、`initiatedAt` 和可选提示 `message`。进度依次为 `requested`（申请已提交）、`mark_pending`（标识结果待核对）、`awaiting_fulfillment`（等待履约人员确认）、`ready_to_refund`（履约已确认）和 `initiated`（已发起退款）。标识调用失败或超时后，可查询管理端订单详情回查标识，或用原事件重试。最终登记发起退款后按线下流程处理款项。

### 报价

```json
{ "eventId": "quote-20261108-001", "amount": 2468, "note": "报价说明（选填）", "quotedBy": "管理端报价人员" }
```

金额使用整数分，范围 1 至 99999999，备注最多 1000 字。管理端桥接层根据登录身份写入 `quotedBy`，后台生成报价时间。成功返回 `{order,replayed}`，其中 `quote` 包含 `status: "quoted"`、`amount`、`note`、`quotedAt`、`quotedBy`，同时更新 `payPrice=amount`。已提交的报价固定，同一事件可重试。

### 1. 确认实际收款

```json
{ "eventId": "receipt-20261008-001", "noteId": "当前 payment.noteId", "transactionId": "实际收款流水号", "amount": 2468 }
```

金额必须等于订单应付金额，同一收款流水不能用于两个订单。`noteId` 提供时必须匹配当前付款资料，并参与事件内容幂等校验。经历过付款资料退回的订单，首次确认必须处于 `submitted` 且携带正确 `noteId`，避免陈旧页面确认新一轮付款。报价订单必须已报价且服务商已提交付款资料。从未退回的历史或兼容模式订单可继续省略 `noteId`、直接确认未提交付款资料的订单。

服务器记录操作时间 `payment.confirmedAt`。真实到账时间 `collectedAt` 可选，提供时原样保存。兼容字段 `payment.paidAt` 优先使用真实到账时间，未提供时使用确认时间。首次确认到账时，同一事务保存 `payment.status=paid`、兼容履约检查的 `review.status=approved` 和唯一建单任务，随后后台自动建单。返回 `external.status=queued` 表示任务已入队，取得履约订单号后更新为 `created`。

### 1.1 收款前退回付款资料

```json
{ "eventId": "reject-payment-001", "noteId": "当前 payment.noteId", "reason": "截图中的收款方需要核对", "reviewerName": "核对人员", "rejectedAt": 1791460800000 }
```

调用 `POST /api/order-management/orders/:id/reject-payment`。仅当前 `payment.status=submitted` 且 `noteId` 匹配时可操作；原因、核对人员和时间必填，`rejectedAt` 不能早于本轮 `submittedAt`。相同事件及内容重发返回 `replayed:true`，同事件不同内容或新事件引用旧轮次返回 409。确认收款与退回并发时，仅一个决策能够成功。

退回后 `payment.status=unpaid`，`review.status` 仍为 `not_submitted`；这只是要求原建单账号重新确认付款资料，不确认到账、不发起退款，也不会建立履约任务。`payment.rejection` 返回当前退回的 `{noteId,reason,reviewerName,rejectedAt}`；`payment.rejections[]` 追加保留每轮被退回的流水、说明、截图元信息、提交时间、提交人和拒绝结果，进度事件保留操作记录。

原账号重新提交 `POST /api/orders/:id/manual-payment` 时，必须额外提供 `previousNoteId`，等于刚被退回的 `payment.noteId`，其余付款字段和截图仍必填。可重新确认相同流水和原图，无需为了重提刻意修改内容。成功后生成新的 `noteId/submittedAt`，清除当前 `payment.rejection` 并保留完整 `rejections`，同时在本轮付款中保存 `previousNoteId`。网络重试必须保留相同 `previousNoteId` 和内容；待确认期间重复相同请求返回 `replayed:true`，旧轮次的提交、确认或退回请求不能改变新资料。初次提交、未退回旧订单补图仍可省略 `previousNoteId`；补图保留本轮已有的 `noteId/submittedAt`。

```json
{ "previousNoteId": "刚被退回的 payment.noteId", "reference": "付款流水号", "description": "付款说明", "screenshot": { "contentType": "image/png", "data": "原图纯base64内容" } }
```

### 2. 历史已收款订单继续建单

```json
{ "eventId": "review-20261008-001", "status": "approved", "reviewerName": "审核人员", "reviewedAt": 1791460860000, "reason": "核实到账" }
```

该接口只处理旧流程下 `payment.status=paid`、`review.status=pending` 的订单，保留历史调用的 `approved` 和 `rejected` 参数。时间不能早于原收款时间，`rejected` 必须填写原因。管理端的「继续建单」提交 `approved`，显式将该笔订单加入履约队列。原有处理结果保留。

后台调用履约系统，成功取得真实 ID 后保存 `external.timelyOrderId`。

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

只允许已确认到账且已放行履约的订单。一个履约订单只可关联一个结算订单，已有不同 ID 时返回冲突。

## 报价上线配置

`ORDER_QUOTE_REQUIRED` 仅接受 `true` 或 `false`。未设置时，开发环境开启，生产环境保持原建单流程。两个前端均发布且报价页面可用后，在后台设置 `ORDER_QUOTE_REQUIRED=true` 并重启。关闭开关只影响此后新建的订单，已有报价订单仍按各自的报价状态完成后续流程。无需变更数据库表结构。

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

尚未配置履约接口时，已确认到账的建单任务留在数据库等待配置。目录尚未配置时使用测试选项，测试目录订单只用于本地演示。

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

POST /api/orders/:id/manual-payment 新增必填 screenshot：{contentType: 'image/png', data: '原图文件的纯 base64 内容，不含 data: 前缀'}，支持 image/jpeg、image/png、image/webp，解码后单张最多 5 MB，请求体上限 8 MB。截图二进制存入同一 SQLite 的 payment_screenshots 表，与付款状态在同一事务提交。订单接口仅返回截图元信息；GET /api/orders/:id/payment-screenshot 仅允许订单所有者的有效会话读取。管理端使用 GET /api/order-management/orders/:id/payment-screenshot，必须持有原管理鉴权。图片响应为私有且禁止缓存。旧的已提交但无截图的订单可保留原流水和说明补充截图，待确认期间的截图不能替换。每轮重提追加一张图片，不覆盖旧图；启动时自动把旧表的一单一图约束迁移为一单多图，保留原截图 ID、二进制和关联。当前截图接口始终按订单归属及当前 `payment.screenshot.id` 读取，拒绝历史中的截图元信息与原二进制保留供审计。

`GET /api/products?query=关键词&page=1` 必须登录。商品统一查询标准库 `/admin/items/` 的 `status=0` 数据，前端页码从 1 开始。留空可浏览商品，单词按 `searchIndex` 查询，完整 UPC 按 `upc` 精确查询，这三种方式直接读取上游对应的 20 条分页。

多个关键词用空格分隔，统一字符宽度和大小写、去重后逐词匹配。后台优先用最长的非容量词查询候选商品，每批最多 100 条，再从商品索引、名称、品牌、规格等字段筛出命中全部词的商品。返回 `{products,page,hasMore}`，每页最多 20 条。扫描最多 8 批或 8 秒，达到上限且无法确认剩余匹配时返回 `limited:true`。商品库故障返回查询错误。`STANDARD_ITEM_HOST`、`STANDARD_ITEM_KEY`、`STANDARD_ITEM_SECRET` 由后台配置。

商品包含 `id`、`name`、`upc`、`spec`、`price`（整数分或 `null`）、`brandId`、`brandName`、`imageUrl`（HTTPS 主图或空字符串）。订单商品可携带 `upc`、`catalogId`、`imageUrl` 作为快照。图片地址选填，最长 2048 字符，随订单入库并在列表和详情返回。建单人确认单价。


## 履约状态、备注与配送信息同步

建单成功后立即读取 `GET /admin/order/:id`。后台每 15 秒分批同步已关联订单（每批最多 10 单、并发 2）。发起方和管理端共用数据库中的履约快照，关闭页面后仍继续同步。

`fulfillment` 除进度外，返回 `sourceCode/sourceStatus`、`messages`（配送订单留言）、`memos`（客服备注及时间）、`deliveries`（平台、物流单号、配送状态、配送员姓名电话、取收件信息、配送提示）、`syncedAt`（最近成功同步时间）。读取接口实际的 `memos` 和 `logiticsOrder` / `deliveryLogistics`，只保存所需字段。状态相同仍同步备注及配送变化；相同快照不会重复写进度事件。同步失败保留上次数据并返回 `syncMessage`，后台继续重试。原建单 `messages/contacts` 保留为原始快照。
