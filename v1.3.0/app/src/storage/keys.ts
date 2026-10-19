import { COLLECTIONS, type CollectionName } from '../types/entities';

/**
 * 本地存储键名（★v1.0.26 起前缀统一为 `flyme.`，旧 `flyme.` 键由
 * `migrateLegacyKeys()` 在应用启动时一次性迁移，跨端备份不受影响）。
 */

/** KV 前缀（`flyme.kv.<name>`）。 */
export const KV_PREFIX = 'flyme.kv.';

/** 会话（token + user）。 */
export const K_USER = 'flyme.user';
/** 当前服务器（Web 版兼容镜像）。 */
export const K_SELFHOST = 'flyme.selfhost';
/** 自定义识别规则（与网页版云端镜像互通，形状 {keyword,category,judgement}）。 */
export const K_PARSE_RULES = 'flyme.parse.rules';
/**
 * ★v1.2.0 本地自学习规则（PRD：对话式智能记录入口改造）。
 * 用户在确认卡片上手动纠正分类后，由样本提炼成的「关键词簇 + 上下文共现词」规则，
 * **只存本机不上云**（避免破坏与网页版互通的 `flyme.parse.rules` payload 形状）。
 */
export const K_LEARNED_RULES = 'flyme.parse.learned';
/** 学习样本（用户人工纠正的原始记录，供规则管理页查看/删除）。 */
export const K_LEARN_SAMPLES = 'flyme.parse.samples';
/** 汇率表。 */
export const K_RATES = 'flyme.rates.v2';
/** UI 偏好（offlineMode / homeTab / lastRoute）。 */
export const K_UI = 'flyme.ui';
/** 是否已灌种子。 */
export const K_SEEDED = 'flyme.seeded.v1';

/** 设置。 */
export const KV_SETTINGS = `${KV_PREFIX}settings`;
/** 服务器列表。 */
export const KV_SERVERS = `${KV_PREFIX}servers`;
/** 备份元信息（自动备份节流用）。 */
export const KV_BACKUP_META = `${KV_PREFIX}backupMeta`;

/** 集合键：`flyme.<collection>`。 */
export function collectionKey(name: CollectionName): string {
  return `flyme.${name}`;
}

/** 全部集合键（有序，与 COLLECTIONS 对齐）。 */
export const COLLECTION_KEYS: string[] = COLLECTIONS.map((c) => collectionKey(c));

/** 全部 KV 键（供「清空本地数据」与调试）。 */
export const ALL_MANAGED_KEYS: string[] = [
  K_USER,
  K_SELFHOST,
  K_PARSE_RULES,
  K_LEARNED_RULES,
  K_LEARN_SAMPLES,
  K_RATES,
  K_UI,
  K_SEEDED,
  KV_SETTINGS,
  KV_SERVERS,
  KV_BACKUP_META,
  ...COLLECTION_KEYS,
];

/** 旧版前缀（v1.0.25 及更早）。 */
export const LEGACY_PREFIX = 'flyme.';
/** 旧 KV 前缀。 */
export const LEGACY_KV_PREFIX = 'flyme.kv.';
/** 迁移标记键（迁移成功后写入，避免重复扫描）。 */
export const K_MIGRATED = 'flyme.migrated.v1';

/**
 * ★v1.0.26：把旧 `flyme.*` 本地键一次性迁移到 `flyme.*`。
 * - 只迁移「新键不存在且旧键存在」的项（不覆盖新数据）；
 * - 迁移成功后写 K_MIGRATED 标记，之后启动直接跳过；
 * - 全程 try/catch，localStorage 不可用（App Preferences 代理等）时静默跳过。
 */
export function migrateLegacyKeys(): void {
  try {
    if (localStorage.getItem(K_MIGRATED) === '1') return;
    let moved = 0;
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(LEGACY_PREFIX) || k.startsWith(LEGACY_KV_PREFIX))) legacyKeys.push(k);
    }
    for (const old of legacyKeys) {
      const next = `flyme.${old.slice(LEGACY_PREFIX.length)}`;
      if (localStorage.getItem(next) === null) {
        const v = localStorage.getItem(old);
        if (v !== null) {
          localStorage.setItem(next, v);
          moved += 1;
        }
      }
    }
    localStorage.setItem(K_MIGRATED, '1');
    if (moved > 0) console.info(`[keys] 已迁移 ${moved} 个旧数据键到 flyme.* 前缀`);
  } catch {
    /* localStorage 不可用时静默 */
  }
}
