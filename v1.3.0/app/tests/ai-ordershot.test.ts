import { describe, expect, it } from 'vitest';
import { cleanProductName, orderNote, orderSentence, parseOrderShot, platformOf, type OrderHit } from '../src/ai/orderShot';
import { parseLocal } from '../src/ai/localParser';
import type { Category } from '../src/types/entities';
import ocr from './fixtures/ecom-ocr.json';

/**
 * ★v1.2.2 订单截图结构化（用户反馈 2：「让他识图是一塌糊涂」→ 按 9 张电商样本教它认）。
 *
 * fixture = 9 张真实截图（京东×3 / 拼多多×2 / 淘宝×2 / 抖音商城×2）经 Tesseract
 * （chi_sim，与 App 同配置）识别的**原始行文本**——解析器就是按这些噪声设计的。
 */

const JD_1 = ocr['S61019-11180546_com.jingdong.app.mall.png'] as string[];
const JD_2 = ocr['S61019-11180946_com.jingdong.app.mall.png'] as string[];
const JD_3 = ocr['S61019-11181238_com.jingdong.app.mall.png'] as string[];
const PDD_1 = ocr['S61019-11182730_com.xunmeng.pinduoduo.png'] as string[];
const PDD_2 = ocr['S61019-11183293_com.xunmeng.pinduoduo.png'] as string[];
const TB_1 = ocr['S61019-11184157_com.taobao.taobao.png'] as string[];
const TB_2 = ocr['S61019-11184976_com.taobao.taobao.png'] as string[];
const DY_1 = ocr['S61019-11190053_com.ss.android.ugc.aweme.png'] as string[];
const DY_2 = ocr['S61019-11190247_com.ss.android.ugc.aweme.png'] as string[];

const CATS: Category[] = [
  { id: 'cg0', name: '数码', icon: 'smartphone', kind: 'goods', order: 0 },
  { id: 'cl0', name: '餐饮', icon: 'utensils', kind: 'ledger', order: 0 },
  { id: 'cs0', name: '影音', icon: 'film', kind: 'sub', order: 0 },
];

/** 一笔订单 → parseLocal（确认合成句能复用全部分类逻辑）。 */
function parseOrder(o: OrderHit) {
  return parseLocal(orderSentence(o), CATS, { today: '2026-10-19', currency: 'CNY' });
}

describe('parseOrderShot：9 张真实电商截图', () => {
  it('京东订单详情（酒精湿巾）：名称去营销前缀，金额取合计 0.99', () => {
    const orders = parseOrderShot(JD_1.join('\n'));
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.name).toBe('酒精温巾'); // OCR 实读「温巾」（原图「湿巾」），fixture 保真
    expect(o.amount).toBe(0.99);
    expect(o.place).toBe('京东');
    // 这张截图的数量「x1」没被 OCR 识别出来（fixture 保真）——qty 缺失不阻塞记账
    expect(o.qty).toBeUndefined();
  });

  it('京东订单详情（园艺三件套）：多行商品名取信息量最大行，金额取合计 0.56', () => {
    const orders = parseOrderShot(JD_2.join('\n'));
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.name).toContain('园艺大三件套盆栽小铲');
    expect(o.name).not.toContain('到手');
    expect(o.name).not.toContain('数量');
    expect(o.amount).toBe(0.56);
    expect(o.place).toBe('京东');
    expect(o.qty).toBe('1件');
  });

  it('京东订单列表（无实付行）：店铺头行切两笔', () => {
    const orders = parseOrderShot(JD_3.join('\n'));
    expect(orders).toHaveLength(2);
    expect(orders[0]!.name).toContain('酒精湿巾');
    expect(orders[0]!.amount).toBe(0.99);
    expect(orders[1]!.name).toContain('园艺大三件套盆栽小铲子花园小');
    expect(orders[1]!.amount).toBe(0.56);
    // 「我的常购」推荐位不能混进来
    expect(orders.some((o) => o.name.includes('常购') || o.name.includes('好评率'))).toBe(false);
  });

  it('拼多多订单详情（老鼠夹）：名称取商品标题行，实付 3.59', () => {
    const orders = parseOrderShot(PDD_1.join('\n'));
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.name).toContain('强力老鼠夹');
    expect(o.amount).toBe(3.59);
    expect(o.place).toBe('拼多多');
    // 这张截图的数量「×1」没被 OCR 识别出来（fixture 保真）——qty 缺失不阻塞记账
    expect(o.qty).toBeUndefined();
  });

  it('拼多多订单详情（辣条）：实付 9.89 而不是商品行里的 9/89 裂价', () => {
    const orders = parseOrderShot(PDD_2.join('\n'));
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.name).toContain('开心农场辣条');
    expect(o.amount).toBe(9.89);
    expect(o.place).toBe('拼多多');
    expect(o.qty).toBe('1件');
  });

  it('淘宝订单详情（心相印）：实付 0.01，绝不用商品总价 2.01；实付价+实付款双锚点合并', () => {
    const orders = parseOrderShot(TB_1.join('\n'));
    expect(orders).toHaveLength(1); // 「实付价Y0.01 价格明细」与「实付款 共减2 Y0.01」是同一笔
    const o = orders[0]!;
    expect(o.name).toBe('心相印抽纸薰衣草面巾纸3层10');
    expect(o.amount).toBe(0.01);
    expect(o.place).toBe('淘宝');
    expect(o.qty).toBe('1件');
  });

  it('淘宝订单详情（金龙鱼）：实付 2.75，不是总价 14.17 也不是商品行 4.17', () => {
    const orders = parseOrderShot(TB_2.join('\n'));
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.name).toContain('金龙鱼');
    expect(o.name).not.toContain('尖');
    expect(o.amount).toBe(2.75);
    expect(o.place).toBe('淘宝');
    expect(o.qty).toBe('1件');
  });

  it('抖音商城订单详情（磁轴）：实付 0.01，不是划线价 3.88；规格行不当商品名', () => {
    const orders = parseOrderShot(DY_1.join('\n'));
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.name).toContain('宝轴鼓动版');
    expect(o.name).not.toContain('Wuque');
    expect(o.amount).toBe(0.01);
    expect(o.place).toBe('抖音商城');
    expect(o.qty).toBe('1件');
  });

  it('抖音商城订单列表：三笔逐条出，金额各取各的实付', () => {
    const orders = parseOrderShot(DY_2.join('\n'));
    expect(orders).toHaveLength(3);
    // 第一笔商品名被 OCR 识成「人宝轴吉动版」（原图「八宝轴鼓动版」）——fixture 保真
    expect(orders[0]!.name).toContain('宝轴');
    expect(orders[0]!.name).not.toContain('Wuque');
    expect(orders[0]!.amount).toBe(0.01);
    expect(orders[1]!.amount).toBe(0.01);
    expect(orders[2]!.name).toContain('狼蛛');
    expect(orders[2]!.amount).toBe(59.99); // 不是划线价 99.00
    expect(orders.every((o) => o.place === '抖音商城')).toBe(true);
  });
});

describe('parseOrderShot：合成句进 parseLocal（复用分类/自学习）', () => {
  it('消耗品走生活流：酒精湿巾/老鼠夹/辣条/抽纸', () => {
    for (const src of [JD_1, PDD_1, PDD_2, TB_1]) {
      for (const o of parseOrderShot(src.join('\n'))) {
        const item = parseOrder(o);
        expect(item.action).toBe('create_ledger');
        expect(item.ledgerDraft!.amount).toBe(o.amount);
      }
    }
  });

  it('耐用品走物品档：磁轴/键盘/园艺三件套', () => {
    for (const src of [DY_1, DY_2]) {
      for (const o of parseOrderShot(src.join('\n'))) {
        const item = parseOrder(o);
        expect(item.action).toBe('create_goods');
        expect(item.goodsDraft!.price).toBe(o.amount);
      }
    }
  });

  it('名称只留商品名（口头语清洗把「1件」和「花了」剥掉）', () => {
    const o = parseOrderShot(JD_1.join('\n'))[0]!;
    const item = parseOrder(o);
    expect(item.ledgerDraft!.name).toBe('酒精温巾');
    // 备注 = 平台 · 数量｜OCR 原文行（用户反馈 3：在哪买的/多少 → 备注）
    const note = orderNote(o);
    expect(note).toContain('京东');
    expect(note).toContain('酒精温巾');
    expect(note).toContain('｜');
  });
});

describe('cleanProductName：边界', () => {
  it('型号码不误伤：苹果15 / N95 / 三只松鼠 原样保留', () => {
    expect(cleanProductName('苹果15', 0.01)).toBe('苹果15');
    expect(cleanProductName('N95笔记本准系统', 4600)).toBe('N95笔记本准系统');
    expect(cleanProductName('三只松鼠零食大礼包', 59.9)).toBe('三只松鼠零食大礼包');
  });

  it('锚点金额按 OCR 裂价形态剥掉（9.89 / 9 89）', () => {
    expect(cleanProductName('开心农场辣条小包装80 9 89', 9.89)).toBe('开心农场辣条小包装80');
    expect(cleanProductName('开心农场辣条 9.89', 9.89)).toBe('开心农场辣条');
  });

  it('整行营销括号清空（半边括号也认）', () => {
    expect(cleanProductName('【专享2】酒精湿巾 一次性消毒大', 0.99)).toBe('酒精湿巾 一次性消毒大');
    expect(cleanProductName('_作宝轴鼓动版 [全新正品 WuqueStudio..， 5.88', 0.01)).toBe('作宝轴鼓动版');
  });
});

describe('platformOf / orderSentence', () => {
  it('平台识别', () => {
    expect(platformOf('京喜自营官方店 回头客')).toBe('京东');
    expect(platformOf('本色食代食品专营店')).toBeUndefined();
    expect(platformOf('来自抖音商城')).toBe('抖音商城');
    expect(platformOf('拼多多 先用后付')).toBe('拼多多');
  });

  it('合成句带数量与金额', () => {
    expect(
      orderSentence({ name: '酒精湿巾', amount: 0.99, qty: '1件' }),
    ).toBe('买了酒精湿巾 1件 花了0.99');
  });

  it('非订单文本（聊天截图/照片）→ 空，交给调用方回落整段解析', () => {
    expect(parseOrderShot('今天午饭花了25\n晚上打车花了30')).toEqual([]);
    expect(parseOrderShot('刚买了N95笔记本准系统 花了899')).toEqual([]);
    expect(parseOrderShot('')).toEqual([]);
  });
});
