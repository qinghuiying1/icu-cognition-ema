import './styles.css';
import { APP_VERSION, MAX_LEARNING_ROUNDS, STROOP_MS, DELAY_MIN_MS, DELAY_MAX_MS,
  SYMPTOM_ITEMS, WORD_CATEGORIES, acceptanceComplete, emptyAcceptance, type Acceptance, type CorrectWords,
  type SessionRecord, type StroopKind, type Symptoms, type Mode } from './model';
import { generatePlan, makeSession, event, scoreRound, mayRepeat, latestAnswerEnd,
  derived, scorable, validateStroop, localDate, localDateTime } from './core';
import { initStorage, getPlan, putPlan, saveSession, loadSession, allSessions,
  getAcceptance, saveAcceptance } from './storage';
import { memoryAudio } from './audio';
import { exportSession } from './export';
import { prepareOffline, offlineReady } from './offline';
import { runSymbolSearch } from './symbol';

const root = document.querySelector<HTMLDivElement>('#app')!;
const STROOP: StroopKind[] = ['w', 'c', 'cw'];
const CARD_NAMES: Record<StroopKind, string> = { w:'读字', c:'命名颜色', cw:'读字的颜色' };
const CARD_FILES: Record<StroopKind, string> = { w:'display/W.png', c:'display/C.png', cw:'display/CW.png' };
const cardUrl = (file:string) => `${import.meta.env.BASE_URL}cards/${file}`;
type Screen = 'home' | 'acceptance' | 'records' | 'session';
let screen: Screen = 'home';
let record: SessionRecord | null = null;
let acceptance: Acceptance = emptyAcceptance();
let records: SessionRecord[] = [];
let busy = false;
let failure = '';
let notice = '';
let storageReady = false;
let cacheReady = false;
let researcherOpen = false;
let readonlyRecord = false;
let saveBlocked = false;
let downloaded = false;
let downloadConfirmed = false;
let timer: number | null = null;
let timerStart = 0;
let timerDeadline = 0;
let stroopKind: StroopKind = 'w';
let symbolController: { stop: () => void } | null = null;
let wakeLock: { release: () => Promise<void> } | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let symptomIndex = 0;
let symptomDraft: Partial<Symptoms> = {};
let learningPlaying = false;
let historyStage: number | null = null;
let resumeId: string | null = null;
let symbolGeneration = 0;
const STAGE_NAMES = ['词语学习与即时回忆','当前感受','颜色任务：读字','颜色任务：命名颜色','颜色任务：读字的颜色','延迟回忆','符号搜索','核对导出'];
let setup = { id:'TEST001', day:1, firstDate:localDate(), mode:'simulation' as Mode };

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]!);
}
function $(selector:string): HTMLElement | null { return root.querySelector(selector); }
function button(id:string,label:string,kind='primary',disabled=false):string {
  return `<button id="${id}" class="button ${kind}" ${disabled?'disabled':''}>${label}</button>`;
}
function bind(id:string,fn:()=>void|Promise<void>):void {
  document.getElementById(id)?.addEventListener('click',()=>void act(fn));
}
function readableError(error:unknown):string { return error instanceof Error ? error.message : String(error); }
async function act(fn:()=>void|Promise<void>):Promise<void> {
  if(busy) return;
  busy=true; failure=''; updateBanners();
  root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('button,input,select,textarea').forEach(b=>{b.dataset.wasDisabled=String(b.disabled);b.disabled=true;});
  try { await fn(); }
  catch(error) { failure=readableError(error); }
  finally { busy=false; root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[data-was-disabled]').forEach(b=>{b.disabled=b.dataset.wasDisabled==='true';delete b.dataset.wasDisabled;});updateBanners(); }
}
function updateBanners():void {
  const area=$('#messages');
  if(area) area.innerHTML=`${failure?`<div class="message error" role="alert">${escape(failure)}</div>`:''}${notice?`<div class="message success" role="status">${escape(notice)}</div>`:''}${saveBlocked?`<div class="message error">本次记录尚未成功保存。请保留此页面，点击重试保存；保存成功后再继续。${button('retry-save','重试保存','secondary')}</div>`:''}`;
  if(saveBlocked){
    root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('main button,main input,main select,main textarea').forEach(b=>{b.disabled=true;});
    document.getElementById('retry-save')?.addEventListener('click',()=>void act(async()=>{await persist();render();}));
  }
}
async function persist():Promise<void> {
  if(!record) return;
  const snapshot=structuredClone(record);
  const current=saveQueue.catch(()=>undefined).then(()=>saveSession(snapshot));
  saveQueue=current;
  try { await current; saveBlocked=false; }
  catch(error) { saveBlocked=true; throw new Error(`保存未完成：${readableError(error)}`); }
}
async function transition(phase:SessionRecord['phase']):Promise<void> {
  if(!record) return;
  record.phase=phase;record.uiDraft=undefined;historyStage=null;researcherOpen=false;notice='';
  event(record,'phase-transition',{phase,stroopKind,symptomIndex});
  await persist();render();
}
function stageIndex():number {
  const p=record?.phase??'learning';
  if(p.startsWith('learning'))return 0;
  if(p==='symptoms')return 1;
  if(p.startsWith('stroop'))return 2+STROOP.indexOf(stroopKind);
  if(p.startsWith('delay'))return 5;
  if(p.startsWith('symbol'))return 6;
  return 7;
}
function stageSkipped(index:number):boolean {return !!record?.events.some(e=>e.kind==='step-skipped'&&e.details?.stage===index);}
function captureDraft():void {
  if(!record||screen!=='session'||historyStage!==null)return;
  if(record.phase==='symptoms'){
    const key=SYMPTOM_ITEMS[symptomIndex].key;
    if(symptomDraft[key]!==undefined)event(record,'symptom-answer',{key,value:symptomDraft[key]});
    event(record,'symptom-position',{index:symptomIndex});
  }
  const values:Record<string,string|boolean>={};
  root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('main input[id],main select[id],main textarea[id]').forEach(el=>{
    values[el.id]=el instanceof HTMLInputElement&&el.type==='checkbox'?el.checked:el.value;
  });
  record.uiDraft={phase:record.phase,stroopKind,symptomIndex,values};
}
function restoreDraft():void {
  const d=record?.uiDraft;if(screen!=='session'||historyStage!==null||!d||d.phase!==record?.phase||d.stroopKind!==stroopKind||(record.phase==='symptoms'&&d.symptomIndex!==symptomIndex))return;
  for(const [id,value] of Object.entries(d.values)){
    const el=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;
    if(!el)continue;
    if(el instanceof HTMLInputElement&&el.type==='checkbox')el.checked=Boolean(value);else el.value=String(value);
  }
}
function navigation():string {
  const inSession=screen==='session'&&record!==null;
  const index=historyStage??stageIndex();
  const previous=inSession&&(index>0||(record?.phase==='symptoms'&&symptomIndex>0));
  const skip=inSession&&historyStage===null&&record?.status==='in-progress'&&index<7;
  return `<nav id="assessment-navigation" class="task-navigation" aria-label="页面导航">${button('nav-home','返回主页','secondary',screen==='home')}${button('nav-prev','返回上一步','secondary',!previous)}${button('nav-skip','跳过这一步','secondary',!skip)}</nav>`;
}
async function abandonActiveForNavigation():Promise<void> {
  if(!record||record.status!=='in-progress')return;
  const r=record;
  if(r.phase==='stroop-running'){
    stopClock();const run=structuredClone(r.stroop[stroopKind]);
    event(r,'task-navigation-abandon',{task:`stroop-${stroopKind}`,data:run,elapsedMs:performance.now()-timerStart});
    event(r,'stroop-abandoned',{kind:stroopKind});
    r.stroop[stroopKind]=null;r.phase='stroop-ready';r.qc=9;
    r.notes=[r.notes,'曾主动离开计时中的颜色任务，原始尝试见事件记录。'].filter(Boolean).join('；');
  }else if(r.phase==='symbol-running'){
    symbolGeneration++;symbolController?.stop();symbolController=null;stopClock();
    event(r,'task-navigation-abandon',{task:'symbol',data:structuredClone(r.symbol)});
    r.symbol={seed:crypto.randomUUID(),startedAt:null,endedAt:null,trials:[]};r.phase='symbol-ready';r.qc=9;
    r.notes=[r.notes,'曾主动离开计时中的符号搜索，原始尝试见事件记录。'].filter(Boolean).join('；');
  }
}
async function leaveForHome():Promise<void> {
  if(saveBlocked)throw new Error('请先重试保存，再返回主页。');
  captureDraft();await abandonActiveForNavigation();stopClock();historyStage=null;
  if(record){event(record,'navigation-home',{phase:record.phase});await persist();resumeId=record.status==='in-progress'?record.sessionId:null;}
  screen='home';notice='已有记录已保存，可从主页继续本次测评。';render();
}
async function previousStep():Promise<void> {
  if(!record)return;
  if(saveBlocked)throw new Error('请先重试保存，再返回上一步。');
  captureDraft();await abandonActiveForNavigation();
  if(historyStage===null&&record.phase==='symptoms'&&symptomIndex>0){
    symptomIndex--;record.uiDraft=undefined;event(record,'symptom-position',{index:symptomIndex});await persist();render();return;
  }
  const index=historyStage??stageIndex();if(index<=0)return;
  stopClock();historyStage=index-1;event(record,'navigation-history',{stage:historyStage});await persist();render();
}
async function advanceFromSkippedStage(stage:number):Promise<void> {
  if(stage===0){symptomIndex=0;await transition('symptoms');}
  else if(stage===1){stroopKind='w';await transition('stroop-ready');}
  else if(stage>=2&&stage<=4){if(stage<4){stroopKind=STROOP[stage-1];await transition('stroop-ready');}else await transition('delay-wait');}
  else if(stage===5)await transition('symbol-ready');
  else{record!.status='completed';record!.endedAt=new Date().toISOString();await transition('review');}
}
async function skipStep():Promise<void> {
  if(!record||record.status!=='in-progress')return;
  if(saveBlocked)throw new Error('请先重试保存，再跳过。');
  const stage=stageIndex(),partialSymbol=stage===6?structuredClone(record.symbol):null;captureDraft();await abandonActiveForNavigation();stopClock();
  if(partialSymbol){partialSymbol.endedAt=new Date().toISOString();record.symbol=partialSymbol;}
  if(stage===0&&record.phase==='learning-score'&&record.memory.rounds.at(-1)?.correct!==null&&record.memory.rounds[0]?.correct!==null){event(record,'navigation-next',{stage});await advanceFromSkippedStage(stage);return;}
  if(stage===1){
    const item=SYMPTOM_ITEMS[symptomIndex];symptomDraft[item.key]=null;event(record,'symptom-skipped',{key:item.key});
    event(record,'symptom-answer',{key:item.key,value:null});
    record.uiDraft=undefined;record.qc=9;record.reason=[record.reason,`跳过：${item.title}`].filter(Boolean).join('；');
    if(symptomIndex<4){symptomIndex++;event(record,'symptom-position',{index:symptomIndex});await persist();render();return;}
    record.symptoms=completeSymptoms();
  }else event(record,'step-skipped',{stage,name:STAGE_NAMES[stage],reason:'研究者选择跳过'});
  record.qc=9;if(stage!==1)record.reason=[record.reason,`跳过：${STAGE_NAMES[stage]}`].filter(Boolean).join('；');
  await advanceFromSkippedStage(stage);
}
function completeSymptoms():Symptoms {
  return Object.fromEntries(SYMPTOM_ITEMS.map(item=>[item.key,symptomDraft[item.key]??null])) as unknown as Symptoms;
}
function renderHistory():void {
  const r=record!,index=historyStage!;let body='';
  if(index===0){const d=derived(r);body=`<p>首次即时回忆：${number(d.immediate)} / 3；学习 ${r.memory.rounds.length} 轮。</p><p>已保存的首轮回答保持不变，返回查看不会重新播放词语。</p>`;}
  else if(index===1)body=`<div class="symptom-summary">${SYMPTOM_ITEMS.map(item=>`<span>${item.title} ${r.symptoms?.[item.key]??symptomDraft[item.key]??'未记录'}</span>`).join('')}</div>`;
  else if(index>=2&&index<=4){const run=r.stroop[STROOP[index-2]];body=`<p>正确数：${run?.correct??'未记录'}；返回首项次数：${run?.repeatCount??'未记录'}。</p><p>已完成任务仅查看原始记录，不自动重新计时。</p>`;}
  else if(index===5)body=`<p>延迟回忆：${number(derived(r).delayed)} / 3；实际延迟 ${number(derived(r).delay_sec,1)} 秒。</p>`;
  else body=summaryTable(r);
  shell(`${title('返回查看',STAGE_NAMES[index])}<section class="panel">${body}<div class="actions">${button('resume-current','返回当前进度')}</div></section>`);
  bind('resume-current',()=>{historyStage=null;render();});
}
function header():string {
  const r=record;
  return `<header class="app-header"><div class="brand"><span class="brand-mark" aria-hidden="true">＋</span><div><strong>认知每日测评</strong><span>院内研究者指导版</span></div></div><div class="header-right">${screen==='session'&&r?`<span class="id-chip">${escape(r.id)} · 第${r.day}日</span><span class="mode-badge ${r.mode}">${r.mode==='simulation'?'模拟测评':'正式资料'}</span>`:`<span class="status-dot ${cacheReady?'ready':''}">${cacheReady?'离线资源已准备':'尚未完成离线准备'}</span>`}</div></header>`;
}
function shell(body:string,extra=''):void {
  document.body.classList.toggle('stroop-active',screen==='session'&&historyStage===null&&record?.phase==='stroop-running');
  root.innerHTML=`${header()}${navigation()}<div id="messages" class="messages" aria-live="polite"></div><main class="main ${extra}">${body}</main><footer class="app-footer"><span>资料保存在本台平板 · 测完请导出转存</span><span>版本 ${escape(APP_VERSION)}</span></footer><div class="portrait-notice"><strong>建议横屏</strong><span>旋转后可继续测评。</span></div>`;
  bind('nav-home',leaveForHome);bind('nav-prev',previousStep);bind('nav-skip',skipStep);restoreDraft();
  updateBanners();
  // Freshly rendered controls must stay disabled until the current audio/save
  // action settles, otherwise a quick tap is silently ignored by act().
  if(busy)root.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('button,input,select,textarea').forEach(b=>{b.dataset.wasDisabled=String(b.disabled);b.disabled=true;});
}
function title(kicker:string,heading:string,description=''):string {
  return `<div class="page-title"><span class="eyebrow">${kicker}</span><h1>${heading}</h1>${description?`<p>${description}</p>`:''}</div>`;
}
function render():void {
  if(screen==='session'&&historyStage!==null&&record)renderHistory();
  else if(screen==='home') renderHome();
  else if(screen==='acceptance') renderAcceptance();
  else if(screen==='records') renderRecords();
  else renderSession();
}
function renderHome():void {
  const accepted=acceptanceComplete(acceptance);
  shell(`${title('开始前','今天的认知测评','由研究者陪同完成。请先确认研究编号和观察日。')}<div class="home-grid"><section class="panel"><form id="setup-form"><div class="mode-options"><label><input type="radio" name="mode" value="simulation" ${setup.mode==='simulation'?'checked':''}>模拟测评</label><label><input type="radio" name="mode" value="formal" ${setup.mode==='formal'?'checked':''}>正式资料</label></div><label class="field-label" for="research-id">沿用的研究编号</label><input id="research-id" autocomplete="off" maxlength="40" value="${escape(setup.id)}" placeholder="例如 P001"><div class="field-row"><div><label class="field-label" for="day">实际观察日</label><select id="day">${Array.from({length:7},(_,i)=>`<option value="${i+1}" ${setup.day===i+1?'selected':''}>第 ${i+1} 日</option>`).join('')}</select></div><div><label class="field-label" for="first-date">首次EMA日期</label><input id="first-date" type="date" value="${setup.firstDate}"></div></div><p class="field-help">已保存的7日词语安排将继续沿用。同编号同日的正式记录直接打开，不重复测评。</p><div class="actions">${button('start-session','检查并开始测评','primary',!storageReady||(setup.mode==='formal'&&!accepted))}</div>${!accepted?'<p class="attention">正式采集需先完成本版本的设备验收。现在可以进行模拟测评。</p>':''}</form></section><aside class="panel prepare-panel"><h2>使用前准备</h2><ol class="preparation-list"><li>横放平板，调好音量。</li><li>关闭自动锁屏，准备纸笔。</li><li>加载全部资源，再测试断网。</li></ol><p id="offline-progress" class="field-help">${cacheReady?'资源已缓存，仍需按验收说明验证断网重开。':'请在联网时点击下方按钮。'}</p>${button('prepare-offline','准备离线资源','secondary')}${button('open-acceptance',accepted?'查看设备验收':'设备验收清单','text')}${button('open-records','查看本地测评记录','text')}</aside></div>`);
  const form=document.getElementById('setup-form')!;
  form.addEventListener('submit',e=>e.preventDefault());
  const capture=()=>{setup={id:(document.getElementById('research-id') as HTMLInputElement).value.trim(),day:Number((document.getElementById('day') as HTMLSelectElement).value),firstDate:(document.getElementById('first-date') as HTMLInputElement).value,mode:(root.querySelector('input[name="mode"]:checked') as HTMLInputElement).value as Mode};};
  form.addEventListener('change',()=>{capture();const b=document.getElementById('start-session') as HTMLButtonElement;b.disabled=!storageReady||(setup.mode==='formal'&&!accepted);});
  bind('start-session',async()=>{capture();await beginSession();});
  bind('prepare-offline',async()=>{cacheReady=await prepareOffline(message=>{const p=$('#offline-progress');if(p)p.textContent=message;});notice=cacheReady?'资源准备完成。请再按清单验证断网重开。':'资源尚未全部准备完成，请保持联网后重试。';render();});
  bind('open-acceptance',()=>{screen='acceptance';notice='';render();});
  bind('open-records',async()=>{records=await allSessions();screen='records';notice='';render();});
  if(resumeId){
    const formPanel=document.getElementById('setup-form')?.parentElement;
    formPanel?.insertAdjacentHTML('beforeend',`<div class="actions">${button('resume-session','继续刚才的测评','secondary')}</div>`);
    const resumeButton=document.getElementById('resume-session') as HTMLButtonElement;
    if(busy){resumeButton.dataset.wasDisabled='false';resumeButton.disabled=true;}
    bind('resume-session',async()=>{if(resumeId)await openRecord(resumeId,true);});
  }
}
async function preloadCards():Promise<void> {
  await Promise.all(Object.values(CARD_FILES).map(file=>new Promise<void>((resolve,reject)=>{const img=new Image();img.onload=()=>resolve();img.onerror=()=>reject(new Error('卡片未加载完成，请先联网准备资源。'));img.src=cardUrl(file);})));
}
async function beginSession():Promise<void> {
  if(!setup.id||!/^[-A-Za-z0-9_]{1,40}$/.test(setup.id)) throw new Error('研究编号请使用字母、数字、短横线或下划线，不填写姓名或电话。');
  if(setup.mode==='formal'&&!acceptanceComplete(acceptance)) throw new Error('请先完成本版本的平板验收，再采集正式资料。');
  if(setup.mode==='formal'&&!await offlineReady()) throw new Error('请先联网准备离线资源。');
  const existing=await allSessions();
  if(setup.mode==='formal') {
    const same=existing.filter(r=>r.mode==='formal'&&r.id===setup.id&&r.day===setup.day);
    if(same.length){await openRecord(same[0].sessionId);notice='已打开这位患者本日的原记录。';updateBanners();return;}
  }
  await memoryAudio.prepare();await preloadCards();
  let plan=await getPlan(setup.id,setup.mode);
  if(plan&&plan.firstEmaDate!==setup.firstDate) throw new Error(`该编号首次EMA日期已保存为${plan.firstEmaDate}，请按原日期填写。`);
  if(!plan){plan=generatePlan(setup.id,setup.mode,setup.firstDate);await putPlan(plan);}
  record=makeSession(plan,setup.day);event(record,'session-start');
  await persist();screen='session';historyStage=null;resumeId=record.sessionId;readonlyRecord=false;downloaded=false;downloadConfirmed=false;symptomIndex=0;symptomDraft={};researcherOpen=false;render();
}
function renderAcceptance():void {
  const rows:[keyof Pick<Acceptance,'audio'|'cards'|'timing'|'offline'|'export'>,string,string][]=[
    ['audio','词语音频','试听普通话声音、12个词语和提示音；确认无漏音、重音或明显音量差。'],
    ['cards','卡片显示','本台平板横屏显示三张原卡；50项完整可辨，颜色与原材料一致。'],
    ['timing','计时与评分','用模拟测评核对3～5分钟延迟、三段45秒计时，以及12题逐题反应时。'],
    ['offline','断网重开','准备资源后关闭手机热点和浏览器，再打开页面；完成模拟测评和导出。'],
    ['export','导出转存','模拟ZIP下载到平板，打开并转存电脑；核对JSON、CSV与页面原记录。'],
  ];
  shell(`${title('研究者操作','本台平板验收','请实际完成每项检查后再勾选。更新测评程序版本后需重新验收。')}<section class="panel acceptance-panel"><div class="material-audit"><h2>研究者音频试听</h2><p class="field-help">在没有患者参与时，按下面的次序核对12词：${WORD_CATEGORIES.flat().map(word=>escape(word.text)).join('、')}。</p><div class="actions">${button('preview-words','试听12个固定词语','secondary')}${button('preview-delayed','试听回忆指导语','secondary')}${button('preview-stop','试听结束提示','text')}</div></div><div class="acceptance-list">${rows.map(([key,name,description])=>`<label class="acceptance-row"><input type="checkbox" data-acceptance="${key}" ${acceptance[key]?'checked':''}><span><strong>${name}</strong><span>${description}</span></span></label>`).join('')}</div><p class="field-help">这些勾选是研究者的确认记录，程序不会自动替你判定平板通过验收。</p><div class="actions">${button('save-acceptance','保存验收记录')}${button('home','返回开始页','secondary')}</div>${acceptance.approvedAt?`<p class="field-help">上次确认：${escape(localDateTime(acceptance.approvedAt))} · ${escape(acceptance.appVersion)}</p>`:''}</section>`);
  bind('preview-words',async()=>{await memoryAudio.playWords(WORD_CATEGORIES.flat());notice='12词试听已结束，请按实际听到的声音确认。';});
  bind('preview-delayed',async()=>{await memoryAudio.playCue('delayed');notice='回忆指导语试听已结束。';});
  bind('preview-stop',async()=>{await memoryAudio.playCue('stop');notice='结束提示试听已结束。';});
  bind('save-acceptance',async()=>{const next=emptyAcceptance();root.querySelectorAll<HTMLInputElement>('[data-acceptance]').forEach(input=>{next[input.dataset.acceptance as 'audio'|'cards'|'timing'|'offline'|'export']=input.checked;});if(acceptanceComplete(next))next.approvedAt=new Date().toISOString();await saveAcceptance(next);acceptance=next;notice=acceptanceComplete(next)?'本版本验收确认已保存。':'已保存当前检查进度，未完成前继续使用模拟测评。';render();});
  bind('home',()=>{screen='home';notice='';render();});
}
function renderRecords():void {
  const sorted=[...records].sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  shell(`${title('研究者操作','本地测评记录','原始记录保留在本台设备，可打开查看并导出。')}<section class="panel"><div class="actions top-actions">${button('home','返回开始页','secondary')}</div>${sorted.length?`<div class="record-list">${sorted.map(r=>`<button class="record-row" data-session="${escape(r.sessionId)}"><span><strong>${escape(r.id)} · 第${r.day}日</strong><span>${escape(localDateTime(r.startedAt))}</span></span><span class="record-tags"><span class="mode-badge ${r.mode}">${r.mode==='simulation'?'模拟':'正式'}</span><span class="state-tag ${r.status}">${r.status==='completed'?'已完成':r.status==='interrupted'?'已中断':'未完成'}</span><span aria-hidden="true">›</span></span></button>`).join('')}</div>`:'<p class="empty-state">暂无本地记录。可以先进行一次模拟测评。</p>'}</section>`);
  bind('home',()=>{screen='home';notice='';render();});
  root.querySelectorAll<HTMLButtonElement>('[data-session]').forEach(b=>b.addEventListener('click',()=>void act(()=>openRecord(b.dataset.session!))));
}
async function openRecord(sessionId:string,internalNavigation=false):Promise<void> {
  const found=await loadSession(sessionId);if(!found)throw new Error('未找到这条记录。');
  record=found;screen='session';historyStage=null;resumeId=found.status==='in-progress'?found.sessionId:null;researcherOpen=false;downloaded=false;downloadConfirmed=false;saveBlocked=false;
  const memoryInProgress=found.status==='in-progress'&&found.memory.delayCueAt===null&&found.memory.rounds.length>0;
  const pendingPlayback=found.events.some((item,index)=>item.kind==='word-playback-pending'&&
    !found.events.slice(index+1).some(later=>later.kind==='word-playback-end'&&later.details?.round===item.details?.round));
  const pendingStroop=found.events.some((item,index)=>item.kind==='stroop-pending'&&
    !found.events.slice(index+1).some(later=>(later.kind==='stroop-end'||later.kind==='stroop-abandoned')&&later.details?.kind===item.details?.kind));
  let pageLeft=false;try{pageLeft=localStorage.getItem(`ema-reopen:${found.sessionId}`)!==null;}catch{/* The durable pending event remains the primary evidence. */}
  const running=found.phase==='stroop-running'||found.phase==='symbol-running'||found.phase==='delayed-recall'||
    (found.phase==='learning'&&found.memory.rounds.length>0&&found.memory.rounds.at(-1)?.answerEndedAt===null);
  const samePageResume=internalNavigation&&found.timeOrigin===performance.timeOrigin&&!pageLeft;
  if(found.status==='in-progress'&&((running&&!samePageResume)||pendingPlayback||pendingStroop||(memoryInProgress&&found.timeOrigin!==performance.timeOrigin)||
    (pageLeft&&found.phase==='learning'))){await interrupt('页面重新打开，原计时流程已终止。');return;}
  readonlyRecord=found.status!=='in-progress';
  if(found.status==='in-progress') {
    if(found.phase==='symptoms'){
      symptomDraft=found.symptoms??{};
      for(const item of found.events){if(item.kind==='symptom-answer'&&item.details){const key=item.details.key as keyof Symptoms;const value=item.details.value===null?null:Number(item.details.value);if(SYMPTOM_ITEMS.some(s=>s.key===key)&&(value===null||(value>=1&&value<=5)))symptomDraft[key]=value;}}
      symptomIndex=SYMPTOM_ITEMS.findIndex(item=>symptomDraft[item.key]===undefined);if(symptomIndex<0)symptomIndex=4;
      const position=[...found.events].reverse().find(e=>e.kind==='symptom-position');if(position&&Number.isInteger(position.details?.index))symptomIndex=Number(position.details!.index);
    }
    if(found.phase==='stroop-ready'||found.phase==='stroop-score')stroopKind=STROOP.find((k,i)=>!stageSkipped(i+2)&&(found.stroop[k]===null||found.stroop[k]!.correct===null))??'cw';
  }
  event(found,'program-open',{runtimeVersion:APP_VERSION});
  if(found.status==='in-progress')await persist();
  render();
}
function phaseNumber():number {
  const p=record?.phase;
  if(p==='learning'||p==='learning-score')return 1;
  if(p==='symptoms')return 2;
  if(p?.startsWith('stroop'))return 3;
  if(p==='delay-wait'||p==='delayed-recall'||p==='delayed-score')return 4;
  if(p?.startsWith('symbol'))return 5;
  return 6;
}
function steps():string {
  const names=['词语学习','当前感受','颜色任务','延迟回忆','符号搜索','核对导出'];const n=phaseNumber();
  return `<nav class="steps" aria-label="测评进度">${names.map((name,i)=>`<span class="step ${i+1===n?'current':i+1<n?'done':''}"><span>${i+1<n?'✓':i+1}</span>${name}</span>`).join('')}</nav>`;
}
function operatorGate(body:string):string {
  if(researcherOpen)return `<div class="operator-banner">研究者录入 · 请将屏幕转向研究者</div>${body}`;
  return `<section class="panel operator-gate"><div class="gate-icon" aria-hidden="true">✓</div><h2>这一部分已完成</h2><p>请稍候，由研究者记录回答。</p>${button('open-researcher','研究者：打开评分录入','secondary')}</section>`;
}
function gateBind():void {bind('open-researcher',()=>{researcherOpen=true;render();});}
function wordCheckboxes(idPrefix:string,checked:CorrectWords|null=null):string {
  const words=record!.plan.days[record!.day-1].words;
  return `<div class="word-score">${words.map((word,i)=>`<label class="word-check"><input id="${idPrefix}-${i}" type="checkbox" ${checked?.[i]?'checked':''}><span><small>第${i+1}词</small><strong>${escape(word.text)}</strong><span>首次自由回答正确</span></span></label>`).join('')}</div>`;
}
function readWordChecks(prefix:string):CorrectWords {return [0,1,2].map(i=>(document.getElementById(`${prefix}-${i}`) as HTMLInputElement).checked) as CorrectWords;}
function renderSession():void {
  if(!record){screen='home';render();return;}
  if(record.status==='interrupted'){renderInterrupted();return;}
  if(readonlyRecord||record.phase==='review'||record.phase==='finished'){renderReview();return;}
  if(record.phase==='learning')renderLearning();
  else if(record.phase==='learning-score')renderLearningScore();
  else if(record.phase==='symptoms')renderSymptoms();
  else if(record.phase==='stroop-ready')renderStroopReady();
  else if(record.phase==='stroop-running')renderStroopRunning();
  else if(record.phase==='stroop-score')renderStroopScore();
  else if(record.phase==='delay-wait')renderDelayWait();
  else if(record.phase==='delayed-recall')renderDelayedRecall();
  else if(record.phase==='delayed-score')renderDelayedScore();
  else if(record.phase==='symbol-ready')renderSymbolReady();
  else if(record.phase==='symbol-running')renderSymbolRunning();
}
function renderLearning():void {
  const rounds=record!.memory.rounds;const current=rounds.at(-1);
  const awaiting=!!current&&!current.answerEndedAt&&!!current.playbackEndedAt;
  shell(`${steps()}${title('第一部分','请听三个词语','听完后，请说出刚才听到的三个词语。顺序不限。')}<section class="panel centered"><div class="audio-orb ${learningPlaying?'playing':''}" aria-hidden="true">♪</div><h2>${learningPlaying?'正在播放，请仔细听':awaiting?'请自由说出三个词语':'准备好后，开始播放'}</h2><p class="soft-text">${rounds.length?`第${rounds.length+(awaiting||learningPlaying?0:1)}轮学习`:'第1轮学习'}</p><div class="actions centered-actions">${awaiting?button('answer-ended','研究者：回答结束'):button('play-words',learningPlaying?'播放中…':'播放词语','primary',learningPlaying||saveBlocked)}</div><p class="field-help">研究者在口头回答结束时立即点击，不等待纸上记分。</p></section>`);
  bind('play-words',playLearning);
  bind('answer-ended',async()=>{const round=record!.memory.rounds.at(-1)!;round.answerEndedAt=new Date().toISOString();round.answerEndedMonoMs=performance.now();event(record!,'immediate-answer-ended',{round:round.n},round.answerEndedMonoMs);await transition('learning-score');});
}
async function playLearning():Promise<void> {
  if(!record||learningPlaying||record.memory.rounds.length>=MAX_LEARNING_ROUNDS)return;
  const session=record;const n=session.memory.rounds.length+1;learningPlaying=true;render();
  let startSaved:Promise<void>|null=null;
  try {
    event(session,'word-playback-pending',{round:n});await persist();
    if(session.status!=='in-progress')return;
    await memoryAudio.playWords(session.plan.days[session.day-1].words,()=>{
      if(session.status!=='in-progress')return;
      session.memory.rounds.push({n,playbackStartedAt:new Date().toISOString(),playbackEndedAt:'',answerEndedAt:null,answerEndedMonoMs:null,correct:null});event(session,'word-playback-start',{round:n});
      startSaved=persist();void startSaved.catch(()=>undefined);
    },()=>{const round=session.memory.rounds.at(-1);if(session.status==='in-progress'&&round){round.playbackEndedAt=new Date().toISOString();event(session,'word-playback-end',{round:n});}});
    if(startSaved)await startSaved;
    if(session.status==='in-progress')await persist();
  } catch(error) {
    if(session.status==='in-progress'){await interrupt(`词语播放未完成：${readableError(error)}`);throw error;}
  } finally {learningPlaying=false;render();}
}
function renderLearningScore():void {
  const round=record!.memory.rounds.at(-1)!;
  if(round.correct!==null){renderLearningDecision();return;}
  const body=`<section class="panel"><h2>第${round.n}轮即时回答</h2><p>按纸上记录逐词勾选正确项。未勾选计0分。</p>${wordCheckboxes('immediate')}<p class="field-help">第1轮回答是正式即时回忆成绩，后续学习不会覆盖它。</p><div class="actions">${button('save-round','保存本轮评分','primary',saveBlocked)}</div></section>`;
  shell(`${steps()}${title('研究者操作','记录即时回答')}${operatorGate(body)}`);gateBind();
  bind('save-round',async()=>{scoreRound(record!,round.n,readWordChecks('immediate'));await persist();renderLearningDecision();});
}
function renderLearningDecision():void {
  const r=record!;const last=r.memory.rounds.at(-1)!;
  const repeat=mayRepeat(r);researcherOpen=true;
  shell(`${steps()}${title('研究者操作','本轮评分已保存')}<section class="panel"><p class="score-callout">本轮正确 ${last.correct!.filter(Boolean).length} / 3 词</p><p>${last.correct!.every(Boolean)?'三个词语均已正确复述，可以继续。':repeat?'如需继续学习，可再次播放同组词语。':'已达到6轮学习上限，请继续后续部分。'}</p><div class="actions">${repeat?button('repeat-learning','再次学习同组词语','secondary'):''}${button('continue-symptoms','继续：当前感受')}</div></section>`);
  bind('repeat-learning',async()=>{await transition('learning');});
  bind('continue-symptoms',async()=>{symptomIndex=0;symptomDraft={};await transition('symptoms');});
}
function renderSymptoms():void {
  const item=SYMPTOM_ITEMS[symptomIndex];const selected=symptomDraft[item.key];
  shell(`${steps()}${title(`当前感受 ${symptomIndex+1} / 5`,item.question)}<section class="panel"><div class="symptom-slider-panel"><div id="slider-current" class="slider-current ${selected?'':'unselected'}" aria-live="polite">${selected?`<span class="slider-score">${selected}</span><span>${item.labels[selected-1]}</span>`:'请滑动圆点选择程度'}</div><input type="range" id="symptom-slider" min="1" max="5" step="1" value="${selected??3}" aria-label="${escape(item.question)}" aria-valuetext="${selected?escape(item.labels[selected-1]):'尚未作答'}" style="--slider-progress:${((selected??3)-1)*25}%"><div class="slider-labels">${item.labels.map((label,i)=>`<span data-slider-label="${i+1}" class="${selected===i+1?'selected':''}"><span class="slider-number">${i+1}</span><span>${label}</span></span>`).join('')}</div><p class="slider-help">拖动圆点到与你感受对应的位置。</p></div><div class="actions">${button('symptom-next',symptomIndex===4?'保存并继续':'下一项','primary',!selected||saveBlocked)}</div><p class="field-help">睡眠一项询问昨晚。中间圆点只是起始位置，需触摸选择后才记录。</p></section>`);
  const slider=document.getElementById('symptom-slider') as HTMLInputElement;
  const select=()=>{
    const value=Number(slider.value);symptomDraft[item.key]=value;slider.style.setProperty('--slider-progress',`${(value-1)*25}%`);slider.setAttribute('aria-valuetext',item.labels[value-1]);
    const label=document.getElementById('slider-current')!;label.classList.remove('unselected');label.innerHTML=`<span class="slider-score">${value}</span><span>${item.labels[value-1]}</span>`;
    root.querySelectorAll<HTMLElement>('[data-slider-label]').forEach(el=>el.classList.toggle('selected',Number(el.dataset.sliderLabel)===value));
    const next=document.getElementById('symptom-next') as HTMLButtonElement;next.disabled=saveBlocked||busy;
  };
  slider.addEventListener('input',select);slider.addEventListener('pointerup',select);slider.addEventListener('keyup',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key))select();});
  bind('symptom-next',async()=>{if(!symptomDraft[item.key])return;event(record!,'symptom-answer',{key:item.key,value:symptomDraft[item.key]});record!.uiDraft=undefined;if(symptomIndex<4){symptomIndex++;event(record!,'symptom-position',{index:symptomIndex});await persist();render();return;}record!.symptoms=completeSymptoms();event(record!,'symptoms-recorded');stroopKind='w';await transition('stroop-ready');});
}
function renderStroopReady():void {
  const instruction=stroopKind==='w'?'请从左到右逐行读出每个字。':stroopKind==='c'?'请从左到右逐行说出色块的颜色。':'请说出字的颜色，不读字本身。';
  shell(`${steps()}${title(`颜色任务 ${STROOP.indexOf(stroopKind)+1} / 3`,CARD_NAMES[stroopKind],instruction)}<section class="panel centered"><div class="timer-preset">45<span>秒</span></div><p>读完一张卡片后，回到第一个项目继续，直到提示结束。</p><div class="actions centered-actions">${button('start-stroop','准备好了，开始','primary',saveBlocked)}</div>${stroopKind==='w'?button('show-practice','首次说明：查看示范图','text'):''}<p class="field-help">研究者纸上计数，错误时简短提示，计时继续。</p></section>`);
  bind('start-stroop',startStroop);
  bind('show-practice',()=>{shell(`${title('首次说明与示范','请说出字的颜色')}<section class="panel centered"><img class="practice-image" src="${cardUrl('CW-practice.png')}" alt="四项Stroop说明示范图"><p>这张图仅供说明和示范，不加入每日正式评分。</p>${button('close-practice','返回正式任务准备页','secondary')}</section>`);bind('close-practice',renderStroopReady);});
}
async function holdScreen():Promise<void> {
  try {const n=navigator as Navigator&{wakeLock?:{request:(kind:string)=>Promise<{release:()=>Promise<void>}>}};wakeLock=await n.wakeLock?.request('screen')??null;}catch{/* The manual setup still asks to disable automatic locking. */}
}
function stopClock():void {if(timer!==null){window.clearInterval(timer);timer=null;}void wakeLock?.release().catch(()=>undefined);wakeLock=null;}
async function startStroop():Promise<void> {
  const r=record!;await holdScreen();
  try{await memoryAudio.playCue('start');}catch(error){stopClock();throw error;}
  if(document.hidden||window.innerHeight>window.innerWidth){stopClock();throw new Error('请返回页面并横放平板后，再开始颜色任务。');}
  if(r.status!=='in-progress')return;
  event(r,'stroop-pending',{kind:stroopKind});await persist();
  if(r.status!=='in-progress')return;
  r.stroop[stroopKind]={startedAt:new Date().toISOString(),endedAt:null,durationMs:null,correct:null,repeatCount:null};r.phase='stroop-running';
  timerDeadline=performance.now()+STROOP_MS;render();
  await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  if(r.status!=='in-progress')return;
  timerStart=performance.now();timerDeadline=timerStart+STROOP_MS;r.stroop[stroopKind]!.startedAt=new Date().toISOString();
  event(r,'stroop-start',{kind:stroopKind,durationMs:STROOP_MS},timerStart);
  try{await persist();}catch(error){await interrupt('颜色任务开始记录未能保存。');throw error;}
  if(r.status!=='in-progress')return;
  timer=window.setInterval(()=>{const remaining=Math.max(0,timerDeadline-performance.now());const label=$('#stroop-time');if(label)label.textContent=`${Math.ceil(remaining/1000)} 秒`;if(remaining===0)void finishStroop();},50);
}
function renderStroopRunning():void {
  shell(`<section class="task-fullscreen"><div class="task-topline"><span>逐行从左到右</span><span id="stroop-time" class="task-timer">${Math.ceil(Math.max(0,timerDeadline-performance.now())/1000)} 秒</span></div><div class="card-stage"><img class="stroop-card" src="${cardUrl(CARD_FILES[stroopKind])}" alt="${CARD_NAMES[stroopKind]}任务矩阵"></div></section>`,'timed-main');
}
async function finishStroop():Promise<void> {
  if(!record||record.phase!=='stroop-running')return;
  stopClock();const mono=performance.now();const run=record.stroop[stroopKind]!;
  run.endedAt=new Date().toISOString();run.durationMs=mono-timerStart;event(record,'stroop-end',{kind:stroopKind},mono);record.phase='stroop-score';researcherOpen=false;render();
  try{await persist();}catch(error){failure=readableError(error);updateBanners();}
  try{await memoryAudio.playCue('stop');}
  catch(error){
    event(record,'stop-cue-failed',{kind:stroopKind,message:readableError(error)});
    failure='结束提示未能播放。卡片已经隐藏，请研究者口头提示停止并检查音量。';
    try{await persist();}catch(saveError){failure+=` ${readableError(saveError)}`;}
    updateBanners();
  }
}
function renderStroopScore():void {
  const body=`<section class="panel"><h2>${CARD_NAMES[stroopKind]}记录</h2><div class="field-row"><div><label class="field-label" for="stroop-correct">正确数</label><input id="stroop-correct" type="number" min="0" step="1" inputmode="numeric" placeholder="填写纸上正确数"></div><div><label class="field-label" for="stroop-repeat">返回首项的次数</label><input id="stroop-repeat" type="number" min="0" step="1" inputmode="numeric" value="0"></div></div><p class="field-help">首次阅读记0次循环；读完后返回首项一次记1。正确数可超过50，同一次项目纠正成功只计一次。</p><div class="actions">${button('save-stroop','保存并继续','primary',saveBlocked)}</div></section>`;
  shell(`${steps()}${title('颜色任务结束','请稍作休息')}${operatorGate(body)}`);gateBind();
  bind('save-stroop',async()=>{const field=document.getElementById('stroop-correct') as HTMLInputElement;if(field.value==='')throw new Error('请填写正确数，正确数为0时填写0。');const correct=Number(field.value),repeatCount=Number((document.getElementById('stroop-repeat') as HTMLInputElement).value);validateStroop(correct,repeatCount);const run=record!.stroop[stroopKind]!;run.correct=correct;run.repeatCount=repeatCount;event(record!,'stroop-score',{kind:stroopKind,correct,repeatCount});const index=STROOP.indexOf(stroopKind);if(index<2){stroopKind=STROOP[index+1];await transition('stroop-ready');}else await transition('delay-wait');});
}
function elapsedDelayMs():number {const anchor=latestAnswerEnd(record!);return anchor===null?0:Math.max(0,performance.now()-anchor);}
function renderDelayWait():void {
  stopClock();const elapsed=elapsedDelayMs();const ready=elapsed>=DELAY_MIN_MS;
  shell(`${steps()}${title('词语回忆','接下来，请回忆刚才的三个词语','研究者会在适当时间开始这一部分。')}<section class="panel centered"><p class="soft-text">距最后一轮即时回答结束</p><div id="delay-clock" class="timer-preset">${Math.floor(elapsed/60000)}:${String(Math.floor(elapsed/1000)%60).padStart(2,'0')}</div><p id="delay-message">${ready?'已达到3分钟，可以开始。':'请稍候，达到3分钟后即可开始。'}</p><div class="delay-reason ${elapsed>DELAY_MAX_MS?'':'hidden'}" id="delay-reason"><label class="field-label" for="deviation-reason">研究者：超过5分钟的原因</label><input id="deviation-reason" maxlength="300" placeholder="例如临床操作打断" value="${escape(record!.memory.delayDeviationReason)}"></div><div class="actions centered-actions">${button('start-delayed','开始延迟回忆','primary',!ready||saveBlocked)}</div></section>`);
  timer=window.setInterval(()=>{const e=elapsedDelayMs();const el=$('#delay-clock');if(el)el.textContent=`${Math.floor(e/60000)}:${String(Math.floor(e/1000)%60).padStart(2,'0')}`;const b=document.getElementById('start-delayed') as HTMLButtonElement|null;if(b)b.disabled=e<DELAY_MIN_MS||saveBlocked||busy;const m=$('#delay-message');if(m)m.textContent=e>=DELAY_MIN_MS?'已达到3分钟，可以开始。':'请稍候，达到3分钟后即可开始。';if(e>DELAY_MAX_MS)$('#delay-reason')?.classList.remove('hidden');},250);
  bind('start-delayed',async()=>{
    if(elapsedDelayMs()<DELAY_MIN_MS)return;
    const session=record!;const reason=(document.getElementById('deviation-reason') as HTMLInputElement).value.trim();
    if(elapsedDelayMs()>DELAY_MAX_MS&&!reason)throw new Error('实际间隔已超过5分钟，请记录原因再继续。');
    session.memory.delayDeviationReason=reason;await persist();stopClock();
    let cueStarted=false;let cueSaved:Promise<void>|null=null;
    try{
      await memoryAudio.playCue('delayed',()=>{
        if(session.status!=='in-progress')return;
        cueStarted=true;session.memory.delayCueAt=new Date().toISOString();session.memory.delayCueMonoMs=performance.now();
        event(session,'delayed-recall-start',undefined,session.memory.delayCueMonoMs);session.phase='delayed-recall';researcherOpen=false;
        cueSaved=persist();void cueSaved.catch(()=>undefined);render();
      });
      if(cueSaved)await cueSaved;
      if(!cueStarted&&session.status==='in-progress')throw new Error('回忆提示未能开始，请检查音量与音频后重试。');
    }catch(error){
      if(cueStarted&&session.status==='in-progress')await interrupt(`延迟回忆提示未能完整播放：${readableError(error)}`);
      else if(session.status==='in-progress')renderDelayWait();
      throw error;
    }
  });
}
function renderDelayedRecall():void {
  shell(`${steps()}${title('词语回忆','请说出刚才学习的三个词语','请尽量回忆，顺序不限。')}<section class="panel centered"><div class="audio-orb" aria-hidden="true">…</div><p>请自由回答。</p><div class="actions centered-actions">${button('delayed-ended','研究者：回答结束','primary',saveBlocked)}</div></section>`);
  bind('delayed-ended',async()=>{event(record!,'delayed-answer-ended');await transition('delayed-score');});
}
function renderDelayedScore():void {
  const body=`<section class="panel"><h2>延迟自由回忆</h2><p>只记录无线索自由回答正确的词语。</p>${wordCheckboxes('delayed')}<div class="actions">${button('save-delayed','保存并继续','primary',saveBlocked)}</div></section>`;
  shell(`${steps()}${title('研究者操作','记录延迟回答')}${operatorGate(body)}`);gateBind();
  bind('save-delayed',async()=>{record!.memory.delayedCorrect=readWordChecks('delayed');event(record!,'delayed-score');await transition('symbol-ready');});
}
function renderSymbolReady():void {
  shell(`${steps()}${title('最后一部分','寻找相同的符号配对','上面有三组配对。请点选下面与其中一组相同的配对。')}<section class="panel centered"><div class="symbol-example" aria-hidden="true"><div><span>◇ ○</span><span>□ ＋</span><span>△ ☆</span></div><div><span>△ ☆</span><span>◇ ＋</span></div></div><p>共12题。请在看清后，尽快点选。</p><div class="actions centered-actions">${button('start-symbol','准备好了，开始','primary',saveBlocked)}</div></section>`);
  bind('start-symbol',async()=>{await holdScreen();record!.phase='symbol-running';record!.symbol.startedAt=new Date().toISOString();event(record!,'symbol-start');await persist();renderSymbolRunning();await launchSymbol();});
}
function renderSymbolRunning():void {
  shell(`<section class="symbol-stage"><div id="symbol-container" class="symbol-container" aria-label="符号搜索任务"></div><p class="symbol-loading">请按说明选择相同的配对。</p></section>`,'timed-main');
}
async function launchSymbol():Promise<void> {
  const r=record!,generation=++symbolGeneration;const container=document.getElementById('symbol-container')!;
  try {
    const controller=await runSymbolSearch(container,{seed:r.symbol.seed,
      onTrial:async(trial)=>{if(generation!==symbolGeneration)return;if(r.status!=='in-progress')throw new Error('本次任务已中断。');r.symbol.trials.push(trial);event(r,'symbol-trial-saved',{trialIndex:trial.trialIndex});await persist();},
      onEnd:async()=>{if(generation!==symbolGeneration||r.status!=='in-progress')return;stopClock();r.symbol.endedAt=new Date().toISOString();r.endedAt=new Date().toISOString();r.status='completed';r.phase='review';event(r,'symbol-end');symbolController=null;researcherOpen=true;await persist();render();},
      onError:async(error)=>{if(generation===symbolGeneration)await interrupt(`符号搜索未完成：${readableError(error)}`);},
      onNavigate:(action)=>act(action==='home'?leaveForHome:action==='previous'?previousStep:skipStep),
    });
    if(generation!==symbolGeneration||r.status!=='in-progress')controller.stop();else symbolController=controller;
  }catch(error){if(generation===symbolGeneration&&r.status==='in-progress')await interrupt(`符号搜索未完成：${readableError(error)}`);throw error;}
}
function number(value:number|null,digits=0):string {return value===null?'缺失':value.toFixed(digits);}
function summaryTable(r:SessionRecord):string {
  const d=derived(r);
  const cells=[['首次即时回忆',`${number(d.immediate)} / 3`],['延迟回忆',`${number(d.delayed)} / 3`],['记忆总分',`${number(d.memory)} / 6`],['学习轮次',String(r.memory.rounds.length)],['实际延迟',d.delay_sec===null?'缺失':`${number(d.delay_sec,1)} 秒`],['Stroop W / C / CW',`${number(d.w)} / ${number(d.c)} / ${number(d.cw)}`],['Stroop IG',number(d.ig,2)],['符号搜索正确数',`${d.ss_correct} / ${d.ss_n}`],['正确试次反应时中位数',d.ss_rt===null?'缺失':`${number(d.ss_rt,1)} 毫秒`],['正确率',d.accuracy===null?'缺失':`${number(d.accuracy*100,1)}%`]];
  return `<dl class="summary-grid">${cells.map(([key,value])=>`<div><dt>${key}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
}
function renderReview():void {
  const r=record!;const eligible=scorable(r);researcherOpen=true;
  shell(`${title('研究者核对',r.status==='completed'?'本次测评已完成':'本次记录核对',`${escape(r.id)} · 第${r.day}日 · ${escape(localDateTime(r.startedAt))}`)}<div class="review-grid"><section class="panel"><div class="operator-banner">研究者页面 · 原始成绩核对</div>${summaryTable(r)}${r.symptoms?`<div class="symptom-summary">${SYMPTOM_ITEMS.map(item=>`<span>${item.title} ${r.symptoms![item.key]}分</span>`).join('')}</div>`:''}<p class="field-help">总体认知标准化评分在分析阶段统一计算。低分、低正确率或反应慢不自动剔除。</p></section><section class="panel"><h2>有效性与保存</h2>${!eligible?'<p class="attention">这条记录存在缺失或中断，暂不能标为有效。请核对原始记录并记录原因。</p>':''}<label class="field-label" for="qc">研究者核查</label><select id="qc"><option value="9" ${r.qc===9?'selected':''}>9 · 待核查</option><option value="1" ${r.qc===1?'selected':''} ${eligible?'':'disabled'}>1 · 有效</option><option value="0" ${r.qc===0?'selected':''}>0 · 无效</option></select><label class="field-label" for="reason">原因说明</label><input id="reason" maxlength="500" value="${escape(r.reason)}" placeholder="标为无效时必填"><label class="field-label" for="notes">其他备注</label><textarea id="notes" maxlength="1000" rows="2">${escape(r.notes)}</textarea><div class="actions">${button('save-review','保存核查')}${button('download','生成并下载ZIP','secondary')}</div><div id="backup-status" class="backup-status"><p>${downloaded?'ZIP已生成并开始下载，请确认设备中的文件。':'尚未在本次页面下载。记录已保存本地，仍需导出转存。'}</p>${downloaded?`<label class="acceptance-row"><input id="confirm-download" type="checkbox" ${downloadConfirmed?'checked':''}><span>我已在平板文件夹中找到并打开该ZIP</span></label>`:''}</div><div class="actions">${button('records','返回记录列表','text')}${button('home','返回开始页','text')}</div></section></div>`);
  const saveReview=async()=>{const qc=Number((document.getElementById('qc') as HTMLSelectElement).value) as 0|1|9;const reason=(document.getElementById('reason') as HTMLInputElement).value.trim();if(qc===1&&!scorable(r))throw new Error('这条记录暂不满足有效条件，请保留待核查或无效。');if(qc===0&&!reason)throw new Error('标为无效时请填写原因。');r.qc=qc;r.reason=reason;r.notes=(document.getElementById('notes') as HTMLTextAreaElement).value.trim();event(r,'researcher-review',{qc,reason});await persist();};
  bind('save-review',async()=>{await saveReview();notice='核查结果已保存本地。';renderReview();});
  bind('download',async()=>{await saveReview();await downloadRecord();renderReview();});
  document.getElementById('confirm-download')?.addEventListener('change',async e=>{downloadConfirmed=(e.target as HTMLInputElement).checked;if(downloadConfirmed){event(r,'download-file-confirmed');try{await persist();notice='已记录平板文件核查，请再转存电脑。';}catch(error){failure=readableError(error);}updateBanners();}});
  bind('records',async()=>{records=await allSessions();screen='records';notice='';render();});
  bind('home',()=>{record=null;screen='home';notice='';render();});
}
async function downloadRecord():Promise<void> {
  const data=await exportSession(record!);const url=URL.createObjectURL(data.blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=data.fileName;document.body.appendChild(anchor);anchor.click();anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60_000);downloaded=true;event(record!,'export-download-requested',{fileName:data.fileName});await persist();notice='已生成ZIP并请求下载。请在平板下载文件夹中核查，生成文件不等于已经备份。';
}
async function interrupt(reason:string):Promise<void> {
  const r=record;if(!r||r.status!=='in-progress')return;
  stopClock();symbolController?.stop();symbolController=null;memoryAudio.stop();learningPlaying=false;
  const time={kind:'interruption',at:new Date().toISOString(),monotonicMs:performance.now(),details:{reason,phase:r.phase}};
  r.events.push(time);r.interruptions.push(time);r.reason=reason;r.status='interrupted';r.phase='interrupted';r.endedAt=time.at;r.qc=9;readonlyRecord=true;
  try{await persist();}catch(error){failure=readableError(error);}render();
}
function renderInterrupted():void {
  const r=record!;
  shell(`${title('测评中断','本次测评已停止','已有数据保留，请由研究者核查。')}<section class="panel"><div class="message error">${escape(r.reason)}</div><p>计时任务不会自动重做或替换原成绩。</p>${summaryTable(r)}<div class="actions">${button('export-interrupted','导出已有记录','secondary')}${button('records','返回记录列表','text')}</div>${saveBlocked?'<p class="attention">请先重试保存；页面中的数据仍暂存于内存。</p>':''}</section>`);
  bind('export-interrupted',async()=>{await downloadRecord();renderInterrupted();});
  bind('records',async()=>{if(saveBlocked)throw new Error('请先重试保存，避免丢失页面中的数据。');records=await allSessions();screen='records';notice='';render();});
}
function activelyTiming():boolean {return screen==='session'&&historyStage===null&&!!record&&record.status==='in-progress'&&['learning','stroop-running','symbol-running','delayed-recall'].includes(record.phase)&&(record.phase!=='learning'||learningPlaying||!!record.memory.rounds.at(-1)?.playbackEndedAt);}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&activelyTiming())void interrupt('测评期间切到后台或锁屏，计时任务已终止。');});
window.addEventListener('pagehide',()=>{if(record?.status==='in-progress'){try{localStorage.setItem(`ema-reopen:${record.sessionId}`,new Date().toISOString());}catch{/* Storage read/write failure is handled when opening the record. */}if(activelyTiming())void interrupt('测评页面关闭或离开，计时任务已终止。');}});
let lastLandscape=window.innerWidth>=window.innerHeight;
function noteOrientation():void {
  const landscape=window.innerWidth>=window.innerHeight;if(landscape===lastLandscape)return;lastLandscape=landscape;
  if(screen==='session'&&record?.status==='in-progress'){
    event(record,'orientation-change',{landscape,width:window.innerWidth,height:window.innerHeight,phase:record.phase,timingContinues:true});
    void persist().catch(error=>{failure=readableError(error);updateBanners();});
  }
}
screenOrientation().addEventListener?.('change',noteOrientation);window.addEventListener('resize',noteOrientation);
window.visualViewport?.addEventListener('resize',()=>{if(activelyTiming()&&window.visualViewport?.scale!==1){event(record!,'viewport-scale-change',{scale:window.visualViewport?.scale});void persist().catch(error=>{failure=readableError(error);updateBanners();});}});
function screenOrientation():EventTarget {return window.screen.orientation??window;}
window.addEventListener('beforeunload',e=>{if(record?.status==='in-progress'||saveBlocked){e.preventDefault();e.returnValue='';}});

async function boot():Promise<void> {
  shell(`${title('准备中','正在读取本地测评资料')}<section class="panel"><p>请稍候…</p></section>`);
  try{await initStorage();storageReady=true;const saved=await getAcceptance();acceptance=saved?.appVersion===APP_VERSION?saved:emptyAcceptance();cacheReady=await offlineReady();render();}
  catch(error){failure=`本地保存暂不可用，不能开始测评：${readableError(error)}`;render();}
}
void boot();
