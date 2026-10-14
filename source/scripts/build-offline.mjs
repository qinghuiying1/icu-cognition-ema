import { readdir,readFile,writeFile,stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root=path.resolve('dist');
async function walk(dir){let files=[];for(const entry of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())files.push(...await walk(p));else files.push(p);}return files;}
// Keep old build outputs on disk, but only package the current dependency graph.
// Include ALL prepared public resources, especially SDK WASM/fonts.
const selected=new Set(['index.html',...(await walk(path.resolve('public'))).map(p=>path.relative(path.resolve('public'),p).replaceAll('\\','/'))]);
const html=await readFile(path.join(root,'index.html'),'utf8');
for(const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)) selected.add(match[1].slice(2));
const visited=new Set();
async function visit(relative){if(visited.has(relative))return;visited.add(relative);if(!relative.endsWith('.js'))return;
  const content=await readFile(path.join(root,relative),'utf8');
  for(const match of content.matchAll(/["'](\.\/[^"']+\.(?:js|css))["']/g)){
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1]));
    try{await stat(path.join(root,target));}catch{throw new Error('Current bundle dependency missing: '+target);}
    selected.add(target);await visit(target);
  }
}
for(const p of [...selected]) await visit(p);
const files=[...selected].map(p=>path.join(root,p));
const assets=[];
for(const file of files.sort()){const data=await readFile(file);assets.push({url:path.relative(root,file).replaceAll('\\','/'),sha256:createHash('sha256').update(data).digest('hex'),bytes:(await stat(file)).size});}
const buildId=createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0,16);
const manifest={buildId,appVersion:JSON.parse(await readFile('package.json','utf8')).version,assets};
await writeFile(path.join(root,'offline-manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(path.join(root,'sw.js'),`const BUILD_ID=${JSON.stringify(buildId)};\n`+await readFile('scripts/service-worker.js','utf8'));
console.log(`Offline package ${buildId}: ${assets.length} files, ${assets.reduce((n,a)=>n+a.bytes,0)} bytes.`);
