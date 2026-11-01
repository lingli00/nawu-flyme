/**
 * 服务器地址归一化。
 *
 * 用户输入不可控（可能写成 `192.168.1.100:3030/`、`http://host/app/`、`HTTPS://Host`），
 * 统一成「`协议://host[:port]`，无尾斜杠、无 path」后再存库与拼请求。
 */
export interface NormalizeResult {
  ok: boolean;
  /** 归一化后的地址；ok=false 时为空串 */
  url: string;
  /** 失败原因（可直接展示） */
  reason?: string;
}

const HOSTNAME_RE = /^[a-zA-Z0-9._~%-]+$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const FAIL: NormalizeResult = {
  ok: false,
  url: '',
  reason: '地址格式不正确，示例：http://192.168.1.10:3030',
};

/** 判断主机名是否合法：IPv4 / localhost / 含点的域名。 */
function isValidHostname(host: string): boolean {
  if (!host || !HOSTNAME_RE.test(host)) return false;
  if (host === 'localhost') return true;
  const m = IPV4_RE.exec(host);
  if (m) {
    return m.slice(1, 5).every((part) => {
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  // 域名必须含点（避免把 "abc" 当成主机）
  return host.includes('.');
}

/**
 * 归一化服务器地址。
 *
 * - 自动补 `http://`
 * - 去尾斜杠、剥离 path 与 query
 * - 无协议且既不含 `.` 也不含 `:` → 判为非法
 *
 * @example
 * normalizeServerUrl('192.168.1.100:3030/') // { ok:true, url:'http://192.168.1.100:3030' }
 * normalizeServerUrl('abc')              // { ok:false, reason:'地址格式不正确…' }
 */
export function normalizeServerUrl(raw: string): NormalizeResult {
  const input = (raw ?? '').trim();
  if (!input) return { ...FAIL, reason: '服务器地址不能为空' };
  if (/\s/.test(input)) return { ...FAIL, reason: '服务器地址中不能包含空格' };

  const hasProtocol = PROTOCOL_RE.test(input);
  // 没写协议又完全没有「.」或「:」→ 几乎可以确定是随手乱填
  if (!hasProtocol && !input.includes('.') && !input.includes(':')) return FAIL;

  let parsed: URL;
  try {
    parsed = new URL(hasProtocol ? input : `http://${input}`);
  } catch {
    return FAIL;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...FAIL, reason: '地址协议只支持 http 或 https' };
  }
  if (!isValidHostname(parsed.hostname)) return FAIL;
  if (parsed.port && !/^\d+$/.test(parsed.port)) return FAIL;

  return { ok: true, url: `${parsed.protocol}//${parsed.host}` };
}

/** 只要判定结果（供 httpClient 快速失败）。 */
export function isValidServerUrl(raw: string): boolean {
  return normalizeServerUrl(raw).ok;
}

/** 拼接完整 URL：`base + path + ?query`。 */
export function joinUrl(base: string, path: string, query?: Record<string, string | number>): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const qs = buildQueryString(query);
  return `${cleanBase}${cleanPath}${qs}`;
}

/** 生成 query 串（无参数时返回空串）。 */
export function buildQueryString(query?: Record<string, string | number>): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** 展示用：隐藏密码、截断长度。 */
export function displayUrl(raw: string): string {
  const n = normalizeServerUrl(raw);
  return n.ok ? n.url : (raw ?? '').trim();
}
