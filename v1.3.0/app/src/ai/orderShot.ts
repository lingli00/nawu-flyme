/**
 * ★v1.2.2 订单截图结构化（用户反馈 2：「让他识图是一塌糊涂」→ 按 9 张电商样本教它认）。
 *
 * 输入：OCR 出的**多行**文本（京东/淘宝/拼多多/抖音商城的订单详情页或订单列表页，
 * 也兼容 POS 小票）。输出：逐笔订单 { 商品名, 实付金额, 平台, 数量, 原文行 }。
 *
 * 设计规则全部来自真实样本的 OCR 噪声（fixture 见 tests/ai-ordershot.test.ts）：
 *
 * 1. **锚点行定边界**：含「实付」的行 = 一笔订单的结算行，金额取行内**最后一个数字**
 *    （「实付款 共减Y4 合计站0.99」→ ¥0.99，前面的共减是优惠）；
 *    没有「实付」时退到「到手/合计/总计」，再退到店铺头行（订单列表页）。
 * 2. **重复锚点合并**：淘宝详情页同时有「实付价Y0.01 价格明细」和「实付款 共减2 Y0.01」，
 *    两个锚点之间没有商品名候选时合并为一笔（金额取更靠后的汇总行）。
 * 3. **商品名候选**：段内非框架行按中文数打分；含「店」的是店铺名、结尾 x1/共N件 的是
 *    规格行、带营销词/冒号长句的是卖点行——各自降权；最高分赢。
 * 4. **名称清洗**：去【】[]营销词 → 去锚点词 → 去行尾金额（带 ¥/羊/半/尖/W 前缀或小数点，
 *    防误伤「苹果15」这类型号码）→ 去首尾残片（序号/字母前缀）。
 * 5. **金额绝不用商品总价/原价**：「商品总价 共1件 ¥2.01」是框架行，实付 ¥0.01 才对；
 *    「到手¥3.88」是划线价，实付 ¥0.01 才对。
 *
 * 纯函数、无副作用；调用方把每笔合成为「买了X 1件 花了Y」交 parseLocal，
 * 即可复用全部分类/自学习/口头语逻辑（见 parseService.parseImageLocal）。
 */

/** 一笔识别出的订单。 */
export interface OrderHit {
  /** 商品名（已去营销前缀/规格后缀/金额残留） */
  name: string;
  /** 实付金额（优先实付款/实付价；列表页取商品行行尾价） */
  amount: number | null;
  /** 平台（京东/淘宝/拼多多/抖音商城…，用户反馈 3 的「在哪买的」） */
  place?: string;
  /** 数量（如「1件」） */
  qty?: string;
  /** 名称所在的 OCR 原文行（进备注，方便用户核对） */
  rawLine?: string;
}

/** UI 框架/物流/售后/推荐位噪声行。 */
const CHROME_RE = new RegExp(
  [
    '实付', '合计', '总计', '到手', '订单编?[号號码]', '支付方式', '交易快照', '更多信息',
    '服务保障', '查看物流', '申请售后', '追加评价', '再次拼单', '再次购买', '再买一单',
    '联系', '分享商品', '^复制$', '展开', '评价晒单', '送朋友', '加入购物车', '确认收货',
    '催物流', '无理由', '价保', '买贵双倍赔', '极速退款', '退款', '退货', '包邮', '运费险',
    '自动理赔', '进店', '回头客', '好评率', '客服平均', '已买', '回购', '常购', '收藏',
    '我的', '先用后付', '拼单', '拼小圈', '待收货', '待支付', '待使用', '待评价', '已完成',
    '交易成功', '交易完成', '已签收', '已发货', '取件码', '预计', '运输中', '自动确认',
    '还剩', '两地距', '您的订单', '快递员', '送货上门', '上门', '代收', '详细位置',
    '安心保障', '全部订单', '下单后', '跨平台', '本单', '红包', '券', '失效', '去使用',
    '去查看', '去申请', '搭配推荐', '组合购买', '商品小贴', '攻略', '价格明细',
    '订单信息', '订单保障', '凭据', '昨日下单', '服务生效中', '判定假货', '查看规',
    '匿名', '愿意继续', '电商购', '完全不愿意', '比较不愿意', '非常愿意', '删除订单',
    '搜索', '^全部', '种送', '历匣', '^完成$', '^省$', '^今$', '人中', '^GO$', '^AP$',
    '更多', '退换', '售后', '推荐', '直播间', '广告', '^价$', '^中$', '^多$', '^人$',
    '^上$', '^过下$', '^已$', '^。', '^\\.', '^共', '服务$', '商品总价', '总价', '原价',
    '划线价', '优惠', '已抵', '^\\d{1,2}:\\d{2}', '^\\d+$', '^[A-Za-z]+$', '\\*{2,}',
  ].join('|'),
);

/**
 * 营销括号剥离（判噪声与清名称共用）。
 *
 * - `【…】`：内容不含空格（「【专享2】」「【毛湘德】开心农场…」——OCR 常把 】 识成 )），
 *   剥到首个空格为止，防止贪婪吃到商品名；
 * - `[…]`：内容到 `]` 或 30 字符止（「[全新正品」 WuqueStud.… 3.88」没有半括号，
 *   必须吃到行尾才不残留英文乱码）；
 * - `（…）`/`(…)`：同【，短内容。
 */
function stripBrackets(s: string): string {
  return s
    .replace(/【[^【】\n ]{0,12}[】)]?\s*/g, ' ')
    .replace(/\[[^[\]\n]{0,30}\]?/g, ' ')
    .replace(/（[^（）\n ]{0,12}[）)]?\s*/g, ' ')
    .replace(/\([^()\n ]{0,16}[\)]?\s*/g, ' ');
}

/** 地址/手机号行（「固县镇黄皮村」「李132****x5054」）。 */
const ADDRESS_RE = /[\u4e00-\u9fa5]{2,4}(省|市|区|县|镇|村|路|街道|号)/;
const PHONE_RE = /\*{2,}|1[3-9]\d{9}/;

/** 锚点词（商品行里常带「到手价」，判噪声前先剥掉）。 */
const ANCHOR_WORD_RE = /(实付[价款]?|到手[价]?|合计|总计)/g;

/** 行尾金额：带 ¥/羊/半/尖/W/O 前缀或小数点才剥（防误伤「苹果15」「N95」型号码）。 */
const TAIL_AMOUNT_RE =
  /(?:[¥￥Yy羊半尖站闻OoWw…]\s*|\.\s*)\d+(?:\.\d+)?[\s~～]*$|[¥￥Yy羊半尖站闻OoWw…]\s*\.\d+[\s~～]*$/;

/** 营销卖点行（满减好物/热销特惠/冒号长文案）。 */
const MARKETING_RE = /满[减意]|好物|热销|特惠|秒杀|抢购|爆款|已售|销量|直降|补贴|官方正品|全新升级/;

/** 规格/数量行结尾（x1 / X1 / ×1 / 共N件）。 */
const QTY_TAIL_RE = /(?:^|[^A-Za-z0-9])[xX×]\s*\d{1,3}\s*$|共\s*\d{1,3}\s*件|数量/;

/** 名称候选里的「数量+单位」（「开心农场30袋」是规格不是商品名）。 */
const QTY_UNIT_IN_NAME_RE = /(?:^|[^0-9])\d{1,3}\s*(袋|包|盒|瓶|件|个|只|条|支|箱|斤|抽|枚|颗|粒|片|套|提|卷|罐|桶|把|张|本|副|打|排|贴|丸|剂)/;

/** 店铺头行（列表页的一笔订单从这里开始）。 */
const SHOP_HEADER_RE = /[\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:官方店|旗舰店|专营店|自营店|店|商行|小铺)/;
const SHOP_HEADER_STATE_RE = /完成|进店|交易成功|交易完成|已买/;

/** 平台识别（用户反馈 3 的购买地点；OCR 常丢平台名，用各平台独有的 UI 词兜底）。 */
export function platformOf(text: string): string | undefined {
  if (/京喜|京东/.test(text)) return '京东';
  if (/淘宝|天猫|淘金币|催物流|确认收货|旺旺/.test(text)) return '淘宝';
  if (/拼多多|拼小圈|拼单|先用后付/.test(text)) return '拼多多';
  if (/抖音|拌音|douyin/i.test(text)) return '抖音商城';
  if (/快手/.test(text)) return '快手';
  if (/美团|饿了么/.test(text)) return '美团';
  return undefined;
}

function cjkCount(s: string): number {
  return (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
}

/** 行内最后一个「像金额」的数字（跳过订单号那种超长数字）。 */
function lastAmountOnLine(line: string): number | null {
  const tokens = line.match(/\d+(?:\.\d+)?/g);
  if (!tokens) return null;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const tk = tokens[i] as string;
    if (/^\d{7,}$/.test(tk)) continue; // 订单编号
    const v = Number.parseFloat(tk);
    if (Number.isFinite(v) && v > 0 && v < 1e8) return v;
  }
  return null;
}

/** 行尾金额（列表页商品行自带价格时用）。 */
function trailingAmount(line: string): number | null {
  const m = TAIL_AMOUNT_RE.exec(line);
  if (!m) return null;
  const digits = m[0].match(/\d+(?:\.\d+)?/g);
  if (!digits) return null;
  const v = Number.parseFloat(digits[digits.length - 1] as string);
  return Number.isFinite(v) && v > 0 && v < 1e8 ? v : null;
}

/** 段内数量（x1 / 共N件 → 「1件」）。 */
function qtyOfSegment(lines: string[], from: number, to: number): string | undefined {
  for (let i = Math.max(0, from); i <= to && i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    const m =
      /(?:^|[^A-Za-z0-9])[xX×]\s*(\d{1,3})(?![\d.])/.exec(l) ?? /共\s*(\d{1,3})\s*件/.exec(l);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 999) return `${n}件`;
    }
  }
  return undefined;
}

/** 在 [from, to] 行区间里挑商品名候选（最高分赢，平分先者赢）。 */
function pickNameLine(lines: string[], from: number, to: number): string | null {
  let best: { line: string; score: number } | null = null;
  for (let i = Math.max(0, from); i <= to && i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (!raw) continue;
    // 先剥营销括号再判噪声（「【顺丰包邮】狼蛛磁轴键…」不能因包邮被当框架行）；
    // 打分也用剥离行——否则「[EE国 本单已返4元券…」整行被括号规则剥空后，
    // 靠原始行字数反而拿最高分，把真商品名挤掉
    const stripped = stripBrackets(raw.replace(ANCHOR_WORD_RE, ' '));
    if (CHROME_RE.test(stripped)) continue;
    if (/店/.test(stripped)) continue; // 店铺名行不是商品名
    if (ADDRESS_RE.test(stripped) && (/\d/.test(stripped) || /(省|市|区|县|镇|村|路|号)\s*$/.test(stripped)))
      continue;
    if (PHONE_RE.test(stripped)) continue;
    const cjk = cjkCount(stripped);
    if (cjk < 4) continue; // 剥完只剩空壳/乱码 → 不是商品名
    let score = cjk * 2;
    // 带【】[]营销前缀的行恰恰是商品行（「【专享2】酒精湿巾…」），剥完字数变少，补回权重
    if (/[【[]/.test(raw)) score += 8;
    if (QTY_TAIL_RE.test(stripped)) score -= 30; // 规格/数量行
    if (QTY_UNIT_IN_NAME_RE.test(stripped)) score -= 30; // 「30袋」这类规格片段
    if (MARKETING_RE.test(stripped)) score -= 15; // 营销卖点行
    if (/[：:]/.test(stripped) && cjk > 12) score -= 20; // 冒号长文案
    if (score <= 0) continue;
    if (!best || score > best.score) best = { line: raw, score };
  }
  return best?.line ?? null;
}

/** 金额 → 行尾剥离正则（9.89 同时匹配「9.89」与「9 89」两种 OCR 形态）。 */
function amountTailRe(amount: number): RegExp | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const s = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const dot = s.indexOf('.');
  const digits = dot > 0 ? `${s.slice(0, dot)}[\\s.]{0,2}${s.slice(dot + 1)}` : s;
  // 整数金额必须带货币符号前缀，防误伤「苹果15」型号码
  const prefix = dot > 0 ? '' : '[¥￥Yy羊半尖站闻OoWw…]\\s*';
  return new RegExp(`${prefix}${digits}[\\s~～]*$`);
}

/**
 * 商品名清洗：营销括号 → 锚点词 → 锚点金额 → 行尾金额 → 首尾残片 → 数字词残片。
 *
 * 「ET 【专享2】酒精温巾 一..， ”四到手#0.99」→「酒精温巾」
 * 「之 二 金龙鱼黄金比例食用植物调和 尖4.17」→「金龙鱼黄金比例食用植物调和」
 * 「心相印抽纸薰衣草面巾纸3层10...， \\ Y2.01」→「心相印抽纸薰衣草面巾纸3层10」
 */
export function cleanProductName(line: string, amount?: number | null): string {
  let s = ` ${line} `;
  // 营销括号（OCR 常丢半边括号，故不强制闭合）
  s = stripBrackets(s);
  // 锚点词与锚点金额
  s = s.replace(ANCHOR_WORD_RE, ' ');
  const tail = amount ? amountTailRe(amount) : null;
  if (tail) s = s.replace(tail, ' ');
  // 行尾残留金额（半0.99 / Y2.01 / W.56 / … 99.00）
  s = s.replace(TAIL_AMOUNT_RE, ' ');
  // 首部标点 + 压空白
  s = s.replace(/^[\s\d_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+]+/, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 独立数字词残片（第一遍：「之 二 金龙鱼…」先删「二」，单字前缀才剥得掉「之」）
  s = dropNumberWordTokens(s);
  // 首部残片循环：字母残片（ET/ED/rr）→ 单字残片（玖/之），各剥到稳定
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(/^[A-Za-z]{1,4}\s+(?=[\u4e00-\u9fa5])/, ' ').trim();
    s = s.replace(/^[\u4e00-\u9fa5]\s+(?=[\u4e00-\u9fa5]{4,})/, ' ').trim();
    if (s === before) break;
  }
  // 尾部残片（循环到稳定）：标点 → 带点英文（WuqueStud.）→ Q@D 式乱码 → 孤立货币前缀（半/W）
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(/[\s_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+@#]+$/, ' ').trim();
    s = s.replace(/[A-Za-z]{1,12}\.[A-Za-z.]*$/, ' ').trim();
    s = s.replace(/[A-Za-z@#]+[@#][A-Za-z@#]*$/, ' ').trim();
    s = s.replace(/[¥￥Yy羊半尖站闻OoWw…]+$/, ' ').trim();
    if (s === before) break;
  }
  // 独立数字词残片（第二遍：「酒精温巾 一 四」剥掉尾部标点后才暴露）
  s = dropNumberWordTokens(s);
  return s.slice(0, 24);
}

/**
 * 独立数字词残片（「酒精温巾 一..， ”四」→「酒精温巾」；「三只松鼠」整块不受影响）。
 *
 * 注意：@ # 不参与切分——「Q@D」是整块乱码，拆散后尾部的 @# 规则就认不出它了；
 * # 由尾部残片循环先剥掉，第二遍过滤自然能碰到引号粘连的「”四」。
 */
const PUNCT_SPLIT_RE = /[。，,、；;！!？?：:~～…_.'"“”‘’()（）[\]【】|/\\+]+/;
function dropNumberWordTokens(s: string): string {
  return s
    .split(/\s+/)
    .flatMap((t) => (PUNCT_SPLIT_RE.test(t) ? t.split(PUNCT_SPLIT_RE).filter(Boolean) : [t]))
    .filter((t) => !/^[“”"'‘’]*[一二三四五六七八九十百千万零两半][“”"'‘’]*$/.test(t))
    .join(' ')
    .trim();
}

interface Anchor {
  idx: number;
  amount: number;
}

/** 找锚点行（实付优先，没有才退到手/合计/总计）。 */
function findAnchors(lines: string[], re: RegExp): Anchor[] {
  const out: Anchor[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!re.test(lines[i] ?? '')) continue;
    const amount = lastAmountOnLine(lines[i] ?? '');
    if (amount != null) out.push({ idx: i, amount });
  }
  return out;
}

/** 把锚点切成分段，并合并「实付价+实付款」这类重复锚点（中间没有商品名候选时）。 */
function segmentsFromAnchors(lines: string[], anchors: Anchor[]): Array<{ from: number; to: number; amount: number }> {
  const segs: Array<{ from: number; to: number; amount: number }> = [];
  for (const a of anchors) {
    const from = segs.length ? segs[segs.length - 1]!.to + 1 : 0;
    // 与上一笔间隔 ≤8 行且中间找不到商品名 → 同一笔的重复锚点（实付价 明细 + 实付款 汇总）
    const dup = segs.length > 0 && a.idx - segs[segs.length - 1]!.to <= 8 && !pickNameLine(lines, from, a.idx);
    if (dup) {
      segs[segs.length - 1]!.to = a.idx;
      segs[segs.length - 1]!.amount = a.amount;
    } else {
      segs.push({ from, to: a.idx, amount: a.amount });
    }
  }
  return segs;
}

/** 店铺头行切分段（订单列表页，没有任何实付/合计行时用）。 */
function segmentsFromShopHeaders(lines: string[]): Array<{ from: number; to: number; amount: number | null }> {
  const segs: Array<{ from: number; to: number; amount: number | null }> = [];
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (!SHOP_HEADER_RE.test(l) || !SHOP_HEADER_STATE_RE.test(l)) continue;
    if (segs.length || i > 0) {
      segs.push({ from: start, to: i - 1, amount: null });
    }
    start = i;
  }
  segs.push({ from: start, to: lines.length - 1, amount: null });
  return segs;
}

/**
 * 订单截图结构化入口。
 *
 * @param text OCR 多行文本（保留换行——localOcr.ocrLines）
 * @returns 逐笔订单（拿不到金额的丢给调用方回落整段解析）
 */
export function parseOrderShot(text: string): OrderHit[] {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const place = platformOf(text);

  // ① 实付锚点（订单详情页/结算行）
  let segs = segmentsFromAnchors(
    lines,
    findAnchors(lines, /实付/),
  ) as Array<{ from: number; to: number; amount: number | null }>;

  // ② 没有实付 → 到手/合计/总计（小票、部分列表页）
  if (segs.length === 0) {
    segs = segmentsFromAnchors(lines, findAnchors(lines, /到手|合计|总计/));
  }

  // ③ 还没有 → 店铺头行（订单列表页）
  if (segs.length === 0) {
    segs = segmentsFromShopHeaders(lines);
  }

  const out: OrderHit[] = [];
  for (const seg of segs) {
    const line = pickNameLine(lines, seg.from, seg.to);
    if (!line) continue;
    const amount = seg.amount ?? trailingAmount(line);
    if (amount == null) continue;
    const name = cleanProductName(line, amount);
    if (name.length < 2) continue;
    const qty = qtyOfSegment(lines, seg.from, seg.to);
    out.push({ name, amount, place, qty, rawLine: line.slice(0, 60) });
  }
  return out;
}

/**
 * 一笔订单 → 口语句（交 parseLocal 复用全部分类/自学习逻辑）。
 *
 * 「买了酒精湿巾 1件 花了0.99」——口头语模块会把「1件」抽进备注、名称只留商品名。
 */
export function orderSentence(o: OrderHit): string {
  const qty = o.qty ? ` ${o.qty}` : '';
  return o.amount && o.amount > 0 ? `买了${o.name}${qty} 花了${o.amount}` : `买了${o.name}${qty}`;
}

/**
 * 一笔订单的备注：平台 · 数量｜OCR 原文行。
 *
 * 用户反馈 3 的「在哪买的、多少数量」以备注形式保留；原文行让用户能核对 OCR 认对了没。
 */
export function orderNote(o: OrderHit): string {
  const prefix = [o.place, o.qty].filter(Boolean).join(' · ');
  const raw = (o.rawLine ?? '').trim();
  return prefix ? `${prefix}｜${raw}` : raw;
}
