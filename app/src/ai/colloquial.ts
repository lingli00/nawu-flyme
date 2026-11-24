import { toNumber } from './cnNumber';
import { QUANTIFIER_RE } from './keywords';

/**
 * ★v1.2.1 口头语细节保留（用户反馈 3）：
 * 「我今天在淘宝花了29块钱买了30斤大米。」这类句子里，
 * **购买地点（淘宝）与数量（30斤）不能丢**——抽出来放备注，名称只留「大米」。
 *
 * 纯函数、无副作用，可单测；localParser 的三种草稿（物品/订阅/生活流）共用。
 */

/** 常见购买地点/渠道（线上平台 + 线下场所）。 */
export const PLACE_WORDS = [
  // 线上
  '京东', '淘宝', '天猫', '拼多多', '抖音商城', '抖音', '快手', '美团', '饿了么', '盒马', '山姆', '宜家',
  '名创优品', '无印良品', '优衣库', '得物', '闲鱼', '转转', '1688', '亚马逊', '海淘', '代购', '微店',
  '小程序', '官网', '网店', '直播间', '直播', '微信小商店', '支付宝',
  // 线下连锁
  '大润发', '沃尔玛', '家乐福', '永辉', '华润万家', '物美', '世纪联华', '华联', '苏果', '欧尚', '麦德龙',
  '肯德基', '麦当劳', '汉堡王', '必胜客', '星巴克', '瑞幸', '蜜雪冰城', '喜茶', '奈雪', '海底捞',
  '沙县小吃', '兰州拉面', '黄焖鸡', '麻辣烫', '火锅店', '烧烤店', '自助餐', '早餐店', '奶茶店', '咖啡店',
  '面包店', '糕点店', '五金店', '文具店', '书店', '花店', '宠物店', '母婴店', '服装店', '鞋店', '数码店',
  '电脑城', '手机店', '维修店', '药店', '诊所', '医院', '食堂', '餐馆', '饭店', '酒店', '网吧',
  '加油站', '车站', '机场', '地铁站', '公交站', '停车场',
  // 泛称
  '超市', '便利店', '小卖部', '菜市场', '水果店', '生鲜店', '专卖店', '旗舰店', '商场', '百货',
  '广场', '大厦', '商圈', '步行街', '夜市', '早市', '集市', '摊位', '铺子', '线下', '实体店',
  '楼下', '小区', '门口', '学校', '公司', '单位', '工厂', '滴滴', '出租车', '网约车',
];

/** 数量单位（注意：不含「块/g/kg/L」——与「29块钱」「8G+128G 内存」「L码」冲突）。 */
export const QTY_UNITS = [
  '斤', '公斤', '克', '千克', 'ml', '升', '毫升',
  '盒', '包', '袋', '瓶', '罐', '箱', '件', '个', '只', '条', '支', '双', '桶', '提', '卷',
  '片', '颗', '粒', '碗', '杯', '份', '打', '本', '张', '台', '部', '辆', '副', '套', '串', '把',
  '排', '枚', '贴', '剂', '丸', '束', '捧',
];

const PLACE_RE = new RegExp(`在?\\s*(${PLACE_WORDS.join('|')})`, 'g');
/** 「在XX店/超市/市场…」：XX 为 1-6 个汉字的未知店名。 */
const PLACE_GENERIC_RE =
  /在\s*[\u4e00-\u9fa5A-Za-z0-9]{1,6}?(店|超市|市场|商城|商场|公司|医院|学校|食堂|餐馆|饭店|酒店|网吧|加油站|车站|机场|广场|大厦|摊位|铺子|小卖部|便利店|柜台|专柜)/;
/** 数量：阿拉伯数字或中文数字 + 单位。 */
const QTY_RE = new RegExp(`(\\d+(?:\\.\\d+)?|[一二三四五六七八九十百千万零两半])\\s*(${QTY_UNITS.join('|')})`, 'gi');
/** 「花了/付了 + 金额 + 钱单位」片段（名称里剥掉）。 */
const SPEND_RE =
  /(花了|花费|消费了?|付了?|支了?|出了?|贡献了?|掏了|砸了|用了)\s*[0-9一二三四五六七八九十百千万点.]+\s*(块钱|块|元|人民币|圆|蚊|刀|美金|美元|港币|欧元)?/g;
/** 购买动作词（名称里剥掉）。 */
const BUY_VERB_RE = /(买了个|买了|开通|开了个|开了|续费|买|购入|入手|收了|下单|抢了|剁手|添置|置办|采购|搞了|整了|囤了|办了|充了|缴了|交了|订了)/g;

/** 口头语里抽出的细节（进备注）。 */
export interface OralDetails {
  /** 购买地点/渠道，如「淘宝」「楼下超市」 */
  place?: string;
  /** 数量，如「30斤」「3盒」 */
  qty?: string;
}

/** 从原句抽地点 + 数量（找不到的字段不出现）。 */
export function extractOralDetails(text: string): OralDetails {
  const t = text ?? '';
  const out: OralDetails = {};

  // 数量（含中文数字：三斤 → 3斤）
  const qm = QTY_RE.exec(t);
  if (qm) {
    const n = toNumber(qm[1]);
    out.qty = Number.isFinite(n) && n > 0 ? `${n}${qm[2]}` : `${qm[1]}${qm[2]}`;
  }
  QTY_RE.lastIndex = 0;

  // 地点：先「在XX店/超市」泛化（更具体），再具名单
  const gm = PLACE_GENERIC_RE.exec(t);
  if (gm) out.place = gm[0].replace(/^在\s*/, '');
  if (!out.place) {
    PLACE_RE.lastIndex = 0;
    const pm = PLACE_RE.exec(t);
    if (pm) out.place = pm[1];
    PLACE_RE.lastIndex = 0;
  }
  return out;
}

/**
 * 名称清洗：把时间/人称/地点/金额/数量/动作词全部剥掉，只留商品名。
 *
 * - 「我今天在淘宝花了29块钱买了30斤大米。」→「大米」
 * - 「刚买了个N95准系统笔记本 花了899」→「N95准系统笔记本」（不被误伤）
 * - 「抽纸花了0.01元。」→「抽纸」
 */
export function cleanNameText(text: string, amountRaw?: string): string {
  let s = ` ${text ?? ''} `;
  // 时间词 / 人称
  s = s.replace(/(今天|昨天|前天|刚才|刚刚|刚|大前天|明天|早上|早晨|清晨|上午|中午|午间|晌午|下午|晚上|傍晚|夜里|半夜|深夜|凌晨)/g, ' ');
  s = s.replace(/(我|我们|俺|咱|你|您)/g, ' ');
  // 地点（细节已抽进备注，名称里删掉）——★v1.3.1 记下命中的地点词：
  // 连锁店名与品类连写时（「瑞幸咖啡」「肯德基汉堡」）品牌就是商品名的一部分，
  // 剥掉会让账本条目只剩「咖啡」，图标匹配也丢掉品牌
  const placeHits: string[] = [];
  PLACE_RE.lastIndex = 0;
  s = s.replace(PLACE_RE, (_m, p1: string) => {
    if (p1 && !placeHits.includes(p1)) placeHits.push(p1);
    return ' ';
  });
  PLACE_RE.lastIndex = 0;
  s = s.replace(PLACE_GENERIC_RE, ' ');
  // 「花了 29 块钱」金额片段
  s = s.replace(SPEND_RE, ' ');
  // ★v1.3.1 行尾裸金额：没有「花了」的口语句式「瑞幸咖啡 19.9元」，
  // 不剥会残留「19 9元」（小数点被标点清洗换成空格）。
  // 只剥带货币单位或带小数点的尾部数字，「iPhone 15」这类型号不受影响。
  s = s.replace(/\s\d{1,6}(?:[.．]\d{1,2})?\s*(?:元|块|块钱|圆)\s*$/, ' ');
  s = s.replace(/\s\d{1,6}[.．]\d{1,2}\s*$/, ' ');
  // ★v1.3.1 行尾裸「0元」（订单截图 0 元券后订单的合成句「买了X 0元」：
  // amountRaw 只剥数字，「0元」两字会残留在名称里——「库迪咖啡 0元」→「库迪咖啡」）
  s = s.replace(/\s*(?:券后\s*)?0\s*元\s*$/, ' ');
  // 数量短语（细节已抽进备注）
  QTY_RE.lastIndex = 0;
  s = s.replace(QTY_RE, ' ');
  QTY_RE.lastIndex = 0;
  // 裸金额原文
  if (amountRaw) s = s.replace(amountRaw, ' ');
  // 购买动作
  s = s.replace(BUY_VERB_RE, ' ');
  // 订阅词（★v1.3.0：「大会员」是 B站 专有产品名，前面带「大」时不剥；
  // 否则「B站大会员年卡」会被啃成「B站大」）
  s = s.replace(/(?<!大)会员|订阅|月卡|年卡|季卡|周卡|包月|包年/g, ' ');
  // 括号与标点
  s = s.replace(/[（(][^）)]*[）)]/g, ' ');
  s = s.replace(/[，,。.；;！!？?、~—\-_/\\|"'“”‘’]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 前缀量词（双跑鞋 → 跑鞋）与前缀动词（吃了碗牛肉面 → 牛肉面）。
  // 量词循环剥，但剥完不足 2 字就停（「包子」「杯子」这类量词即词根的保留）
  for (let i = 0; i < 3; i += 1) {
    const stripped = s.replace(QUANTIFIER_RE, '').trim();
    if (!stripped || stripped === s || stripped.length < 2) break;
    s = stripped;
  }
  s = s.replace(/^(吃了|喝了|吃|喝|整|嗦|撸|啃|撮|扒|吞|嚼)/, '').trim();
  s = s.replace(/^[了的过]+/, '').trim();
  for (let i = 0; i < 3; i += 1) {
    const stripped = s.replace(QUANTIFIER_RE, '').trim();
    if (!stripped || stripped === s || stripped.length < 2) break;
    s = stripped;
  }
  // 尾部虚词
  s = s.replace(/(了|的|个|一下|呀|啊|哦|哈|咯)+$/g, '').trim();
  const out = s.slice(0, 24);
  // ★v1.3.1 连锁店名与品类连写（原文里紧挨着）→ 品牌回到商品名
  for (const p of placeHits) {
    if (out && text.includes(p + out)) return `${p}${out}`.slice(0, 24);
  }
  // 只剩店名（「星巴克 32」）时名称用店名，别丢成空（纯数字残留视为金额）
  const onlyAmount = !out || /^[\d\s.]+$/.test(out);
  if (onlyAmount && placeHits.length) return placeHits[placeHits.length - 1];
  return out;
}

/**
 * 备注：细节（地点·数量）前缀 + 原文。
 * 无细节时就是原文（保持 PRD「备注自动填充原文」）。
 */
export function detailsNote(text: string, details: OralDetails): string {
  const parts = [details.place, details.qty].filter(Boolean);
  const t = (text ?? '').trim();
  return parts.length ? `${parts.join(' · ')}｜${t}` : t;
}
