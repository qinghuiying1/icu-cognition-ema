export const APP_VERSION = '1.0.0-rc.1';
export const MATERIAL_VERSION = 'materials-1';
export const SCHEMA_VERSION = 1;
export const STROOP_MS = 45_000;
export const DELAY_MIN_MS = 180_000;
export const DELAY_MAX_MS = 300_000;
export const MAX_LEARNING_ROUNDS = 6;
export type Mode = 'simulation' | 'formal';
export type Phase = 'setup' | 'learning' | 'learning-score' | 'symptoms' |
  'stroop-ready' | 'stroop-running' | 'stroop-score' | 'delay-wait' |
  'delayed-recall' | 'delayed-score' | 'symbol-ready' | 'symbol-running' |
  'review' | 'finished' | 'interrupted';
export type StroopKind = 'w' | 'c' | 'cw';
export type CorrectWords = [boolean, boolean, boolean];
export interface Word { id: string; text: string; category: string; }
export interface DayWords { day: number; words: [Word, Word, Word]; }
export interface PatientPlan {
  id: string; mode: Mode; seed: string; firstEmaDate: string;
  createdAt: string; materialVersion: string; days: DayWords[];
}
export interface TimeEvent {
  kind: string; at: string; monotonicMs: number; details?: Record<string, unknown>;
}
export interface LearningRound {
  n: number; playbackStartedAt: string; playbackEndedAt: string;
  answerEndedAt: string | null; answerEndedMonoMs: number | null;
  correct: CorrectWords | null;
}
export interface StroopRun {
  startedAt: string; endedAt: string | null; durationMs: number | null;
  correct: number | null; repeatCount: number | null;
}
export interface SymbolTrial {
  trialIndex: number; stimulus: unknown; correctResponse: number;
  userResponse: number; rtMs: number; stimulusAt: string; respondedAt: string;
  raw: Record<string, unknown>;
}
export interface Symptoms {
  pain: number; fatigue: number; anxiety: number; depressed: number; sleep: number;
}
export interface SessionRecord {
  sessionId: string; schemaVersion: number; appVersion: string; materialVersion: string;
  id: string; mode: Mode; day: number; plan: PatientPlan; phase: Phase;
  status: 'in-progress' | 'completed' | 'interrupted';
  startedAt: string; endedAt: string | null; setting: 1;
  timeOrigin: number; events: TimeEvent[];
  memory: { rounds: LearningRound[]; delayCueAt: string | null;
    delayCueMonoMs: number | null; delayedCorrect: CorrectWords | null;
    delayDeviationReason: string; };
  symptoms: Symptoms | null;
  stroop: Record<StroopKind, StroopRun | null>;
  symbol: { seed: string; startedAt: string | null; endedAt: string | null;
    trials: SymbolTrial[]; };
  qc: 0 | 1 | 9; notes: string; reason: string;
  interruptions: TimeEvent[]; device: { userAgent: string; width: number;
    height: number; pixelRatio: number; };
}
export interface Acceptance {
  appVersion: string; audio: boolean; cards: boolean; timing: boolean;
  offline: boolean; export: boolean; approvedAt: string | null;
}
export const WORD_CATEGORIES: Word[][] = [
  [{ id:'lamei',text:'腊梅',category:'flower' },{ id:'haitang',text:'海棠',category:'flower' },
   { id:'yulan',text:'玉兰',category:'flower' },{ id:'baihe',text:'百合',category:'flower' }],
  [{ id:'lvshi',text:'律师',category:'job' },{ id:'siji',text:'司机',category:'job' },
   { id:'shibing',text:'士兵',category:'job' },{ id:'mugong',text:'木工',category:'job' }],
  [{ id:'changku',text:'长裤',category:'clothing' },{ id:'shoutao',text:'手套',category:'clothing' },
   { id:'toujin',text:'头巾',category:'clothing' },{ id:'dayi',text:'大衣',category:'clothing' }],
];
export const SYMPTOM_ITEMS = [
  {key:'pain' as const,title:'疼痛',question:'现在，我的疼痛程度是……',
   labels:['无疼痛','轻微','中度','严重','非常严重']},
  {key:'fatigue' as const,title:'疲劳',question:'现在，我感到疲惫……',
   labels:['一点也不','有一点','有些','相当多','非常多']},
  {key:'anxiety' as const,title:'焦虑',question:'现在，我感到不安或紧张……',
   labels:['一点也不','有一点','有些','相当多','非常多']},
  {key:'depressed' as const,title:'抑郁情绪',question:'现在，我感到抑郁或心情低落……',
   labels:['一点也不','有一点','有些','相当多','非常多']},
  {key:'sleep' as const,title:'睡眠',question:'昨晚，我的睡眠受干扰程度是……',
   labels:['一点也不','有一点','有些','相当多','非常多']},
];
export const emptyAcceptance = (): Acceptance => ({ appVersion: APP_VERSION,
  audio:false,cards:false,timing:false,offline:false,export:false,approvedAt:null });
export function acceptanceComplete(a: Acceptance): boolean {
  return a.appVersion === APP_VERSION && a.audio && a.cards && a.timing && a.offline && a.export;
}
