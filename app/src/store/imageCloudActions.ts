import { humanMessage } from '../lib/error';
import {
  fetchCloudHashes,
  isCloudKnown,
  makeThumbDataUrl,
  uploadImage,
  cloudAvailable,
  sha256Hex,
} from '../lib/imageCloud';
import {
  base64BodyOf,
  hydrateImages,
  isMigratable,
  migrateRecord,
  type CloudImageLike,
  type MigrateCtx,
  type MigrateStat,
  type PendingImage,
} from '../lib/imageMigrate';
import logger from '../lib/log';
import { saveCollection } from '../storage/repo';
import { COLLECTIONS, type CollectionName } from '../types/entities';
import { useDataStore } from './useDataStore';

/**
 * ★v1.8.0 图片托管的实施层（编排：读记录 → 差异上传 → 改写记录 → 落盘）。
 *
 * 对外只暴露一个入口 `migrateLocalImages()`，被这些时机调用：
 *   · 用户点「立即备份到云端」之前（用户明确要求：备份前先比对云端差异）；
 *   · 同步引擎每轮开始时（登录态下自动、低频、失败静默）；
 *   · 打开物品详情 / 编辑物品时（单条，最小试探）。
 *
 * 关键设计：
 * - **只读刷新**：先一次性把 12 集合里需要托管的图找出来 → 取云端 sha256 列表 →
 *   只传云端没有的 → 再改写记录。这样一次备份的开销是「一次 LIST + N 张缺失图」，
 *   而不是「16MB 快照里塞满 base64」。
 * - **失败即回滚**：某张图上传失败 → 对应记录保持本地 base64 原样（不丢图）。
 * - **不碰其它字段**：改写记录只换 image/icon 字段，`updatedAt` 保持原值
 *   （托管不是「用户改了物品」，不该让它赢得 LWW 冲突、也不该触发同步风暴）。
 * - **落盘走 repo**：`saveCollection` 有防抖 + 串行写链 + 配额自愈，直接写 KV 会绕过它们。
 * - 同一条记录只会被本次改写一次：先把整段集合的改写结果算好，再一次性 saveCollection。
 */

/** 一次托管的统计（供设置页 / 日志展示）。 */
export interface ImageMigrateReport extends MigrateStat {
  /** 云端已有、无需上传的图片数。 */
  cloudExisting: number;
  /** 因服务器不支持 / 未登录 / 离线 → 完全没跑。 */
  skipped: string;
}

/** 同一时刻只允许一次托管（手动备份 + 自动同步可能同时触发）。 */
let running: Promise<ImageMigrateReport> | null = null;

const EMPTY_REPORT: ImageMigrateReport = { records: 0, uploaded: 0, deduped: 0, failed: 0, cloudExisting: 0, skipped: '' };

/**
 * 把本机所有「内嵌 base64 / 照片外链」的图托管到云端，并改写本地记录为引用。
 *
 * @param opts.scope `'all'`（默认，全量扫描）或 `'record'`（只处理单条，用于详情页打开时的最小试探）
 * @param opts.collection / opts.recordId 单条模式必填
 * @param opts.force 忽略「本进程已知云端已有」的快速判断（手动备份时用）
 */
export async function migrateLocalImages(
  opts: { scope?: 'all' | 'record'; collection?: CollectionName; recordId?: string; force?: boolean } = {},
): Promise<ImageMigrateReport> {
  if (running) return running;
  running = run(opts).finally(() => {
    running = null;
  });
  return running;
}

async function run(opts: {
  scope?: 'all' | 'record';
  collection?: CollectionName;
  recordId?: string;
  force?: boolean;
}): Promise<ImageMigrateReport> {
  if (!cloudAvailable()) return { ...EMPTY_REPORT, skipped: 'offline-or-guest' };

  try {
    const ds = useDataStore.getState();
    // 只处理用户真正打开的集合（AI/演示数据可能缺字段，一律容错）
    const targets: CollectionName[] =
      opts.scope === 'record' && opts.collection ? [opts.collection] : (COLLECTIONS as readonly CollectionName[]).slice();

    /* ① 扫描：找出需要迁移的图（本地图必然需要；照片外链也算） */
    const pending: PendingImage[] = [];
    const seen = new Set<string>();
    for (const name of targets) {
      const rows = (ds[name] as unknown as Array<Record<string, unknown>>) ?? [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (opts.scope === 'record' && opts.recordId && row.id !== opts.recordId) continue;
        for (const key of ['image', 'icon'] as const) {
          const v = row[key];
          if (!v) continue;
          const src = imageSourceOf(v);
          if (!src || seen.has(src)) continue;
          seen.add(src);
          const sha = await sha256Hex(src);
          pending.push({ src, sha256: sha ?? '' });
        }
      }
    }
    if (pending.length === 0) return { ...EMPTY_REPORT, skipped: '' };

    /* ② 云端已有 sha256（差异比对；老服务器不支持 → null，交给 PUT 自己判重） */
    const cloudHashes = opts.scope === 'all' || opts.force ? await fetchCloudHashes() : null;
    let cloudExisting = 0;
    if (cloudHashes) {
      for (const p of pending) if (p.sha256 && cloudHashes.has(p.sha256)) cloudExisting += 1;
    } else {
      for (const p of pending) if (p.sha256 && isCloudKnown(p.sha256)) cloudExisting += 1;
    }

    /* ③ 差异上传（只传云端没有的；并发 2；失败不抛） */
    const ctx: MigrateCtx = {
      upload: uploadImage,
      thumb: makeThumbDataUrl,
    };
    const hydrated = await hydrateImages(pending, { upload: uploadImage, cloudHashes });

    /* ④ 改写记录：用「内容 → 上传结果」把记录里的图换成云端引用 */
    const stat: MigrateStat = { records: 0, uploaded: hydrated.uploaded, deduped: hydrated.deduped, failed: hydrated.failed };
    const uploaderWithCache = async (src: string) => {
      const hit = hydrated.results.get(src);
      if (hit) return hit;
      // 兜底（理论上不会走到：hydrate 已覆盖所有 pending）
      return uploadImage(src);
    };

    for (const name of targets) {
      const rows = (ds[name] as unknown as Array<Record<string, unknown>>) ?? [];
      let changed = false;
      const nextRows: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') {
          nextRows.push(row);
          continue;
        }
        if (opts.scope === 'record' && opts.recordId && row.id !== opts.recordId) {
          nextRows.push(row);
          continue;
        }
        const before = countCloud(row);
        const out = await migrateRecord(row, { ...ctx, upload: uploaderWithCache }, stat);
        if (out.changed && countCloud(out.row) > before) {
          changed = true;
          nextRows.push(out.row);
        } else {
          nextRows.push(row);
        }
      }
      if (!changed) continue;
      stat.records += nextRows.filter((r, i) => r !== rows[i]).length;
      // 内存先更新（UI 立刻看到引用形态），落盘交给 repo 的防抖写链
      useDataStore.setState({ [name]: nextRows } as unknown as Partial<Record<string, unknown>>);
      await saveCollection(name, nextRows as unknown as unknown[]);
    }

    if (stat.uploaded || stat.deduped || stat.failed) {
      logger.debug(
        'imageCloud',
        `图片托管：新增 ${stat.uploaded}（云端已有 ${cloudExisting + stat.deduped}）、失败 ${stat.failed}、改写记录 ${stat.records}`,
      );
    }
    return { ...stat, cloudExisting, skipped: '' };
  } catch (e) {
    // 托管失败绝不影响主流程（备份/同步照常跑，图片仍是本地 base64）
    logger.warn('imageCloud', '图片托管中断（保留本地 base64）', humanMessage(e));
    return { ...EMPTY_REPORT, skipped: 'error' };
  }
}

/** 从 image/icon 字段取「待托管的图片内容」；不是可托管的返回 ''。 */
function imageSourceOf(v: unknown): string {
  try {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('img:')) return bodyOf(s);
      if (s.startsWith('cloud:') || s.startsWith('url:') || s.startsWith('brand:')) return '';
      return isMigratable(s) && !/^https?:\/\//i.test(s) ? s : '';
    }
    if (v && typeof v === 'object') {
      const img = v as CloudImageLike;
      if (typeof img.ref !== 'string') return '';
      if (typeof img.source === 'string' && img.source.toLowerCase() === 'cloud') return '';
      const ref = img.ref.trim();
      if (!ref || ref.startsWith('brand:') || ref.startsWith('cloud:')) return '';
      return isMigratable(ref) ? ref : '';
    }
  } catch {
    /* 异常数据一概不托管 */
  }
  return '';
}

function bodyOf(icon: string): string {
  const raw = icon.slice(4).trim();
  return raw.startsWith('data:') ? raw : `data:image/jpeg;base64,${base64BodyOf(raw)}`;
}

/** 记录里已经是云端引用的图片数（用于判断「这次改动真的把图托管了」）。 */
function countCloud(row: Record<string, unknown>): number {
  let n = 0;
  for (const key of ['image', 'icon'] as const) {
    const v = row[key];
    if (typeof v === 'string' && (v.startsWith('cloud:') || /\/api\/user\/images\//.test(v))) n += 1;
    else if (v && typeof v === 'object') {
      const img = v as CloudImageLike;
      if (typeof img.ref === 'string' && /\/api\/user\/images\//.test(img.ref)) n += 1;
    }
  }
  return n;
}