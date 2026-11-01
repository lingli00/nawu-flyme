/**
 * ★v1.4.0 端侧离线语音识别（vosk + 中文小模型，按需下载）。
 *
 * 需求原点（用户反馈「系统语音服务联网失败」）：
 * 旧实现依赖 Android 系统语音服务 / 浏览器 Web Speech —— 前者在部分 ROM 上
 * 只有在线识别（服务端一抖就失败），后者在 Chrome 上把音频送到 Google，
 * 国内网络根本不可达。语音是记账的主输入方式，不能受外部服务牵连。
 *
 * 现在的架构：
 * - 引擎：vosk-browser（WebAssembly，随包分发 `public/vosk/vosk.js`，约 5.8MB）；
 * - 模型：vosk-model-small-cn-0.22（约 40MB，tar.gz），**不打包进 APK**，
 *   首次使用语音时弹窗引导下载，托管在自有服务器；
 * - 下载后存进 IndexedDB，之后完全本地运算：断网、服务端停机都能用；
 * - 总占用：引擎 5.8MB + 模型 ~40MB ≈ 46MB（≤ 50MB 约束）。
 *
 * 兼容策略（调用方负责兜底顺序）：
 *   本地引擎不可用（缺模型/无麦克风权限/非安全上下文）→ 系统语音/Web Speech
 *   → 都失败 → 提示改用键盘输入。
 *
 * 本文件除音频采集外都是纯逻辑，便于单测（见 tests/offline-asr.test.ts）。
 */

/**
 * 模型 tar.gz 的线上地址（自有服务器，经 PHP 接口下发）：
 * - 网页版同源，无跨域；
 * - App 内页面源是 https://localhost，跨域但接口带 `Access-Control-Allow-Origin: *`；
 * - 单文件直读 + Content-Length，客户端据此显示下载进度。
 *
 * ★v1.6.4：旧地址 `http://106.53.204.29/asr-model.php` 随公共分发目录一起下线，
 * 改指自己正在运行的服务端站点根（与更新渠道同一个站点、同一个 https）。
 * ⚠️ 该接口读的是 `storage/asr/vosk-model-small-cn-0.22.tar.gz`（约 42MB），
 * 这个文件不随纯净包分发，**部署时要单独上传**，否则接口返回 404
 * （页面拿到的是品牌 404 页，前端报「模型下载失败」）。
 */
export const ASR_MODEL_URL = 'https://your.domain.com/asr-model.php';

import { ASR_SAMPLE_RATE, resamplePcm, rms } from './pcm';
/** 引擎脚本路径（public/vosk/vosk.js，随包分发）。 */
export const ASR_ENGINE_PATH = '/vosk/vosk.js';
/** 模型展示大小（MB，用于引导文案；真实大小以下载响应为准）。 */
export const ASR_MODEL_MB = 40;

const IDB_NAME = 'nawu-asr';
const IDB_STORE = 'models';
const IDB_KEY = 'vosk-small-cn-v1';
const LS_KEY = 'nawu-asr-model-v1';

/* ---------------- IndexedDB ---------------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 不可用'));
  });
}

async function idbGet(key: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error ?? new Error('读取模型失败'));
  });
}

async function idbPut(key: string, value: Blob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('保存模型失败'));
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('删除模型失败'));
  });
}

/* ---------------- 模型状态 ---------------- */

/** 进程内缓存：避免每次按麦克风都读 IndexedDB。 */
let readyCache: boolean | null = null;

/** 模型是否已下载并可离线使用。 */
export async function asrModelReady(): Promise<boolean> {
  if (readyCache !== null) return readyCache;
  try {
    if (localStorage.getItem(LS_KEY) !== 'ok') {
      readyCache = false;
      return false;
    }
    const blob = await idbGet(IDB_KEY);
    readyCache = Boolean(blob && blob.size > 1024 * 1024);
  } catch {
    readyCache = false;
  }
  return readyCache;
}

/** 删除已下载模型（设置页「释放空间」用）。 */
export async function removeAsrModel(): Promise<void> {
  readyCache = false;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* 忽略 */
  }
  try {
    await idbDel(IDB_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 下载模型（带进度）。成功后写入 IndexedDB 并置位。
 *
 * @param onPct 0~100 的整数百分比回调；total 未知时传 -1
 */
/** 分片大小：4MB 一片，落 IndexedDB 后即使退出也能续传。 */
const CHUNK = 4 * 1024 * 1024;
const META_KEY = `${IDB_KEY}:meta`;

interface DlMeta {
  received: number;
  total: number;
  url: string;
}

async function readMeta(): Promise<DlMeta | null> {
  try {
    const db = await openDb();
    return await new Promise<DlMeta | null>((resolve) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(META_KEY);
      req.onsuccess = () => resolve((req.result as DlMeta | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeMeta(meta: DlMeta): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(meta, META_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function putChunk(index: number, data: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data, `${IDB_KEY}:c${index}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function readChunks(uptoIndex: number): Promise<BlobPart[]> {
  const db = await openDb();
  const out: BlobPart[] = [];
  for (let i = 0; i < uptoIndex; i += 1) {
    const v = await new Promise<Uint8Array | undefined>((resolve) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(`${IDB_KEY}:c${i}`);
      req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!v) break;
    out.push(v as unknown as BlobPart);
  }
  return out;
}

async function clearDlState(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const st = tx.objectStore(IDB_STORE);
    st.delete(META_KEY);
    for (let i = 0; i < 64; i += 1) st.delete(`${IDB_KEY}:c${i}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 已下载的临时字节（供界面提示「继续下载」）。 */
export async function asrPartialBytes(): Promise<number> {
  const m = await readMeta();
  return m ? m.received : 0;
}

/**
 * 下载模型（**断点续传**）：
 * - 每 4MB 一片落 IndexedDB，同时记录已接收字节；
 * - 退出界面 / 断网 / App 重启后再点下载 → 从上次字节数发 `Range` 续传；
 * - 上游不支持 Range（200 而非 206）→ 清空重下，不拼接脏数据；
 * - 完成后拼装、比对总大小，再写入模型槽位并清理分片。
 */
export async function downloadAsrModel(
  onPct: (pct: number, received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const meta = await readMeta();
  let received = meta?.received ?? 0;
  let chunkIndex = Math.floor(received / CHUNK);
  if (meta && meta.received % CHUNK !== 0) {
    // 上次中断在半片中间：回退到整片边界重下这一片（最多浪费 4MB）
    received = chunkIndex * CHUNK;
  }

  const headers: Record<string, string> = {};
  if (received > 0) headers.Range = `bytes=${received}-`;
  const res = await fetch(ASR_MODEL_URL, { headers, signal });
  if (!res.ok && res.status !== 206) {
    if (received > 0) {
      await clearDlState();
      return downloadAsrModel(onPct, signal);
    }
    throw new Error(`模型下载失败（HTTP ${res.status}）`);
  }
  if (received > 0 && res.status !== 206) {
    // 服务器忽略了 Range：从头下，避免拼出坏文件
    received = 0;
    chunkIndex = 0;
    await clearDlState();
  }

  const len = Number(res.headers.get('content-length') ?? 0);
  const total = res.status === 206 ? received + len : len || (meta?.total ?? 0);
  if (total > 0) await writeMeta({ received, total, url: ASR_MODEL_URL });
  onPct(total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1, received, total);

  const reader = res.body?.getReader();
  if (!reader) {
    // 老内核不支持流式 body：一次性取回（无进度、无续传）
    const blob = await res.blob();
    const merged = received > 0 ? new Blob([...(await readChunks(chunkIndex)), blob]) : blob;
    await idbPut(IDB_KEY, merged);
    await clearDlState();
    finishDownload(merged);
    return;
  }

  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    // 拼到当前片，满 4MB 落盘
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf, 0);
    next.set(value, buf.length);
    buf = next;
    received += value.length;
    while (buf.length >= CHUNK) {
      await putChunk(chunkIndex, buf.slice(0, CHUNK));
      chunkIndex += 1;
      buf = buf.slice(CHUNK);
    }
    await writeMeta({ received, total, url: ASR_MODEL_URL });
    onPct(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1, received, total);
  }
  if (buf.length > 0) {
    await putChunk(chunkIndex, buf);
    chunkIndex += 1;
  }

  const parts = await readChunks(chunkIndex);
  const blob = new Blob(parts, { type: 'application/gzip' });
  if (total > 0 && blob.size !== total) {
    throw new Error(`模型下载不完整（${blob.size}/${total}），已保留进度，可重试继续`);
  }
  await idbPut(IDB_KEY, blob);
  await clearDlState();
  finishDownload(blob);
}

function finishDownload(blob: Blob): void {
  readyCache = true;
  try {
    localStorage.setItem(LS_KEY, 'ok');
    localStorage.setItem(`${LS_KEY}-size`, String(blob.size));
  } catch {
    /* 隐私模式：仅本次会话可用 */
  }
}

/** 已下载模型的大小（字节，未知返回 0）。 */
export function asrModelBytes(): number {
  try {
    return Number(localStorage.getItem(`${LS_KEY}-size`) ?? '0') || 0;
  } catch {
    return 0;
  }
}

/* ---------------- 引擎加载 ---------------- */

interface VoskModule {
  createModel(url: string): Promise<VoskModel>;
}
interface VoskModel {
  KaldiRecognizer: new (sampleRate: number) => VoskRecognizer;
  terminate(): void;
}
interface VoskRecognizer {
  on(event: string, cb: (msg: unknown) => void): void;
  /** 已重采样到 16k 的 PCM（★v1.6.0：库内不重采样，必须我们自己降采样）。 */
  acceptWaveformFloat(buffer: Float32Array, sampleRate: number): void;
  retrieveFinalResult(): void;
  remove(): void;
}

let enginePromise: Promise<VoskModule> | null = null;

/** 按需注入引擎脚本（5.8MB，只在第一次用语音时加载）。 */
function loadEngine(): Promise<VoskModule> {
  if (enginePromise) return enginePromise;
  enginePromise = new Promise<VoskModule>((resolve, reject) => {
    const w = window as unknown as { Vosk?: VoskModule };
    if (w.Vosk) {
      resolve(w.Vosk);
      return;
    }
    const s = document.createElement('script');
    s.src = ASR_ENGINE_PATH;
    s.async = true;
    s.onload = () => {
      if (w.Vosk) resolve(w.Vosk);
      else reject(new Error('引擎加载失败'));
    };
    s.onerror = () => reject(new Error('引擎加载失败'));
    document.head.appendChild(s);
  });
  return enginePromise;
}

/* ---------------- ★v1.6.1 模型常驻缓存 ---------------- */

/**
 * 模型常驻（设置项 `asrKeepModel`，默认关闭）。
 *
 * - 关：每次识别结束立刻 `terminate()` 释放 wasm 内存，下次重新加载（约 3~4s）；
 * - 开：首次加载后把 model 留在内存，后续识别直接复用，跳过加载；
 *   只有进程被系统回收 / 用户手动释放 / 关掉开关时才真正释放。
 *
 * ⚠️ 常驻的只是**模型**：麦克风仍然只在每次点击录音时打开、结束即关。
 */
let resident: { model: VoskModel } | null = null;

/** 模型当前是否常驻在内存（设置页用来显示状态）。 */
export function asrResidentStatus(): boolean {
  return resident !== null;
}

/** 立即释放常驻模型（关闭开关 / 用户点「释放内存」时调用）。 */
export function releaseAsrModel(): void {
  if (!resident) return;
  const m = resident.model;
  resident = null;
  try {
    m.terminate();
  } catch {
    /* 已终止 */
  }
}

/* ---------------- 识别会话（★v1.6.0 全链路重写） ---------------- */

/** 识别阶段（界面据此显示「加载模型 / 打开麦克风 / 正在聆听」）。 */
export type AsrPhase = 'loading-model' | 'opening-mic' | 'listening';

export interface OfflineAsrCallbacks {
  onPhase?: (phase: AsrPhase) => void;
  onPartial?: (text: string) => void;
  onResult: (text: string) => void;
  /** code: model-missing / engine-timeout / mic-denied / mic-no-device / mic-failed / mic-silent / no-match */
  onError?: (code: string, detail?: string) => void;
  onEnd?: (reason: 'result' | 'error' | 'cancelled') => void;
  /** 实时音量 0~1（界面用于「麦克风真的在收声」的视觉反馈） */
  onLevel?: (level: number) => void;
}

export interface OfflineAsrSession {
  stop(): void;
  cancel(): void;
  /** 诊断：收到的音频帧数 / 平均音量（用于区分「没开麦」与「没听清」）。 */
  stats(): { frames: number; avgLevel: number };
}

/** 各阶段超时（ms）：宁可明确报错，也不让界面卡在"录音中"。 */
const T_MODEL_MS = 20000;
const T_MIC_MS = 8000;
const T_FIRST_FRAME_MS = 5000;

/** 麦克风是否可用（非安全上下文 / 无设备都会返回 false）。 */
export function micAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** 从 vosk 消息里取文本（partial / final 结构一致）。 */
function textOf(msg: unknown): string {
  const r = (msg as { result?: { text?: string; partial?: string } })?.result;
  return (r?.text ?? r?.partial ?? '').trim();
}

function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(code)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** MediaStream 错误 → 稳定错误码（便于界面给可执行提示）。 */
function micErrorCode(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'mic-no-device';
  if (name === 'NotReadableError' || name === 'AbortError') return 'mic-busy';
  return 'mic-failed';
}

/**
 * 启动一次离线识别。
 *
 * 关键约束（都是"以前为什么用不了"的直接原因）：
 * - 模型固定 16kHz：采集到的一律重采样到 16k 再喂，绝不把 48k 原样塞进去；
 * - AudioContext 必须 resume 到 running，否则一帧音频都收不到；
 * - 首帧看门狗：5 秒没有音频帧 → 判定麦克风没打开（mic-silent），立刻报错退出；
 * - 每个异步阶段都有超时，界面永远不会卡在"正在录音"。
 */
export async function startOfflineAsr(
  opts: OfflineAsrCallbacks,
  runOpts?: { keepModel?: boolean },
): Promise<OfflineAsrSession> {
  const keepModel = runOpts?.keepModel === true;
  if (!micAvailable()) throw new Error('mic-unavailable');

  const blob = await idbGet(IDB_KEY);
  if (!blob) {
    readyCache = false;
    throw new Error('model-missing');
  }

  // ① 引擎 + 模型：★v1.6.1 常驻开启时直接复用，跳过 3~4s 加载
  let model: VoskModel;
  if (resident) {
    model = resident.model;
  } else {
    opts.onPhase?.('loading-model');
    const vosk = await loadEngine();
    const url = URL.createObjectURL(blob);
    try {
      model = await withTimeout(vosk.createModel(url), T_MODEL_MS, 'engine-timeout');
    } catch (e) {
      readyCache = false;
      throw new Error((e as Error)?.message === 'engine-timeout' ? 'engine-timeout' : 'engine-failed');
    } finally {
      URL.revokeObjectURL(url);
    }
    if (keepModel) resident = { model };
  }

  /** 按设置决定是否释放模型（常驻时不动，关闭时立刻清）。 */
  const releaseModel = (): void => {
    if (keepModel) return;
    try {
      model.terminate();
    } catch {
      /* 已终止 */
    }
    if (resident?.model === model) resident = null;
  };

  // ② 麦克风
  opts.onPhase?.('opening-mic');
  let stream: MediaStream;
  try {
    stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      }),
      T_MIC_MS,
      'mic-timeout',
    );
  } catch (e) {
    releaseModel();
    const code = (e as Error)?.message === 'mic-timeout' ? 'mic-failed' : micErrorCode(e);
    throw new Error(code);
  }

  // ③ 音频图：优先让 AudioContext 直接跑 16k；拿不到就用软件重采样兜底
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: ASR_SAMPLE_RATE });
  } catch {
    ctx = new Ctx();
  }
  try {
    if (ctx.state !== 'running') await ctx.resume();
  } catch {
    /* 某些内核 resume 会 reject，继续用状态判定 */
  }
  if (ctx.state !== 'running') {
    for (const t of stream.getTracks()) t.stop();
    releaseModel();
    throw new Error('audio-suspended');
  }

  const rec = new model.KaldiRecognizer(ASR_SAMPLE_RATE);
  let finalText = '';
  let partial = '';
  let frames = 0;
  let levelSum = 0;
  let lastLevel = 0;
  let firstFrameAt = 0;
  const openedAt = Date.now();
  let settled = false;
  let cancelled = false;

  const settle = (reason: 'result' | 'error' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    opts.onEnd?.(reason);
  };

  rec.on('partialresult', (m) => {
    const t = textOf(m);
    if (!t) return;
    partial = t;
    opts.onPartial?.(t);
  });
  rec.on('result', (m) => {
    const t = textOf(m);
    if (!t) return;
    finalText = finalText ? `${finalText}${/[，。,.!！?？]$/.test(finalText) ? '' : '，'}${t}` : t;
    partial = '';
    opts.onPartial?.(finalText);
  });

  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (ev) => {
    if (cancelled) return;
    const pcm = ev.inputBuffer.getChannelData(0);
    const lv = rms(pcm);
    lastLevel = lv;
    if (lv > 0.0005 || frames === 0) {
      frames += 1;
      levelSum += lv;
      if (!firstFrameAt) firstFrameAt = Date.now();
      opts.onLevel?.(lv);
    }
    try {
      // ★必须：48k → 16k（模型 16k；库内不重采样）
      const pcm16 = ctx.sampleRate === ASR_SAMPLE_RATE ? pcm : resamplePcm(pcm, ctx.sampleRate, ASR_SAMPLE_RATE);
      rec.acceptWaveformFloat(pcm16, ASR_SAMPLE_RATE);
    } catch {
      /* 单帧异常不打断整段识别 */
    }
  };
  source.connect(node);
  node.connect(ctx.destination);
  opts.onPhase?.('listening');

  // ④ 首帧看门狗：没收到音频就是没开麦，不能假装在录
  const watchdog = window.setInterval(() => {
    if (cancelled || settled) return;
    if (!firstFrameAt && Date.now() - openedAt > T_FIRST_FRAME_MS) {
      window.clearInterval(watchdog);
      opts.onError?.('mic-silent');
      opts.onEnd?.('error');
      settled = true;
      void cleanup();
    }
  }, 300);

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    window.clearInterval(watchdog);
    try {
      node.disconnect();
      source.disconnect();
    } catch {
      /* ignore */
    }
    node.onaudioprocess = null;
    for (const t of stream.getTracks()) t.stop();
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
    try {
      rec.remove();
    } catch {
      /* ignore */
    }
    releaseModel();
  };

  return {
    stop: () => {
      if (cancelled || settled) return;
      try {
        rec.retrieveFinalResult();
      } catch {
        /* 收尾失败就用已有文本 */
      }
      window.setTimeout(() => {
        if (settled) return;
        const text = (finalText || partial).trim();
        if (text) {
          opts.onResult(text);
          settle('result');
        } else if (frames === 0) {
          // 一帧都没收到：是麦克风问题，不是"没听清"
          opts.onError?.('mic-silent');
          settle('error');
        } else {
          opts.onError?.('no-match');
          settle('error');
        }
        void cleanup();
      }, 420);
    },
    cancel: () => {
      cancelled = true;
      void cleanup();
      settle('cancelled');
    },
    stats: () => ({ frames, avgLevel: frames > 0 ? levelSum / frames : lastLevel }),
  };
}
