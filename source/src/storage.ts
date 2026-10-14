import { emptyAcceptance, APP_VERSION, type Acceptance, type Mode, type PatientPlan, type SessionRecord } from './model';

const DB_NAME = 'icu-cognition-ema';
let opening: Promise<IDBDatabase> | null = null;
const planKey = (id: string, mode: Mode) => JSON.stringify([mode, id.trim()]);
function db(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if(!d.objectStoreNames.contains('plans')) d.createObjectStore('plans');
      if(!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'sessionId' });
      if(!d.objectStoreNames.contains('revisions')) d.createObjectStore('revisions', { keyPath: 'revisionId', autoIncrement: true }).createIndex('sessionId', 'sessionId');
      if(!d.objectStoreNames.contains('settings')) d.createObjectStore('settings');
      if(!d.objectStoreNames.contains('formal-days')) d.createObjectStore('formal-days');
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); opening = null; };
      resolve(d);
    };
    req.onerror = () => { opening = null; reject(new Error('无法打开本地数据库：' + req.error?.message)); };
    req.onblocked = () => reject(new Error('数据库正在其他标签页中使用。请关闭其他测评页面后重试。'));
  });
  return opening;
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve,reject) => { r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
}
function committed(t: IDBTransaction): Promise<void> {
  return new Promise((resolve,reject) => { t.oncomplete=()=>resolve(); t.onabort=()=>reject(t.error ?? new Error('本地保存已中止。')); t.onerror=()=>reject(t.error ?? new Error('本地保存失败。')); });
}
function writing(d: IDBDatabase, stores: string[]): IDBTransaction {
  try { return d.transaction(stores,'readwrite',{durability:'strict'}); }
  catch { return d.transaction(stores,'readwrite'); }
}
export async function initStorage(): Promise<void> {
  const d=await db(); const t=writing(d,['settings']); const done=committed(t);
  t.objectStore('settings').put({checkedAt:new Date().toISOString()},'storage-probe');
  await done;
}
export async function getPlan(id: string, mode: Mode): Promise<PatientPlan|null> {
  const d=await db(); return await request(d.transaction('plans').objectStore('plans').get(planKey(id,mode))) ?? null;
}
export async function putPlan(plan: PatientPlan): Promise<void> {
  const d=await db(); const t=writing(d,['plans']); const done=committed(t); const store=t.objectStore('plans');
  const r=store.get(planKey(plan.id,plan.mode));
  r.onsuccess=()=>{
    if (r.result && JSON.stringify(r.result)!==JSON.stringify(plan)) { t.abort(); return; }
    store.put(structuredClone(plan),planKey(plan.id,plan.mode));
  };
  await done;
}
export async function saveSession(record: SessionRecord): Promise<void> {
  // Snapshot before awaiting: later UI mutations must never change an in-flight save.
  const snapshot=structuredClone(record); const savedAt=new Date().toISOString();
  const d=await db(); const t=writing(d,['sessions','revisions','formal-days']); const done=committed(t);
  const store=t.objectStore('sessions');
  const write=()=>{const previous=store.get(snapshot.sessionId);previous.onsuccess=()=>{
    const old=previous.result as SessionRecord|undefined;
    if (old && (old.id!==snapshot.id || old.day!==snapshot.day || old.mode!==snapshot.mode ||
      JSON.stringify(old.plan)!==JSON.stringify(snapshot.plan) ||
      (old.memory.rounds[0]?.correct!=null && JSON.stringify(old.memory.rounds[0].correct)!==JSON.stringify(snapshot.memory.rounds[0]?.correct)))) {
      t.abort(); return;
    }
    store.put(snapshot);
    t.objectStore('revisions').add({sessionId:snapshot.sessionId,savedAt,record:snapshot});
  };};
  if(snapshot.mode==='formal'){
    const locks=t.objectStore('formal-days'),key=JSON.stringify([snapshot.id,snapshot.day]);const lock=locks.get(key);
    lock.onsuccess=()=>{if(lock.result&&lock.result!==snapshot.sessionId){t.abort();return;}locks.put(snapshot.sessionId,key);write();};
  }else write();
  await done;
}
export async function loadSession(sessionId: string): Promise<SessionRecord|null> {
  const d=await db();return await request(d.transaction('sessions').objectStore('sessions').get(sessionId))??null;
}
export async function allSessions(): Promise<SessionRecord[]> {
  const d=await db(); const rows=await request(d.transaction('sessions').objectStore('sessions').getAll());
  return (rows as SessionRecord[]).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
}
export async function sessionRevisions(sessionId: string): Promise<unknown[]> {
  const d=await db();return request(d.transaction('revisions').objectStore('revisions').index('sessionId').getAll(sessionId));
}
export async function getAcceptance(): Promise<Acceptance> {
  const d=await db();const a=await request(d.transaction('settings').objectStore('settings').get('acceptance')) as Acceptance|undefined;
  return a?.appVersion===APP_VERSION ? a : emptyAcceptance();
}
export async function saveAcceptance(a: Acceptance): Promise<void> {
  if(a.appVersion!==APP_VERSION) throw new Error('验收记录版本不匹配。');
  const d=await db();const t=writing(d,['settings']);const done=committed(t);
  t.objectStore('settings').put(structuredClone(a),'acceptance');await done;
}
