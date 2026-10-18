import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/types/entities';
import type { CollectionName } from '../src/types/entities';
import { ensureSeeded, SEED_CATEGORIES, mergeSeedCategories, OTHER_LAST_ORDER } from '../src/storage/seed';
import { crud, loadAllCollections, loadCollection, saveCollectionNow } from '../src/storage/repo';
import { getKV, removeKV, setKV } from '../src/storage/kv';
import { KV_SETTINGS } from '../src/storage/keys';

describe('storage/repo · 12 集合读写往返（验收 5）', () => {
  beforeAll(async () => {
    // 清空，保证从零开始
    for (const name of COLLECTIONS) await saveCollectionNow(name, []);
  });

  it('12 个集合全部写入后读回，数据不丢', async () => {
    const written: Record<string, Array<{ id: string }>> = {};
    for (const name of COLLECTIONS) {
      const rows = [
        { id: `${name}-1`, name: '第一条' },
        { id: `${name}-2`, name: '第二条' },
      ];
      written[name] = rows;
      await saveCollectionNow(name as CollectionName, rows);
    }

    const all = await loadAllCollections();
    for (const name of COLLECTIONS) {
      const rows = (all as unknown as Record<string, Array<{ id: string }>>)[name];
      expect(rows, `集合 ${name} 读取失败`).toHaveLength(2);
      expect(rows[0]?.id).toBe(`${name}-1`);
      expect(rows[1]?.id).toBe(`${name}-2`);
    }
  });

  it('空的 / 损坏的集合读取为空数组而不是抛错', async () => {
    await removeKV('flyme.walls');
    expect(await loadCollection('walls')).toEqual([]);
    await setKV('flyme.times', { broken: true });
    expect(await loadCollection('times')).toEqual([]);
  });

  it('CRUD 增删改查可用', async () => {
    await saveCollectionNow('goods', []);
    const goods = crud<{ id: string; name: string }>('goods');
    const created = await goods.insert({ name: '跑鞋' } as { id: string; name: string });
    expect(created.id).toBeTruthy();
    expect((await goods.list()).length).toBe(1);

    await goods.update(created.id, { name: '跑鞋 2' });
    expect((await goods.findById(created.id))?.name).toBe('跑鞋 2');

    await goods.remove(created.id);
    expect((await goods.list()).length).toBe(0);
  });
});

describe('storage/seed · 分类种子（验收 5）', () => {
  it('43 条分类齐全，id 与 kind 正确', async () => {
    await saveCollectionNow('categories', []);
    await removeKV('flyme.seeded.v1');
    await removeKV(KV_SETTINGS);
    await ensureSeeded();

    const cats = await loadCollection<{ id: string; kind: string; name: string }>('categories');
    // ★v1.0.0：生活流分类由 8 条扩充到 24 条（服饰/饰品/食材/通讯/游戏/云服务…）
    expect(cats).toHaveLength(43);

    const goods = cats.filter((c) => c.kind === 'goods').map((c) => c.id);
    const sub = cats.filter((c) => c.kind === 'sub').map((c) => c.id);
    const ledger = cats.filter((c) => c.kind === 'ledger').map((c) => c.id);

    expect(goods).toEqual(['cg0', 'cg1', 'cg2', 'cg3', 'cg4', 'cg5', 'cg6', 'cg7', 'cg8', 'cg9', 'cg10', 'cg11', 'cg12']);
    expect(sub).toEqual(['cs0', 'cs1', 'cs2', 'cs3', 'cs4', 'cs5']);
    expect(ledger).toEqual([
      'cl0', 'cl1', 'cl2', 'cl3', 'cl4', 'cl5', 'cl6',
      'cl8', 'cl9', 'cl10', 'cl11', 'cl12', 'cl13', 'cl14', 'cl15', 'cl16', 'cl17',
      'cl18', 'cl19', 'cl20', 'cl21', 'cl22', 'cl23',
      'cl7', // 「其他」恒定垫底
    ]);
    expect(SEED_CATEGORIES.find((c) => c.id === 'cl0')?.name).toBe('餐饮');
    expect(SEED_CATEGORIES.find((c) => c.id === 'cl0')?.icon).toBe('utensils'); // v1.0.3 极简 lucide id
    // 新增分类存在性
    expect(SEED_CATEGORIES.find((c) => c.id === 'cl14')?.name).toBe('通讯');
    expect(SEED_CATEGORIES.find((c) => c.id === 'cl15')?.name).toBe('游戏');
    expect(SEED_CATEGORIES.find((c) => c.id === 'cl16')?.name).toBe('云服务');
    expect(SEED_CATEGORIES.find((c) => c.id === 'cl8')?.name).toBe('服饰');
  });

  it('老版本升级：按 id 补齐新增种子分类，且「其他」被顶到最后', async () => {
    // 模拟老用户：只有 27 条老种子，且「其他」还是老版本的 order 7
    const OLD = SEED_CATEGORIES.filter((c) => /^cg|^cs|^cl[0-7]$/.test(c.id)).map((c) =>
      c.id === 'cl7' ? { ...c, order: 7 } : c,
    );
    expect(OLD).toHaveLength(27);
    const { list, changed } = mergeSeedCategories(OLD);
    expect(changed).toBe(true);
    expect(list).toHaveLength(43);
    // 老分类（含改名/自定义排序）不被覆盖
    expect(list.find((c) => c.id === 'cl0')?.name).toBe('餐饮');
    // 新增项被追加
    expect(list.find((c) => c.id === 'cl16')?.name).toBe('云服务');
    // 「其他」被顶到最后（排序后垫底）
    const sorted = list.filter((c) => c.kind === 'ledger').slice().sort((a, b) => a.order - b.order);
    expect(sorted[sorted.length - 1].id).toBe('cl7');
    expect(sorted[sorted.length - 1].order).toBe(OTHER_LAST_ORDER);
    // 幂等：再跑一次不再变化
    expect(mergeSeedCategories(list).changed).toBe(false);
  });

  it('首次启动会写入默认设置', async () => {
    const settings = await getKV<{ currency: string; app?: string }>(KV_SETTINGS, null);
    expect(settings).not.toBeNull();
    expect(settings?.currency).toBe('CNY');
  });
});
