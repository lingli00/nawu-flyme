/**
 * ★v1.2.2 订单截图结构化（用户反馈 2：「让他识图是一塌糊涂」→ 按 9 张电商样本教它认）。
 * ★v1.3.1 新增 12 张真实样本训练（用户反馈：五类账单识别效果差）：
 *
 *  1. **闲鱼**：商品购买账单（详情页「成交价」锚点）+ 已购买商品列表
 *     （卖家头行切段 + 商品行尾价，卖家名不是店铺名，单独一套头行规则）；
 *  2. **抖音到店消费**（团购）：详情/列表——名称**优先取店铺行**（「乐野男士理发馆」
 *     而不是被 OCR 截断的商品行「专业男士洗..」），锚点 实付/合计/应付款；
 *  3. **淘宝外卖**：订单详情（实付 y6.8）+ 列表（实付款锚点 + 店铺头行切段）；
 *  4. **京东秒送/外卖**：订单详情（「合计YO」= 合计¥0，O 当 0 认）+ 列表
 *     （店铺头行切段 + 券后 0 元——0 元订单也要能记，备注体现「用券」）；
 *  5. **拼多多多商品订单**：逐项「实付:」锚点逐笔出；订单级「实付: 24.66」行
 *     （后接 商品总额/平台优惠/订单编号）识别为**汇总行**，不单独成笔。
 *
 * 设计规则全部来自真实样本的 OCR 噪声（fixture 见 tests/ai-ordershot.test.ts）：
 *
 * 1. **锚点行定边界**：含「实付」的行 = 一笔订单的结算行，金额取行内**最后一个数字**
 *    （「实付款 共减Y4 合计站0.99」→ ¥0.99，前面的共减是优惠）；
 *    没有「实付」时退到「到手/合计/总计」，再退到店铺头行（订单列表页）。
 *    v1.3.1 补「成交价」（闲鱼）与「应付款」（抖音团购列表）。
 * 2. **重复锚点合并**：淘宝详情页同时有「实付价Y0.01 价格明细」和「实付款 共减2 Y0.01」，
 *    两个锚点之间没有商品名候选时合并为一笔（金额取更靠后的汇总行）。
 * 3. **汇总行跳过**（v1.3.1）：拼多多多商品订单里，订单级「实付」行后 4 行内出现
 *    商品总额/平台优惠/订单编号 → 这是整单汇总，不是独立一笔（前面已有逐项锚点时跳过）。
 * 4. **商品名候选**：段内非框架行按中文数打分；含「店」的是店铺名、结尾 x1/共N件 的是
 *    规格行、带营销词/冒号长句的是卖点行——各自降权；最高分赢。
 *    v1.3.1：①「店」只在**带头行状态词**（完成/交易成功/等待买家收货…）时才排除，
 *    外卖详情「豫襄阳阳牛杂面(宿舍直达店)」这类商品行要能当名字；
 *    ②≥3 个单字中文 token 的行（淘金币权益位「金龙自. 国f 星人 人 秆 和…」）降权；
 *    ③地址行放宽：含 省/市/县/镇/村/路 且中文数 ≥8 即弃（闲鱼「河南省南阳市桐柏县固县镇新王庄」）。
 * 5. **名称清洗**：去【】[]营销词 → 去锚点词 → 去行尾金额（带 ¥/羊/半/尖/W 前缀或小数点，
 *    防误伤「苹果15」这类型号码）→ 去首尾残片（序号/字母前缀）。
 *    v1.3.1 补：规格前缀（「2斤±0.2斤/盒」「10斤/份」）、行尾「-默认」、
 *    用法尾注（「放红后食用」）、店铺名专用清洗（状态词/「等N店通用」/括号分店名）。
 * 6. **金额绝不用商品总价/原价**：「商品总价 共1件 ¥2.01」是框架行，实付 ¥0.01 才对；
 *    「到手¥3.88」是划线价，实付 ¥0.01 才对。
 * 7. **OCR 金额噪声**（v1.3.1 全部来自真实样本）：
 *    · 货币前缀被识成 x / X / “ / ” / * / 兰 / 闭 / 站（「x190.oo」「“460oo」「*3.79」）；
 *    · 「oo」是「00」的误识（460oo = 460.00）、「O」是「0」（合计YO = 合计¥0）；
 *    · 小数点被空格拆开（「实付款#9 .8」= 9.8）——抽取前先把数字间的空格点号合回去。
 *
 * 纯函数、无副作用；调用方把每笔合成为「买了X 1件 花了Y」交 parseLocal，
 * 即可复用全部分类/自学习/口头语逻辑（见 parseService.parseImageLocal）。
 */

/** 一笔识别出的订单。 */
export interface OrderHit {
  /** 商品名（已去营销前缀/规格后缀/金额残留） */
  name: string;
  /** 实付金额（优先实付款/实付价；列表页取商品行行尾价；券后 0 元为 0） */
  amount: number | null;
  /** 平台（京东/淘宝/拼多多/抖音/抖音商城/闲鱼…，用户反馈 3 的「在哪买的」） */
  place?: string;
  /** 数量（如「1件」） */
  qty?: string;
  /** 名称所在的 OCR 原文行（进备注，方便用户核对） */
  rawLine?: string;
  /** v1.3.1：到店消费的店铺名（名称用店铺行时，原文行进备注） */
  shop?: string;
}

/* ---------------- 平台档案（v1.3.1） ---------------- */

interface PlatformProfile {
  place: string;
  /** 文本特征（命中即该平台；顺序即优先级，特征更具体的放前面） */
  detect: RegExp;
  /** 到店消费类：名称优先取店铺行（商品行常被 OCR 截断成「专业男士洗..」） */
  shopFirst?: boolean;
  /** 卖家头行即分段边界（闲鱼已购列表：卖家名不是店铺名，没有「店」字） */
  sellerHeaderRe?: RegExp;
}

const PROFILES: PlatformProfile[] = [
  {
    // 闲鱼：二手商品订单（详情页「成交价」/ 列表「等待买家收货」）
    place: '闲鱼',
    detect: /闲鱼|待买家收货|等待买家收货|送小红花|联系卖家|待确认收货|卖家已发货/,
    sellerHeaderRe: /等待买家收货|待买家收货|交易成功|交易关闭/,
  },
  {
    // 抖音到店消费（团购）：到店使用/团购/消费时间/等N店通用/入住离店 —— 与抖音商城（电商）分流
    // （★v1.3.1：「门店」太宽——淘宝外卖列表的「门店 接受预订」会被误判成抖音，删）
    place: '抖音',
    detect: /团购|到店使用|消费时间|等\d+店通用|入住|离店/,
    shopFirst: true,
  },
  {
    place: '抖音商城',
    detect: /抖音|拌音|douyin/i,
  },
  {
    // 淘宝（含闪购外卖）：淘金币/飞猪/闪购/菜鸟 是淘宝系独有 UI 词
    place: '淘宝',
    detect: /淘宝|天猫|淘金币|催物流|确认收货|旺旺|闪购|飞猪|菜鸟/,
  },
  {
    place: '京东',
    detect: /京喜|京东|秒送|PLUS会员/,
  },
  {
    place: '拼多多',
    detect: /拼多多|拼小圈|拼单|先用后付|免运费|共优惠/,
  },
  { place: '快手', detect: /快手/ },
  { place: '美团', detect: /美团|饿了么/ },
];

/** UI 框架/物流/售后/推荐位/权益位噪声行（v1.3.1 按 12 张新样本补词）。 */
const CHROME_RE = new RegExp(
  [
    '实付', '合计', '总计', '到手', '订单编?[号號码]', '支付方式', '交易快照', '更多信息',
    '服务保障', '查看物流', '申请售后', '追加评价', '再次拼单', '再次购买', '再买一单',
    '联系', '分享商品', '复制', '展开', '评价晒单', '送朋友', '加入购物车', '确认收货',
    '催物流', '无理由', '价保', '买贵双倍赔', '极速退款', '退款', '退货', '包邮', '运费险',
    '自动理赔', '进店', '回头客', '好评率', '客服平均', '已买', '回购', '常购', '收藏',
    '我的', '先用后付', '拼单', '拼小圈', '待收货', '待支付', '待使用', '待评价', '已完成',
    '交易成功', '交易完成', '已签收', '已发货', '取件码', '预计', '运输中', '自动确认',
    '运输中', '快件到达', '车辆正在', '车辆临近', '请您放心', '两地距', '您的订单',
    '快递员', '送货上门', '上门', '代收', '详细位置',
    '安心保障', '全部订单', '下单后', '跨平台', '本单', '红包', '券', '失效', '去使用',
    '去查看', '去申请', '去领取', '搭配推荐', '组合购买', '商品小贴', '攻略', '价格明细',
    '订单信息', '订单保障', '凭据', '昨日下单', '服务生效中', '判定假货', '查看规',
    '匿名', '愿意继续', '电商购', '完全不愿意', '比较不愿意', '非常愿意', '删除订单',
    '搜索', '^全部', '种送', '历匣', '^完成$', '^省$', '^今$', '人中', '^GO$', '^AP$',
    '更多', '退换', '售后', '推荐', '直播间', '广告', '^价$', '^中$', '^多$', '^人$',
    '^上$', '^过下$', '^已$', '^。', '^\\.', '^共', '服务$', '商品总价', '总价', '原价',
    '划线价', '优惠', '已抵', '^\\d{1,2}:\\d{2}', '^\\d+$', '^[A-Za-z]+$', '\\*{2,}',
    // —— v1.3.1 新增（闲鱼 / 抖音到店 / 淘宝外卖 / 京东秒送 / 拼多多）——
    '顺丰', '速运', '收货前拍摄', '开箱视频', '蚂蚁森林', '免费领', '分钱兑', '为你推荐',
    '立即领取', '分钟送达', 'PLUS', '节约用餐', '不浪费', '维权', '纠纷', '预制', '含包装',
    '配送费', '配送地址', '配送骑手', '发票信息', '费用明细', '快速解决', '怎么', '你可能还喜欢',
    '常见问题', '待确认收货', '待买家收货', '交易关闭', '全部门店', '适用门店', '感谢入住',
    '感谢购买', '期待', '入住信息', '房型详情', '入离日期', '离店时间', '订单详情', '平台心意',
    '含运费险', '付尾款', '买单', '尾款', '赠品', '权益', '赠送', '至高', '手慢无', '金币', '福利',
    '可抵', '淘金币', '客服', '开发票', '发票', '开票信息', '号码保护', '隐私', '送达', '保障',
    '评价', '到店使用', '免预约', '全周可用', '消费时间', '再次预订', '再来一单', '去评价',
    '查看发票', '删除订单', '其他订单', '等待买家收货', '体验如何', '评价一下', '确认夏贰',
    // ★v1.3.1 评价引导行（闲鱼「分享一下这次交易体验吧 好评 中评 差评」——
    // 中文数最高会抢商品名，但整行带「好评/中评/差评/体验吧」时必是评价 UI 不是商品）
    '好评', '中评', '差评', '体验吧', '交易体验',
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
const ANCHOR_WORD_RE = /(实付[价款]?|到手[价]?|成交价|应付款|合计|总计)/g;
/** 锚点词（非全局副本——`.test()` 用；带 g 标志的正则 lastIndex 会在调用间残留，导致时灵时不灵）。 */
const ANCHOR_WORD_TEST_RE = /(?:实付[价款]?|到手[价]?|成交价|应付款|合计|总计)/;

/** 行尾金额：带货币前缀（OCR 常误识成 x / 引号 / 星号 / 兰 / 闭 / 站 / 六）或小数点才剥（防误伤「苹果15」型号码）。 */
const TAIL_AMOUNT_RE =
  /(?:[¥￥Yy羊半尖站闻六兰闭OoWw…xX“”"'‘’*]\s*|\.\s*)\d+(?:\.\d+)?[\s~～]*$|[¥￥Yy羊半尖站闻六兰闭OoWw…xX“”"'‘’*]\s*\.\d+[\s~～]*$/;

/**
 * ★v1.3.1 宽松行尾金额残片（清名称用；比 TAIL_AMOUNT_RE 更宽，对抗真实 OCR 噪声）：
 * 「x190.oo」「“460oo」「兰3.39」「*3.79」「站24.66」「xy24.50」「六2.80」。
 * 仍要求**货币前缀 / 小数点 / oo 尾**三者之一——裸数字（「苹果15」）不剥。
 */
const LOOSE_TAIL_RE =
  /[¥￥Yy羊半尖站闻六兰闭OoWw…xX“”"'‘’*]\s*\d{1,3}(?:,\d{3})*(?:\.(?:\d{1,2}|[oO]{2}))?(?:[oO]{2})?[\s~～]*$|\d{1,3}(?:,\d{3})*\.\d{1,2}[\s~～]*$|\d{1,3}(?:,\d{3})*[oO]{2}[\s~～]*$/;

/** ★v1.3.1 0 元行尾（京东秒送「标准不 0 00」「*0.00」「Y0.00」——amount=0 时才剥）。 */
const ZERO_TAIL_RE =
  /(?:[¥￥Yy羊半尖站闻六兰闭OoWw…xX“”"'‘’*]\s*)?0\s*[.,]?\s*0{1,2}\s*(?:元)?\s*[~～]?\s*$/;

/** 营销卖点行（满减好物/热销特惠/冒号长文案）。 */
const MARKETING_RE = /满[减意]|好物|热销|特惠|秒杀|抢购|爆款|已售|销量|直降|补贴|官方正品|全新升级/;

/** 规格/数量行结尾（x1 / X1 / ×1 / 共N件——「共1伯」是「共1件」的误识）。 */
const QTY_TAIL_RE = /(?:^|[^A-Za-z0-9])[xX×]\s*\d{1,3}\s*$|共\s*\d{1,3}\s*[件伯个份名只条支张本袋盒瓶包]|数量/;

/** 名称候选里的「数量+单位」（「开心农场30袋」是规格不是商品名）。 */
const QTY_UNIT_IN_NAME_RE = /(?:^|[^0-9])\d{1,3}\s*(袋|包|盒|瓶|件|个|只|条|支|箱|斤|抽|枚|颗|粒|片|套|提|卷|罐|桶|把|张|本|副|打|排|贴|丸|剂)/;

/** 段内数量（x1 / 共N件 → 「1件」；v1.3.1 兼容「共1伯」误识）。 */
const QTY_IN_SEGMENT_RE = /(?:^|[^A-Za-z0-9])[xX×]\s*(\d{1,3})(?![\d.])|共\s*(\d{1,3})\s*[件伯个份名只条支张本袋盒瓶包]/;

/** 店铺头行（列表页的一笔订单从这里开始）。 */
const SHOP_HEADER_RE = /[\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:官方店|旗舰店|专营店|自营店|店|商行|小铺)/;
const SHOP_HEADER_STATE_RE = /完成|进店|交易成功|交易完成|已买|等待买家收货|待买家收货|交易关闭/;

/**
 * ★v1.3.1 无状态词的店铺头行（京东详情「医王司回京喜自营官方店」——v1.3.0 用
 * 「含店即排除」，但外卖详情的商品名「牛杂面(宿舍直达店)」也被误杀）。
 * 判据：店名在**正文**（剥括号后）且行尾只剩杂物（> 》。，、空白/进店/完成…）。
 * 括号里的店（「(宿舍直达店)」）是商品名一部分，剥完括号后这条规则自然不触发。
 */
const SHOP_HEADER_TAIL_RE =
  /[\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:官方店|旗舰店|专营店|自营店|店|商行|小铺)\s*(?:[>》》。，.,、\s]|进店|完成|交易成功|交易完成|已买|等待买家收货|待买家收货|交易关闭)*$/;

/** 行尾状态词（店铺行判定前先剥；与 cleanShopName 保持一致）。 */
const SHOP_STATE_TAIL_RE = /(?:等待买家收货|待买家收货|交易成功|交易完成|交易关闭|已完成|完成)\s*$/;

/** 店铺行（到店消费名称优先；v1.3.1 补民宿/餐饮/理发等到店业态）。 */
const SHOP_LINE_RE =
  /[\u4e00-\u9fa5A-Za-z0-9]{2,15}?(?:官方店|旗舰店|专营店|自营店|店|商行|小铺|民宿|客栈|酒楼|酒店|宾馆|餐饮服务|理发馆|健身馆|火锅|烧烤|拉面|粥铺|粉店|面馆)/;

/** 汇总行跟随特征（拼多多订单级「实付: 24.66」后接这些 → 整单汇总，不单独成笔）。 */
const ORDER_TOTAL_FOLLOW_RE = /商品总额|平台优惠|订单编?[号號]|下单时间/;

/** 平台识别（用户反馈 3 的购买地点；OCR 常丢平台名，用各平台独有的 UI 词兜底）。 */
export function platformOf(text: string): string | undefined {
  for (const p of PROFILES) {
    if (p.detect.test(text)) return p.place;
  }
  return undefined;
}

/** 当前文本命中的平台档案（含锚点词/店铺优先等策略）。 */
function profileOf(text: string): PlatformProfile | undefined {
  return PROFILES.find((p) => p.detect.test(text));
}

function cjkCount(s: string): number {
  return (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
}

/**
 * 把被空格拆开的小数点合回去（「实付款#9 .8」→「9.8」；
 * 「9 89」这种裂价形态也一并发觉：中间是空格而非小数点时保持原样，
 * 由 lastAmountOnLine 的 token 扫描处理）。
 */
function joinSplitDecimal(line: string): string {
  return line.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
}

/** 行内最后一个「像金额」的数字（跳过订单号那种超长数字；allowZero 放行 0 元）。 */
function lastAmountOnLine(line: string, allowZero = false): number | null {
  const tokens = joinSplitDecimal(line).match(/\d+(?:\.\d+)?/g);
  if (!tokens) return null;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const tk = tokens[i] as string;
    if (/^\d{7,}$/.test(tk)) continue; // 订单编号
    const v = Number.parseFloat(tk);
    if (Number.isFinite(v) && v < 1e8 && (allowZero ? v >= 0 : v > 0)) return v;
  }
  return null;
}

/**
 * v1.3.1 宽松行尾金额（列表页商品行/0 元订单用）。
 *
 * 对抗真实 OCR 噪声：「x190.oo」（x 是 ¥、oo 是 00）、「“460oo」（“ 是 ¥）、
 * 「*3.79」「兰3.39」「闭4.99」「站24.66」「xy24.50」「0 00」「合计YO」。
 *
 * 规则：
 * - 前缀可选（货币符号的各种误识）；
 * - 小数部分允许是 [oO]{2}（.oo = .00）；
 * - 无小数点时行尾 [oO]{2} 视为 .00（460oo = 460.00）；
 * - 单独的「x1」是数量后缀不是金额。
 */
function looseTailAmount(line: string): number | null {
  const m = /[¥￥Yy羊半尖站闻兰闭OoWw…xX“”"'‘’*]?\s*(\d{1,3}(?:,\d{3})*(?:\.(\d{1,2}|[oO]{2}))?)[oO]{0,2}\s*[~～]?\s*$/.exec(line);
  if (!m) return null;
  const raw = m[0];
  // 「x1」「×2」是数量后缀，不是金额
  if (/^[xX×*]\s*\d{1,3}$/.test(raw.trim())) return null;
  let digits = (m[1] ?? '').replace(/,/g, '');
  const dec = m[2];
  if (dec != null && /^[oO]{2}$/.test(dec)) digits += '.00';
  else if (dec == null && /[oO]{2}$/.test(raw)) digits += '.00';
  const v = Number.parseFloat(digits);
  return Number.isFinite(v) && v < 1e8 ? v : null;
}

/**
 * v1.3.1 显式 0 元识别（京东秒送「券后 0 元」整单）。
 * 只认「0 00 / 0.00 / ¥0 / YO」这类明确的零价形态， stray 的「0」不算。
 */
function zeroPriceOnLine(line: string): boolean {
  const fixed = line.replace(/([¥￥Yy])\s*[Oo](?=[^0-9]*$)/g, '$10');
  return /(?:[¥￥Yy羊半尖站闻兰闭OoWw…xX]\s*)?0\s*[.,]?\s*0{1,2}\s*(?:元)?\s*[~～]?\s*$/.test(fixed) || /^0\s*[.,]?\s*0{1,2}\s*(?:元)?\s*$/.test(fixed.trim());
}

/** 行尾金额（列表页商品行自带价格时用；v1.3.1 起兼容宽松噪声与 0 元）。 */
function trailingAmount(line: string): number | null {
  const m = TAIL_AMOUNT_RE.exec(line);
  if (m) {
    const digits = m[0].match(/\d+(?:\.\d+)?/g);
    if (digits) {
      const v = Number.parseFloat(digits[digits.length - 1] as string);
      if (Number.isFinite(v) && v > 0 && v < 1e8) return v;
    }
  }
  const loose = looseTailAmount(line);
  if (loose != null && loose > 0) return loose;
  if (zeroPriceOnLine(line)) return 0;
  return null;
}

/** 段内数量（x1 / 共N件 → 「1件」）。 */
function qtyOfSegment(lines: string[], from: number, to: number): string | undefined {
  let fallback: string | undefined;
  for (let i = Math.max(0, from); i <= to && i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    const m = QTY_IN_SEGMENT_RE.exec(l);
    if (!m) continue;
    const n = Number(m[1] ?? m[2]);
    if (!Number.isFinite(n) || n < 1 || n > 999) continue;
    const qty = `${n}件`;
    // ★v1.3.1 优惠券行的「x4」（抖音「券 Y] 领 Y0.5 和所 x4」）不是商品数量——
    // 框架行上的数量降级为兜底，优先取非框架行上的（商品行的 X1）
    const stripped = stripBrackets(l);
    if (!CHROME_RE.test(stripped)) return qty;
    fallback = fallback ?? qty;
  }
  return fallback;
}

/** 单字中文 token 数（淘金币权益位「金龙自. 国f 星人 人 秆 和…」这类碎行的特征）。 */
function singleCharCjkTokens(s: string): number {
  return s
    .split(/\s+/)
    .filter((t) => /^[\u4e00-\u9fa5]$/.test(t)).length;
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
    // ★v1.3.1：「店」只在**带头行状态词**时才当店铺头行排除——
    // 外卖详情的「豫襄阳阳牛杂面(宿舍直达店)」是商品行，要能当名字。
    // 判定要同时看**原始行**：店名常在括号里（「塔斯汀.中国汉堡(高坡岩步行街店)」），
    // 剥完括号 SHOP_HEADER_RE 就丢了店字，头行反被当成商品名（京东秒送列表实测）
    const header =
      (SHOP_HEADER_STATE_RE.test(stripped) || SHOP_HEADER_STATE_RE.test(raw)) &&
      (SHOP_HEADER_RE.test(stripped) || SHOP_HEADER_RE.test(raw));
    // 无状态词但店名在正文行尾的（「医王司回京喜自营官方店」）同样是店铺头行
    if (header || SHOP_HEADER_TAIL_RE.test(stripped)) continue;
    if (ADDRESS_RE.test(stripped) && (/\d/.test(stripped) || cjkCount(stripped) >= 8)) continue;
    if (PHONE_RE.test(stripped)) continue;
    const cjk = cjkCount(stripped);
    if (cjk < 4) continue; // 剥完只剩空壳/乱码 → 不是商品名
    let score = cjk * 2;
    // 带【】[]营销前缀的行恰恰是商品行（「【专享2】酒精湿巾…」），剥完字数变少，补回权重
    if (/[【[]/.test(raw)) score += 8;
    // ★v1.3.1 淘宝外卖详情的商品行带「己购」前缀——强信号，加分压过权益位碎行
    if (/^\s*(?:已|己)购\b/.test(raw)) score += 15;
    if (QTY_TAIL_RE.test(stripped)) score -= 30; // 规格/数量行
    // 「30袋」这类规格片段罚分；但**行首**规格前缀（拼多多「2斤±0.2斤/盒 本地现摘新鲜西…」）
    // 是商品行特征不是噪声，不罚（v1.3.1 实测：罚了整行被跳过，名称丢）。
    // 判定前先把规格前缀整块剥掉——否则「±0.2斤」里的「2斤」会误触罚分
    const noSpec = stripped.replace(SPEC_PREFIX_RE, ' ');
    const qtyUnit = QTY_UNIT_IN_NAME_RE.exec(noSpec);
    if (qtyUnit && qtyUnit.index > 0) score -= 30;
    if (MARKETING_RE.test(stripped)) score -= 15; // 营销卖点行
    if (/[：:]/.test(stripped) && cjk > 12) score -= 20; // 冒号长文案
    // ★v1.3.1 用法尾注行（拼多多「红柿(100g起) 放红后食用」）是上一件商品的续行，
    // 不是主商品名——降权让锚点行（「…精选水洗胡” 实付: *4.74」）赢
    if (USAGE_ANY_RE.test(stripped)) score -= 10;
    // ★v1.3.1：≥3 个单字中文 token = 权益位/标签行的碎文本（淘金币「可抵0.53元…」同级噪声）
    if (singleCharCjkTokens(stripped) >= 3) score -= 25;
    // ★v1.3.1 碎行降权：≥5 个 token 且平均中文 ≤2 且**无数字 token**
    // （淘金币权益位「爹花鱼爹龙鲁 必定 让是 强生」中文数最高会抢真商品名；
    //  带数字 token 的行豁免——0 元商品行「… 0 00」、规格行「2斤±0.2斤/盒 …」都是这个形态）
    const tokens = noSpec.trim().split(/\s+/).filter(Boolean);
    const digitTok = tokens.filter((t) => /\d/.test(t) && cjkCount(t) <= 1).length;
    if (tokens.length >= 5 && cjk / tokens.length <= 2 && digitTok === 0) score -= 25;
    // ★v1.3.1 数字碎片行（京东秒送「满5 01.， 国轩 尘5 o1. <二 有」——满减提示被 OCR 打碎）：
    // ≥3 个「带数字且中文≤1」的 token 即营销/提示碎片，不是商品名
    if (digitTok >= 3) score -= 20;
    if (score <= 0) continue;
    if (!best || score > best.score) best = { line: raw, score };
  }
  return best?.line ?? null;
}

/** 段内店铺行（到店消费名称优先 / 无商品名时的兜底；v1.3.1）。 */
function shopLineOf(lines: string[], from: number, to: number, extra = 0): string | null {
  for (let i = Math.max(0, from); i <= to + extra && i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (!raw) continue;
    // ★v1.3.1 先剥行尾状态词再判噪声——店铺行常带「交易完成」（抖音列表
    // 「乐野男士理发馆(开元过号店)等11店通用 交易完成」），不剥会被 CHROME 误杀
    const stripped = stripBrackets(raw).replace(SHOP_STATE_TAIL_RE, ' ');
    if (CHROME_RE.test(stripped)) continue;
    if (SHOP_LINE_RE.test(stripped)) return raw;
  }
  return null;
}

/** 金额 → 行尾剥离正则（9.89 同时匹配「9.89」与「9 89」两种 OCR 形态）。 */
function amountTailRe(amount: number): RegExp | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const s = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const dot = s.indexOf('.');
  const digits = dot > 0 ? `${s.slice(0, dot)}[\\s.]{0,2}${s.slice(dot + 1)}` : s;
  // 整数金额必须带货币符号前缀，防误伤「苹果15」型号码；
  // 小数金额前缀改为**可选**——带上才能把「兰3.39」整块剥掉
  // （只剥 3.39 会留下「兰」，首部短残片规则反把真名「红柿」当残片剥掉）
  const prefix = '[¥￥Yy羊半尖站闻兰闭六OoWw…xX]\\s*';
  return new RegExp(`(?:${prefix})?${digits}[\\s~～]*$`);
}

/** 规格前缀（拼多多「2斤±0.2斤/盒」「10斤/份」「5斤/袋[甘甜清脆]」；v1.3.1）。 */
const SPEC_PREFIX_RE =
  /\d+(?:\.\d+)?\s*(?:斤|kg|g|克|袋|盒|瓶|包|份|个|只|条|箱|升|ml|ML|L|颗|根|双|提|块|片|枚)(?:\s*[±+]\s*\d+(?:\.\d+)?\s*(?:斤|kg|g|克|袋|盒|瓶|包|份|个|只|条|箱|升|ml|ML|L|颗|根|双|提|块|片|枚))?(?:\s*\/\s*[^\s]{1,6})?/g;

/** 用法尾注（拼多多「放红后食用」；v1.3.1）。 */
const USAGE_TAIL_RE = /[,\s]*(?:放红后食用|开袋即食|洗净即可|现摘现发|产地直发|趁鲜食用|收到后?食用|阴凉干燥处保存)\s*$/;
/** 用法尾注（不限位置——评分降权用；真实样本里它常出现在行中，价格在后面）。 */
const USAGE_ANY_RE = /放红后食用|开袋即食|洗净即可|现摘现发|产地直发|趁鲜食用|收到后?食用|阴凉干燥处保存/;

/**
 * 商品名清洗：营销括号 → 锚点词 → 锚点金额 → 行尾金额 → 首尾残片 → 数字词残片。
 *
 * 「ET 【专享2】酒精温巾 一..， ”四到手#0.99」→「酒精温巾」
 * 「之 二 金龙鱼黄金比例食用植物调和 尖4.17」→「金龙鱼黄金比例食用植物调和」
 * 「心相印抽纸薰衣草面巾纸3层10...， \\ Y2.01」→「心相印抽纸薰衣草面巾纸3层10」
 * v1.3.1：「2斤±0.2斤/盒 | 本地现摘新鲜西红柿(100g起) 放红后食用」→「本地现摘新鲜西红柿」
 */
export function cleanProductName(line: string, amount?: number | null): string {
  let s = ` ${line} `;
  // ★v1.3.1 淘宝外卖详情「己购 商品名(店)」——「己购」是 UI 词不是商品名一部分
  s = s.replace(/^\s*(?:已|己)购\s+/, ' ');
  // 营销括号（OCR 常丢半边括号，故不强制闭合）
  s = stripBrackets(s);
  // 锚点词与锚点金额
  s = s.replace(ANCHOR_WORD_RE, ' ');
  const tail = amount ? amountTailRe(amount) : null;
  if (tail) s = s.replace(tail, ' ');
  // 行尾残留金额（半0.99 / Y2.01 / W.56 / x190.oo / … 99.00）
  s = s.replace(TAIL_AMOUNT_RE, ' ');
  // ★v1.3.1 宽松行尾金额残片（x190.oo / “460oo / 兰3.39 / *3.79 / 六2.80）
  s = s.replace(LOOSE_TAIL_RE, ' ');
  // ★v1.3.1 0 元行尾（京东秒送「标准不 0 00」「*0.00」；amount=0 时才剥，
  // 防误伤正常金额行的尾数）
  if (amount === 0) s = s.replace(ZERO_TAIL_RE, ' ');
  // ★v1.3.1 规格前缀（拼多多「2斤±0.2斤/盒」）与用法尾注（「放红后食用」）
  s = s.replace(SPEC_PREFIX_RE, ' ');
  s = s.replace(USAGE_TAIL_RE, ' ');
  // 行尾规格后缀（淘宝外卖「-默认」）
  s = s.replace(/\s*[-—–]\s*(?:默认|默认规格|规格)\s*$/, ' ');
  // 首部标点 + 压空白
  s = s.replace(/^[\s\d_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+<>〉》]+/, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 独立数字词残片（第一遍：「之 二 金龙鱼…」先删「二」，单字前缀才剥得掉「之」）
  s = dropNumberWordTokens(s);
  // 首部残片循环（剥到稳定）：标点 → 字母残片（ET/ED/rr）→ 短中文/中英混排残片
  // （「全 沪 。 橙C美式…」「损昼 库迪咖啡」「和ss 两萤一素」——
  //  ★v1.3.1 由「单字」放宽到「≤2 字短 token」，剩余中文≥4 才剥，防误伤两字真名）
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(/^[\s_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+]+/, ' ').trim();
    s = s.replace(/^[A-Za-z]{1,4}\s+(?=[\u4e00-\u9fa5])/, ' ').trim();
    const m = /^(\S+)\s+([\s\S]*)$/.exec(s);
    if (m) {
      const head = m[1] ?? '';
      const rest = m[2] ?? '';
      const junkHead = /^[\u4e00-\u9fa5]{1,2}$/.test(head) || /^[\u4e00-\u9fa5]?[A-Za-z]{1,4}[\u4e00-\u9fa5]?$/.test(head);
      if (junkHead && cjkCount(rest) >= 4) s = rest.trim();
    }
    if (s === before) break;
  }
  // 尾部残片（循环到稳定）：标点（含 > 》〉）→ 带点英文（WuqueStud.）→ Q@D 式乱码 → 孤立货币前缀（半/W/x/六）
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(/[\s_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+@#<>〉》]+$/, ' ').trim();
    s = s.replace(/[A-Za-z]{1,12}\.[A-Za-z.]*$/, ' ').trim();
    s = s.replace(/[A-Za-z@#]+[@#][A-Za-z@#]*$/, ' ').trim();
    // 孤立货币前缀（半/W/x/六）。注意不含「兰/闭」——那是 OCR 噪声前缀，
    // 金额已在上面整块剥掉；这里若剥会误伤「芬兰」这类真名
    s = s.replace(/[¥￥Yy羊半尖站闻六OoWw…xX*]+$/, ' ').trim();
    if (s === before) break;
  }
  // ★v1.3.1 尾部短残片（≤3 个中文、不含数字；前面已有 ≥6 中文时剥）：
  // 「橙C美式冰大杯 标准不」→「橙C美式冰大杯」、「杂牌笔记本 CPU瑞特尔」→「杂牌笔记本」
  // （「英特尔N95 四核」前面只有 3 个中文 → 保留；「1人份1人」带数字 → 保留）
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    const m = /^(.*?)(\S+)\s*$/.exec(s);
    if (m) {
      const head = m[1] ?? '';
      const last = m[2] ?? '';
      if (cjkCount(last) <= 3 && cjkCount(last) > 0 && !/\d/.test(last) && cjkCount(head) >= 6) {
        s = head.trim();
      }
    }
    if (s === before) break;
  }
  // 独立数字词残片（第二遍：「酒精温巾 一 四」剥掉尾部标点后才暴露）
  s = dropNumberWordTokens(s);
  return s.slice(0, 24);
}

/**
 * 店铺名清洗（v1.3.1 到店消费用）：
 * 状态词 → 「等N店通用」→ 括号分店名 → 首尾残片（「7本 初见民宿 7 ee」→「初见民宿」）。
 */
export function cleanShopName(line: string): string {
  let s = ` ${line} `;
  s = s.replace(/(?:等待买家收货|待买家收货|交易成功|交易完成|交易关闭|已完成|完成)\s*$/, ' ');
  s = s.replace(/等\s*\d+\s*店通用\s*$/, ' ');
  s = stripBrackets(s);
  s = s.replace(/[\s<>〉》|]+/g, ' ').trim();
  s = s.replace(/^[\s\d_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+]+/, ' ').trim();
  // 首部单字残片（「7本 初见民宿」→「初见民宿」）
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(/^[\u4e00-\u9fa5]\s+(?=[\u4e00-\u9fa5]{2,})/, ' ').trim();
    if (s === before) break;
  }
  // 尾部残片：短英文/数字 token（「初见民宿 7 ee」→「初见民宿」）
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(/\s+[A-Za-z0-9]{1,4}$/, ' ').trim();
    s = s.replace(/[\s_.。，,、\-—~～:：;；!！?？"'“”‘’|/\\+]+$/, ' ').trim();
    if (s === before) break;
  }
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
  /** v1.3.1：整单汇总行（拼多多订单级实付，后接商品总额/订单编号） */
  total?: boolean;
}

/** 锚点金额：行内最后一个数字 → 失败时宽松兜底（O 当 0：「合计YO」= 合计¥0）。 */
function anchorAmount(line: string): number | null {
  // ★v1.3.1 先剥数量模式（「共1件」「x1」）——京东秒送详情「旧 共1件 合计YO」，
  // 不剥会让数量「1」抢走金额（解析成 ¥1）
  const noQty = line.replace(
    /共\s*\d{1,3}\s*[件伯个份名只条支张本袋盒瓶包]|(?:^|[^A-Za-z0-9])[xX×]\s*\d{1,3}(?![\d.])/g,
    ' ',
  );
  const direct = lastAmountOnLine(noQty);
  if (direct != null) return direct;
  const fixed = noQty.replace(/([¥￥Yy])\s*[Oo](?=[^0-9]*$)/g, '$10');
  const zero = lastAmountOnLine(fixed, true);
  if (zero != null) return zero;
  const loose = looseTailAmount(line);
  if (loose != null) return loose;
  if (zeroPriceOnLine(line)) return 0;
  return null;
}

/** 找锚点行（实付优先，没有才退到手/合计/总计；v1.3.1 含成交价/应付款）。 */
function findAnchors(lines: string[], re: RegExp): Anchor[] {
  const out: Anchor[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!re.test(lines[i] ?? '')) continue;
    const amount = anchorAmount(lines[i] ?? '');
    if (amount == null) continue;
    // 汇总行判定：后 4 行内出现 商品总额/平台优惠/订单编号/下单时间
    const follow = lines.slice(i + 1, i + 5).join('\n');
    const total = ORDER_TOTAL_FOLLOW_RE.test(follow);
    out.push({ idx: i, amount, total });
  }
  return out;
}

/** 把锚点切成分段，并合并「实付价+实付款」这类重复锚点（中间没有商品名候选时）。 */
function segmentsFromAnchors(lines: string[], anchors: Anchor[]): Array<{ from: number; to: number; amount: number | null }> {
  const segs: Array<{ from: number; to: number; amount: number | null }> = [];
  let kept = 0;
  for (const a of anchors) {
    // ★v1.3.1 汇总行跳过：已有逐项锚点时，订单级「实付: 24.66」不单独成笔
    if (a.total && kept > 0) continue;
    const from = segs.length ? segs[segs.length - 1]!.to + 1 : 0;
    // 与上一笔间隔 ≤8 行且中间找不到商品名 → 同一笔的重复锚点（实付价 明细 + 实付款 汇总）
    const dup = segs.length > 0 && a.idx - segs[segs.length - 1]!.to <= 8 && !pickNameLine(lines, from, a.idx);
    if (dup) {
      segs[segs.length - 1]!.to = a.idx;
      segs[segs.length - 1]!.amount = a.amount;
    } else {
      segs.push({ from, to: a.idx, amount: a.amount });
    }
    kept += 1;
  }
  return segs;
}

/** 店铺头行切分段（订单列表页，没有任何实付/合计行时用）。 */
function segmentsFromShopHeaders(lines: string[], sellerHeaderRe?: RegExp): Array<{ from: number; to: number; amount: number | null }> {
  const segs: Array<{ from: number; to: number; amount: number | null }> = [];
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    const isHeader = sellerHeaderRe
      ? sellerHeaderRe.test(l)
      : SHOP_HEADER_RE.test(l) && SHOP_HEADER_STATE_RE.test(l);
    if (!isHeader) continue;
    if (segs.length || i > 0) {
      segs.push({ from: start, to: i - 1, amount: null });
    }
    start = i;
  }
  segs.push({ from: start, to: lines.length - 1, amount: null });
  return segs;
}

/**
 * 名称行行尾「带货币前缀」的金额（严格版 trailingAmount——用于校正锚点金额）。
 * 「和ss。 【人气王超下饭】两萤一素-默认 Y11.5」→ 11.5（Y 是 ¥ 的误识）。
 */
function currencyTailAmount(line: string): number | null {
  const m = /[¥￥Yy羊半尖站闻六兰闭OoWw…xX“”"'‘’*]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)[oO]{0,2}\s*[~～]?\s*$/.exec(line);
  if (!m) return null;
  const v = Number.parseFloat((m[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/**
 * 断字续行（v1.3.1 拼多多实测）：商品名被 OCR 从中间截断——
 * 「2斤+0.2斤/盒 | 本地现摘新鲜西”实付: *3.79」+ 下一行「红柿(100g起) 放红后食用」
 * 真名是「本地现摘新鲜西红柿」。只接受**纯中文短词**（≤6 字）作续行，
 * 「人SS (单果三两起)」这种带字母的拒掉（防乱拼）。
 */
function continuationOf(lines: string[], from: number): string | null {
  for (let i = Math.max(0, from); i <= from + 1 && i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (!raw) continue;
    const stripped = stripBrackets(raw);
    if (CHROME_RE.test(stripped)) continue;
    const cand = cleanProductName(raw);
    if (/^[\u4e00-\u9fa5]{1,6}$/.test(cand)) return cand;
  }
  return null;
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
  const profile = profileOf(text);

  // ① 强锚点（订单详情页/结算行）：实付 / 成交价。
  // ★v1.3.1 到手/合计/总计降为弱锚点只在②用——京东详情的商品行常带「到手O.5」，
  // 混进强锚点会凭空多切一笔（实测 JD_2 被切成 2 笔）
  let segs = segmentsFromAnchors(lines, findAnchors(lines, /实付|成交价/)) as Array<{
    from: number;
    to: number;
    amount: number | null;
  }>;

  // ② 没有强锚点 → 到手/合计/总计（小票、部分列表页）
  if (segs.length === 0) {
    segs = segmentsFromAnchors(lines, findAnchors(lines, /到手|合计|总计/));
  }

  // ③ 还没有 → 店铺头行（订单列表页；闲鱼用卖家头行）。
  // ★v1.3.1 必须已识别出平台——否则聊天记录/口头账（「今天午饭花了25」）也会被
  // 店铺头行切成"订单"并报出金额（looseTailAmount 对裸数字也放行）
  if (segs.length === 0) {
    segs = place ? segmentsFromShopHeaders(lines, profile?.sellerHeaderRe) : [];
  }

  const out: OrderHit[] = [];
  for (const seg of segs) {
    const nameLine = pickNameLine(lines, seg.from, seg.to);
    // ★v1.3.1 店铺行：到店消费名称优先；无商品名时兜底。
    // 锚点分段（详情页）允许往锚点后再看 6 行——抖音详情页的店铺行在实付行下方。
    const shopLine = shopLineOf(lines, seg.from, seg.to, profile?.shopFirst ? 6 : 0);
    const useShop = profile?.shopFirst ? shopLine != null : nameLine == null && shopLine != null;
    const src = useShop ? shopLine : nameLine;
    if (!src) continue;
    // 金额：锚点 → 名称行行尾 → 段内其它行行尾 → 显式 0 元
    let amount = seg.amount ?? trailingAmount(src);
    if (amount == null) {
      for (let i = seg.from; i <= seg.to && i < lines.length; i += 1) {
        const a = trailingAmount(lines[i] ?? '');
        if (a != null) {
          amount = a;
          break;
        }
      }
    }
    if (amount == null) continue;
    // ★v1.3.1 锚点金额被 OCR 吃掉首位（淘宝外卖列表「实付款J]1.5」实为 ¥11.5）：
    // 名称行带货币前缀的行尾金额以锚点金额**结尾且更长」→ 用名称行的
    if (seg.amount != null && !useShop) {
      const tail = currencyTailAmount(src);
      if (tail != null) {
        const a = String(seg.amount);
        const t = String(tail);
        if (t !== a && t.endsWith(a) && tail > seg.amount) amount = tail;
      }
    }
    let name = useShop ? cleanShopName(src) : cleanProductName(src, amount);
    // ★v1.3.1 断字续行（拼多多）：名称就在锚点行上且锚点前已有 ≥4 中文 →
    // 下一行若是纯中文短词则拼回去（「本地现摘新鲜西」+「红柿」）
    if (!useShop && ANCHOR_WORD_TEST_RE.test(src) && cjkCount(name) >= 4) {
      const cont = continuationOf(lines, seg.to + 1);
      if (cont) name = `${name}${cont}`;
    }
    if (name.length < 2) continue;
    // 数量：先看锚点行之后（拼多多每件的「X1」在锚点行下一行），再回落段内
    const qty =
      qtyOfSegment(lines, seg.to + 1, seg.to + 3) ?? qtyOfSegment(lines, seg.from, seg.to);
    const hit: OrderHit = { name, amount, place, qty };
    hit.rawLine = src.slice(0, 60);
    if (useShop && nameLine) hit.shop = cleanProductName(nameLine, amount) || undefined;
    out.push(hit);
  }
  return out;
}

/**
 * 一笔订单 → 口语句（交 parseLocal 复用全部分类逻辑）。
 *
 * 「买了酒精湿巾 1件 花了0.99」——口头语模块会把「1件」抽进备注、名称只留商品名。
 * v1.3.1：0 元订单（京东秒送券后 0 元）走「0元」句式——「花了0」会被数量「1件」抢戏。
 */
export function orderSentence(o: OrderHit): string {
  const qty = o.qty ? ` ${o.qty}` : '';
  if (o.amount != null && o.amount > 0) return `买了${o.name}${qty} 花了${o.amount}`;
  if (o.amount === 0) return `买了${o.name} 0元`;
  return `买了${o.name}${qty}`;
}

/**
 * 一笔订单的备注：平台 · 数量｜OCR 原文行。
 *
 * 用户反馈 3 的「在哪买的、多少数量」以备注形式保留；原文行让用户能核对 OCR 认对了没。
 * v1.3.1：到店消费附店铺名（名称用了店铺行时，原文行即店铺行，不再重复）。
 */
export function orderNote(o: OrderHit): string {
  const prefix = [o.place, o.qty].filter(Boolean).join(' · ');
  const raw = (o.rawLine ?? '').trim();
  return prefix ? `${prefix}｜${raw}` : raw;
}
