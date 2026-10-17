/**
 * 运行环境判定。
 *
 * ★R1：后端零 CORS（OPTIONS 返回 404、无任何跨域头），
 * 因此真机必须走原生 `CapacitorHttp`；浏览器 dev 走 Vite `server.proxy` 的 fetch。
 */

/** 是否在 Capacitor 原生容器里（Android/iOS）。 */
export function isNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: Record<string, unknown> }).Capacitor;
  if (!cap) return false;
  const isNativeFn = cap.isNativePlatform;
  if (typeof isNativeFn === 'function') {
    try {
      return (isNativeFn as () => boolean).call(cap) === true;
    } catch {
      return false;
    }
  }
  const getPlatform = cap.getPlatform;
  if (typeof getPlatform === 'function') {
    try {
      return (getPlatform as () => string).call(cap) !== 'web';
    } catch {
      return false;
    }
  }
  return false;
}

/** 读取 `import.meta.env`（在非 Vite 环境下安全降级为空对象）。 */
function metaEnv(): Record<string, unknown> {
  try {
    return ((import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 是否开发环境。 */
export function isDev(): boolean {
  return metaEnv().DEV === true;
}

/** 是否可以使用 Vite dev 代理（仅浏览器 + dev）。 */
export function isDevProxy(): boolean {
  return !isNative() && isDev();
}

/** dev 代理目标地址（用于日志与提示）。 */
export function devProxyBase(): string {
  const env = metaEnv();
  const target = env.VITE_DEV_PROXY_TARGET;
  return typeof target === 'string' && target ? target : 'http://192.168.1.100:2222';
}
