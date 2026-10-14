import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('node_modules/@m2c2kit/assessment-symbol-search/dist');
if(!fs.existsSync(root)) throw new Error('符号搜索依赖未安装完成。');
let changed=0,checked=0;
function visit(dir) { for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
  const p=path.join(dir,entry.name);
  if(entry.isDirectory()) {visit(p);continue;}
  if(!/\.(js|mjs)$/.test(p)) continue;
  const before=fs.readFileSync(p,'utf8');
  const after=before.replace(/(["'])interstimulus_interval_ms\1/g,'"interstimulus_interval_duration_ms"');
  if(after!==before) {fs.writeFileSync(p,after);changed++;}
  checked++;
}}
visit(root);
if(checked===0) throw new Error('未找到符号搜索可执行文件。');
console.log(`Symbol Search interval check: ${checked} files inspected, ${changed} patched.`);
