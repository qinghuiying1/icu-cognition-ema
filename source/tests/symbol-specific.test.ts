import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbolTrial, symbolParameters } from '../src/symbol';

function trial(): Record<string, unknown> {
  return {
    trial_index: 0,
    correct_response_index: 1,
    user_response_index: 0,
    response_time_duration_ms: 32.125,
    trial_begin_iso8601_timestamp: '2026-10-13T07:00:00.000Z',
    trial_end_iso8601_timestamp: '2026-10-13T07:00:00.033Z',
    card_configuration: {
      top_cards_symbols: [{top:1,bottom:2},{top:3,bottom:4},{top:5,bottom:6}],
      bottom_cards_symbols: [{top:7,bottom:8},{top:3,bottom:4}],
    },
    device_metadata: { devicePixelRatio: 2 },
    quit_button_pressed: false,
  };
}

test('study configuration overrides SDK defaults and disables filtered scoring', () => {
  const p = symbolParameters('P001-day1');
  assert.equal(p.number_of_trials, 12);
  assert.equal(p.number_of_top_pairs, 3);
  assert.equal(p.interstimulus_animation, false);
  assert.equal(p.interstimulus_interval_duration_ms, 200);
  assert.equal(p.scoring, false);
  assert.equal(p.seed, 'P001-day1');
  assert.ok(!('scoring_filter_response_time_duration_ms' in p));
  assert.throws(() => symbolParameters(' '), /种子/);
});

test('first-choice incorrect and very fast response are preserved without filtering', () => {
  const raw = trial();
  const normalized = normalizeSymbolTrial(raw);
  assert.equal(normalized.trialIndex, 0);
  assert.equal(normalized.userResponse, 0);
  assert.equal(normalized.correctResponse, 1);
  assert.equal(normalized.rtMs, 32.125);
  assert.deepEqual(normalized.raw, raw);
  (normalized.raw.device_metadata as {devicePixelRatio:number}).devicePixelRatio = 99;
  assert.equal((raw.device_metadata as {devicePixelRatio:number}).devicePixelRatio, 2);
});

test('slow responses are retained and SDK RT is not replaced by wall-clock duration', () => {
  const raw = trial();
  raw.response_time_duration_ms = 15_678.75;
  raw.user_response_index = 1;
  raw.trial_index = 11;
  const normalized = normalizeSymbolTrial(raw);
  assert.equal(normalized.rtMs, 15_678.75);
  assert.equal(normalized.trialIndex, 11);
  assert.equal(normalized.stimulusAt, raw.trial_begin_iso8601_timestamp);
  assert.equal(normalized.respondedAt, raw.trial_end_iso8601_timestamp);
});

test('missing or malformed SDK data fail visibly rather than inventing scores', () => {
  for (const [field,value] of [
    ['response_time_duration_ms', null], ['response_time_duration_ms', -1],
    ['trial_index',12], ['user_response_index',2], ['card_configuration',null],
    ['trial_begin_iso8601_timestamp','unknown'],
  ] as [string,unknown][]) {
    const raw = trial(); raw[field] = value;
    assert.throws(() => normalizeSymbolTrial(raw));
  }
});
