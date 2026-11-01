import { request } from '../net/httpClient';
import { APP_VERSION, OFFICIAL_UPDATE_CHANNEL, compareVersions } from '../lib/appVersion';
import { checkAppVersion } from './app';
import type { ServerConfig } from '../types/entities';

/**
 * App 更新检查（★v1.4.2 渠道规则改造）。
 *
 * 渠道由「当前连接的服务器」自动决定，App 内不做渠道选择：
 * 1. 当前服务器**已发布**更新包（后台传过 APK）且版本更新 → 走该服务器的更新通道；
 * 2. 服务器没发布 / 版本不新 / 未配置服务器 → 走官网渠道（含增量补丁）；
 * 3. 都没有 → 返回 null（界面显示「已是最新」）。
 * 切换服务器后，下一次检查自动跟随新的服务器。
 *
 * 官网渠道：http://106.53.204.29/nawu-update/app-manifest.json（80 端口静态目录，
 * 原 2233 独立端口已下线整合），含完整安装包 + 增量补丁。
 * 每次检查都会写一条「更新来源日志」，设置页可见，便于排查走了哪条渠道。
 */

export interface ChannelApk {
  url: string;
  size: number;
  sha256: string;
}

export interface ChannelPatch {
  from: string;
  url: string;
  size: number;
  sha256: string;
  /** 合成结果的 sha256（与完整包一致，用于校验） */
  apkSha256: string;
}

export interface ChannelManifest {
  app: string;
  version: string;
  publishedAt: string;
  notes: string;
  minVersion: string;
  apk: ChannelApk;
  patches: ChannelPatch[];
}

/** ★v1.4.2 更新来源日志（排查「这次走的是官网还是服务器」）。 */
export interface UpdateCheckLog {
  /** ISO 时间 */
  at: string;
  /** 最终采用的渠道；none = 无更新 */
  source: 'channel' | 'server' | 'none';
  /** 客户端当前版本 */
  current: string;
  /** 远端的版本号（无则空） */
  remote: string;
  /** 一句话说明（为什么走这条渠道） */
  reason: string;
  /** 当前服务器的地址（未配置为空） */
  server?: string;
}

const LOG_KEY = 'nawu-update-check-log';

/** 记录一次检查结果（同时 console 输出，方便真机连日志时查看）。 */
export function recordUpdateLog(log: UpdateCheckLog): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    /* 隐私模式忽略 */
  }
  // eslint-disable-next-line no-console
  console.info(`[update] ${log.source} ${log.current}→${log.remote || '-'} | ${log.reason}`);
}

/** 读取最近一次更新来源日志。 */
export function lastUpdateLog(): UpdateCheckLog | null {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as UpdateCheckLog) : null;
  } catch {
    return null;
  }
}

export interface AppUpdateTarget {
  source: 'channel' | 'server';
  version: string;
  notes: string;
  publishedAt: string;
  /** 绝对下载地址 */
  apkUrl: string;
  apkSize: number;
  apkSha256: string;
  /** 匹配当前版本的增量补丁（仅频道提供） */
  patch: { url: string; size: number; sha256: string; apkSha256: string } | null;
}

/**
 * 频道地址拆成「原点 + 目录路径」。
 *
 * ★v1.1.1 修复：`request()` 内部的 `normalizeServerUrl()` 会把 server.url 归一成
 * 「协议://主机」，**path 被剥掉**。此前把 OFFICIAL_UPDATE_CHANNEL 整个当 server.url
 * 传进去，手机实际请求的是 `http://host:port/app-manifest.json`（少了 `/nawu-update/`），
 * 拿到的是 SPA 的 index.html → 解析失败 → 静默回退用户服务器 → 官方频道（含增量补丁）
 * 从未在 App 端生效过。修复：原点与目录分开传，path 带上目录前缀。
 */
export function channelBase(): { origin: string; dir: string } {
  try {
    const u = new URL(OFFICIAL_UPDATE_CHANNEL);
    return { origin: u.origin, dir: u.pathname.replace(/^\/+|\/+$/g, '') };
  } catch {
    return { origin: OFFICIAL_UPDATE_CHANNEL, dir: '' };
  }
}

/** 频道 manifest 的请求 path（相对原点，含目录前缀）。 */
export function channelManifestPath(): string {
  const { dir } = channelBase();
  return dir ? `${dir}/app-manifest.json` : 'app-manifest.json';
}

/** 拉取官方频道 manifest；任何失败都返回 null（调用方回退自有服务器）。 */
export async function fetchChannelManifest(timeoutMs = 10000): Promise<ChannelManifest | null> {
  try {
    const res = await request<Record<string, unknown>>(
      { url: channelBase().origin },
      {
        path: channelManifestPath(),
        auth: false,
        expectOk: false, // 静态 JSON，没有 ok 字段
        retry: 0,
        timeoutMs,
      },
    );
    const d = res.data;
    if (!d || typeof d.version !== 'string' || typeof d.apk !== 'object' || d.apk === null) {
      return null;
    }
    const apk = d.apk as Record<string, unknown>;
    if (typeof apk.url !== 'string' || apk.url === '') {
      return null;
    }
    return {
      app: typeof d.app === 'string' ? d.app : 'nawu-app',
      version: d.version,
      publishedAt: typeof d.publishedAt === 'string' ? d.publishedAt : '',
      notes: typeof d.notes === 'string' ? d.notes : '',
      minVersion: typeof d.minVersion === 'string' ? d.minVersion : '',
      apk: {
        url: absUrl(apk.url),
        size: typeof apk.size === 'number' ? apk.size : 0,
        sha256: typeof apk.sha256 === 'string' ? apk.sha256 : '',
      },
      patches: Array.isArray(d.patches)
        ? (d.patches as Record<string, unknown>[])
            .filter((p) => p && typeof p.from === 'string' && typeof p.url === 'string')
            .map((p) => ({
              from: p.from as string,
              url: absUrl(p.url as string),
              size: typeof p.size === 'number' ? (p.size as number) : 0,
              sha256: typeof p.sha256 === 'string' ? (p.sha256 as string) : '',
              apkSha256: typeof p.apkSha256 === 'string' ? (p.apkSha256 as string) : '',
            }))
        : [],
    };
  } catch {
    return null;
  }
}

/** 相对频道目录补全为绝对地址。 */
function absUrl(u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  try {
    return new URL(u, OFFICIAL_UPDATE_CHANNEL).toString();
  } catch {
    return u;
  }
}

/**
 * 检查 App 更新。返回 null = 已是最新（或都查不到）。
 * 频道可达时以频道为准；频道不可达才回退用户服务器。
 */
export async function checkAppUpdate(server: ServerConfig | null): Promise<AppUpdateTarget | null> {
  const now = new Date().toISOString();

  /**
   * ① 当前服务器优先：服务器后台传过更新包 → 只走它的通道
   *（其他部署者在自己服务器上传包，就形成自己的更新通道；
   *  切换服务器后这里自然跟着变，不做任何额外选择）
   */
  if (server) {
    try {
      const info = await checkAppVersion(server);
      const remote = (info.version ?? '').trim();
      if (remote && compareVersions(remote, APP_VERSION) > 0) {
        recordUpdateLog({
          at: now,
          source: 'server',
          current: APP_VERSION,
          remote,
          reason: '当前服务器已发布更新包，走该服务器通道',
          server: server.url,
        });
        return {
          source: 'server',
          version: remote,
          notes: info.notes ?? '',
          publishedAt: info.publishedAt ?? '',
          apkUrl: `${server.url.replace(/\/+$/, '')}/api/app/download`,
          apkSize: info.fileSize ?? 0,
          apkSha256: '',
          patch: null,
        };
      }
      // 服务器没有发布 / 版本不新 → 继续看官网
    } catch {
      /* 服务器不可达：继续尝试官网 */
    }
  }

  // ② 官网渠道（有增量补丁）
  const m = await fetchChannelManifest();
  if (m) {
    if (compareVersions(m.version, APP_VERSION) > 0) {
      const patch = m.patches.find((p) => p.from === APP_VERSION) ?? null;
      recordUpdateLog({
        at: now,
        source: 'channel',
        current: APP_VERSION,
        remote: m.version,
        reason: server ? '当前服务器无更新包，走官网渠道' : '未连接服务器，走官网渠道',
        server: server?.url,
      });
      return {
        source: 'channel',
        version: m.version,
        notes: m.notes,
        publishedAt: m.publishedAt,
        apkUrl: m.apk.url,
        apkSize: m.apk.size,
        apkSha256: m.apk.sha256,
        patch,
      };
    }
    recordUpdateLog({
      at: now,
      source: 'none',
      current: APP_VERSION,
      remote: m.version,
      reason: '官网与服务器都没有更新版本',
      server: server?.url,
    });
    return null;
  }

  recordUpdateLog({
    at: now,
    source: 'none',
    current: APP_VERSION,
    remote: '',
    reason: '官网渠道不可达，且服务器没有可用更新',
    server: server?.url,
  });
  return null;
}
