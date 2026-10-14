import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan, scoreRound, mayRepeat, delaySeconds, derived, validateStroop, scorable } from '../src/core';
import { APP_VERSION, MATERIAL_VERSION, type SessionRecord } from '../src/model';
import { CSV_COLUMNS, dailyCsv } from '../src/export';

function fixture(): SessionRecord {
  return {
    sessionId: 'qa-session', schemaVersion: 1, appVersion: APP_VERSION,
    materialVersion: MATERIAL_VERSION, id: 'TEST_QA', mode: 'simulation', day: 1,
    plan: generatePlan('TEST_QA', 'simulation', '2026-10-13', 'independent-qa'),
    phase: 'review', status: 'completed', startedAt: '2026-10-13T07:00:00.000Z',
    endedAt: '2026-10-13T07:05:00.000Z', setting: 1, timeOrigin: 1,
    events: [], memory: { rounds: [], delayCueAt: null, delayCueMonoMs: null,
      delayedCorrect: [true, false, true], delayDeviationReason: '' },
    symptoms: { pain: 1, fatigue: 2, anxiety: 3, depressed: 4, sleep: 5 },
    stroop: {
      w: { startedAt: '', endedAt: '', durationMs: 45000, correct: 60, repeatCount: 1 },
      c: { startedAt: '', endedAt: '', durationMs: 45000, correct: 45, repeatCount: 0 },
      cw: { startedAt: '', endedAt: '', durationMs: 45000, correct: 25, repeatCount: 0 },
    },
    symbol: { seed: 'qa-symbol', startedAt: '', endedAt: '', trials: [] },
    qc: 9, notes: '', reason: '', interruptions: [],
    device: { userAgent: 'independent-test', width: 1280, height: 800, pixelRatio: 1 },
  };
}
function appendRound(r: SessionRecord, n: number, answerEnd: number): void {
  r.memory.rounds.push({ n, playbackStartedAt: '2026-10-13T07:00:00.000Z',
    playbackEndedAt: '2026-10-13T07:00:03.000Z',
    answerEndedAt: '2026-10-13T07:00:06.000Z', answerEndedMonoMs: answerEnd, correct: null });
}

test('independent schedule check: every word appears 1–2 times and adjacent days share no target', () => {
  for (let seed = 0; seed < 250; seed++) {
    const plan = generatePlan('TEST_QA', 'simulation', '2026-10-13', String(seed));
    assert.equal(plan.days.length, 7);
    const occurrences = new Map<string, number>();
    for (let d = 0; d < 7; d++) {
      assert.equal(plan.days[d].day, d + 1);
      assert.equal(new Set(plan.days[d].words.map(w => w.category)).size, 3);
      for (const w of plan.days[d].words) {
        occurrences.set(w.id, (occurrences.get(w.id) ?? 0) + 1);
        if (d) assert.ok(!plan.days[d-1].words.some(previous => previous.id === w.id));
      }
    }
    assert.equal(occurrences.size, 12);
    assert.ok([...occurrences.values()].every(n => n === 1 || n === 2));
    assert.deepEqual(plan.days, generatePlan('TEST_QA', 'simulation', '2026-10-13', String(seed)).days);
  }
});

test('first immediate score survives repeat learning, and the sixth round is the final allowed repeat', () => {
  const r = fixture();
  appendRound(r, 1, 1000); scoreRound(r, 1, [true, false, false]);
  assert.throws(() => scoreRound(r, 1, [true, true, true]), /覆盖/);
  for (let n = 2; n <= 6; n++) {
    assert.equal(mayRepeat(r), true);
    appendRound(r, n, n * 1000); scoreRound(r, n, [false, false, false]);
  }
  assert.equal(mayRepeat(r), false);
  assert.equal(derived(r).immediate, 1);
  assert.equal(derived(r).memory, 3);
  r.memory.delayCueMonoMs = 186000;
  assert.equal(delaySeconds(r), 180); // 186000 - last round 6000, not first round 1000.
});

test('negative IG and correct-response median retain their mathematical meanings without RT filters', () => {
  const r = fixture(); appendRound(r, 1, 1000); scoreRound(r, 1, [true, true, true]);
  const times = [10, 16000, 700, 900, 1, 99999, 500, 800, 600, 1000, 300, 1200];
  r.symbol.trials = times.map((rtMs, trialIndex) => ({ trialIndex, rtMs,
    userResponse: trialIndex < 4 ? 1 : 0, correctResponse: 1,
    stimulus: {}, stimulusAt: '', respondedAt: '', raw: {} }));
  const d = derived(r);
  assert.equal(d.ss_n, 12); assert.equal(d.ss_correct, 4);
  assert.equal(d.ss_rt, 800); // Median of 10, 16000, 700, 900: neither fast nor slow RT filtered.
  assert.ok(d.ig! < 0);
  assert.equal(d.ig, 25 - 60 * 45 / (60 + 45));
  assert.equal(scorable(r), true); // Four correct trials are enough for a computable median.
  r.symbol.trials.forEach(t => { t.userResponse = 0; });
  assert.equal(derived(r).ss_rt, null);
  assert.equal(scorable(r), false);
  r.stroop.w!.correct = 0; r.stroop.c!.correct = 0;
  assert.equal(derived(r).ig, null);
});

test('Stroop accepts more than 50 correct when actual returns justify it; impossible counts fail', () => {
  assert.doesNotThrow(() => validateStroop(61, 1));
  assert.doesNotThrow(() => validateStroop(101, 2));
  assert.throws(() => validateStroop(51, 0));
  assert.throws(() => validateStroop(101, 1));
  assert.throws(() => validateStroop(1.5, 0));
});

test('export matches all 28 acquisition columns and leaves missing scores blank, not zero', () => {
  const r = fixture();
  const rows = dailyCsv(r).replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  assert.equal(CSV_COLUMNS.length, 28);
  assert.equal(rows[0], 'id,day,start,end,setting,completed,reason,mem_i,mem_d,learn_n,learn_ok,delay_sec,word1,word2,word3,w,c,cw,ss_n,ss_correct,ss_rt,pain,fatigue,anxiety,depressed,sleep,qc,notes');
  const cells = rows[1].split(',');
  assert.equal(cells.length, 28);
  assert.equal(cells[2], '2026-10-13 15:00:00');
  assert.equal(cells[7], ''); assert.equal(cells[8], '2'); assert.equal(cells[20], '');
  assert.deepEqual(cells.slice(21, 26), ['1', '2', '3', '4', '5']);
  r.notes = '=SUM(1,2)';
  assert.ok(dailyCsv(r).includes('"\'=SUM(1,2)"'));
});
