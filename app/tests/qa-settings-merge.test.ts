import { describe, expect, it } from 'vitest';
import { applySnapshot, buildSnapshot } from '../src/storage/snapshot';
import { createDefaultSettings } from '../src/storage/seed';
import type { Settings } from '../src/types/entities';

/**
 * ★铁律回归测试（QA 补充）：
 * 快照恢复时 collections 整体替换、settings 必须合并展开 ——
 * 快照 settings **不含**的键（如纯 Web 备份里的 archivedSubIds），
 * 本机值必须保留；快照含的键则正常覆盖。
 * 依据：Web 端恢复代码 `t.replaceAll(collections); t.patchSettings(settings)`。
 */

/** 模拟「纯 Web 版备份」的 settings：不含 App 自定义键 archivedSubIds。 */
function webSnapshotSettings(): Settings {
  const s = { ...createDefaultSettings() };
  delete (s as unknown as Record<string, unknown>).archivedSubIds;
  return s;
}

/** settings 直接原样进快照（不再二次合并），undefined 时用纯 Web 版 settings。 */
function snapWith(settings?: Settings) {
  return buildSnapshot({
    collections: {
      goods: [{ id: 'g1' }],
      subscriptions: [{ id: 's1' }],
      valueRecords: [{ id: 'v1' }],
    },
    settings: settings ?? webSnapshotSettings(),
  });
}

describe('qa · settings 合并语义铁律', () => {
  it('纯 Web 备份（快照无 archivedSubIds 键）→ 保留本机归档列表', () => {
    const current = { ...createDefaultSettings(), archivedSubIds: ['s1', 's2'] } as Settings;

    const applied = applySnapshot(snapWith(), current);

    expect(applied.settings.archivedSubIds).toEqual(['s1', 's2']);
  });

  it('快照 settings 含某键 → 覆盖本机同名值（覆盖式恢复语义）', () => {
    const current = { ...createDefaultSettings(), currency: 'CNY' } as Settings;

    // 快照里 currency=USD → 应覆盖
    const applied = applySnapshot(snapWith({ ...webSnapshotSettings(), currency: 'USD' }), current);
    expect(applied.settings.currency).toBe('USD');
  });

  it('本机独有的 aiModel 配置：快照缺该键时保留，快照有该键时覆盖', () => {
    const current = { ...createDefaultSettings(), aiModel: 'local-model' } as Settings;

    // 快照缺 aiModel → 保留本机
    const partial = webSnapshotSettings();
    delete (partial as unknown as Record<string, unknown>).aiModel;
    const kept = applySnapshot(snapWith(partial), current);
    expect(kept.settings.aiModel).toBe('local-model');

    // 快照有 aiModel（Web 默认 gpt-4o-mini）→ 覆盖本机
    const covered = applySnapshot(snapWith(), current);
    expect(covered.settings.aiModel).toBe('gpt-4o-mini');
  });

  it('本机 settings 为 null（首次恢复）也不抛错，走快照/默认值', () => {
    const applied = applySnapshot(snapWith({ ...webSnapshotSettings(), currency: 'USD' }), null);
    expect(applied.settings.currency).toBe('USD');
    expect(applied.settings.archivedSubIds).toEqual([]);
  });

  it('不传 currentSettings 时行为向后兼容（与旧调用一致）', () => {
    const applied = applySnapshot(snapWith({ ...webSnapshotSettings(), currency: 'USD' }));
    expect(applied.settings.currency).toBe('USD');
    expect(applied.settings.archivedSubIds).toEqual([]);
  });

  it('payload 为 JSON 字符串时同样保留本机自定义键', () => {
    const current = { ...createDefaultSettings(), archivedSubIds: ['keep'] } as Settings;
    const applied = applySnapshot(JSON.stringify(snapWith()), current);
    expect(applied.settings.archivedSubIds).toEqual(['keep']);
  });

  it('App 归档状态应随 App 备份一起上云（settings 含 archivedSubIds）', () => {
    const current = { ...createDefaultSettings(), archivedSubIds: ['s1'] } as Settings;
    const payload = buildSnapshot({
      collections: { goods: [], subscriptions: [], valueRecords: [] },
      settings: current,
    });
    const json = JSON.stringify(payload);
    expect(json).toContain('"archivedSubIds":["s1"]');
    expect(payload.app).toBe('flyme-web');
  });
});
