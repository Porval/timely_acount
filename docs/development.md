# 开发与接口说明

## 账户数据

`providerName` 为服务商名称，`personName` 为人员名称（均 1–80 字符），`mobile` 为中国大陆 11 位手机号，账户内唯一。`role` 为 `admin` 或 `member`，默认普通成员。`enabled` 为启用状态。

管理员管理所有账户；普通成员通过 `/api/auth/me` 查看自己的账户。手机号尚未创建或账户停用时不会发送验证码，不支持自动注册。

## HTTP 接口

同源 JSON 请求，登录状态由 HttpOnly Cookie 携带，前端不读取 token，也不存入 localStorage。

| 接口 | 说明 | 权限 |
| --- | --- | --- |
| GET /api/health | 服务检查 | 公开 |
| GET /api/config | 是否使用开发验证码 | 公开 |
| POST /api/auth/code | `{mobile}` 请求验证码 | 公开，限流 |
| POST /api/auth/login | `{mobile, code}` 验证并登录 | 公开，限流 |
| GET /api/auth/me | 当前账户及 expiresAt | 已登录 |
| POST /api/auth/logout | 立即吊销当前会话并清除 Cookie | 已登录 |
| GET /api/accounts | 全部账户 | 管理员 |
| POST /api/accounts | `{providerName, personName, mobile, role?}` | 管理员 |
| PATCH /api/accounts/:id | 更新名称、手机号、role 或 enabled | 管理员 |

登录返回 `{account, expiresAt}`，同时设置 `account_session` Cookie。服务端保存 SHA-256 token 哈希，每个账户只保留一个会话。有效期从登录成功时固定计算 7 天，旧 token 即使仍保存在浏览器也无法访问接口。页面每 30 秒及恢复窗口焦点时检查会话；服务端在每次请求时立即检查。

验证码随机生成 6 位，只保存带随机盐的哈希。过期或用过即作废，5 次错误后作废；发送新验证码覆盖旧验证码。手机号变更、角色变更或停用时吊销会话和验证码。

## 短信服务协议

仓库参考：`warehouse_account/src/routes/login.ts`、`src/debugSmsClient.ts` 和 `src/util.ts`。

设置 `SMS_MODE=remote`、`DEBUG_SMS_HOST=https://短信服务基础地址` 后，`src/sms.js` 按基础路径拼接接口：

```json
// POST <DEBUG_SMS_HOST>/api/sms/requestCode
{"number":"接收手机号","template":"【上海蜜田科技】注册绑定手机号验证码是${code}"}
// POST <DEBUG_SMS_HOST>/api/sms/verifyCode
{"number":"接收手机号","code":"用户输入的6位验证码"}
```

上游验证手机号字段通过 `SMS_VERIFY_PHONE_FIELD` 配置：默认 `phone`，当前真实服务必须设置为 `number`。本系统对外的 `{phone, code}` 入口不受该上游配置影响。验证码字段默认为 `code`，可用 `SMS_VERIFY_CODE_FIELD` 修改为 `verifyCode` 等字段。模板由服务端配置 `DEBUG_SMS_TEM`，默认与参考仓库一致。请求头为 Content-Type / Accept application/json；只有配置了 `SMS_API_TOKEN` 时才添加 Bearer Authorization，参考仓库本身不添加鉴权头。

客户端 10 秒超时，不跟随跳转。HTTP 错误、发送业务失败、响应非 JSON 和超时均不作为成功；对外返回通用错误，不透传上游 token 或验证码。当前校验仅认 `success === true`、`error !== true` 且 `verified !== false`。HTTP 200 或 `{error:false}` 不自动视为验证成功。

**接口格式尚待确认**：参考 BFF 的 verifyCode 在短信服务成功时调用 `client.loginWithPhone(phone)`，返回内容会变成旧账户服务结果。如果提供 BFF 地址，需要真实成功响应示例及旧账户依赖说明，再调整成功判定。若直接使用 `DEBUG_SMS_HOST` 的纯短信服务，预期返回 `{success:true}`。本机已启用真实短信模式，发送已联调成功，验证接口的手机号字段已确认为 `number`。

远程模式只在本地保存请求时间、5 分钟有效期、尝试次数和随机请求标识，不生成或比较本地验证码。验证前在数据库事务内检查账户及请求并累计错误尝试；调用外部接口时不占用数据库写锁；返回成功后再检查账户仍启用、手机号未改、请求未重发且未消费，然后签发会话。每个请求最多调用外部验证 5 次；并发成功回复只允许消费一次。新登录仍替换该账户原会话，固定有效 7 天。

## 兼容接口

| 入口 | 请求参数 | 行为 |
| --- | --- | --- |
| POST /api/auth/code | `{mobile}` | 当前前端发送验证码 |
| POST /api/auth/login | `{mobile, code}` | 当前前端校验并登录 |
| POST /api/sms/requestCode | `{number}` | 同一发送流程 |
| POST /api/sms/verifyCode | `{phone, code}` | 同一校验及登录流程；code 字段随 SMS_VERIFY_CODE_FIELD 配置 |

入口按操作共用 IP 限流，不通过切换路径绕过限制。任何入口都不能绕过外部验证直接按手机号发 token。

## 配置

真实短信：`SMS_MODE=remote`、`DEBUG_SMS_HOST`、按实际接口设置 `SMS_VERIFY_CODE_FIELD` 与可选 `SMS_API_TOKEN`。生产另设 `NODE_ENV=production` 和 `APP_ORIGIN=https://你的后台域名`，通过 HTTPS 反向代理访问；Cookie 自动设置 Secure。`HOST` 可设为 `0.0.0.0`，开发验证码模式拒绝此配置。

## SQLite 数据库

`DATABASE_FILE` 设置数据库路径，默认 `data/accounts.sqlite`；相对路径以工程根目录为基准。启动时自动建表，表结构版本由 `PRAGMA user_version` 保存。

| 表 | 内容与约束 |
| --- | --- |
| accounts | 服务商名称、人员名称、手机号、角色、状态；mobile 唯一 |
| sessions | account_id 为主键和外键，每账户一个会话；token 哈希和到期时间 |
| otp_challenges | mobile 为主键；验证码哈希、盐、到期时间、错误次数 |
| sms_deliveries | 手机号及验证码请求时间，控制发送频率 |
| migrations | 旧 JSON 数据迁移标记，防止重复导入 |

`store.update()` 在 IMMEDIATE 事务内读取、校验、写入；失败回滚。读取不缓存业务数据，因此另一个数据库连接的提交可立即读取。WAL 模式允许同机多个连接读写，写锁最长等待 5 秒。当前存储接口在事务内加载业务状态，适合初期规模；大规模使用时应进一步将业务筛选及更新下推到 SQL。

首次启动若数据库没有账户且存在旧 JSON 文件，会完整迁移账户、当前会话、验证码及发送记录；数据库已有账户时以数据库为准，不覆盖现有数据。迁移成功后标记一次，原 JSON 保留但不再更新。旧文件路径可由 `DATA_FILE` 指定。损坏的旧文件使迁移回滚并阻止启动，须修复数据后重试。

数据库文件权限 600，数据目录及 SQLite 的 WAL/SHM 文件均在 Git 忽略范围内。运行时备份请使用 SQLite `.backup` 或停止服务后复制数据库，避免遗漏 WAL 中未检查点的数据。

命令行创建账户会直接写入数据库，无需停止服务。首次创建管理员用 `npm run account:create -- --phone ... --provider ... --name ... --admin`。演示账户仅用于本地联调，部署前停用或使用独立生产数据库。

多进程单点登录依赖共同的数据库；跨服务器应改用数据库服务。当前 IP 限流仍为进程级，代理运行时按连接来源计算，不信任客户端 X-Forwarded-For。手机号发送频率通过数据库事务控制。
