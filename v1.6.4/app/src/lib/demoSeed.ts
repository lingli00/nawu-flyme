import { useDataStore } from '../store/useDataStore';

/**
 * 预览用的演示数据（只在 `?demo=1` 打开过一次之后生效）。
 *
 * ★ 为什么不直接用真实数据：换台电脑打开是全新 localStorage，
 *   首页会显示「今天还没有记录」、报表全 0、生活流空 —— 看不出界面对不对。
 *
 * ★ 安全边界：
 *   1. 必须显式带过 `?demo=1`（写 localStorage `gf.demo=1`），之后才继续生效；
 *   2. **只在本地数据为空时灌**，任何已有数据（哪怕一条）都不覆盖、不追加；
 *   3. 全部走 store 的 add* 正式接口，与手动录入产生的数据完全同构，
 *      因此详情、报表、生活流、物品成本核算看到的都是真实链路。
 */

const MARK = 'gf.demo';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 相对今天的日期（offset=0 即今天）。 */
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 是否应该灌演示数据（读标记 + 解析并抹掉 ?demo=1）。 */
export function demoRequested(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('demo') === '1' || q.get('demo') === 'reset') {
      localStorage.setItem(MARK, '1');
      q.delete('demo');
      const rest = q.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash,
      );
      return true;
    }
    return localStorage.getItem(MARK) === '1';
  } catch {
    return false;
  }
}

/** 数据已经存在就什么都不做（保护真实数据）。 */
export async function seedDemoIfEmpty(): Promise<void> {
  if (!demoRequested()) return;
  const s = useDataStore.getState();
  if (s.valueRecords.length || s.goods.length || s.subscriptions.length || s.cooldowns.length) return;

  /* —— 生活流 5 笔（今日 2 笔共 23.90，与设计稿一致）—— */
  await s.addLedgerMany([
    { type: 'expense', amount: 19.9, categoryId: 'cl0', judgement: 'xu', date: day(0), note: '早上的第一杯咖啡', currency: 'CNY' },
    { type: 'expense', amount: 4, categoryId: 'cl1', judgement: 'xu', date: day(0), note: '地铁通勤', currency: 'CNY' },
    { type: 'expense', amount: 63.4, categoryId: 'cl10', judgement: 'gui', date: day(-1), note: '周末备菜', currency: 'CNY' },
    { type: 'expense', amount: 15, categoryId: 'cl5', judgement: 'fou', date: day(-2), note: '自动续费，忘了关', currency: 'CNY' },
    { type: 'income', amount: 280, categoryId: 'cl7', judgement: 'gui', date: day(-3), note: '旧键盘已出', currency: 'CNY' },
  ]);

  /* —— 物品 4 件（★v1.3.0 加「相机」：供「我的相机卖了36000」演示完整
     退役转卖链路——确认后自动扣减：净赚 31800 记入生活流、摊销定格退役日）—— */
  await s.addGoods({ name: 'MacBook Air M3', price: 8999, categoryId: 'cg0', buyDate: day(-120), status: 'active', note: '主力机' });
  await s.addGoods({ name: 'Sony WH-1000XM5', price: 1299, categoryId: 'cg0', buyDate: day(-62), status: 'active', note: '通勤降噪' });
  await s.addGoods({ name: '机械键盘 87 键', price: 699, categoryId: 'cg0', buyDate: day(-300), status: 'active', note: '已换新，旧的在转卖' });
  await s.addGoods({ name: '索尼相机', price: 4200, categoryId: 'cg0', buyDate: day(-45), status: 'active', note: '演唱会神器' });

  /* —— 订阅 3 个 —— */
  await s.addSubscription({
    name: '网易云音乐',
    amount: 15,
    categoryId: 'cs0',
    icon: 'tv',
    type: 'recurring',
    period: 'month',
    every: 1,
    startDate: day(-200),
    nextRenewDate: day(6),
    autoRenew: true,
    currency: 'CNY',
  });
  await s.addSubscription({
    name: 'iCloud 50G',
    amount: 6,
    categoryId: 'cs3',
    icon: 'cloud',
    type: 'recurring',
    period: 'month',
    every: 1,
    startDate: day(-400),
    nextRenewDate: day(11),
    autoRenew: true,
    currency: 'CNY',
  });
  await s.addSubscription({
    name: '极客时间', amount: 199, categoryId: 'cs2', icon: 'book-open',
    type: 'recurring', period: 'year', every: 1,
    startDate: day(-150), nextRenewDate: day(215), autoRenew: false, currency: 'CNY',
  });

  /* —— 冷静池 1 件（还剩 3 天）—— */
  await s.addCooldown({ name: '桌面音箱', amount: 1299, until: day(3), reason: '深夜上头' });

  /* —— 心动清单 2 件 —— */
  await s.addWish({ name: '富士遮光罩', price: 290, note: '配 X100V' });
  await s.addWish({ name: '键盘键帽', price: 1000, note: '等打折' });

  /* —— 情绪 3 条 —— */
  await s.addMood({ feeling: '开心', text: '项目终于上线了', date: day(0), crushed: false, inHeart: true });
  await s.addMood({ feeling: '平静', text: '周末在家做饭，哪儿也没去', date: day(-1), crushed: false, inHeart: false });
  await s.addMood({ feeling: '后悔', text: '又买了不需要的东西', date: day(-2), crushed: true, inHeart: false });

  /* —— 时间切片 3 段（今日 2h）—— */
  await s.addTime({ durationMin: 80, tags: ['阅读'], meaning: 'gui', date: day(0), note: '《纳瓦尔宝典》' });
  await s.addTime({ durationMin: 40, tags: ['跑步'], meaning: 'xu', date: day(0), note: '江边 6 公里' });
  await s.addTime({ durationMin: 100, tags: ['写作'], meaning: 'gui', date: day(-1), note: '整理周报' });
}
