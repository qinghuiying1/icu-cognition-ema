import JSZip from 'jszip';
import { derived,localDateTime } from './core';
import type { SessionRecord } from './model';
import { sessionRevisions } from './storage';

export const CSV_COLUMNS=['id','day','start','end','setting','completed','reason','mem_i','mem_d','learn_n','learn_ok','delay_sec','word1','word2','word3','w','c','cw','ss_n','ss_correct','ss_rt','pain','fatigue','anxiety','depressed','sleep','qc','notes'] as const;
const cell=(value:unknown):string=>{
  if(value===null||value===undefined) return '';
  let s=String(value);
  // Prevent spreadsheet formula execution in free text / study identifiers.
  if(typeof value==='string'&&/^[=+@\-\t\r]/.test(s)) s="'"+s;
  return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
};
export function dailyCsv(record:SessionRecord):string {
  const d=derived(record),words=record.plan.days[record.day-1].words,s=record.symptoms;
  const last=record.memory.rounds.at(-1)?.correct;
  const row=[record.id,record.day,localDateTime(record.startedAt),localDateTime(record.endedAt),record.setting,
    record.status==='completed'?1:0,record.reason,d.immediate,d.delayed,record.memory.rounds.length,
    last==null?null:last.every(Boolean)?1:0,d.delay_sec,...words.map(w=>w.text),d.w,d.c,d.cw,
    d.ss_n,d.ss_correct,d.ss_rt,s?.pain,s?.fatigue,s?.anxiety,s?.depressed,s?.sleep,record.qc,record.notes];
  return '\uFEFF'+CSV_COLUMNS.join(',')+'\r\n'+row.map(cell).join(',')+'\r\n';
}
export async function exportSession(record:SessionRecord):Promise<{blob:Blob,fileName:string}> {
  const snapshot=structuredClone(record);const zip=new JSZip();
  const audit=await sessionRevisions(snapshot.sessionId);
  const material=await fetch(new URL('material-manifest.json',document.baseURI));
  if(!material.ok) throw new Error('材料版本清单无法读取，请恢复已缓存页面后导出。');
  zip.file('raw-record.json',JSON.stringify({exportFormat:'icu-ema-v1',exportedAt:new Date().toISOString(),timezone:'Asia/Shanghai',record:snapshot,computed:derived(snapshot),revisions:audit},null,2));
  zip.file('daily-ema.csv',dailyCsv(snapshot));zip.file('material-manifest.json',await material.text());
  zip.file('读取说明.txt','JSON为完整原始记录及本地保存历史；CSV为Excel“03每日EMA”前28个采集字段，UTF-8 BOM、北京时间。空白表示缺失，非0分。模拟数据record.mode=simulation，请勿合入正式研究。研究编号保持不变，sessionId区分记录；重复导出同一sessionId不重复导入。核查编码：1有效，0无效，9待核查。程序不自动计算整体认知标准化分。网页生成下载不能证明文件已转存备份，请检查下载文件再转存电脑。\r\n');
  const safe=snapshot.id.replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,60)||'ID';
  const stamp=snapshot.startedAt.replace(/[^0-9]/g,'').slice(0,14);
  return {blob:await zip.generateAsync({type:'blob',compression:'DEFLATE'}),fileName:`${snapshot.mode==='simulation'?'模拟_':''}${safe}_D${snapshot.day}_${stamp}_${snapshot.sessionId.slice(0,8)}.zip`};
}
