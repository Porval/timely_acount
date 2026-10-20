import { loadConfig } from '../src/config.js';
import { SQLiteStore } from '../src/store.js';
import { AccountService } from '../src/service.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
if (demo && (process.env.NODE_ENV === 'production' || process.env.SMS_MODE === 'remote')) throw new Error('真实短信或生产环境禁止创建演示账户');
const option = (name) => args[args.indexOf(name) + 1];
if (!demo && !['--phone', '--provider', '--name'].every((name) => args.includes(name))) {
  console.error('用法：npm run account:create -- --phone 手机号 --provider 服务商 --name 人员名称 [--admin]');
  process.exit(1);
}
const config = loadConfig();
const store = new SQLiteStore(config.databaseFile, { legacyFile: config.legacyFile });
const service = new AccountService({ store });
const input = demo ? { mobile: '13800138000', providerName: '演示服务商', personName: '演示管理员', role: 'admin' } :
  { mobile: option('--phone'), providerName: option('--provider'), personName: option('--name'), role: args.includes('--admin') ? 'admin' : 'member' };
try {
  const account = service.createAccount(input);
  console.log(`账户已创建：${account.personName} / ${account.mobile} / ${account.role}`);
  console.log('数据已写入 SQLite，运行中的服务可直接读取新账户。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
