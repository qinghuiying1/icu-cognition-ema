const BUILD_ID="cf51a438f627b786";
/* No patient records are stored or transmitted by this worker. */
const CACHE='icu-ema-static-'+BUILD_ID;
const BASE=self.registration.scope;
let manifest=null;
const hex=buffer=>[...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function getManifest(){
  if(manifest)return manifest;
  const cache=await caches.open(CACHE);
  let res=await cache.match(new URL('offline-manifest.json',BASE).href);
  if(!res)res=await fetch(new URL('offline-manifest.json',BASE),{cache:'no-store'});
  if(!res.ok)throw new Error('资源清单读取失败。');
  const data=await res.json();if(data.buildId!==BUILD_ID)throw new Error('发布版本与离线包不一致，请重新打开页面。');
  manifest=data;return data;
}
async function verify(){
  const m=await getManifest(),cache=await caches.open(CACHE);
  for(const a of m.assets){
    const res=await cache.match(new URL(a.url,BASE).href);if(!res)return false;
    if(hex(await crypto.subtle.digest('SHA-256',await res.arrayBuffer()))!==a.sha256)return false;
  }return true;
}
async function prepare(){
  const m=await getManifest(),cache=await caches.open(CACHE);
  for(const a of m.assets){
    const url=new URL(a.url,BASE).href;const existing=await cache.match(url);
    if(existing&&hex(await crypto.subtle.digest('SHA-256',await existing.arrayBuffer()))===a.sha256)continue;
    const res=await fetch(url,{cache:'no-store'});if(!res.ok)throw new Error('资源未加载完成：'+a.url);
    const bytes=await res.clone().arrayBuffer();if(hex(await crypto.subtle.digest('SHA-256',bytes))!==a.sha256)throw new Error('资源校验失败：'+a.url);
    await cache.put(url,res);
  }
  await cache.put(new URL('offline-manifest.json',BASE).href,new Response(JSON.stringify(m),{headers:{'Content-Type':'application/json'}}));
  return await verify();
}
self.addEventListener('install',e=>e.waitUntil(prepare()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>{
  const port=e.ports[0];if(!port)return;
  e.waitUntil((async()=>{try{port.postMessage({ready:e.data.type==='PREPARE'?await prepare():await verify()});}catch(error){port.postMessage({ready:false,message:error.message});}})());
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);if(!url.href.startsWith(BASE))return;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const exact=await cache.match(url.href);if(exact)return exact;
    if(e.request.mode==='navigate')return await cache.match(new URL('index.html',BASE).href)??fetch(e.request);
    return fetch(e.request);
  })());
});
