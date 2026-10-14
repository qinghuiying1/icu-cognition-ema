interface Reply { ready:boolean; message?:string; }
let ready=false;
async function registration():Promise<ServiceWorkerRegistration|null> {
  if(!('serviceWorker' in navigator)||!isSecureContext) return null;
  return (await navigator.serviceWorker.getRegistration(new URL('.',document.baseURI).href))??null;
}
function ask(worker:ServiceWorker,type:string):Promise<Reply> {
  return new Promise((resolve,reject)=>{
    const channel=new MessageChannel();const timeout=setTimeout(()=>reject(new Error('离线资源核查超时，请保持联网后重试。')),90_000);
    channel.port1.onmessage=e=>{clearTimeout(timeout);channel.port1.close();resolve(e.data as Reply);};
    worker.postMessage({type},[channel.port2]);
  });
}
export async function offlineReady():Promise<boolean> {
  try {
    const reg=await registration();if(!reg?.active) return false;
    const result=await ask(reg.active,'VERIFY');ready=result.ready;return ready;
  } catch { return false; }
}
export async function prepareOffline(onProgress?:(message:string)=>void):Promise<boolean> {
  if(!('serviceWorker' in navigator)||!isSecureContext) throw new Error('当前地址不支持离线保存。请使用已发布的HTTPS网址。');
  const response=await fetch(new URL('offline-manifest.json',document.baseURI),{cache:'no-store'});
  if(!response.ok) throw new Error('此开发预览尚无离线包。请使用构建后的预览或正式发布网址。');
  onProgress?.('正在加载网页、卡片、语音和符号搜索资源…');
  const reg=await navigator.serviceWorker.register(new URL('sw.js',document.baseURI),{scope:new URL('.',document.baseURI).pathname,updateViaCache:'none'});
  await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('离线安装尚未完成，请保持联网并重试。')),90_000))]);
  // Do not activate a waiting update while an older version may have a live task.
  if(reg.waiting) throw new Error('有新版本等待启用。请先导出当前记录并关闭所有测评页，再重新打开。');
  const worker=reg.active;if(!worker) throw new Error('离线程序尚未启用，请重新打开页面。');
  const result=await ask(worker,'PREPARE');
  if(!result.ready) throw new Error(result.message??'离线资源尚未全部准备完成。');
  ready=true;
  onProgress?.('离线准备完成。请关闭热点、关闭浏览器后重开进行模拟验收。');
  try { await navigator.storage.persist(); } catch { /* User/device may decline persistent storage; export remains required. */ }
  return true;
}
