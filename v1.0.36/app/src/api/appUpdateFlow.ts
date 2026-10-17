import ApkUpdate from './apkUpdate';
import type { PluginListenerHandle } from '@capacitor/core';
import type { AppUpdateTarget } from './appUpdate';

/**
 * v1.0.36 · 应用内更新编排（仅 App 端；网页端请走 api/app.ts 的浏览器下载）。
 *
 * 流程：
 *   1. canInstall 权限检查（Android 8+ 需要「安装未知应用」，缺失则跳设置页）
 *   2. 有匹配的增量补丁 → 下载补丁（sha256 校验）→ applyPatch 合并 →
 *      合成结果按 manifest 的 apkSha256 校验 → 任一环节失败自动回退全量下载
 *   3. 全量下载（Range 断点续传由原生插件负责，下载中断后重试会续传）
 *   4. install 经 FileProvider 调起系统安装器
 *
 * 所有阶段通过 onProgress 回调推给 UI；本函数不自己弹任何 UI。
 */

export type UpdatePhase = 'permission' | 'download' | 'patch' | 'verify' | 'install' | 'done';

export interface UpdateProgress {
  phase: UpdatePhase;
  /** 已下载字节（下载阶段有效） */
  received: number;
  /** 总字节（未知时为 0） */
  total: number;
  /** 展示给用户的阶段描述 */
  text: string;
}

export interface UpdateOutcome {
  /** 整个流程是否成功走到「安装器已调起」 */
  started: boolean;
  /** 本次是否走了增量补丁路径 */
  usedPatch: boolean;
  /** 失败原因（started=true 时为空） */
  message: string;
}

/** 人类可读的文件大小。 */
export function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pct(received: number, total: number): string {
  if (!total || total <= 0) return '';
  const p = Math.floor((received / total) * 100);
  return ` ${Math.min(99, Math.max(0, p))}%`;
}

/**
 * 执行一次应用内更新。调用方需保证 isNative() 为真。
 * 本函数只抛「调用前置不满足」类的异常；更新本身的失败都收敛进返回值。
 */
export async function runAppUpdate(
  target: AppUpdateTarget,
  onProgress: (p: UpdateProgress) => void,
): Promise<UpdateOutcome> {
  const emit = (phase: UpdatePhase, received: number, total: number, text: string) =>
    onProgress({ phase, received, total, text });

  // ① 安装权限
  emit('permission', 0, 0, '检查安装权限…');
  let perm: { allowed: boolean };
  try {
    perm = await ApkUpdate.canInstall();
  } catch {
    return { started: false, usedPatch: false, message: '当前环境不支持应用内更新，请前往官网下载安装包' };
  }
  if (!perm.allowed) {
    try {
      await ApkUpdate.openInstallSettings();
    } catch {
      // 某些机型跳转设置页也会失败，忽略
    }
    return {
      started: false,
      usedPatch: false,
      message: '请先在系统设置里允许本应用「安装未知应用」，然后回来重试',
    };
  }

  // ② 增量补丁（失败自动回退全量）
  if (target.patch && target.patch.url) {
    try {
      const outcome = await updateByPatch(target, emit);
      return outcome;
    } catch {
      emit('download', 0, target.apkSize, '增量更新失败，改用完整安装包…');
    }
  }

  // ③ 全量下载
  const apkName = `nawu-${target.version}.apk`;
  const listener: PluginListenerHandle = await ApkUpdate.addListener('downloadProgress', (d) => {
    emit('download', d.received ?? 0, d.total ?? 0, `正在下载安装包${pct(d.received ?? 0, d.total ?? 0)}`);
  });
  try {
    const apk = await ApkUpdate.download({
      url: target.apkUrl,
      sha256: target.apkSha256 || undefined,
      fileName: apkName,
    });
    if (target.apkSha256 && apk.sha256.toLowerCase() !== target.apkSha256.toLowerCase()) {
      return { started: false, usedPatch: false, message: '安装包校验失败（sha256 不匹配），请重新更新' };
    }
    return await doInstall(apk.path, emit, false);
  } catch (e) {
    return { started: false, usedPatch: false, message: errText(e, '下载安装包失败，请检查网络后重试') };
  } finally {
    void listener.remove();
  }
}

/** 增量路径：下载补丁 → 合并 → 校验 → 安装。任何失败都抛错由调用方回退全量。 */
async function updateByPatch(
  target: AppUpdateTarget,
  emit: (phase: UpdatePhase, received: number, total: number, text: string) => void,
): Promise<UpdateOutcome> {
  const patch = target.patch!;
  const patchName = `nawu-patch-${target.version}.bin`;

  const listener: PluginListenerHandle = await ApkUpdate.addListener('downloadProgress', (d) => {
    emit('download', d.received ?? 0, d.total ?? 0, `正在下载增量包${pct(d.received ?? 0, d.total ?? 0)}`);
  });
  let patchPath: string;
  try {
    const pf = await ApkUpdate.download({
      url: patch.url,
      sha256: patch.sha256 || undefined,
      fileName: patchName,
    });
    patchPath = pf.path;
  } finally {
    void listener.remove();
  }

  emit('patch', 0, 0, '正在合并差分包…');
  const merged = await ApkUpdate.applyPatch({ patchPath, fileName: `nawu-${target.version}.apk` });

  emit('verify', 0, 0, '校验安装包…');
  if (patch.apkSha256 && merged.sha256.toLowerCase() !== patch.apkSha256.toLowerCase()) {
    throw new Error('合成结果与官方签名不一致');
  }
  return await doInstall(merged.path, emit, true);
}

async function doInstall(
  path: string,
  emit: (phase: UpdatePhase, received: number, total: number, text: string) => void,
  usedPatch: boolean,
): Promise<UpdateOutcome> {
  emit('install', 0, 0, '正在调起安装器…');
  const r = await ApkUpdate.install({ path });
  if (!r.started) {
    const why = r.reason === 'unknown_sources'
      ? '系统拒绝了安装请求，请检查「安装未知应用」权限'
      : `无法调起系统安装器：${r.reason ?? '未知原因'}`;
    return { started: false, usedPatch, message: why };
  }
  emit('done', 0, 0, '安装器已打开');
  return {
    started: true,
    usedPatch,
    message: usedPatch ? '安装器已打开，点「安装」完成增量更新' : '安装器已打开，点「安装」完成更新',
  };
}

function errText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}
