import { describe, expect, it } from 'vitest';
import { answerQuery, isQueryIntent, type QueryData } from '../src/ai/queryLocal';
import type { Category, Goods, Mood, Subscription, TimeRec, ValueRecord } from '../src/types/entities';

/* v1.2.0 对话入口查询能力（意图识别 + 本地数据回答）。 */

const TODAY = '2026-10-19'; // 周一

function goods(partial: Partial<Goods>): Goods {
  return {
    id: 'g1',
    name: '物品',
    categoryId: 'cg0',
    tags: [],
    price: 0,
    currency: 'CNY',
    buyDate: TODAY,
    status: 'active',
    extraFees: [],
    incomes: [],
    ...partial,
  } as Goods;
}

function ledger(partial: Partial<ValueRecord>): ValueRecord {
  return {
    id: 'v1',
    type: 'expense',
    amount: 0,
    currency: 'CNY',
    date: TODAY,
    categoryId: 'cl0',
    judgement: 'xu',
    createdAt: '2026-10-19T00:00:00.000Z',
    ...partial,
  };
}

function mood(partial: Partial<Mood>): Mood {
  return { id: 'm1', feeling: '🙂', text: '', crushed: false, inHeart: false, date: TODAY, ...partial };
}

function time(partial: Partial<TimeRec>): TimeRec {
  return { id: 't1', durationMin: 60, tags: [], meaning: 'gui', date: TODAY, ...partial };
}

function sub(partial: Partial<Subscription> = {}): Subscription {
  return {
    id: 's1',
    name: '订阅',
    categoryId: 'cs0',
    icon: '🎬',
    currency: 'CNY',
    type: 'recurring',
    period: 'month',
    every: 1,
    amount: 25,
    startDate: TODAY,
    nextRenewDate: '2026-11-01',
    autoRenew: true,
    ...partial,
  } as Subscription;
}

const CATS: Category[] = [
  { id: 'cg0', name: '数码', icon: 'smartphone', kind: 'goods', order: 0 },
  { id: 'cl0', name: '餐饮', icon: 'utensils', kind: 'ledger', order: 0 },
  { id: 'cl1', name: '交通', icon: 'bus', kind: 'ledger', order: 1 },
  { id: 'cl2', name: '居住', icon: 'home', kind: 'ledger', order: 2 },
  { id: 'cl3', name: '学习', icon: 'book-open', kind: 'ledger', order: 3 },
  { id: 'cl4', name: '健康', icon: 'heart-pulse', kind: 'ledger', order: 4 },
  { id: 'cl5', name: '娱乐', icon: 'headphones', kind: 'ledger', order: 5 },
  { id: 'cl6', name: '人情', icon: 'gift', kind: 'ledger', order: 6 },
  { id: 'cl7', name: '其他', icon: 'package', kind: 'ledger', order: 7 },
  { id: 'cl8', name: '服饰', icon: 'shirt', kind: 'ledger', order: 8 },
  { id: 'cl9', name: '饰品', icon: 'gem', kind: 'ledger', order: 9 },
  { id: 'cl10', name: '食材', icon: 'milk', kind: 'ledger', order: 10 },
  { id: 'cl11', name: '日用', icon: 'package', kind: 'ledger', order: 11 },
  { id: 'cs0', name: '影音', icon: 'film', kind: 'sub', order: 0 },
];

function data(over: Partial<QueryData> = {}): QueryData {
  return {
    categories: CATS,
    goods: [],
    valueRecords: [],
    subscriptions: [],
    moods: [],
    times: [],
    ...over,
  };
}

describe('isQueryIntent', () => {
  it('查询说法 → true', () => {
    expect(isQueryIntent('帮我查一下昨天买了什么')).toBe(true);
    expect(isQueryIntent('你昨天消费了什么？')).toBe(true);
    expect(isQueryIntent('我昨天吃了什么？')).toBe(true);
    expect(isQueryIntent('昨天心情怎么样？')).toBe(true);
    expect(isQueryIntent('看看我的时间记录')).toBe(true);
    expect(isQueryIntent('这周花了多少？')).toBe(true);
    expect(isQueryIntent('有哪些订阅')).toBe(true);
    expect(isQueryIntent('查一下我的记录')).toBe(true);
  });

  it('记录说法 → false（不能被误判成查询）', () => {
    expect(isQueryIntent('刚买了N95笔记本准系统 花了899')).toBe(false);
    expect(isQueryIntent('抽纸花了0.01元。')).toBe(false);
    expect(isQueryIntent('买了包蓝利群花了39')).toBe(false);
    expect(isQueryIntent('午饭25')).toBe(false);
    expect(isQueryIntent('今天很开心')).toBe(false);
    expect(isQueryIntent('开通了腾讯视频会员 25/月')).toBe(false);
    expect(isQueryIntent('')).toBe(false);
  });

  it('「记一下/记一笔」开头且无强查询词 → 记录', () => {
    expect(isQueryIntent('记一下昨天花了多少钱')).toBe(false);
    expect(isQueryIntent('帮我记一笔 打车30')).toBe(false);
    // 但带「查」仍然是查询
    expect(isQueryIntent('查一下昨天记了些什么')).toBe(true);
  });
});

describe('answerQuery', () => {
  it('昨天买了什么 → 列出当天物品（空则给提示）', () => {
    const d = data({
      goods: [
        goods({ id: 'a', name: 'N95笔记本准系统', price: 899, buyDate: '2026-10-18' }),
        goods({ id: 'b', name: '抽纸', price: 0.01, buyDate: '2026-10-19' }),
      ],
    });
    const ans = answerQuery('昨天买了什么', d, TODAY);
    expect(ans).toContain('昨天买入 1 件物品');
    expect(ans).toContain('N95笔记本准系统 ¥899');
    expect(ans).not.toContain('抽纸');

    expect(answerQuery('昨天买了什么', data(), TODAY)).toContain('昨天没有买入物品的记录');
  });

  it('吃了什么/花了多少 → 生活流明细与合计', () => {
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 25, date: '2026-10-18', note: '午饭·黄焖鸡' }),
        ledger({ id: 'b', amount: 30, date: '2026-10-18', type: 'income', note: '报销' }),
        ledger({ id: 'c', amount: 12, date: TODAY, note: '早饭·豆浆' }),
      ],
    });
    const ans = answerQuery('昨天吃了什么', d, TODAY);
    expect(ans).toContain('昨天共 2 笔');
    expect(ans).toContain('支出 ¥25');
    expect(ans).toContain('收入 ¥30');
    expect(ans).toContain('黄焖鸡'); // 「午饭·」前缀已剥掉
    expect(ans).not.toContain('豆浆');
  });

  it('心情怎么样 → 心情列表', () => {
    const d = data({ moods: [mood({ feeling: '😄', text: '开心', date: '2026-10-18' })] });
    const ans = answerQuery('昨天心情怎么样', d, TODAY);
    expect(ans).toContain('心情记录 1 条');
    expect(ans).toContain('😄 开心');
    expect(answerQuery('心情记录', data(), TODAY)).toContain('还没有心情记录');
  });

  it('时间记录 → 时长明细', () => {
    const d = data({ times: [time({ durationMin: 90, date: TODAY, note: '打游戏' })] });
    const ans = answerQuery('这周时间记录', d, TODAY);
    expect(ans).toContain('时间记录 1 条');
    expect(ans).toContain('合计 1.5小时');
    expect(ans).toContain('1.5小时 打游戏');
    expect(answerQuery('时间记录', data(), TODAY)).toContain('还没有时间记录');
  });

  it('订阅 → 当前订阅列表', () => {
    const d = data({ subscriptions: [sub({ name: '腾讯视频', amount: 25 })] });
    const ans = answerQuery('有哪些订阅', d, TODAY);
    expect(ans).toContain('当前订阅 1 个');
    expect(ans).toContain('腾讯视频 ¥25/月');
    expect(ans).toContain('11/1 续费');
    expect(answerQuery('我的订阅', data(), TODAY)).toContain('还没有订阅记录');
  });

  it('泛查询（查一下我的记录）→ 各域汇总', () => {
    const d = data({
      goods: [goods({ name: '耳机', price: 299, buyDate: '2026-10-18' })],
      valueRecords: [ledger({ amount: 25, date: '2026-10-18' })],
      moods: [mood({ date: '2026-10-18' })],
      subscriptions: [sub()],
    });
    const ans = answerQuery('查一下我的记录', d, TODAY);
    expect(ans).toContain('物品 1 件（¥299）');
    expect(ans).toContain('生活流 1 笔（支出 ¥25）');
    expect(ans).toContain('订阅 1 个');
    expect(ans).toContain('心情 1 条');
  });

  it('日期范围：最近3天 / 本月 / 全部', () => {
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 10, date: '2026-10-17' }),
        ledger({ id: 'b', amount: 20, date: '2026-10-18' }),
        ledger({ id: 'c', amount: 30, date: '2026-10-01' }),
      ],
    });
    expect(answerQuery('最近3天花了多少', d, TODAY)).toContain('最近3天共 2 笔');
    expect(answerQuery('本月花了多少', d, TODAY)).toContain('本月共 3 笔');
    expect(answerQuery('花了多少', d, TODAY)).toContain('全部共 3 笔');
  });

  it('超过 8 条时提示「等 N 条」', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      ledger({ id: `v${i}`, amount: 1, date: '2026-10-18' }),
    );
    const ans = answerQuery('昨天花了多少', data({ valueRecords: many }), TODAY);
    expect(ans).toContain('等 10 笔');
  });

  /* ---------- ★v1.2.1 超级比较 + 汇总（用户反馈 5） ---------- */

  it('最贵/最便宜 → 直接给结论', () => {
    // 注意：三条都在本周内（TODAY=2026-10-19 周一，「本周」只有 10-19 一天）
    const d = data({
      goods: [
        goods({ id: 'a', name: 'Sony WH-1000XM5', price: 1299, buyDate: TODAY }),
        goods({ id: 'b', name: 'MacBook Air M3', price: 8999, buyDate: TODAY }),
        goods({ id: 'c', name: '机械键盘 87 键', price: 699, buyDate: TODAY }),
      ],
    });
    const ans = answerQuery('这一周买过最贵的东西是什么？', d, TODAY);
    expect(ans).toContain('最贵');
    expect(ans).toContain('MacBook Air M3 ¥8999');
    const cheap = answerQuery('这一周买过最便宜的是什么？', d, TODAY);
    expect(cheap).toContain('最便宜');
    expect(cheap).toContain('机械键盘 87 键 ¥699');
    expect(answerQuery('买过最贵的东西', data(), TODAY)).toContain('没有买入物品的记录');
  });

  it('最大/最小一笔（生活流）', () => {
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 25, date: TODAY, note: '午饭' }),
        ledger({ id: 'b', amount: 200, date: TODAY, note: '加油' }),
      ],
    });
    expect(answerQuery('这周最大的一笔花销', d, TODAY)).toContain('最大');
    expect(answerQuery('这周最大的一笔花销', d, TODAY)).toContain('¥200');
    expect(answerQuery('这周最小的一笔', d, TODAY)).toContain('¥25');
  });

  it('周/月/年汇总 → 合计 + 分类构成', () => {
    // 注意：TODAY=2026-10-19 是周一，「本周」只有 10-19 一天，测试数据都要落在本周内
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 25, date: TODAY, note: '午饭', categoryId: 'cl0' }),
        ledger({ id: 'b', amount: 30, date: TODAY, note: '打车', categoryId: 'cl1' }),
        ledger({ id: 'c', amount: 12, date: TODAY, note: '早饭', categoryId: 'cl0' }),
        ledger({ id: 'd', amount: 5000, date: '2026-09-01', note: '房租', categoryId: 'cl2' }),
      ],
      goods: [goods({ name: '耳机', price: 299, buyDate: TODAY })],
      moods: [mood({ date: TODAY })],
    });
    const week = answerQuery('本周汇总', d, TODAY);
    expect(week).toContain('本周汇总');
    expect(week).toContain('支出 ¥67'); // 25+30+12
    expect(week).toContain('餐饮 ¥37（2笔）');
    expect(week).toContain('买入物品 1 件');
    expect(week).toContain('心情 1 条');
    const month = answerQuery('这个月汇总', d, TODAY);
    expect(month).toContain('支出 ¥67'); // 9/1 的房租不计入本月
  });

  it('今年范围', () => {
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 100, date: '2026-01-15' }),
        ledger({ id: 'b', amount: 50, date: '2026-10-18' }),
        ledger({ id: 'c', amount: 70, date: '2025-12-31' }),
      ],
    });
    expect(answerQuery('今年花了多少', d, TODAY)).toContain('今年共 2 笔');
    expect(answerQuery('去年花了多少', d, TODAY)).toContain('去年共 1 笔');
  });

  it('「都干了什么」→ 全域汇总', () => {
    const d = data({ valueRecords: [ledger({ amount: 25, date: TODAY })] });
    const ans = answerQuery('我今天都干了什么', d, TODAY);
    expect(ans).toContain('今天记录');
    expect(ans).toContain('生活流 1 笔');
  });

  /* ---------- ★v1.3.0 周期分类统计 / 日均 / 订阅月均 / 摊销 ---------- */

  it('分类周期统计：这一周吃饭花了多少 → 餐饮合计 + 日均', () => {
    // TODAY=2026-10-19 是周一，「本周」只有 10-19 一天
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 19.9, date: TODAY, categoryId: 'cl0', note: '早饭·第一杯咖啡' }),
        ledger({ id: 'b', amount: 4, date: TODAY, categoryId: 'cl1', note: '地铁通勤' }),
        ledger({ id: 'c', amount: 12, date: TODAY, categoryId: 'cl0', note: '午饭·黄焖鸡' }),
        ledger({ id: 'd', amount: 63.4, date: '2026-10-17', categoryId: 'cl10', note: '上周备菜' }),
      ],
    });
    const ans = answerQuery('我这一周吃饭花了多少钱？', d, TODAY);
    expect(ans).toContain('本周餐饮共 2 笔，合计 ¥31.90');
    expect(ans).toContain('第一杯咖啡'); // 「早饭·」前缀已剥
    expect(ans).not.toContain('地铁通勤'); // 交通不计入
    expect(ans).toContain('按 1 天计'); // 周期日均
    // 口语「交通」命中交通分类
    const t = answerQuery('我这一周交通花多少？', d, TODAY);
    expect(t).toContain('本周交通共 1 笔，合计 ¥4');
    expect(t).toContain('地铁通勤');
  });

  it('日均花费：平均每天花多少 → 总支出 + 按天均', () => {
    const d = data({
      valueRecords: [
        ledger({ id: 'a', amount: 19.9, date: '2026-10-15', categoryId: 'cl0', note: '咖啡' }),
        ledger({ id: 'b', amount: 63.4, date: '2026-10-17', categoryId: 'cl10', note: '周末备菜' }),
        ledger({ id: 'c', amount: 280, date: '2026-10-15', type: 'income', note: '旧键盘已出' }),
      ],
    });
    const ans = answerQuery('我平均每天花费多少？', d, TODAY);
    expect(ans).toContain('支出 ¥83.30'); // 19.9+63.4
    expect(ans).toContain('收入 ¥280');
    expect(ans).toContain('日均支出');
    expect(ans).toContain('按 3 天计'); // 无周期词 → 按记录跨度 10-15~10-17
  });

  it('订阅月均/累计：平均每个月多少 + 一共花了多少', () => {
    const d = data({
      subscriptions: [
        sub({ id: 's1', name: '极客时间', amount: 199, period: 'year', startDate: '2024-05-21' }),
        sub({ id: 's2', name: 'iCloud 50G', amount: 6, period: 'month', startDate: '2025-06-10' }),
        sub({ id: 's3', name: '网易云音乐', amount: 15, period: 'month', startDate: '2026-10-24' }),
        sub({ id: 's4', name: '百度网盘', amount: 30, period: 'month', startDate: '2026-01-01' }),
      ],
      archivedSubIds: ['s4'],
    });
    const m = answerQuery('我的订阅平均每个月多少钱？', d, TODAY);
    expect(m).toContain('当前订阅 3 个'); // 停用的不计
    expect(m).toContain('月均合计');
    expect(m).toContain('极客时间 ¥199/年');
    expect(m).toContain('≈¥16.58/月'); // 199/12
    expect(m).not.toContain('百度网盘');
    const t = answerQuery('我的订阅一共花了多少？', d, TODAY);
    expect(t).toContain('累计已花');
    expect(t).toContain('极客时间');
  });

  it('物品摊销：每天成本多少 → 在用物品日均合计 + TOP', () => {
    const d = data({
      goods: [
        goods({ id: 'a', name: 'Sony WH-1000XM5', price: 1299, buyDate: '2026-09-20' }),
        goods({ id: 'b', name: '机械键盘', price: 699, buyDate: '2026-10-01' }),
        goods({ id: 'c', name: '旧相机', price: 8000, buyDate: '2025-01-01', status: 'retired', sellPrice: 36000 }),
      ],
    });
    const ans = answerQuery('我的物品每天成本多少？', d, TODAY);
    expect(ans).toContain('在用物品 2 件'); // 退役的不计
    expect(ans).toContain('日均摊销合计');
    expect(ans).toContain('Sony WH-1000XM5');
    expect(ans).not.toContain('旧相机');
  });

  it('汇总报表带摊销行（v1.3.0）', () => {
    const d = data({
      valueRecords: [ledger({ id: 'a', amount: 25, date: TODAY, note: '午饭' })],
      goods: [goods({ name: '耳机', price: 300, buyDate: TODAY })],
    });
    const ans = answerQuery('本周汇总', d, TODAY);
    expect(ans).toContain('物品日均摊销');
  });
});
