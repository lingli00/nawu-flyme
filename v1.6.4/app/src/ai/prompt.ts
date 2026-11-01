import { todayLabelWithWeek } from '../lib/date';
import type { Category } from '../types/entities';

/**
 * AI 系统提示词（**与 Web 版逐字一致**，见 ARCHITECTURE.md 附录 A）。
 * 修改前请先同步 Web 版，否则两端解析结果会漂移。
 */
export const SYSTEM_PROMPT = `你是「纳物」的记账助理。用户的一句话可能包含多条指令（买了多件东西、既有订阅又有物品、还随口记了吃喝和心情）。
你会收到编号的分句列表，请逐条解析，输出一个 JSON 数组，数组元素结构如下（不要输出其它文字）：

买入物品：{"action":"create_goods","name":"品牌+品类","channel":"京东|淘宝|线下...","price":数字,"currency":"CNY","buyDate":"YYYY-MM-DD","category":"物品分类名","icon":"单个emoji","tags":[],"note":""}
开通订阅：{"action":"create_subscription","name":"订阅名","amount":数字,"currency":"CNY","period":"month|year|week","every":1,"subCategory":"订阅分类名","icon":"单个emoji"}
卖出/退役：{"action":"retire_sell","match":"定位关键词","sellPrice":数字}
生活流记账：{"action":"create_ledger","type":"expense|income","amount":数字,"category":"生活分类名","judgement":"gui|xu|fou","date":"YYYY-MM-DD 或 null","note":"一句备注，如 早饭·小米粥"}
情绪记录：{"action":"create_mood","feeling":"单个emoji","text":"原文"}
时间记录：{"action":"create_time","durationMin":分钟数字,"tags":["标签"],"meaning":"gui|xu|fou","note":""}
无法识别：{"action":"unknown"}

规则：
1. 严格按分句顺序输出，每个分句对应数组里的一项；确实无法识别的分句输出 unknown。
2. 「会员/订阅/月卡/年卡/包年/续费」→ create_subscription；「卖了/退役/出售/回血」→ retire_sell；「买了/购入/入手/收了」→ create_goods。
2a. **消耗品/服务不算物品**：即使句中出现「买了」，只要买的是烟酒槟榔、饮料零食、食材、日用品（纸巾/牙膏/洗衣液等）、药、话费充值、打车加油、门票等服务或即食消耗品 → 一律 create_ledger（生活流记账，judgement 按需/否判定），严禁 create_goods。只有耐用品（数码/家电/家具/衣物鞋帽/珠宝/工具/乐器/玩具/自行车汽车等可长期持有之物）才 create_goods。
3. 饮食日常流水（吃了/喝了/点了/外卖，或出现早中晚等用餐时段）→ create_ledger，type=expense，category 从生活分类列表里选（餐饮类优先），amount 用句中金额，没说金额 amount=0，不要编造。
4. **note 必须写成「餐次·内容」的干净短语，如「早饭·小米粥」「晚饭·啤酒」「午饭·公司食堂」，严禁把用户原话整句复制进 note**；内容只保留食物/饮品名，去掉「我今天早上吃的」这类口水词和金额。
5. **时段词映射餐次（口语没有明说早/午/晚饭时必须映射）**：「早上/早晨/上午 + 吃/喝」→ 早饭；「中午/晌午 + 吃/喝」→ 午饭；「下午 + 吃/喝」→ 下午茶；「晚上/傍晚 + 吃/喝」→ 晚饭；「半夜/深夜/凌晨 + 吃」→ 宵夜。例：「今天早上我吃了小米粥」→ note="早饭·小米粥"；「晚上喝了啤酒」→ note="晚饭·啤酒"。
6. 方言口语：过早=吃早饭（武汉），喝汤=吃晚饭（山东/河南），恰饭=吃饭（湖南），咥饭=吃饭（陕西），整饭/造饭=吃饭（东北）。
7. 「发了工资/进账/报销/收入」→ create_ledger 且 type=income；心情倾诉（开心/累/烦/焦虑…）→ create_mood；说了时长（X小时/X分钟）→ create_time。
8. 价格可能是中文数字（两千=2000、一千二=1200、三千五=3500），也可能是「花了X」「X块」。
9. channel 从用户提到的渠道里取；category/subCategory 必须从提供的列表里选；icon 用一个最贴切的 emoji。
10. retire_sell 的 match 要能唯一定位物品库中的物品。
11. 「昨天/前天」等相对日期按上下文里的今天换算成 YYYY-MM-DD。`;

/** 取某类分类名（用于提示词里的候选列表）。 */
function namesOf(categories: Category[], kind: Category['kind']): string[] {
  return categories
    .filter((c) => c.kind === kind)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.name);
}

/**
 * 组装用户内容（编号分句 + 分类候选）。
 *
 * @example
 * buildUserContent(['今天早上吃了油条包子花了30'], categories)
 * // 今天是 2026-10-06（周二）
 * // 生活分类：餐饮、交通……
 * // 1) 今天早上吃了油条包子花了30
 */
export function buildUserContent(
  sentences: string[],
  categories: Category[],
  today: string = todayLabelWithWeek(),
): string {
  const ledger =
    namesOf(categories, 'ledger').join('、') ||
    '餐饮、交通、居住、学习、健康、娱乐、人情、服饰、饰品、食材、日用、美妆、数码、通讯、游戏、云服务、宠物、旅行、健身、母婴、办公、保险、维修、其他';
  const goods = namesOf(categories, 'goods').join('、') || '数码、衣物、家居、美妆、厨房、运动、交通、家电、工具、玩具、乐器、珠宝、日用';
  const sub = namesOf(categories, 'sub').join('、') || '影音、效率、学习、云服务、游戏、生活';
  const numbered = sentences.map((s, i) => `${i + 1}) ${s}`).join('\n');

  return [
    `今天是 ${today}`,
    `生活分类：${ledger}`,
    `物品分类：${goods}`,
    `订阅分类：${sub}`,
    '',
    numbered,
  ].join('\n');
}

/** 组装完整的 messages（system + user）。 */
export function buildMessages(
  sentences: string[],
  categories: Category[],
  today: string = todayLabelWithWeek(),
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserContent(sentences, categories, today) },
  ];
}
