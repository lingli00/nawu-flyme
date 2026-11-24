/**
 * 物品智能匹配（★v1.3.7）。
 *
 * 背景（用户反馈）：物品库里明明有「N95笔记本准系统 粉色」，用户说
 * 「粉色的N95笔记本」或「N95笔记本粉色」就匹配不到，只能报「请先入库」。
 * 旧实现是**严格子串**判断：
 *
 *     g.name.includes(key) || key.includes(g.name)
 *
 * 语序一变、多一个「的」、或者名称里夹了别的词，全都不成立；而且**完全没看备注**，
 * 而备注里往往写着更口语的型号叫法。
 *
 * 新实现不再要求语序一致，改成「关键词覆盖率」打分：
 * 1. 归一化：转小写、去掉标点/空白/虚词（的/了/我/把…），中英文一视同仁；
 * 2. 切词：中文按 2-gram 切（「粉色」「色笔」「笔记」「记本」），
 *    英文数字按连续串切（n95、pro）；
 * 3. 打分：查询词片段落在候选文本里的比例 = 覆盖率；
 * 4. 备注参与匹配，但权重略低（备注常是整句原文，容易误命中）；
 * 5. 排序：在役优先 → 分数高 → 名称更短更精确。
 *
 * 这样「N95笔记本粉色」= 7 个 2-gram，命中 6 个（≈0.86），
 * 「粉色的N95笔记本」= 7 个命中 6 个，两者都能稳定命中同一件物品；
 * 而「粉色鼠标」对它的覆盖率只有 1/4，不会串味。
 */

/** 可参与匹配的最小结构（物品实体天然满足）。 */
export interface MatchableItem {
  id: string;
  name: string;
  note?: string;
  status?: string;
  /** ★v1.3.8 标签参与搜索匹配。 */
  tags?: string[];
}

export interface MatchResult<T> {
  item: T;
  /** 0 ~ 1，越大越可信。 */
  score: number;
  /** 命中的关键词片段（调试/提示用）。 */
  hits: string[];
}

/** 虚词与量词：出现在查询里只会稀释匹配，直接丢掉。 */
const FILLER = /[的了是我把给就都也还和与跟这那个件条只卖出你他她它]/g;

/** 归一化：小写 + 去标点/空白 + 去虚词。 */
export function normalizeForMatch(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(FILLER, '');
}

/**
 * 切词：中文 2-gram + 英文/数字连续串。
 * 长度 ≤ 2 时整串作为一片（「灯」「硬盘」这种短词不做 2-gram）。
 */
export function tokenizeForMatch(s: string): string[] {
  const norm = normalizeForMatch(s);
  if (!norm) return [];
  if (norm.length <= 2) return [norm];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < norm.length; i++) {
    const g = norm.slice(i, i + 2);
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** 覆盖率：查询片段有多少落在了候选文本里。 */
function coverage(queryTokens: string[], haystack: string, hayTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0;
  let hit = 0;
  for (const t of queryTokens) {
    if (haystack.includes(t) || hayTokens.has(t)) hit += 1;
  }
  return hit / queryTokens.length;
}

/** 命中片段（用于卡片上「匹配到：粉色 / 笔记本 / N95」这类提示）。 */
function hitTokens(queryTokens: string[], haystack: string): string[] {
  return queryTokens.filter((t) => haystack.includes(t));
}

/** 低于这个分数不认，宁可让用户先入库，也不要错关联到别的物品。 */
const ACCEPT = 0.62;
/** 长查询（≥6 字）放宽一点：词越多越难全中，但已经足够有辨识度。 */
const ACCEPT_LONG = 0.55;
/** 备注命中打点折扣：备注常是整句原文，容易把别的物品也带进来。 */
const NOTE_WEIGHT = 0.94;

/**
 * 在一批物品里找最匹配的一件。
 *
 * @param list  物品库（通常是 store 里的全量列表）
 * @param query 用户口语描述，例如「粉色的N95笔记本」
 * @returns 命中的物品与分数；没有达到阈值的候选返回 null
 */
export function matchGoods<T extends MatchableItem>(list: T[], query: string): MatchResult<T> | null {
  const key = (query ?? '').trim();
  if (!key || !Array.isArray(list) || list.length === 0) return null;

  const qNorm = normalizeForMatch(key);
  const qTokens = tokenizeForMatch(key);
  const minHits = qTokens.length > 3 ? 2 : 1;

  let best: MatchResult<T> | null = null;
  let bestRank = -Infinity;

  for (const item of list) {
    const nameNorm = normalizeForMatch(item.name ?? '');
    const noteNorm = normalizeForMatch(item.note ?? '');
    if (!nameNorm) continue;

    let score = 0;
    let hits: string[] = [];

    // ① 整串包含（语序一致的强命中）：直接用满分
    if (nameNorm.includes(qNorm) || qNorm.includes(nameNorm)) {
      score = 1;
      hits = qTokens.filter((t) => nameNorm.includes(t));
    } else {
      // ② 名称覆盖率（★v1.3.8：同义别名互换，搜「内存条」能命中「DDR4」）
      const nameHay = withSynonyms(nameNorm, qNorm);
      const nameTokens = new Set(tokenizeForMatch(item.name ?? ''));
      const nameScore = coverage(qTokens, nameHay, nameTokens);
      const nameHits = hitTokens(qTokens, nameHay);

      // ③ 名称 + 备注一起看（权重打折）
      let fullScore = nameScore;
      let fullHits = nameHits;
      if (noteNorm) {
        const merged = withSynonyms(nameHay + noteNorm, qNorm);
        const mergedTokens = new Set([...nameTokens, ...tokenizeForMatch(item.note ?? '')]);
        const s = coverage(qTokens, merged, mergedTokens) * NOTE_WEIGHT;
        if (s > fullScore) {
          fullScore = s;
          fullHits = hitTokens(qTokens, merged);
        }
      }
      score = fullScore;
      hits = fullHits;
    }

    const accept = score >= ACCEPT || (qNorm.length >= 6 && score >= ACCEPT_LONG);
    if (!accept || hits.length < minHits) continue;

    // 排序权重：在役优先（退役/已售出的沉底），再比分数，再比名称精确度
    const retired = item.status === 'retired' ? 1 : 0;
    const rank = -retired * 10 + score * 5 + Math.min(nameNorm.length, 20) / 100;
    if (rank > bestRank) {
      bestRank = rank;
      best = { item, score: Number(score.toFixed(3)), hits };
    }
  }

  return best;
}

/** 取前 N 个候选（给「匹配到的是这件吗」这类选择场景用）。 */
export function matchGoodsTopN<T extends MatchableItem>(list: T[], query: string, n = 5): Array<MatchResult<T>> {
  const out: Array<MatchResult<T>> = [];
  for (const item of list) {
    const r = matchGoods([item], query);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

/* ======================================================================
 * ★v1.3.8 物品搜索：分词 + 同义别名 + 按重合度排序
 *
 * 用户反馈：物品叫「镁光DDR4 8G」，搜「美光内存条」「美光的DDR4」全都没有结果——
 * 旧实现是严格子串 `name.includes(kw)`，不懂分词、不懂别名。
 *
 * 三件事：
 * 1. 分词：复用 tokenizeForMatch（中文 2-gram + 英文数字串），长句/口语都能拆；
 * 2. 同义别名：内存条↔DDR↔内存、美光↔镁光、笔记本↔电脑……查询与物品
 *    分别命中同组的**不同**成员时互换（normalizeForMatch 会把「条/的」等虚词去掉，
 *    组内词统一用归一化形态）；
 * 3. 排序：重合度（覆盖率）高在前，在役优先于退役；搜索比语音定位宽松
 *    （阈值 0.34），宁多给几个候选也不要「搜不到」。
 * ==================================================================== */

/** 互为同义/别名的词组（组内均为 normalizeForMatch 之后的形态）。 */
const SYNONYM_GROUPS: string[][] = [
  ['内存', 'ddr', 'ram', '存储'],
  ['美光', '镁光', 'micron'],
  ['笔记本', '笔电', '电脑', 'laptop', '手提'],
  ['手机', '电话'],
  ['硬盘', '固态', 'ssd'],
  ['显卡', 'gpu', '显示卡'],
  ['平板', 'ipad'],
  ['耳机', '耳塞'],
  ['手表', '手环'],
  ['充电器', '充电头', '电源'],
  ['数据线', '充电线'],
  ['相机', '摄像机'],
];

/**
 * 同义互换：查询里出现组内某别名、物品文本里出现同组另一别名时，
 * 把查询侧的别名借给物品文本，让覆盖率打分能命中。
 */
function withSynonyms(itemNorm: string, queryNorm: string): string {
  if (!itemNorm || !queryNorm) return itemNorm;
  let extra = '';
  for (const group of SYNONYM_GROUPS) {
    const inQuery = group.filter((w) => queryNorm.includes(w));
    if (inQuery.length === 0) continue;
    const inItem = group.some((w) => itemNorm.includes(w));
    if (!inItem) continue;
    for (const w of inQuery) {
      if (!itemNorm.includes(w)) extra += w;
    }
  }
  return extra ? itemNorm + extra : itemNorm;
}

/** 列表搜索的接受阈值：比语音定位（0.62）宽松得多——搜索要召回，不要保守。 */
const SEARCH_ACCEPT = 0.34;

/**
 * 物品列表搜索：返回按重合度排序的全部命中（在役优先）。
 *
 * 与 matchGoods（唯一定位，用于语音关联物品）不同，这里面向搜索列表：
 * 阈值放宽、返回多个结果、名称/标签/备注一起参与匹配。
 */
export function searchGoods<T extends MatchableItem>(list: T[], query: string, limit = 50): Array<MatchResult<T>> {
  const key = (query ?? '').trim();
  if (!key) return [];
  const qNorm = normalizeForMatch(key);
  if (!qNorm) return [];
  const qTokens = tokenizeForMatch(key);

  const out: Array<MatchResult<T>> = [];
  for (const item of list) {
    const nameNorm = normalizeForMatch(item.name ?? '');
    const tagsNorm = normalizeForMatch((item.tags ?? []).join(' '));
    const noteNorm = normalizeForMatch(item.note ?? '');
    if (!nameNorm && !noteNorm && !tagsNorm) continue;

    const nameTokens = new Set(tokenizeForMatch(item.name ?? ''));
    const fullTokens = new Set([
      ...nameTokens,
      ...tokenizeForMatch((item.tags ?? []).join(' ')),
      ...tokenizeForMatch(item.note ?? ''),
    ]);
    const nameHay = withSynonyms(nameNorm, qNorm);
    const fullHay = withSynonyms(nameNorm + tagsNorm + noteNorm, qNorm);

    // ① 整串包含（语序一致的强命中）直接满分；② 否则取名称覆盖 / 全文覆盖的较大者
    let score = 0;
    if (nameNorm.includes(qNorm) || qNorm.includes(nameNorm)) score = 1;
    else {
      score = Math.max(coverage(qTokens, nameHay, nameTokens), coverage(qTokens, fullHay, fullTokens) * NOTE_WEIGHT);
    }
    if (score < SEARCH_ACCEPT) continue;
    out.push({ item, score: Number(score.toFixed(3)), hits: hitTokens(qTokens, fullHay) });
  }

  // 排序：在役优先 → 重合度高 → 名称更短更精确
  out.sort((a, b) => {
    const ra = a.item.status === 'retired' ? 1 : 0;
    const rb = b.item.status === 'retired' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    if (b.score !== a.score) return b.score - a.score;
    return (normalizeForMatch(a.item.name ?? '').length ?? 0) - (normalizeForMatch(b.item.name ?? '').length ?? 0);
  });
  return out.slice(0, Math.max(1, limit));
}
