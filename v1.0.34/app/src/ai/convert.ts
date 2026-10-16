import { today as todayStr } from '../lib/date';
import { emojiForName } from '../lib/emoji';
import type { AiResultItem, GoodsDraft, LedgerDraft, SubDraft } from '../types/ai';
import type { Category } from '../types/entities';
import { defaultCategoryId, matchCategoryId } from './localParser';

/**
 * ★v1.0.27 识别结果类型切换：生活流 / 物品 / 订阅 三选一。
 *
 * AI（或本地规则）偶尔会把「买包烟」识别成物品、把「买桌子」识别成消费——
 * 与其让用户去对应页面手工改，不如在确认列表上直接一键改类型。
 * 转换只搬运 金额 / 名称 / 日期 等已有信息，分类重新按文本匹配，缺省走默认值。
 */

/** 可切换的三种目标类型。 */
export type SwitchableKind = 'ledger' | 'goods' | 'sub';

const KIND_BY_ACTION: Partial<Record<AiResultItem['action'], SwitchableKind>> = {
  create_ledger: 'ledger',
  create_goods: 'goods',
  create_subscription: 'sub',
};

/** 该条结果当前属于哪种可切换类型（其余动作如 情绪/时间/退役 返回 null）。 */
export function switchableKindOf(it: AiResultItem): SwitchableKind | null {
  return KIND_BY_ACTION[it.action] ?? null;
}

/** 三类 chip 的展示顺序。 */
export const SWITCH_KINDS: Array<{ kind: SwitchableKind; label: string }> = [
  { kind: 'ledger', label: '生活' },
  { kind: 'goods', label: '物品' },
  { kind: 'sub', label: '订阅' },
];

/** 取当前条目的「名称」语义（物品/订阅用 name，生活流用 note）。 */
function nameOf(it: AiResultItem): string {
  if (it.action === 'create_goods' && it.goodsDraft) return it.goodsDraft.name;
  if (it.action === 'create_subscription' && it.subDraft) return it.subDraft.name;
  if (it.action === 'create_ledger' && it.ledgerDraft) {
    // note 可能带「早饭·」前缀，物品/订阅名里不需要餐次
    return it.ledgerDraft.note.replace(/^[早午晚宵夜下上]{1,2}[饭餐茶]·/, '') || '消费';
  }
  return '';
}

/** 取当前条目的金额语义。 */
function amountOf(it: AiResultItem): number {
  if (it.action === 'create_goods' && it.goodsDraft) return it.goodsDraft.price;
  if (it.action === 'create_subscription' && it.subDraft) return it.subDraft.amount;
  if (it.action === 'create_ledger' && it.ledgerDraft) return it.ledgerDraft.amount;
  return 0;
}

/** 取当前条目的日期语义。 */
function dateOf(it: AiResultItem, fallback: string): string {
  if (it.action === 'create_goods' && it.goodsDraft) return it.goodsDraft.buyDate || fallback;
  if (it.action === 'create_ledger' && it.ledgerDraft) return it.ledgerDraft.date || fallback;
  return fallback;
}

/** 组装生活流草稿。 */
function toLedgerDraft(
  it: AiResultItem,
  categories: Category[],
  today: string,
): LedgerDraft {
  const text = nameOf(it);
  const amount = amountOf(it);
  const categoryId =
    matchCategoryId(text, categories, 'ledger') || defaultCategoryId(categories, 'ledger');
  return {
    type: 'expense',
    amount,
    categoryId,
    judgement: 'xu',
    date: dateOf(it, today),
    note: text.slice(0, 40),
  };
}

/** 组装物品草稿。 */
function toGoodsDraft(
  it: AiResultItem,
  categories: Category[],
  today: string,
): GoodsDraft {
  const name = (nameOf(it) || '物品').slice(0, 24);
  const matchText = `${name} ${it.explanation ?? ''}`;
  const categoryId =
    matchCategoryId(matchText, categories, 'goods') || defaultCategoryId(categories, 'goods');
  return {
    name,
    price: amountOf(it),
    currency: it.goodsDraft?.currency ?? it.subDraft?.currency ?? 'CNY',
    buyDate: dateOf(it, today),
    categoryId,
    icon: emojiForName(name),
    tags: [],
    note: '',
  };
}

/** 组装订阅草稿。 */
function toSubDraft(
  it: AiResultItem,
  categories: Category[],
): SubDraft {
  const name = (nameOf(it) || '订阅').slice(0, 24);
  const categoryId =
    matchCategoryId(name, categories, 'sub') || defaultCategoryId(categories, 'sub');
  return {
    name,
    amount: amountOf(it),
    currency: it.goodsDraft?.currency ?? it.subDraft?.currency ?? 'CNY',
    period: 'month',
    every: 1,
    categoryId,
    icon: emojiForName(name),
  };
}

/**
 * 把一条识别结果切换到目标类型（同类型原样返回）。
 *
 * @example convertItem(goodsItem, 'ledger', categories) → 生活流记账草稿
 */
export function convertItem(
  it: AiResultItem,
  target: SwitchableKind,
  categories: Category[],
  today: string = todayStr(),
): AiResultItem {
  const cur = switchableKindOf(it);
  if (!cur || cur === target) return it;

  if (target === 'ledger') {
    return { ...it, action: 'create_ledger', ledgerDraft: toLedgerDraft(it, categories, today), explanation: `手动改为生活流${it.explanation ? `（原：${it.explanation}）` : ''}` };
  }
  if (target === 'goods') {
    return { ...it, action: 'create_goods', goodsDraft: toGoodsDraft(it, categories, today), explanation: `手动改为物品${it.explanation ? `（原：${it.explanation}）` : ''}` };
  }
  return { ...it, action: 'create_subscription', subDraft: toSubDraft(it, categories), explanation: `手动改为订阅${it.explanation ? `（原：${it.explanation}）` : ''}` };
}
