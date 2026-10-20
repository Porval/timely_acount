import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const root of ['src', 'public', 'scripts', 'test']) {
  for (const file of readdirSync(root).filter((name) => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript 语法检查通过');
