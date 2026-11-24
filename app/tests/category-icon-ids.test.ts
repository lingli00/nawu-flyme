import { describe, expect, it } from 'vitest';
import { CATEGORY_ICON_IDS, isKnownCategoryIconId } from '../src/lib/categoryIconIds';
import { CATEGORY_ICON_GROUPS, isKnownCategoryIcon } from '../src/lib/categoryIcons';

/**
 * ★v1.8.1 一致性护栏：`categoryIconIds.ts`（首包用的纯 id 集合）必须与
 * `categoryIcons.ts`（渲染用的图标组件库）的 id 集合**完全相等**。
 *
 * 为什么：首包瘦身把「种子迁移的 id 判定」从 categoryIcons 拆到了 categoryIconIds，
 * 避免整库 lucide 进首包。代价是 id 列表在两处各存一份 —— 将来新增/删除分类图标时
 * 若只改了一边，会让「种子迁移判断」与「实际可渲染图标」不一致（表现为旧分类迁移时
 * 图标被误判为未知而被覆盖，或新 id 被判非法）。本测试把这种漂移变成红灯。
 */
describe('lib/categoryIconIds · 与 categoryIcons 的 id 集合一致（防漂移）', () => {
  it('CATEGORY_ICON_IDS 与 CATEGORY_ICON_GROUPS 的 id 集合完全相等', () => {
    const fromGroups = new Set<string>();
    for (const g of CATEGORY_ICON_GROUPS) {
      for (const d of g.icons) fromGroups.add(d.id);
    }
    const fromIds = new Set<string>(CATEGORY_ICON_IDS);

    // 双向差集都要为空：任何一边多/少一个 id 都会在这里报出来
    const onlyInGroups = [...fromGroups].filter((id) => !fromIds.has(id));
    const onlyInIds = [...fromIds].filter((id) => !fromGroups.has(id));
    expect(onlyInGroups, '只有 categoryIcons 有、categoryIconIds 缺的 id').toEqual([]);
    expect(onlyInIds, '只有 categoryIconIds 有、categoryIcons 缺的 id').toEqual([]);

    // 数量也要相等（防止重复 id 让集合相等但条数不一致的错觉）
    expect(fromIds.size).toBe(fromGroups.size);
  });

  it('两处导出的判定函数对被抽查的 id 给出相同结论', () => {
    const sample = [...CATEGORY_ICON_IDS.slice(0, 5), 'not-a-real-icon', '', null];
    for (const id of sample) {
      expect(isKnownCategoryIconId(id)).toBe(isKnownCategoryIcon(id));
    }
  });
});
