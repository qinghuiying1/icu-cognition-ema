import type { SymbolTrial } from './model';

export const SYMBOL_SDK_VERSION = '0.8.35';
export const SYMBOL_SESSION_VERSION = '0.3.19';
export const SYMBOL_TRIAL_COUNT = 12;
export const SYMBOL_INTERVAL_MS = 200;

export interface SymbolSearchOptions {
  seed: string;
  onTrial: (trial: SymbolTrial) => void | Promise<void>;
  onEnd: () => void | Promise<void>;
  onError: (error: Error) => void;
}

/** Explicit configuration: SDK defaults are not the study configuration. */
export function symbolParameters(seed: string): Record<string, unknown> {
  if (!seed.trim()) throw new Error('符号搜索随机种子不能为空。');
  return {
    seed,
    number_of_trials: SYMBOL_TRIAL_COUNT,
    number_of_top_pairs: 3,
    lure_percent: 0.5,
    left_correct_percent: 0.5,
    lure_position_on_card: 'either',
    interstimulus_animation: false,
    interstimulus_interval_duration_ms: SYMBOL_INTERVAL_MS,
    after_countdown_transition_duration_ms: 0,
    show_trials_complete_scene: false,
    show_quit_button: false,
    show_locale_picker: false,
    show_fps: false,
    scoring: false,
  };
}

function numericField(raw: Record<string, unknown>, name: string): number {
  const value = raw[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`符号搜索原始数据缺少有效字段：${name}。`);
  }
  return value;
}

function timeField(raw: Record<string, unknown>, name: string): string {
  const value = raw[name];
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`符号搜索原始数据缺少实际时间：${name}。`);
  }
  return value;
}

/** Preserve SDK trial values; do not estimate RT from wall-clock timestamps. */
export function normalizeSymbolTrial(raw: Record<string, unknown>): SymbolTrial {
  const trialIndex = numericField(raw, 'trial_index');
  const correctResponse = numericField(raw, 'correct_response_index');
  const userResponse = numericField(raw, 'user_response_index');
  const rtMs = numericField(raw, 'response_time_duration_ms');
  if (!Number.isInteger(trialIndex) || trialIndex < 0 || trialIndex >= SYMBOL_TRIAL_COUNT) {
    throw new Error('符号搜索试次编号超出0～11范围。');
  }
  if (![0, 1].includes(correctResponse) || ![0, 1].includes(userResponse) || rtMs < 0) {
    throw new Error('符号搜索答复或反应时原始数据异常。');
  }
  const stimulus = raw.card_configuration;
  if (!stimulus || typeof stimulus !== 'object') {
    throw new Error('符号搜索原始刺激配置缺失。');
  }
  const config = stimulus as Record<string, unknown>;
  if (!Array.isArray(config.top_cards_symbols) || config.top_cards_symbols.length !== 3 ||
      !Array.isArray(config.bottom_cards_symbols) || config.bottom_cards_symbols.length !== 2) {
    throw new Error('符号搜索刺激配置不符合上方3对、下方2对。');
  }
  return {
    trialIndex,
    stimulus: structuredClone(stimulus),
    correctResponse,
    userResponse,
    rtMs,
    stimulusAt: timeField(raw, 'trial_begin_iso8601_timestamp'),
    respondedAt: timeField(raw, 'trial_end_iso8601_timestamp'),
    raw: structuredClone(raw),
  };
}

/**
 * Run the original SDK in a viewport-sized overlay. The SDK sizes its canvas
 * against window.innerHeight; CSS-resizing the canvas into a smaller panel
 * would make its pointer offsets inconsistent with the drawn positions.
 */
export async function runSymbolSearch(
  container: HTMLElement,
  options: SymbolSearchOptions,
): Promise<{ stop: () => void }> {
  const parameters = symbolParameters(options.seed);
  const [{ SymbolSearch }, { Session }] = await Promise.all([
    import('@m2c2kit/assessment-symbol-search'),
    import('@m2c2kit/session'),
  ]);
  if (document.getElementById('m2c2kit-canvas')) {
    throw new Error('已有符号搜索任务运行中，不能同时开启第二次。');
  }

  const overlay = document.createElement('section');
  overlay.className = 'symbol-fullscreen';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '符号搜索测评');
  const root = document.createElement('div');
  root.id = `symbol-sdk-${crypto.randomUUID()}`;
  root.className = 'symbol-sdk-root';
  const side = document.createElement('aside');
  side.className = 'symbol-directions';
  const title = document.createElement('h2');
  title.textContent = '符号搜索';
  const directions = document.createElement('p');
  directions.textContent = '请在下方两组图形中，点选与上方任意一组完全相同的一组。请尽量又快又准确，每题选择一次。';
  const progress = document.createElement('p');
  progress.setAttribute('role', 'status');
  progress.textContent = '正在加载测评材料……';
  side.append(title, directions, progress);
  const abort = document.createElement('button');
  abort.type = 'button';
  abort.className = 'symbol-abort';
  abort.textContent = '中止本次任务';
  overlay.append(root, side, abort);
  const style = document.createElement('style');
  const styleMarker = `symbol-session-${root.id}`;
  const sheet = `/* ${styleMarker} */
    .symbol-fullscreen {position:fixed;inset:0;z-index:1000;background:#f2f6f8;overscroll-behavior:none;touch-action:manipulation;}
    .symbol-sdk-root {width:100vw;height:100vh;height:100dvh;}
    .symbol-sdk-root .m2c2kit-full-viewport {height:100%;width:100%;}
    .symbol-sdk-root .m2c2kit-flex-container {display:flex;align-items:center;justify-content:center;}
    .symbol-sdk-root .m2c2kit-display-none {display:none!important;}
    .symbol-sdk-root .m2c2kit-display-block {display:block;}
    .symbol-sdk-root canvas {touch-action:none;display:block;}
    .symbol-sdk-root .m2c2kit-canvas-overlay {position:absolute;inset:0;background:#f2f6f8;}
    .symbol-sdk-root .m2c2kit-spinner {position:absolute;left:calc(50% - 20px);top:calc(50% - 20px);width:40px;height:40px;border:5px solid #ddd;border-top-color:#204e66;border-radius:50%;animation:symbol-loading-spin 1s linear infinite;}
    .symbol-directions {position:absolute;left:24px;top:50%;transform:translateY(-50%);width:clamp(140px,calc((100vw - min(400px,50vh))/2 - 48px),300px);font:22px/1.55 system-ui,sans-serif;color:#172b3a;}
    .symbol-directions h2 {font-size:28px;margin:0 0 16px;}
    .symbol-directions p {margin:12px 0;}
    .symbol-directions p[role=status] {font-size:17px;color:#536a78;}
    .symbol-abort {position:absolute;right:20px;top:20px;min-height:48px;padding:8px 18px;border:1px solid #98aab4;background:white;border-radius:8px;color:#344854;font-size:17px;}
    @keyframes symbol-loading-spin {to{transform:rotate(360deg);}}
    @media(max-width:760px) {.symbol-directions {left:12px;top:8px;transform:none;width:calc(100vw - 155px);font-size:15px;line-height:1.3;}.symbol-directions h2{font-size:18px;margin:0 0 4px;}.symbol-directions p{margin:4px 0;}.symbol-directions p[role=status]{font-size:13px;}.symbol-abort{right:8px;top:8px;font-size:14px;padding:6px 10px;}}
  `;
  style.textContent = sheet;
  document.head.append(style);
  document.body.append(overlay);
  container.textContent = '符号搜索正在全屏进行。';

  const game = new SymbolSearch();
  game.setParameters({
    ...parameters,
    locale: 'en-US',
    translation: {
      'en-US': { WHICH_MATCHES_TEXT: '', OR_TEXT: '' },
    },
  });
  game.entryScene = 'chooseCardScene';
  // Use the prepared same-origin assets in both Vite and GitHub Pages.
  const assetsBase = new URL(
    'assets/symbol-search/',
    new URL(import.meta.env.BASE_URL, window.location.href),
  ).href.replace(/\/$/, '');
  game.resolveGameBaseUrls = async () => ({ assets: assetsBase, canvasKitWasm: assetsBase });
  const bodyBackground = document.body.style.backgroundColor;
  const globals = window as Window & { m2c2kitSession?: unknown };
  const previousSession = globals.m2c2kitSession;
  const session = new Session({
    activities: [game],
    rootElementId: root.id,
    autoStartAfterInit: false,
    autoEndAfterLastActivity: false,
    autoGoToNextActivity: false,
    diagnostics: false,
    styleSheet: sheet,
  });
  let initialized = false;
  let stopped = false;
  let errorSent = false;
  let endRequested = false;
  let gameStopped = false;
  let disposed = false;
  let saveTail = Promise.resolve();
  const seen = new Set<number>();

  const disposeDom = (): void => {
    if (disposed) return;
    disposed = true;
    overlay.remove();
    style.remove();
    // Session.initialize adds its own style node. Remove only this session's.
    document.head.querySelectorAll('style').forEach((node) => {
      if (node.textContent?.includes(styleMarker)) node.remove();
    });
    if (globals.m2c2kitSession === session) globals.m2c2kitSession = previousSession;
    document.body.style.backgroundColor = bodyBackground;
    window.removeEventListener('error', handleWindowError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
  const stopGame = (): void => {
    if (gameStopped || !initialized) return;
    gameStopped = true;
    game.stop();
  };
  const stop = (): void => {
    stopped = true;
    if (!initialized) {
      progress.textContent = '正在结束本次任务……';
      abort.disabled = true;
      return;
    }
    try { stopGame(); }
    catch (error) { console.error('符号搜索资源清理失败：', error); }
    finally { disposeDom(); }
  };
  const fail = (cause: unknown): void => {
    if (errorSent) return;
    errorSent = true;
    stop();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    options.onError(error);
  };
  function handleWindowError(event: ErrorEvent): void {
    if (!stopped) fail(event.error ?? new Error(event.message));
  }
  function handleRejection(event: PromiseRejectionEvent): void {
    if (!stopped) fail(event.reason);
  }
  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleRejection);
  abort.addEventListener('click', () => fail(new Error('研究者中止符号搜索，本次已经保存的记录予以保留。')));

  session.onActivityData((event) => {
    if (stopped || event.dataType !== 'Trial') return;
    try {
      const normalized = normalizeSymbolTrial(event.newData as Record<string, unknown>);
      if (seen.has(normalized.trialIndex)) throw new Error('SDK重复提交同一符号搜索试次。');
      if (normalized.trialIndex !== seen.size) throw new Error('SDK符号搜索试次顺序异常。');
      seen.add(normalized.trialIndex);
      normalized.raw.adapter = {
        symbolSdkVersion: SYMBOL_SDK_VERSION,
        sessionSdkVersion: SYMBOL_SESSION_VERSION,
        parameters: structuredClone(parameters),
        activityConfiguration: structuredClone(event.activityConfiguration),
        activityMetrics: structuredClone(event.activityMetrics ?? []),
        rawEventTimestamp: event.iso8601Timestamp,
      };
      saveTail = saveTail.then(async () => {
        await options.onTrial(normalized);
        if (!stopped) progress.textContent = `已保存 ${normalized.trialIndex + 1} / ${SYMBOL_TRIAL_COUNT} 题`;
      });
      // The SDK does not await asynchronous data listeners. Attach rejection
      // immediately, and wait for all queued writes before declaring success.
      void saveTail.catch(fail);
    } catch (error) { fail(error); }
  });
  game.onCancel(() => fail(new Error('符号搜索任务已中止。')));
  game.onEnd(() => {
    if (endRequested || stopped) return;
    endRequested = true;
    const canvas = root.querySelector('canvas');
    if (canvas) canvas.style.pointerEvents = 'none';
    progress.textContent = '正在保存最后一题……';
    void (async () => {
      await saveTail;
      if (stopped) return;
      if (seen.size !== SYMBOL_TRIAL_COUNT) {
        throw new Error(`符号搜索仅收到 ${seen.size} 题，不能标记完成。`);
      }
      stop();
      await options.onEnd();
    })().catch(fail);
  });

  try {
    await session.initialize();
    initialized = true;
    if (stopped) {
      stop();
      return { stop };
    }
    progress.textContent = `共 ${SYMBOL_TRIAL_COUNT} 题，请点选下方图形。`;
    await session.start();
  } catch (error) {
    // Even partial initialization may allocate assets/listeners.
    initialized = true;
    stop();
    try { fail(error); } finally { disposeDom(); }
    throw error;
  }
  return { stop };
}
