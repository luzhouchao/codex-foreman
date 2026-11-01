import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const frontend=fileURLToPath(new URL('../history-front/',import.meta.url));
const output=fileURLToPath(new URL('../skills/codex-foreman/scripts/history-ui/',import.meta.url));
const vite=path.join(frontend,'node_modules','vite','bin','vite.js');
if(!fs.existsSync(vite))throw Error('请先执行 npm --prefix history-front ci 安装锁定的构建依赖。');
function fingerprint(dir=output){return fs.readdirSync(dir).sort().flatMap(name=>{const file=path.join(dir,name);return fs.statSync(file).isDirectory()?fingerprint(file):[[path.relative(output,file),createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];});}
const before=JSON.stringify(fingerprint());
for(let round=0;round<2;round++){
  const result=spawnSync(process.execPath,[vite,'build'],{cwd:frontend,encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr||result.stdout||'构建失败');
  if(JSON.stringify(fingerprint())!==before)throw Error('静态产物与已提交构建不一致；请重新运行 build:history 后复核。');
}
process.stdout.write('历史前端连续两次构建与已保存产物逐文件 SHA256 一致。\n');
