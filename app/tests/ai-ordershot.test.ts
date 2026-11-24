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

// ★v1.3.1 新增 12 张真实样本（用户反馈：五类账单识别效果差）
const XY_1 = ocr['S61019-17310384_com.taobao.idlefish.png'] as string[]; // 闲鱼已购列表
const XY_2 = ocr['S61019-17310688_com.taobao.idlefish.png'] as string[]; // 闲鱼订单详情
const XY_3 = ocr['S61019-17310966_com.taobao.idlefish.png'] as string[]; // 闲鱼订单详情
const DY_D_1 = ocr['S61019-17304815_com.ss.android.ugc.aweme.png'] as string[]; // 抖音民宿详情
const DY_D_2 = ocr['S61019-17305343_com.ss.android.ugc.aweme.png'] as string[]; // 抖音到店详情
const DY_L_1 = ocr['S61019-17305584_com.ss.android.ugc.aweme.png'] as string[]; // 抖音到店列表
const DY_L_2 = ocr['S61019-17305924_com.ss.android.ugc.aweme.png'] as string[]; // 抖音到店列表
const TB_W_1 = ocr['S61019-17312261_com.taobao.taobao.png'] as string[]; // 淘宝外卖详情
const TB_W_2 = ocr['S61019-17312662_com.taobao.taobao.png'] as string[]; // 淘宝外卖列表
const JD_M_1 = ocr['S61019-17313851_com.jingdong.app.mall.png'] as string[]; // 京东秒送列表（券后 0 元）
const JD_M_2 = ocr['S61019-17314183_com.jingdong.app.mall.png'] as string[]; // 京东秒送详情
const PDD_M_1 = ocr['S61019-17315955_com.xunmeng.pinduoduo.png'] as string[]; // 拼多多多商品订单
const PDD_M_2 = ocr['S61019-17320243_com.xunmeng.pinduoduo.png'] as string[]; // 拼多多多商品订单

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

describe('parseOrderShot：v1.3.1 新增 12 张真实样本（五类账单）', () => {
  /* ---------- 闲鱼 ---------- */

  it('闲鱼订单详情：名称取商品标题行，金额取「成交价」不是商品行的划线价', () => {
    const o1 = parseOrderShot(XY_2.join('\n'));
    expect(o1).toHaveLength(1);
    expect(o1[0]!.name).toBe('杂牌笔记本 CPU瑞特尔');
    expect(o1[0]!.amount).toBe(190); // 成交价 190.00，不是商品行 xY200.00
    expect(o1[0]!.place).toBe('闲鱼');

    const o2 = parseOrderShot(XY_3.join('\n'));
    expect(o2).toHaveLength(1);
    expect(o2[0]!.name).toBe('英特尔N95 四核');
    expect(o2[0]!.amount).toBe(460);
    expect(o2[0]!.place).toBe('闲鱼');
  });

  it('闲鱼已购列表：卖家头行切三笔，行尾金额残片（x190.oo/“460oo）剥掉', () => {
    const orders = parseOrderShot(XY_1.join('\n'));
    expect(orders).toHaveLength(3);
    expect(orders[0]!.name).toBe('杂忆笔记本cpu英特尔ne5');
    expect(orders[0]!.amount).toBe(190);
    expect(orders[1]!.name).toBe('英特尔N95 四核');
    expect(orders[1]!.amount).toBe(460);
    expect(orders[2]!.amount).toBe(7);
    // 评价引导行「分享一下这次交易体验吧 好评 中评 差评」中文数最高，不能当商品名
    expect(orders[2]!.name).not.toContain('好评');
    expect(orders.every((o) => o.place === '闲鱼')).toBe(true);
  });

  /* ---------- 抖音到店消费（团购） ---------- */

  it('抖音民宿详情：名称取店铺行（初见民宿），实付 69', () => {
    const orders = parseOrderShot(DY_D_1.join('\n'));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.name).toBe('初见民宿');
    expect(orders[0]!.amount).toBe(69);
    expect(orders[0]!.place).toBe('抖音');
  });

  it('抖音到店详情：名称取店铺行，数量取商品行的 X1 而不是优惠券行的 x4', () => {
    const orders = parseOrderShot(DY_D_2.join('\n'));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.name).toBe('乐野男士理发馆');
    expect(orders[0]!.amount).toBe(12.8);
    expect(orders[0]!.qty).toBe('1件');
    expect(orders[0]!.place).toBe('抖音');
  });

  it('抖音到店列表：三笔逐条出，名称全部取店铺行（不是被 OCR 截断的商品行）', () => {
    const orders = parseOrderShot(DY_L_1.join('\n'));
    expect(orders).toHaveLength(3);
    expect(orders[0]!.name).toBe('乐野男士理发馆');
    expect(orders[0]!.amount).toBe(12.8);
    expect(orders[1]!.name).toBe('九州太空舱青年民宿');
    expect(orders[1]!.amount).toBe(24.5);
    expect(orders[2]!.name).toBe('鸭小将痪香鸭餐饮服务店');
    expect(orders[2]!.amount).toBe(11.9);
    expect(orders.every((o) => o.place === '抖音')).toBe(true);
  });

  it('抖音到店列表（合计被 OCR 打碎的第三笔不强求）：前两笔店铺名+金额正确', () => {
    const orders = parseOrderShot(DY_L_2.join('\n'));
    expect(orders).toHaveLength(2);
    expect(orders[0]!.name).toBe('乐野男士理发馆');
    expect(orders[0]!.amount).toBe(12.8);
    expect(orders[1]!.name).toBe('九州太空舱青年民宿');
    expect(orders[1]!.amount).toBe(24.5);
  });

  /* ---------- 淘宝外卖 ---------- */

  it('淘宝外卖详情：「己购」商品行赢过淘金币权益位碎行，实付 6.8', () => {
    const orders = parseOrderShot(TB_W_1.join('\n'));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.name).toBe('驳尚训阳牛杂面');
    expect(orders[0]!.amount).toBe(6.8);
    expect(orders[0]!.qty).toBe('1件');
    expect(orders[0]!.place).toBe('淘宝'); // 不被「门店」误判成抖音
  });

  it('淘宝外卖列表：三笔逐条出；「实付款J]1.5」被吃掉首位的金额校正为 11.5', () => {
    const orders = parseOrderShot(TB_W_2.join('\n'));
    expect(orders).toHaveLength(3);
    expect(orders.every((o) => o.place === '淘宝')).toBe(true);
    expect(orders[0]!.amount).toBe(6.8);
    expect(orders[1]!.amount).toBe(11.5); // 锚点行 1.5，名称行 Y11.5 以 1.5 结尾且更长
    expect(orders[1]!.name).toBe('两萤一素');
    expect(orders[2]!.amount).toBe(9.8); // 「实付款#9 .8」裂小数点合回
    expect(orders[2]!.name).toContain('窗鸡腿饭');
  });

  /* ---------- 京东秒送 ---------- */

  it('京东秒送列表：券后 0 元四笔全出，店铺头行不当商品名', () => {
    const orders = parseOrderShot(JD_M_1.join('\n'));
    expect(orders).toHaveLength(4);
    expect(orders.map((o) => o.name)).toEqual([
      '橙C美式冰大杯',
      '黄金本鸡儿中国汉堡1人份1人',
      '香后鸡腿中国汉堡1人从',
      '红油手据鸡十哈尔',
    ]);
    expect(orders.every((o) => o.amount === 0)).toBe(true); // 券后 0 元也要能记
    expect(orders.every((o) => o.place === '京东')).toBe(true);
  });

  it('京东秒送详情：「合计YO」= 合计¥0，「共1件」不抢金额，名称取库迪咖啡', () => {
    const orders = parseOrderShot(JD_M_2.join('\n'));
    expect(orders).toHaveLength(1);
    expect(orders[0]!.name).toBe('库迪咖啡');
    expect(orders[0]!.amount).toBe(0);
    expect(orders[0]!.qty).toBe('1件');
  });

  /* ---------- 拼多多多商品订单 ---------- */

  it('拼多多多商品订单：逐项实付逐笔出，订单级汇总行不单独成笔', () => {
    const orders = parseOrderShot(PDD_M_1.join('\n'));
    expect(orders).toHaveLength(2);
    expect(orders[0]!.name).toBe('本地现摘新鲜西红柿'); // 断字续行拼回
    expect(orders[0]!.amount).toBe(3.79);
    expect(orders[1]!.name).toBe('精选水洗胡萝卜');
    expect(orders[1]!.amount).toBe(4.74);
    expect(orders.every((o) => o.place === '拼多多')).toBe(true);
  });

  it('拼多多多商品订单（展开态 4 件）：四笔逐条出，名称断字全部拼回', () => {
    const orders = parseOrderShot(PDD_M_2.join('\n'));
    expect(orders).toHaveLength(4);
    expect(orders.map((o) => o.name)).toEqual([
      '本地现摘新鲜西红柿',
      '精选水洗胡萝卜',
      '基地直采新鲜现挖大土豆',
      '精选新鲜洋葱',
    ]);
    expect(orders.map((o) => o.amount)).toEqual([3.79, 4.74, 9.49, 6.64]);
    expect(orders.every((o) => o.qty === '1件')).toBe(true);
  });

  /* ---------- 合成句 / 边界 ---------- */

  it('0 元券后订单合成句进 parseLocal：金额 0 落库，名称不带「0元」残片', () => {
    for (const src of [JD_M_1, JD_M_2]) {
      for (const o of parseOrderShot(src.join('\n'))) {
        const item = parseOrder(o);
        const draft = item.ledgerDraft ?? item.goodsDraft;
        expect(draft).toBeTruthy();
        const paid = item.ledgerDraft ? item.ledgerDraft.amount : item.goodsDraft!.price;
        expect(paid).toBe(0);
        expect(draft!.name).not.toContain('0元');
        expect(draft!.name!.length).toBeGreaterThan(1);
      }
    }
    expect(parseOrder({ name: '库迪咖啡', amount: 0 }).ledgerDraft!.name).toBe('库迪咖啡');
  });

  it('非订单文本（聊天记录/口头账）不误报：没有平台词就没有订单', () => {
    expect(parseOrderShot('今天午饭花了25\n晚上打车花了30')).toEqual([]);
    expect(parseOrderShot('刚买了N95笔记本准系统 花了899')).toEqual([]);
  });
});

describe('cleanProductName：v1.3.1 边界', () => {
  it('宽松行尾金额残片按 OCR 噪声形态剥掉（x190.oo / “460oo / 兰3.39）', () => {
    expect(cleanProductName('英特尔N95 四核 “460oo', 460)).toBe('英特尔N95 四核');
    expect(cleanProductName('杂忆笔记本cpu英特尔ne5, 没有 x190.oo', 190)).toBe('杂忆笔记本cpu英特尔ne5');
    expect(cleanProductName('红柿(100g起) 放红后食用 兰3.39', 3.39)).toBe('红柿');
  });

  it('0 元行尾剥掉（京东秒送「标准不 0 00」「*0.00」），正常金额行不动', () => {
    expect(cleanProductName('全 沪 。 橙C美式冰大杯(450m 标准不 0 00', 0)).toBe('橙C美式冰大杯');
    expect(cleanProductName('后 香后鸡腿中国汉堡1人从 *0.00', 0)).toBe('香后鸡腿中国汉堡1人从');
    expect(cleanProductName('苹果15', 0)).toBe('苹果15');
  });

  it('首部短残片 token 剥掉（「损昼 库迪咖啡」「和ss 两萤一素」），两字真名不误伤', () => {
    expect(cleanProductName('损昼 库迪咖啡(二七东方大厦店) .', 0)).toBe('库迪咖啡');
    expect(cleanProductName('和ss。 【人气王超下饭】两萤一素-默认 Y11.5', 11.5)).toBe('两萤一素');
    expect(cleanProductName('三只松鼠零食大礼包', 59.9)).toBe('三只松鼠零食大礼包');
  });

  it('淘宝外卖「己购」前缀剥掉', () => {
    expect(cleanProductName('己购 驳尚训阳牛杂面(宿舍直达店) >', 6.8)).toBe('驳尚训阳牛杂面');
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
