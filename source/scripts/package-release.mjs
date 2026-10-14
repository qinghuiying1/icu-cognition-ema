import {createRequire} from 'node:module';
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url),JSZip=require('jszip'),zip=new JSZip();
const version=JSON.parse(await readFile('package.json','utf8')).version;
const manifest=JSON.parse(await readFile('dist/offline-manifest.json','utf8'));
for(const a of [...manifest.assets,{url:'sw.js'},{url:'offline-manifest.json'}])zip.file('site/'+a.url,await readFile(path.join('dist',a.url)));
async function include(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await include(p);else zip.file('source/'+p.replaceAll('\\','/'),await readFile(p));}}
for(const dir of['src','public','tests','docs'])await include(dir);
for(const file of['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','vite.config.ts','index.html','.gitignore','README.md'])zip.file('source/'+file,await readFile(file));
// Bundle build/material helpers, not local browser QA fixtures or exported data.
for(const file of['build-offline.mjs','service-worker.js','patch-symbol-search.mjs','prepare-symbol-assets.mjs','prepare-materials.ps1','prepare-materials.py','preview-server.mjs','package-release.mjs'])zip.file('source/scripts/'+file,await readFile('scripts/'+file));
zip.file('先读我.txt','site为完整静态网页，请整体作为GitHub仓库docs目录发布。source为完整源码、锁文件、材料、构建脚本和操作说明。只包含程序及材料，无患者数据、研究Word或Excel。首版为待验收版本，平板验收前不得用于正式采集。不要双击index.html以file://运行，应使用HTTPS发布地址或本机localhost预览。\r\n');
await mkdir('交付',{recursive:true});const output=`交付/电子测评平台_${version}.zip`;
const buffer=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await writeFile(output,buffer);
console.log(JSON.stringify({output,bytes:buffer.length,siteFiles:manifest.assets.length+2,version,patientDataIncluded:false}));
