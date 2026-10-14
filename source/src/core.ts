import { APP_VERSION, MATERIAL_VERSION, SCHEMA_VERSION, WORD_CATEGORIES,
  MAX_LEARNING_ROUNDS, type PatientPlan, type Mode, type SessionRecord,
  type CorrectWords, type Word } from './model';

export function seededRandom(seed: string): () => number {
  let x = 2166136261;
  for (const ch of seed) { x ^= ch.charCodeAt(0); x = Math.imul(x,16777619); }
  return () => { x += 0x6D2B79F5; let t=x; t=Math.imul(t^(t>>>15),t|1);
    t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
}
function shuffle<T>(items: T[], random: () => number): T[] {
  const a=[...items]; for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];} return a;
}
function categorySchedule(words: Word[], random: () => number): Word[] {
  const shuffled=shuffle(words,random); const counts=[2,2,2,1]; const result:number[]=[];
  const build=(): boolean => {
    if(result.length===7) return true;
    for(const i of shuffle([0,1,2,3],random)) {
      if(counts[i]===0 || result.at(-1)===i) continue;
      counts[i]--;result.push(i); if(build()) return true;
      result.pop();counts[i]++;
    } return false;
  };
  if(!build()) throw new Error('无法生成符合规则的词语安排。');
  return result.map(i=>({...shuffled[i]}));
}
export function generatePlan(id: string, mode: Mode, firstEmaDate: string,
  seed: string = crypto.randomUUID()): PatientPlan {
  if(!id.trim()) throw new Error('请填写沿用的研究编号。');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(firstEmaDate)) throw new Error('首次EMA日期格式不正确。');
  const random=seededRandom(seed); const sequences=WORD_CATEGORIES.map(w=>categorySchedule(w,random));
  return {id:id.trim(),mode,seed,firstEmaDate,createdAt:new Date().toISOString(),
    materialVersion:MATERIAL_VERSION,days:Array.from({length:7},(_,i)=>({day:i+1,
      words:[sequences[0][i],sequences[1][i],sequences[2][i]]}))};
}
export function makeSession(plan: PatientPlan, day: number): SessionRecord {
  if(!Number.isInteger(day)||day<1||day>7) throw new Error('观察日应为1～7。');
  return {sessionId:crypto.randomUUID(),schemaVersion:SCHEMA_VERSION,appVersion:APP_VERSION,
    materialVersion:MATERIAL_VERSION,id:plan.id,mode:plan.mode,day,plan:structuredClone(plan),
    phase:'learning',status:'in-progress',startedAt:new Date().toISOString(),endedAt:null,setting:1,
    timeOrigin:performance.timeOrigin,events:[],memory:{rounds:[],delayCueAt:null,
      delayCueMonoMs:null,delayedCorrect:null,delayDeviationReason:''},symptoms:null,
    stroop:{w:null,c:null,cw:null},symbol:{seed:crypto.randomUUID(),startedAt:null,endedAt:null,trials:[]},
    qc:9,notes:'',reason:'',interruptions:[],device:{userAgent:navigator.userAgent,
      width:window.innerWidth,height:window.innerHeight,pixelRatio:window.devicePixelRatio}};
}
export function event(record: SessionRecord, kind: string, details?: Record<string,unknown>,
  monotonicMs: number = performance.now()): void {
  record.events.push({kind,at:new Date().toISOString(),monotonicMs,details});
}
export function countCorrect(value: CorrectWords | null): number | null {
  return value===null ? null : value.filter(Boolean).length;
}
export function scoreRound(record: SessionRecord, n: number, correct: CorrectWords): void {
  const round=record.memory.rounds[n-1];
  if(!round||n<1||n>MAX_LEARNING_ROUNDS) throw new Error('学习轮次无效。');
  if(round.answerEndedAt===null) throw new Error('请先记录回答结束时间。');
  if(round.correct!==null) throw new Error('已记录的即时回答不能被重复学习覆盖。');
  round.correct=[...correct]; event(record,'learning-score',{round:n,correct:[...correct]});
}
export function mayRepeat(record: SessionRecord): boolean {
  const rounds=record.memory.rounds;const last=rounds.at(-1);
  return !!last && last.correct!==null && !last.correct.every(Boolean) && rounds.length<MAX_LEARNING_ROUNDS;
}
export function latestAnswerEnd(record: SessionRecord): number | null {
  return record.memory.rounds.at(-1)?.answerEndedMonoMs ?? null;
}
export function delaySeconds(record: SessionRecord): number | null {
  const start=latestAnswerEnd(record);const end=record.memory.delayCueMonoMs;
  return start===null||end===null?null:(end-start)/1000;
}
export function median(values: number[]): number | null {
  if(values.length===0) return null;
  if(values.some(v=>!Number.isFinite(v))) throw new Error('反应时包含非有限值。');
  const s=[...values].sort((a,b)=>a-b); const m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
export function derived(record: SessionRecord) {
  const immediate=countCorrect(record.memory.rounds[0]?.correct??null);
  const delayed=countCorrect(record.memory.delayedCorrect);
  const w=record.stroop.w?.correct??null,c=record.stroop.c?.correct??null,cw=record.stroop.cw?.correct??null;
  const correctTrials=record.symbol.trials.filter(t=>t.userResponse===t.correctResponse);
  const rt=median(correctTrials.map(t=>t.rtMs));
  return {immediate,delayed,memory:immediate===null||delayed===null?null:immediate+delayed,
    w,c,cw,ig:w===null||c===null||cw===null||w+c===0?null:cw-w*c/(w+c),
    ss_n:record.symbol.trials.length,ss_correct:correctTrials.length,ss_rt:rt,
    accuracy:record.symbol.trials.length?correctTrials.length/record.symbol.trials.length:null,
    delay_sec:delaySeconds(record)};
}
export function validateStroop(correct: number, repeatCount: number): void {
  if(!Number.isInteger(correct)||correct<0) throw new Error('正确数应为非负整数。');
  if(!Number.isInteger(repeatCount)||repeatCount<0) throw new Error('循环次数应为非负整数。');
  if(correct>50*(repeatCount+1)) throw new Error('正确数超过本轮和已循环卡片的项目数，请核对纸上记录。');
}
export function scorable(record: SessionRecord): boolean {
  const d=derived(record);
  return record.status==='completed' && record.interruptions.length===0 &&
    !record.events.some(e=>e.kind==='step-skipped'&&[0,2,3,4,5,6].includes(Number(e.details?.stage))) &&
    d.memory!==null && d.ig!==null && d.ss_n===12 && d.ss_rt!==null;
}
export function localDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',
    month:'2-digit',day:'2-digit'}).format(at);
}
export function localDateTime(iso: string | null): string {
  if(!iso) return '';
  const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',
    month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(iso));
  return parts.replace(',','');
}
