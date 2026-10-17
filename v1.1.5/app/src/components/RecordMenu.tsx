import { createPortal } from 'react-dom';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Compass,
  CreditCard,
  Heart,
  Hourglass,
  NotebookPen,
  PenLine,
  Snowflake,
  Sparkles,
  Sprout,
} from 'lucide-react';
import { useBackGuard } from '../lib/backGuard';
import { haptic } from '../lib/haptics';
import { useMediaQuery } from '../lib/useMediaQuery';
import type { SheetKey } from '../lib/sheetBus';
import QuickSheetHost from './QuickSheets';

/**
 * 加号动作菜单（v1.0.22 起 · 文案与视觉全部自有语言）。
 *
 * 结构：2×2 记录卡（AI 记一笔 / 价值记账 / 手动录入 / 新增订阅）
 *      + 2×2 生活流入口（购物冷静 / 心动清单 / 时间切片 / 情绪速写）+ 取消。
 *
 * ★ v1.0.28 就地弹层：六类弹层不再跨路由跳转——在哪个页面点加号，
 * 弹层就地出现在哪个页面（QuickSheetHost），关闭后仍停留在原页面。
 * 实现：组件保持挂载，点卡片后切到「弹层模式」（菜单面板换成 QuickSheetHost），
 * 弹层关闭时先撤弹层占位历史，再延迟一拍关闭菜单（见 closeAll 注释）。
 * 「AI 记一笔 / 价值记账」是页面导航，仍走路由跳转。
 *
 * PC 适配：≥1024px 居中对话框（pop-enter），移动端底部 sheet（sheet-enter）。
 */

/**
 * ★v1.0.33 P0-4：tint 全部收敛到 index.css 语义令牌（--tint-warm/cool/clay/violet + 归需否三色），
 * 不再写死十六进制 —— 原 8 张卡 8 种色相稀释品牌的问题由此修复，深色模式自动适配。
 */
const TINT = {
  ai: 'var(--accent)', // 墨绿（品牌主色）
  ledger: 'var(--xu)', // 需蓝（归需否价值语言）
  manual: 'var(--tint-violet)', // 紫（手动录入）
  sub: 'var(--tint-warm)', // 琥珀（订阅提醒）
  cool: 'var(--tint-cool)', // 青瓷（冷静池）
  wish: 'var(--tint-warm)', // 琥珀（心动清单）
  time: 'var(--accent)', // 墨绿（与时间拨盘同色系）
  mood: 'var(--tint-clay)', // 陶土（情绪速写）
};

/** 旧跨路由方案的 sessionStorage 标志名（v1.0.28 起只做清理，不再写入）。 */
const SHEET_FLAG: Record<SheetKey, string> = {
  goods: 'gf.open.goods',
  sub: 'gf.open.sub',
  wish: 'gf.open.wish',
  cooldown: 'gf.open.cooldown',
  mood: 'gf.open.mood',
  time: 'gf.open.time',
};

function clearFlag(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

export default function RecordMenu({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const wide = useMediaQuery('(min-width: 1024px)');
  useBackGuard(true, onClose);
  /* v1.0.28 就地弹层：非 null 时菜单面板换成对应弹层；leaving 时整层静默等卸载。 */
  const [sheet, setSheet] = useState<SheetKey | null>(null);
  const [leaving, setLeaving] = useState(false);

  /**
   * 弹层关闭（保存成功 / 点遮罩 / 返回键）→ 关弹层 + 关菜单。
   * 延迟一拍：让弹层 backGuard cleanup 的 history.back() 先落地，
   * 菜单卸载撤占位时的 length 判定才准确（否则菜单占位历史残留，
   * 用户之后按返回会感觉「要多按一次」）。
   */
  const closeAll = (): void => {
    if (leaving) return;
    setSheet(null);
    setLeaving(true);
    setTimeout(onClose, 60);
  };

  /** 六类弹层全部就地打开（任意页面），不再跳路由。 */
  const openSheet = (key: SheetKey): void => {
    clearFlag(SHEET_FLAG[key]);
    setSheet(key);
  };

  /** 页面跳转类入口（AI 记一笔 / 价值记账）：关菜单 + 导航。
   *  就地弹层类入口（手动录入 / 新增订阅 / 生活流四键）：不关菜单，切到弹层模式。 */
  const go = (fn: () => void): void => {
    void haptic('select');
    onClose();
    fn();
  };
  const pick = (fn: () => void): void => {
    void haptic('select');
    fn();
  };

  const cards: Array<{ label: string; sub: string; Icon: typeof Sparkles; tint: string; run: () => void; inPlace: boolean }> = [
    { label: 'AI 记一笔', sub: '说一句话 / 贴图自动归档', Icon: Sparkles, tint: TINT.ai, run: () => nav('/ai'), inPlace: false },
    { label: '价值记账', sub: '消费 / 归需否判断', Icon: NotebookPen, tint: TINT.ledger, run: () => nav('/record'), inPlace: false },
    {
      label: '手动录入',
      sub: '搜索 / 填写',
      Icon: PenLine,
      tint: TINT.manual,
      run: () => openSheet('goods'),
      inPlace: true,
    },
    {
      label: '新增订阅',
      sub: '周期 / 续费',
      Icon: CreditCard,
      tint: TINT.sub,
      run: () => openSheet('sub'),
      inPlace: true,
    },
  ];

  const rows: Array<{ label: string; sub: string; Icon: typeof Compass; tint: string; key: SheetKey }> = [
    { label: '购物冷静', sub: '放入冷静池', Icon: Snowflake, tint: TINT.cool, key: 'cooldown' },
    { label: '心动清单', sub: '先记下，再斟酌', Icon: Sprout, tint: TINT.wish, key: 'wish' },
    { label: '时间切片', sub: '记录刚才做了啥', Icon: Hourglass, tint: TINT.time, key: 'time' },
    { label: '情绪速写', sub: '记录心灵灵感', Icon: Heart, tint: TINT.mood, key: 'mood' },
  ];

  const panel = (
    <>
      <p className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }}
        >
          <Compass size={15} strokeWidth={2} />
        </span>
        记一笔，归一类
      </p>

      {/* 2×2 记录卡 */}
      <div className="grid grid-cols-2 gap-2.5">
        {cards.map(({ label, sub, Icon, tint, run, inPlace }) => (
          <button
            key={label}
            onClick={() => (inPlace ? pick(run) : go(run))}
            className="rounded-card border border-line p-3.5 text-left transition-all active:scale-[0.98]"
            style={{ background: `color-mix(in srgb, ${tint} 8%, var(--surface))` }}
          >
            <span
              className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: `color-mix(in srgb, ${tint} 18%, transparent)`, color: tint }}
            >
              <Icon size={17} />
            </span>
            <p className="text-sm font-semibold">{label}</p>
            <p className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</p>
          </button>
        ))}
      </div>

      <div className="my-3 border-t border-line-2" />

      {/* 生活流 2×2 入口（tint 小卡，非列表行） */}
      <div className="grid grid-cols-2 gap-2.5">
        {rows.map(({ label, sub, Icon, tint, key }) => (
          <button
            key={label}
            onClick={() => pick(() => openSheet(key))}
            className="flex items-center gap-2.5 rounded-card border px-3 py-2.5 text-left transition-all active:scale-[0.98]"
            style={{
              borderColor: `color-mix(in srgb, ${tint} 28%, transparent)`,
              background: `color-mix(in srgb, ${tint} 10%, var(--surface))`,
            }}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ background: `color-mix(in srgb, ${tint} 18%, transparent)`, color: tint }}
            >
              <Icon size={16} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{label}</span>
              <span className="block truncate text-[11px] text-ink-3">{sub}</span>
            </span>
          </button>
        ))}
      </div>

      <button
        onClick={onClose}
        className="mt-4 h-11 w-full rounded-btn border border-line bg-surface-2 text-sm font-medium text-ink-2 active:scale-[0.99]"
      >
        取消
      </button>
    </>
  );

  /* —— v1.0.28 弹层模式：菜单面板换成对应弹层（组件保持挂载，菜单守卫占位仍在栈底）—— */
  if (sheet && !leaving) {
    return <QuickSheetHost sheetKey={sheet} onClose={closeAll} />;
  }
  /* 弹层已关、菜单即将卸载：渲染空，避免菜单面板闪现一帧。 */
  if (leaving) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex bg-black/40" onClick={onClose} style={wide ? { alignItems: 'center', justifyContent: 'center' } : { alignItems: 'flex-end' }}>
      <div
        className={
          wide
            ? 'pop-enter mx-auto max-h-[86vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-5'
            : 'sheet-enter mx-auto max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)]'
        }
        onClick={(e) => e.stopPropagation()}
      >
        {panel}
      </div>
    </div>,
    document.body,
  );
}
