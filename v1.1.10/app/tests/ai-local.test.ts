import { describe, expect, it } from 'vitest';
import { cnToNumber } from '../src/ai/cnNumber';
import { splitSentences } from '../src/ai/split';
import { cleanNote, parseLocal } from '../src/ai/localParser';
import { parseLocalOnly } from '../src/ai/parseService';
import { convertItem, switchableKindOf } from '../src/ai/convert';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { AiResultItem } from '../src/types/ai';

/** 解析一句话，返回非 unknown 的结果。 */
function parseAll(text: string, today = '2026-10-06'): AiResultItem[] {
  return parseLocalOnly(text, { categories: SEED_CATEGORIES, today }).items;
}

describe('ai/cnNumber · 中文数字', () => {
  it('两千=2000 / 一千二=1200 / 三千五=3500 / 半=0.5', () => {
    expect(cnToNumber('两千')).toBe(2000);
    expect(cnToNumber('一千二')).toBe(1200);
    expect(cnToNumber('三千五')).toBe(3500);
    expect(cnToNumber('半')).toBe(0.5);
  });

  it('也能处理 十五 / 一百二十 / 一万', () => {
    expect(cnToNumber('十五')).toBe(15);
    expect(cnToNumber('一百二十')).toBe(120);
    expect(cnToNumber('一万')).toBe(10000);
  });
});

describe('ai/split · 分句', () => {
  it('顺接连词「然后」能切开，保证拆成 2 条', () => {
    const parts = splitSentences('今天早上吃了油条包子花了30然后坐大巴花了60去桐柏');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('油条包子');
    expect(parts[1]).toContain('大巴');
  });

  it('句号 / 分号 / 换行也能切', () => {
    expect(splitSentences('买了杯子50。充了会员25')).toHaveLength(2);
    expect(splitSentences('买了杯子50；充了会员25')).toHaveLength(2);
  });
});

describe('ai/localParser · 本地规则解析（验收 7）', () => {
  it('① 「今天早上吃了油条包子花了30然后坐大巴花了60去桐柏」→ 餐饮30 + 交通60（目的地桐柏）', () => {
    const items = parseAll('今天早上吃了油条包子花了30然后坐大巴花了60去桐柏');
    expect(items).toHaveLength(2);

    const food = items[0]?.ledgerDraft;
    expect(items[0]?.action).toBe('create_ledger');
    expect(food?.amount).toBe(30);
    expect(food?.categoryId).toBe('cl0'); // 餐饮
    expect(food?.note).toContain('早饭');
    expect(food?.note).toContain('油条包子');

    const traffic = items[1]?.ledgerDraft;
    expect(items[1]?.action).toBe('create_ledger');
    expect(traffic?.amount).toBe(60);
    expect(traffic?.categoryId).toBe('cl1'); // 交通
    expect(traffic?.note).toContain('桐柏');
  });

  it('② 「坐飞机1200北京到上海」→ 交通 1200', () => {
    const items = parseAll('坐飞机1200北京到上海');
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe('create_ledger');
    expect(items[0]?.ledgerDraft?.amount).toBe(1200);
    expect(items[0]?.ledgerDraft?.categoryId).toBe('cl1');
    expect(items[0]?.ledgerDraft?.judgement).toBe('xu');
  });

  it('③ 「我在闲鱼买了魅族20花了两千」→ 物品 2000', () => {
    const items = parseAll('我在闲鱼买了魅族20花了两千');
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe('create_goods');
    expect(items[0]?.goodsDraft?.price).toBe(2000);
    expect(items[0]?.goodsDraft?.name).toContain('魅族');
    expect(items[0]?.goodsDraft?.categoryId).toBe('cg0'); // 数码
    expect(items[0]?.goodsDraft?.buyDate).toBe('2026-10-06');
  });

  it('④ 「今天很累」→ 情绪记录', () => {
    const items = parseAll('今天很累');
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe('create_mood');
    expect(items[0]?.moodDraft?.text).toBe('今天很累');
    expect(items[0]?.moodDraft?.feeling).toBeTruthy();
  });

  it('补充：买了双跑鞋 899 → 物品；冲动买的皮肤 129 → 判为「否」；发了工资 12000 → 收入「归」', () => {
    const shoes = parseAll('买了双跑鞋 899');
    expect(shoes[0]?.action).toBe('create_goods');
    expect(shoes[0]?.goodsDraft?.price).toBe(899);
    expect(shoes[0]?.goodsDraft?.categoryId).toBe('cg5'); // 运动

    const skin = parseAll('冲动买的皮肤 129');
    expect(skin[0]?.action).toBe('create_ledger');
    expect(skin[0]?.ledgerDraft?.amount).toBe(129);
    expect(skin[0]?.ledgerDraft?.judgement).toBe('fou');
    // ★v1.0.0：游戏充值从「娱乐」独立成「游戏」分类
    expect(skin[0]?.ledgerDraft?.categoryId).toBe('cl15'); // 游戏

    const salary = parseAll('发了工资 12000');
    expect(salary[0]?.ledgerDraft?.type).toBe('income');
    expect(salary[0]?.ledgerDraft?.amount).toBe(12000);
    expect(salary[0]?.ledgerDraft?.judgement).toBe('gui');
  });

  it('v1.0.0 新增分类：充话费→通讯、充游戏→游戏、云服务→云服务、维修→维修', () => {
    expect(parseAll('充了100块话费')[0]?.ledgerDraft?.categoryId).toBe('cl14'); // 通讯
    expect(parseAll('给游戏充了648')[0]?.ledgerDraft?.categoryId).toBe('cl15'); // 游戏
    expect(parseAll('阿里云服务器288元')[0]?.ledgerDraft?.categoryId).toBe('cl16'); // 云服务
    expect(parseAll('腾讯云域名55元')[0]?.ledgerDraft?.categoryId).toBe('cl16'); // 云服务
    expect(parseAll('修水管花了200')[0]?.ledgerDraft?.categoryId).toBe('cl23'); // 维修
    // 注：服饰/饰品/食材这类「买东西」的句子按设计会走 create_goods（物品），
    // 作为纯支出记录时才落到对应生活流分类，故这里不测「买了…」句式。
  });

  it('补充：订阅 / 时间记录 / 相对日期', () => {
    const sub = parseAll('开了个B站会员25');
    expect(sub[0]?.action).toBe('create_subscription');
    expect(sub[0]?.subDraft?.amount).toBe(25);
    expect(sub[0]?.subDraft?.period).toBe('month');

    const yesterday = parseAll('昨天打车花了32');
    expect(yesterday[0]?.ledgerDraft?.date).toBe('2026-10-05');

    const time = parseLocal('健身1小时', SEED_CATEGORIES, { today: '2026-10-06' });
    expect(time.action).toBe('create_time');
    expect(time.timeDraft?.durationMin).toBe(60);
    expect(time.timeDraft?.meaning).toBe('gui');
  });

  it('未配置 AI 时 parse 自动回落本地规则，source 为 local', async () => {
    const { parse } = await import('../src/ai/parseService');
    const out = await parse('今天早上吃了油条包子花了30', { categories: SEED_CATEGORIES, today: '2026-10-06' });
    expect(out.source).toBe('local');
    expect(out.items.length).toBeGreaterThanOrEqual(1);
    expect(out.reason).toContain('本地规则');
  });
});

describe('v1.0.27 · 消耗品不入物品库（买了烟/零食/日用品 → 生活流记账）', () => {
  it('「我买了包蓝利群花了18」→ 生活流记账 cl0，金额 18，不再建物品', () => {
    const items = parseAll('我买了包蓝利群花了18');
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe('create_ledger');
    expect(items[0]?.ledgerDraft?.amount).toBe(18);
    expect(items[0]?.ledgerDraft?.categoryId).toBe('cl0'); // 餐饮（烟酒类）
  });

  it('「买了包烟」没说金额 → 也走生活流记账（amount 0）', () => {
    const items = parseAll('买了包烟');
    expect(items[0]?.action).toBe('create_ledger');
    expect(items[0]?.ledgerDraft?.amount).toBe(0);
  });

  it('日用品/药/饮料：买纸巾→日用 cl11、买药→健康 cl4、买可乐→餐饮 cl0', () => {
    expect(parseAll('买了包纸巾花了10')[0]?.ledgerDraft?.categoryId).toBe('cl11');
    expect(parseAll('买药花了25')[0]?.ledgerDraft?.categoryId).toBe('cl4');
    expect(parseAll('买了瓶可乐花了3块')[0]?.action).toBe('create_ledger');
  });

  it('耐用品保持建物品档：魅族20→数码、跑鞋→运动、杯子→厨房', () => {
    expect(parseAll('在闲鱼买了魅族20花了两千')[0]?.action).toBe('create_goods');
    expect(parseAll('买了双跑鞋 899')[0]?.action).toBe('create_goods');
    expect(parseAll('买了个杯子50')[0]?.action).toBe('create_goods');
  });

  it('冲动语义优先级不变：冲动买的皮肤 129 → 生活流「否」', () => {
    const items = parseAll('冲动买的皮肤 129');
    expect(items[0]?.action).toBe('create_ledger');
    expect(items[0]?.ledgerDraft?.judgement).toBe('fou');
  });
});

describe('v1.0.27 · ai/convert 识别结果类型切换', () => {
  const today = '2026-10-14';

  it('switchableKindOf：三类可切换，情绪/时间/退役不可', () => {
    expect(switchableKindOf({ action: 'create_goods', source: 'local' } as AiResultItem)).toBe('goods');
    expect(switchableKindOf({ action: 'create_ledger', source: 'local' } as AiResultItem)).toBe('ledger');
    expect(switchableKindOf({ action: 'create_subscription', source: 'local' } as AiResultItem)).toBe('sub');
    expect(switchableKindOf({ action: 'create_mood', source: 'local' } as AiResultItem)).toBeNull();
  });

  it('物品 → 生活流：金额/日期搬运，note 取物品名', () => {
    const goods: AiResultItem = {
      action: 'create_goods',
      source: 'local',
      goodsDraft: { name: '蓝牙耳机', price: 199, currency: 'CNY', buyDate: today, categoryId: 'cg0', icon: '🎧', tags: [] },
    };
    const out = convertItem(goods, 'ledger', SEED_CATEGORIES, today);
    expect(out.action).toBe('create_ledger');
    expect(out.ledgerDraft?.amount).toBe(199);
    expect(out.ledgerDraft?.note).toBe('蓝牙耳机');
    expect(out.ledgerDraft?.date).toBe(today);
  });

  it('生活流 → 物品：note 变物品名，餐次前缀剥掉', () => {
    const ledger: AiResultItem = {
      action: 'create_ledger',
      source: 'local',
      ledgerDraft: { type: 'expense', amount: 30, categoryId: 'cl0', judgement: 'xu', date: today, note: '早饭·小米粥' },
    };
    const out = convertItem(ledger, 'goods', SEED_CATEGORIES, today);
    expect(out.action).toBe('create_goods');
    expect(out.goodsDraft?.name).toBe('小米粥');
    expect(out.goodsDraft?.price).toBe(30);
  });

  it('订阅 → 生活流 / 生活流 → 订阅 双向可用', () => {
    const sub: AiResultItem = {
      action: 'create_subscription',
      source: 'local',
      subDraft: { name: 'B站会员', amount: 25, currency: 'CNY', period: 'month', every: 1, categoryId: 'cs0', icon: '📺' },
    };
    const asLedger = convertItem(sub, 'ledger', SEED_CATEGORIES, today);
    expect(asLedger.action).toBe('create_ledger');
    expect(asLedger.ledgerDraft?.amount).toBe(25);

    const back = convertItem(asLedger, 'sub', SEED_CATEGORIES, today);
    expect(back.action).toBe('create_subscription');
    expect(back.subDraft?.name).toBe('B站会员');
  });
});

/**
 * ★v1.1.10 回归：名称里的型号码与金额要分得清。
 * 用户在真机上遇到的三个现象都落在这里：
 *   ① 名称里的「N95」被当金额删掉 → 只剩后半截；
 *   ② 「8G+128G」里的 128 被当金额 → 一台 4600 的笔记本记成 ¥128；
 *   ③ 认不出类别时默认落「餐饮」→ 笔记本被记成饭钱。
 */
describe('ai/localParser · 型号码 vs 金额（v1.1.10）', () => {
  it('note 保留型号码，不把 N95 拆掉', () => {
    expect(cleanNote('N95笔记淮系统粉色花了190')).toBe('N95笔记淮系统粉色');
    expect(cleanNote('N95口罩')).toBe('N95口罩');
    expect(cleanNote('iPhone 15 Pro 花了8999')).toBe('iPhone 15 Pro');
    expect(cleanNote('N95笔记本 8G+128G')).toBe('N95笔记本 8G+128G');
    expect(cleanNote('买了RTX4090显卡12000')).toBe('RTX4090显卡');
  });

  it('孤立出现的金额仍然会被清掉', () => {
    expect(cleanNote('油条包子 30')).toBe('油条包子');
    expect(cleanNote('买了外套 199')).toBe('外套');
  });

  it('8G+128G 不会被当成 ¥128', () => {
    const items = parseAll('买了台N95笔记本 8G+128G 4600');
    expect(items[0]?.goodsDraft?.name).toBe('N95笔记本 8G+128G');
    expect(items[0]?.goodsDraft?.price).toBe(4600);
  });

  it('「N95 型号码 + 花了 N」名称完整、金额正确', () => {
    const items = parseAll('N95笔记淮系统粉色花了190');
    expect(items[0]?.ledgerDraft?.note).toBe('N95笔记淮系统粉色');
    expect(items[0]?.ledgerDraft?.amount).toBe(190);
  });

  it('认不出类别时归「其他」，不再默认餐饮', () => {
    const items = parseAll('N95笔记淮系统粉色花了190');
    expect(items[0]?.ledgerDraft?.categoryId).toBe('cl7');
  });

  it('「粉色」不会被「粉」（米粉）误判成餐饮', () => {
    const items = parseAll('粉色台灯 89');
    expect(items[0]?.ledgerDraft?.categoryId).not.toBe('cl0');
  });
});
