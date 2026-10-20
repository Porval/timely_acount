# 及时达 · 账户管理

账户字段为服务商名称、人员名称和手机号。管理员可新增、编辑、启用与停用账户；普通成员只可查看自己的信息。手机号唯一，登录前须由管理员创建账户。

## 登录规则

- 6 位手机号验证码，5 分钟有效，一次使用；连续输错 5 次失效。
- 验证码发送间隔 60 秒，每手机号每小时最多请求 10 次，并有 IP 限流。
- 单账户单会话：同一账户再次登录，之前所有登录立即失效。
- 随机 token 固定有效 7 天，访问不会续期；退出、停用、变更手机号或权限立即吊销。
- token 通过 HttpOnly / SameSite Cookie 保存，数据库仅保留哈希；生产 Cookie 使用 Secure。
- 最后一名启用管理员不能被停用或降级。

## 本地启动

需要 Node.js 20.6 及以上，使用 better-sqlite3 连接 SQLite。

```sh
cd /Users/jiang/cmd_world/price-tag/auto/extrasAccount
npm ci
# 首次体验：创建本地演示管理员，演示手机号 13800138000
npm run seed:demo
npm run dev
```

打开 `http://127.0.0.1:3100`。点击获取验证码，开发页面显示验证码并自动填入；终端也会输出验证码。此模式不会发送真实短信，仅允许本机访问，生产环境禁止使用。

创建自己的初始管理员时，将以下占位内容替换为真实资料后执行，运行中的后台会直接读取数据库新账户：

```sh
npm run account:create -- --phone 你的手机号 --provider '你的服务商名称' --name '你的人员名称' --admin
```

正常运行用 `npm start`。复制 `.env.example` 为 `.env` 后用 `npm run dev:env` 或 `npm run start:env` 启动。普通 `npm run dev` 不会读取 `.env`。

## 短信发送与校验接口

已按 `warehouse_account` 的两个接口拆分短信发送与验证码验证：

- 发送：`POST /api/sms/requestCode`，向短信服务传 `{number, template}`。
- 校验：`POST /api/sms/verifyCode`，上游手机号字段通过 `SMS_VERIFY_PHONE_FIELD` 配置为 `phone`（默认）或 `number`；当前真实服务使用 `{number, code}`。验证码字段可以通过 `SMS_VERIFY_CODE_FIELD` 改为 `verifyCode` 等已确认名称。

设置 `SMS_MODE=remote` 和 `DEBUG_SMS_HOST`（短信服务基础 URL）后启用；若需 Bearer 鉴权可配置 `SMS_API_TOKEN`，不需要时不添加该请求头。真实模式不在本地产生短信验证码，也不返回验证码给浏览器；只有远程校验明确成功才签发本系统的 7 天单点登录凭证。

本机已配置真实短信服务，发送请求已联调成功，验证请求的手机号字段已确认为 `number`。适配器仅接受短信服务 `success === true` 且未明确拒绝验证的响应；你给出的 BFF 路由会将成功响应替换为 `loginWithPhone` 结果，若使用 BFF 地址，需按实际返回格式调整成功判定，不能仅凭 HTTP 200 放行。

前端继续使用 `/api/auth/code` 与 `/api/auth/login`，同时提供 `/api/sms/requestCode` 和 `/api/sms/verifyCode` 作为参数兼容入口。不同入口共享发送和验证的 IP 限流，后者校验成功后返回本系统账户及会话到期时间，并设置 Cookie。

配置详情见 [开发说明](docs/development.md)。生产强制 HTTPS；仅本机模拟短信服务允许 HTTP 联调。

## 数据库

使用 SQLite，数据库路径默认为 `data/accounts.sqlite`，可通过 `DATABASE_FILE` 配置。账户、会话、验证码和发送记录分别保存在 `accounts`、`sessions`、`otp_challenges`、`sms_deliveries` 表，数据库有手机号唯一约束和会话外键。

数据更新使用事务，开启 WAL、外键校验和忙等待，数据库文件权限为 600。会话表以账户 ID 为主键，确保每个账户只有一个当前会话；登录有效期仍为固定 7 天。

首次启动会把原 `data/accounts.json` 自动迁入数据库（包含当前会话及验证码状态）。迁移记录防止重复导入，原 JSON 文件保留作为备份；迁移完成后新增、编辑和登录操作均读写数据库，重启不丢数据。

同一台机器上的多个连接或服务进程可共享同一数据库，命令行创建账户不需要停止后台。SQLite 数据库应放在本机磁盘；跨服务器部署需共享数据库服务。手机号发送频率由数据库保存，IP 限流仍按进程计算。`.env`、`data/`、数据库和真实账号资料不提交到 Git。

## 检查

```sh
npm run check
npm test
```

接口测试覆盖账户权限、重复手机号、验证码过期与尝试限制、单点登录、7 天边界、退出、停用、变更手机号及角色、重启持久化和跨站请求防护。

## 目录

```text
src/config.js              配置、7 天会话与 5 分钟验证码常量
src/store.js               SQLite 表结构、事务和旧数据迁移
src/service.js             账户、验证码、会话及权限业务
src/sms.js                 短信发送和校验适配器
src/server.js              页面、接口、Cookie 与请求限制
src/index.js               服务启动
public/                    登录及账户管理页面
scripts/account-create.js  初始管理员/演示账户创建
scripts/check.js           全部 JavaScript 语法检查
test/server.test.js        接口及业务测试
test/store.test.js         数据库迁移、回滚和并发测试
test/sms.test.js           远程短信协议、失败与并发校验测试
docs/development.md        接口及接入说明
```

## 手工订单与人工付款审核

订单模块已合并进本服务，与账号共用 SQLite。发起方使用登录 Cookie 建单、提交手动付款流水号和查询进度；已有管理端使用专用 Bearer 密钥确认收款和审核。审核通过后由本后台创建履约订单并关联及时达 ID。仅支持手工订单和手动付款，未接线上支付。

完整接口、JSON 示例和履约配置见 [订单接口说明](docs/orders-api.md)。
