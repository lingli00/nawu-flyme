/**
 * 脱敏日志。
 *
 * 所有请求/响应经此输出，自动剔除 `token` / `password` / `key` / `Authorization`
 * 等敏感字段（架构 §10.4 第 6 条）。
 */

const SENSITIVE_KEY_RE = /(token|password|passwd|secret|authorization|api[-_]?key|^key$|cookie|code)/i;
const SENSITIVE_VALUE_RE = /^(Bearer\s+)[^\s]+/i;
const MASK = '***';

/** 深拷贝并把敏感字段替换成 `***`。 */
export function sanitize<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return (SENSITIVE_VALUE_RE.test(value) ? value.replace(SENSITIVE_VALUE_RE, '$1***') : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? MASK : sanitize(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** 是否开启调试日志（dev 环境默认开）。 */
function enabled(): boolean {
  try {
    const metaEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
    return metaEnv.DEV === true || metaEnv.MODE === 'development';
  } catch {
    return false;
  }
}

function emit(level: 'log' | 'warn' | 'error', tag: string, args: unknown[]): void {
  if (!enabled()) return;
  const safe = args.map((a) => sanitize(a));
  // eslint-disable-next-line no-console
  (console[level] as (...a: unknown[]) => void)(`[flyme:${tag}]`, ...safe);
}

export const logger = {
  /** 调试日志（dev 可见）。 */
  debug: (tag: string, ...args: unknown[]): void => emit('log', tag, args),
  /** 警告（dev 可见）。 */
  warn: (tag: string, ...args: unknown[]): void => emit('warn', tag, args),
  /** 错误（dev 可见；生产环境由 UI 的 Toast 承接）。 */
  error: (tag: string, ...args: unknown[]): void => emit('error', tag, args),
};

export default logger;
