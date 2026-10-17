/**
 * 自动备份策略（架构 §7.5 / R4 / R5）。
 *
 * ★服务端只保留最近 3 份备份（PHP 侧 trimBackups(3)），
 * 因此自动备份必须节流：24 小时 + 变更条数阈值。
 */

/** 24 小时（ms）。 */
export const BACKUP_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** 默认变更阈值：距上次备份至少新增/修改 5 条才自动备份（Q5）。 */
export const DEFAULT_CHANGE_THRESHOLD = 5;

export interface AutoBackupInput {
  /** 是否已登录（离线不备份） */
  loggedIn: boolean;
  /** 设置里的自动同步开关 */
  autoSync: boolean;
  /** 上次备份时间（ISO 或空串） */
  lastBackupAt: string;
  /** 距上次备份的变更条数 */
  changedSinceBackup: number;
  /** 变更阈值，默认 5 */
  threshold?: number;
  /** 节流时长，默认 24h */
  throttleMs?: number;
  /** 参考时间（测试用），默认 Date.now() */
  now?: number;
}

/**
 * 是否应该静默自动备份。
 *
 * 条件（全部满足）：已登录 && 开了自动同步 && 变更 ≥ 阈值 && 距上次备份 > 24h（或从未备份）。
 */
export function shouldAutoBackup(s: AutoBackupInput): boolean {
  if (!s.loggedIn || !s.autoSync) return false;
  const threshold = s.threshold ?? DEFAULT_CHANGE_THRESHOLD;
  if ((s.changedSinceBackup ?? 0) < threshold) return false;
  if (!s.lastBackupAt) return true;

  const last = Date.parse(s.lastBackupAt);
  if (!Number.isFinite(last)) return true;
  const now = s.now ?? Date.now();
  return now - last > (s.throttleMs ?? BACKUP_THROTTLE_MS);
}

/** 距下次可自动备份还剩多少毫秒（已可备份则返回 0）。 */
export function msUntilNextAutoBackup(lastBackupAt: string, now: number = Date.now()): number {
  if (!lastBackupAt) return 0;
  const last = Date.parse(lastBackupAt);
  if (!Number.isFinite(last)) return 0;
  const left = last + BACKUP_THROTTLE_MS - now;
  return left > 0 ? left : 0;
}

/** 备份页顶部常驻提示（R5 硬要求）。 */
export const BACKUP_NOTICE = '服务端仅保留最近 3 份备份，重要数据请定期本地导出';

/** 生成默认备份标签：`手动备份 10-06 08:12`。 */
export function backupLabel(kind: 'manual' | 'auto' = 'manual', at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return kind === 'auto' ? `自动备份 ${stamp}` : `手动备份 ${stamp}`;
}
