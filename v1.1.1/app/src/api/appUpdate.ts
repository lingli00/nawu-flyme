import { request } from '../net/httpClient';
import { APP_VERSION, OFFICIAL_UPDATE_CHANNEL, compareVersions } from '../lib/appVersion';
import { checkAppVersion } from './app';
import type { ServerConfig } from '../types/entities';

/**
 * v1.0.36 · App 更新检查（官方频道优先，用户自己的服务器兜底）。
 *
 * - 官方频道：http://127.0.0.1:2233/nawu-update/app-manifest.json，
 *   含完整安装包 + 可选增量补丁（NAWU-PATCH1，见 .gh/make-app-patch.py）；
 * - 频道不可达时回退用户服务器 /api/app/version（无补丁，只能全量）；
 * - 网页端不适用本模块的安装流程（浏览器打开即最新版），
 *   SettingsPage 会按 isNative() 分流。
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
  const m = await fetchChannelManifest();
  if (m) {
    if (compareVersions(m.version, APP_VERSION) <= 0) {
      return null;
    }
    const patch = m.patches.find((p) => p.from === APP_VERSION) ?? null;
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
  if (!server) {
    return null;
  }
  try {
    const info = await checkAppVersion(server);
    const remote = (info.version ?? '').trim();
    if (!remote || compareVersions(remote, APP_VERSION) <= 0) {
      return null;
    }
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
  } catch {
    return null;
  }
}
