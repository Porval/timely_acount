# extrasAccount · 账号系统开发工程

用于继续开发账号相关功能的独立 Node.js 工程。当前提供服务入口、HTTP 路由、健康检查、配置示例和接口测试；业务字段及账号功能待确认后实现。

## 启动

需要 Node.js 20.6 或更高版本，无第三方依赖，不需要执行 npm install。

```sh
cd /Users/jiang/cmd_world/price-tag/auto/extrasAccount
npm run dev
```

开发服务默认使用 `http://127.0.0.1:3100`，修改源码后自动重启。

```sh
curl http://127.0.0.1:3100/api/health
# {"status":"ok","service":"extras-account"}
```

正常运行使用 `npm start`。自定义配置可复制 `.env.example` 为 `.env`，再运行 `npm run dev:env` 或 `npm run start:env`。

## 工程结构

```text
src/
  index.js           服务启动、端口配置、退出处理
  server.js          HTTP 服务和接口入口
test/
  server.test.js     健康检查及未知路由测试
docs/
  development.md    账号模块的开发入口及待确认范围
.env.example        配置示例
.gitignore          忽略本地配置、数据与依赖
package.json        启动与检查命令
```

## 验证

```sh
npm run check
npm test
```

当前仅用于本地开发。开放到其他设备或部署前，需要实现所选业务对应的认证、权限、持久化与输入校验。
