/**
 * 全局错误捕获 + 环形日志（v1.0.30 · 白屏定位工程）。
 *
 * 背景：v1.0.29 上线后用户录屏仍见「品牌图片页白屏卡死」，但**无任何现场报错**
 * 可查 —— 渲染崩溃 / Promise 逃逸全都无声无息。这里做两层：
 * ① window.onerror + unhandledrejection → 内存环形缓冲（≤20 条，防抖落盘）；
 * ② ErrorBoundary 崩溃兜底页直接展示最近错误 —— 用户截图即现场。
 */

export interface ErrRecord {
  /** 时间戳（ms）。 */
  t: number;
  /** 错误类型：error（同步）/ rejection（Promise）/ boundary（React 渲染）。 */
  kind: 'error' | 'rejection' | 'boundary';
  /** 摘要消息（截断 300 字符）。 */
  msg: string;
  /** 堆栈首行候选（截断 500 字符）。 */
  stack?: string;
  /** 页面路径。 */
  page?: string;
}

const STORE_KEY = 'flyme.errlog';
const MAX_RECORDS = 20;

let buffer: ErrRecord[] | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function loadBuffer(): ErrRecord[] {
  if (buffer) return buffer;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    buffer = Array.isArray(parsed) ? (parsed as ErrRecord[]) : [];
  } catch {
    buffer = [];
  }
  return buffer;
}

function flush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(loadBuffer().slice(-MAX_RECORDS)));
    } catch {
      /* 配额不足就丢，错误日志不是数据 */
    }
  }, 600);
}

function record(kind: ErrRecord['kind'], msg: string, stack?: string): void {
  const buf = loadBuffer();
  buf.push({
    t: Date.now(),
    kind,
    msg: (msg ?? '').slice(0, 300),
    stack: (stack ?? '').slice(0, 500),
    page: typeof location !== 'undefined' ? `${location.pathname}${location.hash}` : undefined,
  });
  if (buf.length > MAX_RECORDS * 2) buf.splice(0, buf.length - MAX_RECORDS);
  flush();
}

function errText(e: unknown): { msg: string; stack?: string } {
  if (e instanceof Error) return { msg: `${e.name}: ${e.message}`, stack: e.stack };
  if (typeof e === 'string') return { msg: e };
  try {
    return { msg: JSON.stringify(e) };
  } catch {
    return { msg: String(e) };
  }
}

/** 装配全局捕获（幂等，main.tsx 启动时调用一次）。 */
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    // 资源加载错误（img/script）没有 message，忽略——图标失败已有兜底
    if (!ev.message && !ev.error) return;
    const { msg, stack } = errText(ev.error ?? ev.message);
    record('error', msg, stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const { msg, stack } = errText(ev.reason);
    record('rejection', msg, stack);
  });
}

/** 手工记录（ErrorBoundary 等入口）。 */
export function recordBoundaryError(e: unknown): void {
  const { msg, stack } = errText(e);
  record('boundary', msg, stack);
}

/** 最近错误（新 → 旧）。 */
export function recentErrors(): ErrRecord[] {
  return [...loadBuffer()].reverse();
}

/** 清空（用户点「清除」后）。 */
export function clearErrors(): void {
  buffer = [];
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 忽略 */
  }
}
