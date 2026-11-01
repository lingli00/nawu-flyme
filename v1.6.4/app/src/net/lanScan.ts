import { CapacitorHttp } from '@capacitor/core';
import { isNative } from './env';

/**
 * @capacitor/core 7.x 的 `dataType` 类型声明与运行时不一致（TS 报错 "json" 不在联合类型里），
 * 与 `httpClient.ts#nativeRequest` 相同的做法：收窄成探测需要的最小结构。
 */
const http = CapacitorHttp as unknown as {
  request: (o: Record<string, unknown>) => Promise<{ status?: number | string; data?: unknown }>;
};

/**
 * ★局域网服务端扫描（问题五）· 底层 helper。
 *
 * 为什么在 `net/` 目录：页面禁止裸 `fetch` / 直接用 `CapacitorHttp`（见 httpClient 顶部铁律），
 * 局域网扫描需要对着 1500 个候选地址发「探测类高频短超时请求」，这类请求与常规 API 请求
 * （统一走 `request()`，带重试 / 鉴权 / expectOk）的特征完全不同，因此在这里实现为
 * 唯一一个例外出口，页面只允许 import 本文件，不允许自己碰 CapacitorHttp。
 *
 * - 真机：CapacitorHttp 原生层发请求，不受浏览器同源策略/CORS 限制 → 扫描可用
 * - 浏览器：CapacitorHttp 回落为 fetch，服务端零 CORS → 几乎扫不到，属预期行为
 *   （`isLanScanRecommended()` 供 UI 提示「请用 App 内扫描」）
 */

/** 探测超时（ms）。高频短超时，不能复用常规接口的 15s。 */
const PROBE_TIMEOUT_MS = 2000;

/** 并发池大小。手机路由器 + 原生 HTTP 栈可承受 60 路短请求。 */
export const LAN_SCAN_CONCURRENCY = 60;

/** 候选总数上限（≈1500），防止多网卡/多网段时探测数失控。 */
export const LAN_SCAN_MAX_TARGETS = 1500;

/** 每台主机依次尝试的端口（顺序即优先级：纳物默认端口最先）。 */
export const LAN_SCAN_PORTS: readonly number[] = [3030, 2222, 8080, 80];

/** 默认探测的 /24 网段（常见家用路由器默认网段 + 本项目开发机网段）。 */
const DEFAULT_SUBNETS: readonly string[] = ['10.0.0', '192.168.0', '192.168.1', '192.168.31'];

/** 一台被发现的服务端。 */
export interface LanScanHit {
  /** 归一化地址：`http://192.168.1.100:3030`（无尾斜杠） */
  url: string;
  /** health 返回里的站点名（当前后端未提供，预留字段） */
  name?: string;
}

export interface LanScanOptions {
  /** 已保存服务器地址列表：从中提取网段，优先扫描（用户服务器大概率在同段） */
  savedUrls?: string[];
  /** 是否已被取消（点「停止」/组件卸载）：每发一个探测前检查 */
  isCancelled?: () => boolean;
  /** 进度回调（done 从 0 开始；第一次调用即带 total） */
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
}

/**
 * 是否建议扫描：仅在原生环境有效（浏览器受 CORS 限制扫不到）。
 * 供 UI 提示用，页面不得直接 import `net/env`。
 */
export function isLanScanRecommended(): boolean {
  return isNative();
}

/** 从 IPv4 host 提取前三段：`192.168.1.100` → `10.0.0`；非 IPv4 返回 null。 */
function subnetOf(hostname: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(hostname);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/**
 * 生成探测目标（去重 + 控量）。
 *
 * 顺序策略：端口为一轮（3030 → 2222 → 8080 → 80），保证所有网段的主机
 * 都先在纳物默认端口上探一遍，再扫次要端口；网段按「已保存服务器的网段
 * 优先、默认网段在后」排列。超过 `LAN_SCAN_MAX_TARGETS` 时截断尾部。
 */
export function buildScanTargets(savedUrls: string[] = []): string[] {
  const subnets: string[] = [];
  const pushSubnet = (s: string | null) => {
    if (s && !subnets.includes(s)) subnets.push(s);
  };

  // 1) 已保存服务器地址里提取的网段最优先
  for (const raw of savedUrls) {
    try {
      pushSubnet(subnetOf(new URL(raw).hostname));
    } catch {
      /* 非法地址直接跳过 */
    }
  }
  // 2) 默认网段
  for (const s of DEFAULT_SUBNETS) pushSubnet(s);

  // 3) 端口为一轮 × 网段 × 1..254
  const targets: string[] = [];
  const seen = new Set<string>();
  outer: for (const port of LAN_SCAN_PORTS) {
    for (const subnet of subnets) {
      for (let host = 1; host <= 254; host += 1) {
        const url = `http://${subnet}.${host}:${port}`;
        if (seen.has(url)) continue;
        seen.add(url);
        targets.push(url);
        if (targets.length >= LAN_SCAN_MAX_TARGETS) break outer;
      }
    }
  }
  return targets;
}

/** 安全 JSON 解析（失败返回 null）。 */
function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 探测单个地址的 `/api/health`。
 *
 * 判定标准与 `api/server.ts#probeHealth` 对齐：HTTP 200 且响应体 `ok === true`。
 * 任何失败（超时/拒绝/非 JSON）一律返回 null —— 扫描场景「失败是常态」。
 */
async function probeOnce(baseUrl: string, timeoutMs: number): Promise<LanScanHit | null> {
  try {
    const res = await http.request({
      url: `${baseUrl}/api/health`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      dataType: 'json',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      shouldEncodeUrlParams: false,
    });
    if (Number(res.status ?? 0) !== 200) return null;
    const body = typeof res.data === 'string' ? safeParse(res.data) : (res.data as unknown);
    if (!body || typeof body !== 'object' || (body as Record<string, unknown>).ok !== true) return null;
    const rec = body as Record<string, unknown>;
    const name = typeof rec.name === 'string' && rec.name ? rec.name : undefined;
    return { url: baseUrl, name };
  } catch {
    return null;
  }
}

/**
 * 扫描局域网服务端（并发池 + 可取消）。
 *
 * 实现是经典的「N 个 worker 抢队列」并发池：所有 worker 共享一个递增下标，
 * 每发一个探测前先看 `isCancelled()`，取消后未发出的目标不再发出。
 *
 * @returns 发现的服务端列表（按发现顺序；一般 0~1 台）
 */
export async function scanLanServers(options: LanScanOptions = {}): Promise<LanScanHit[]> {
  const { savedUrls = [], isCancelled = () => false, onProgress, concurrency = LAN_SCAN_CONCURRENCY } = options;
  const targets = buildScanTargets(savedUrls);
  const total = targets.length;
  onProgress?.(0, total);
  if (total === 0) return [];

  const hits: LanScanHit[] = [];
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (isCancelled()) return;
      const i = next;
      next += 1;
      if (i >= total) return;
      const hit = await probeOnce(targets[i], PROBE_TIMEOUT_MS);
      done += 1;
      onProgress?.(done, total);
      if (hit) hits.push(hit);
    }
  };

  const workers: Array<Promise<void>> = [];
  const poolSize = Math.max(1, Math.min(concurrency, total));
  for (let w = 0; w < poolSize; w += 1) workers.push(worker());
  await Promise.all(workers);

  return hits;
}
