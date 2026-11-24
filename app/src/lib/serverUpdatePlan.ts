/**
 * v1.0.36 · 服务端在线更新「废弃文件删除规则」的 TS 镜像。
 *
 * 与服务端 `app/lib/Update.php` 的 planDiff / isProtectedPath / isBuildAsset
 * 逐条对齐；服务端 diff 是权威结果，本模块是同一套规则的客户端镜像与
 * 可执行规格（tests/serverUpdatePlan.test.ts 数据驱动对拍，防两端规则漂移）。
 */

export interface FileEntry {
  sha256: string;
  size: number;
}

export type FileMap = Record<string, FileEntry>;

const BUILD_EXTS = [
  'js', 'css', 'map', 'woff', 'woff2', 'ttf', 'png', 'svg',
  'jpg', 'jpeg', 'gif', 'webp', 'ico', 'txt',
];

const PROTECTED_NAMES = ['install.php', '.user.ini'];
const PROTECTED_DIRS = ['storage', 'brand-icons', 'tess', 'tessdata'];

/** 相对路径安全性：拒绝绝对路径、..、非法字符（与服务端 safeRelPath 同规则）。 */
export function safeRelPath(p: string): boolean {
  return (
    typeof p === 'string' &&
    p !== '' &&
    p.length <= 300 &&
    /^[A-Za-z0-9._/-]+$/.test(p) &&
    !p.includes('..') &&
    p[0] !== '/' &&
    !p.includes('//')
  );
}

/** 永久保护名单：任何规则都不得删除。 */
export function isProtectedPath(p: string): boolean {
  if (!safeRelPath(p)) return true;
  if (PROTECTED_NAMES.includes(p)) return true;
  return PROTECTED_DIRS.some((d) => p === d || p.startsWith(d + '/'));
}

/** 构建产物（assets/ 下的静态文件）——不在新 manifest 即可删。 */
export function isBuildAsset(p: string): boolean {
  if (!/^assets\/[-A-Za-z0-9._]+$/.test(p)) return false;
  const ext = (p.split('.').pop() ?? '').toLowerCase();
  return BUILD_EXTS.includes(ext);
}

export interface UpdateDiff {
  added: string[];
  updated: string[];
  deleted: string[];
  kept: string[];
}

/**
 * diff：本地 vs 新 manifest（applied = 上一次更新记录的 files 映射，首次更新传 null）。
 * 删除候选过滤：保护名单 → kept；assets 构建产物 → deleted；
 * app/ 且被 applied 托管 → deleted；其余 → kept。
 */
export function planDiff(local: FileMap, remote: FileMap, applied: FileMap | null | undefined): UpdateDiff {
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const [path, info] of Object.entries(remote)) {
    const l = local[path];
    if (!l) added.push(path);
    else if (l.sha256 !== info.sha256) updated.push(path);
  }
  for (const path of Object.keys(local)) {
    if (remote[path]) continue;
    if (isProtectedPath(path)) {
      kept.push(path);
    } else if (isBuildAsset(path)) {
      deleted.push(path);
    } else if (path.startsWith('app/') && applied && applied[path]) {
      deleted.push(path);
    } else {
      kept.push(path);
    }
  }
  const sortFn = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    added: added.sort(sortFn),
    updated: updated.sort(sortFn),
    deleted: deleted.sort(sortFn),
    kept: kept.sort(sortFn),
  };
}

export function summarize(diff: UpdateDiff): { added: number; updated: number; deleted: number; kept: number } {
  return {
    added: diff.added.length,
    updated: diff.updated.length,
    deleted: diff.deleted.length,
    kept: diff.kept.length,
  };
}
