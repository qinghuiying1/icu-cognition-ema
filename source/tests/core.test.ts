import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan,scoreRound,mayRepeat,derived,median,validateStroop,delaySeconds } from '../src/core';
import type { SessionRecord } from '../src/model';
function fixture():SessionRecord {
  return {sessionId:'test-session',schemaVersion:1,appVersion:'test',materialVersion:'materials-1',id:'TEST',mode:'simulation',day:1,
    plan:generatePlan('TEST','simulation','2026-10-13','fixed'),phase:'review',status:'completed',startedAt:'2026-10-13T07:00:00.000Z',endedAt:'2026-10-13T07:05:00.000Z',setting:1,timeOrigin:0,events:[],
    memory:{rounds:[],delayCueAt:null,delayCueMonoMs:null,delayedCorrect:null,delayDeviationReason:''},symptoms:null,stroop:{w:null,c:null,cw:null},symbol:{seed:'s',startedAt:null,endedAt:null,trials:[]},qc:9,notes:'',reason:'',interruptions:[],device:{userAgent:'test',width:1280,height:800,pixelRatio:1}};
}
test('7-day material constraints hold for 1000 distinct schedules',()=>{
  for(let seed=0;seed<1000;seed++){
    const p=generatePlan('TEST','simulation','2026-10-13',String(seed));assert.equal(p.days.length,7);
    const counts=new Map<string,number>();
    for(let d=0;d<7;d++){
      assert.equal(new Set(p.days[d].words.map(w=>w.category)).size,3);
      for(const w of p.days[d].words){counts.set(w.id,(counts.get(w.id)??0)+1);if(d)assert(!p.days[d-1].words.some(x=>x.id===w.id));}
    }
    assert.equal(counts.size,12);assert([...counts.values()].every(n=>n===1||n===2));
    assert.deepEqual(p.days,generatePlan('TEST','simulation','2026-10-13',String(seed)).days);
  }
});
test('first oral score immutable; delay anchored to last oral answer end, not scoring entry',()=>{
  const r=fixture();
  for(let n=1;n<=6;n++){
    r.memory.rounds.push({n,playbackStartedAt:'x',playbackEndedAt:'x',answerEndedAt:'x',answerEndedMonoMs:n*1000,correct:null});
    scoreRound(r,n,n===1?[true,false,false]:[false,true,false]);
  }
  assert.equal(derived(r).immediate,1);assert.equal(mayRepeat(r),false);
  assert.throws(()=>scoreRound(r,1,[true,true,true]));
  r.memory.delayCueMonoMs=186000;assert.equal(delaySeconds(r),180);
});
test('median includes slow/fast correct trials and does not convert total duration',()=>{
  assert.equal(median([]),null);assert.equal(median([30,15000]),7515);
  const r=fixture();r.symbol.trials=[{trialIndex:0,stimulus:{},correctResponse:0,userResponse:1,rtMs:100,stimulusAt:'x',respondedAt:'x',raw:{}},
    {trialIndex:1,stimulus:{},correctResponse:0,userResponse:0,rtMs:15000,stimulusAt:'x',respondedAt:'x',raw:{}}];
  assert.equal(derived(r).ss_rt,15000);assert.equal(derived(r).ss_correct,1);
  r.symbol.trials[1].userResponse=1;assert.equal(derived(r).ss_rt,null);
});
test('Stroop permits scores over 50, preserves negative IG and handles zero denominator',()=>{
  validateStroop(72,1);assert.throws(()=>validateStroop(72,0));assert.throws(()=>validateStroop(-1,0));
  const r=fixture();const run=(correct:number)=>({startedAt:'x',endedAt:'x',durationMs:45000,correct,repeatCount:1});
  r.stroop={w:run(60),c:run(40),cw:run(20)};assert.equal(derived(r).ig,-4);
  r.stroop={w:run(0),c:run(0),cw:run(0)};assert.equal(derived(r).ig,null);
});
