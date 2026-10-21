import type { PluginListenerHandle } from '@capacitor/core';
import NawuSpeech from '../api/speechNative';

/**
 * ★v1.3.6 语音输入：**端侧识别优先，云端零依赖**。
 *
 * 背景（用户反馈）：
 *   旧版「按住说话」用 WebView 的 Web Speech API。Android 上这套 API 实际把音频
 *   送去 **Google 在线识别**——服务端/外网一抖就报网络错误，用户明明只想记一笔账，
 *   却突然「语音不可用」。而语音是该页面最核心的输入方式，不能受外部服务牵连。
 *
 * 现在的分流：
 *   ① App 端（Capacitor）→ 原生 `NawuSpeech` 插件 → Android 12+ 的
 *      `createOnDeviceSpeechRecognizer()` 纯本机识别；低版本退回系统识别器并强制
 *      `EXTRA_PREFER_OFFLINE` —— **完全不经过我们自己的服务端**，也不依赖它在线；
 *   ② 网页端 → 浏览器 Web Speech（浏览器自己的能力，Chrome 需 HTTPS）；
 *   ③ 两者都没有 → 明确告知「本机没有离线语音引擎，请用键盘输入」，不装作在听。
 *
 * 本文件是纯编排层（不碰 React、不读 store），便于单测：
 * `probeSpeech()` 与 `speechErrorText()` 都是纯粹的判断/映射。
 */

export type SpeechMode = 'native' | 'web' | 'none';

export interface SpeechProbe {
  mode: SpeechMode;
  /** 是否会走**本机**识别（不走网络）。 */
  onDevice: boolean;
  /** 原生引擎名（native 时有意义）。 */
  engine?: string;
}

/** 是否跑在 Capacitor 原生容器里（与 theme.ts 一致的 window 探测）。 */
export function isNativeApp(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  return w.Capacitor?.isNativePlatform?.() === true;
}

/** 浏览器是否有 Web Speech。 */
export function hasWebSpeech(): boolean {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

/**
 * 探测当前环境的语音能力。
 * - App 端优先问原生插件（拿 onDevice 真值）；
 * - 原生插件不可用（老包 / 注册失败）时退回 Web Speech，不让功能整体消失。
 */
export async function probeSpeech(): Promise<SpeechProbe> {
  if (isNativeApp()) {
    try {
      const info = await NawuSpeech.isAvailable();
      if (info.supported) {
        return { mode: 'native', onDevice: Boolean(info.onDevice), engine: info.engine };
      }
    } catch {
      /* 插件缺失 → 落到 Web Speech 兜底 */
    }
  }
  if (hasWebSpeech()) return { mode: 'web', onDevice: false };
  return { mode: 'none', onDevice: false };
}

/* ---------------- 识别会话 ---------------- */

export interface SpeechCallbacks {
  /** 实时中间结果（用来做「正在聆听…」提示）。 */
  onPartial?: (text: string) => void;
  /** 最终结果。 */
  onResult: (text: string) => void;
  /** 失败（code 见 speechErrorText）。 */
  onError?: (code: string) => void;
  /** 会话结束（无论成败，只回调一次）。 */
  onEnd?: (reason: 'result' | 'error' | 'cancelled') => void;
}

export interface SpeechSession {
  mode: SpeechMode;
  onDevice: boolean;
  stop(): void;
  cancel(): void;
}

/** 原生事件清理句柄。 */
async function listenNative(
  events: Array<'partial' | 'result' | 'error' | 'end'>,
  handler: (event: string, data: { text?: string; code?: string }) => void,
): Promise<PluginListenerHandle[]> {
  const handles: PluginListenerHandle[] = [];
  for (const ev of events) {
    handles.push(
      await NawuSpeech.addListener(ev, (data) => {
        handler(ev, (data ?? {}) as { text?: string; code?: string });
      }),
    );
  }
  return handles;
}

/**
 * 启动一次语音识别。
 *
 * @throws 当环境完全没有识别能力时抛错（调用方据此提示「请用键盘输入」）
 */
export async function startSpeech(opts: SpeechCallbacks & { lang?: string }): Promise<SpeechSession> {
  const probe = await probeSpeech();
  if (probe.mode === 'none') {
    throw new Error('unavailable');
  }
  if (probe.mode === 'native') return startNative(opts);
  return startWeb(opts);
}

/** App 端：走原生插件（本地识别）。 */
async function startNative(opts: SpeechCallbacks & { lang?: string }): Promise<SpeechSession> {
  let finalText = '';
  let errorCode = '';
  let settled = false;
  let cancelled = false;
  let handles: PluginListenerHandle[] = [];

  const cleanup = (): void => {
    for (const h of handles) {
      try {
        void h.remove();
      } catch {
        /* 已移除 */
      }
    }
    handles = [];
  };
  const settle = (reason: 'result' | 'error' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    cleanup();
    opts.onEnd?.(reason);
  };

  handles = await listenNative(['partial', 'result', 'error', 'end'], (event, data) => {
    if (event === 'partial') {
      const t = (data.text ?? '').trim();
      if (t) opts.onPartial?.(t);
      return;
    }
    if (event === 'result') {
      finalText = (data.text ?? '').trim();
      return;
    }
    if (event === 'error') {
      errorCode = data.code ?? 'unknown';
      opts.onError?.(errorCode);
      return;
    }
    // end：系统已收尾，按「有结果 / 出错」分派
    if (cancelled) {
      settle('cancelled');
      return;
    }
    if (finalText) {
      opts.onResult(finalText);
      settle('result');
      return;
    }
    settle('error');
  });

  try {
    await NawuSpeech.start({ lang: opts.lang ?? 'zh-CN' });
  } catch (e) {
    cleanup();
    throw e instanceof Error ? e : new Error('start-failed');
  }

  return {
    mode: 'native',
    onDevice: true,
    stop: () => {
      void NawuSpeech.stop().catch(() => undefined);
    },
    cancel: () => {
      cancelled = true;
      void NawuSpeech.cancel().catch(() => undefined);
      settle('cancelled');
    },
  };
}

/** 网页端：Web Speech（浏览器能力，非本机模型）。 */
async function startWeb(opts: SpeechCallbacks & { lang?: string }): Promise<SpeechSession> {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!SR) throw new Error('unavailable');

  const rec = new SR();
  let finalText = '';
  let cancelled = false;
  let settled = false;
  const settle = (reason: 'result' | 'error' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    opts.onEnd?.(reason);
  };

  rec.lang = opts.lang ?? 'zh-CN';
  rec.interimResults = true;
  rec.maxResults = 1;
  rec.onresult = (e) => {
    const last = e.results?.[e.results.length - 1];
    const t = (last?.[0]?.transcript ?? '').trim();
    finalText = t;
    if (t) opts.onPartial?.(t);
  };
  rec.onerror = (ev) => {
    const code = (ev as { error?: string } | undefined)?.error ?? 'unknown';
    if (!cancelled) opts.onError?.(code);
  };
  rec.onend = () => {
    if (cancelled) {
      settle('cancelled');
      return;
    }
    if (finalText) {
      opts.onResult(finalText);
      settle('result');
      return;
    }
    settle('error');
  };
  rec.start();

  return {
    mode: 'web',
    onDevice: false,
    stop: () => rec.stop(),
    cancel: () => {
      cancelled = true;
      rec.abort();
      settle('cancelled');
    },
  };
}

/* ---------------- 文案 ---------------- */

/**
 * 把识别错误码映射成用户能动作的一句中中文。
 * 端侧识别不存在「服务端故障」这一类错误，所以这里的措辞不再提网络服务。
 */
export function speechErrorText(code: string, native: boolean): string {
  switch (code) {
    case 'not-allowed':
      return native
        ? '麦克风权限被拒绝：请到 系统设置 → 应用 → 纳物 → 权限 里允许「麦克风」'
        : '麦克风权限被拒绝，请在浏览器地址栏允许麦克风';
    case 'unavailable':
      return '本机没有离线语音引擎，请用键盘输入（也可在 系统设置 → 语音 里安装中文离线包）';
    case 'no-match':
      return '没听清，请再说一次或直接打字';
    case 'speech-timeout':
      return '没有检测到说话，请重试';
    case 'busy':
      return '语音识别正在被其它应用占用，请稍后再试';
    case 'network':
      return '系统语音服务需要联网，可改用键盘输入（不影响记账）';
    case 'audio':
      return '麦克风被占用或不可用，请检查是否正在通话';
    default:
      return '语音识别失败，请再试或直接打字';
  }
}

/** Web Speech API 最小结构（避免依赖具体 DOM lib 版本的类型名）。 */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxResults: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
