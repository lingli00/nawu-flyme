import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  Angry,
  Award,
  BadgePercent,
  BedDouble,
  BookOpen,
  Briefcase,
  CalendarClock,
  CloudRain,
  Dumbbell,
  Flame,
  Frown,
  Gamepad2,
  Gift,
  Hash,
  Heart,
  Hourglass,
  ImagePlus,
  Laugh,
  Link2,
  Meh,
  MoonStar,
  Plus,
  ShoppingBag,
  ShoppingCart,
  Smile,
  Snowflake,
  Sparkles,
  TrainFront,
  Trash2,
  TrendingDown,
  Users,
  Utensils,
  Wind,
  X,
  Zap,
} from 'lucide-react';
import { useDataStore, useUiStore, toastSuccess, toastError } from '../store';
import { useBackGuard } from '../lib/backGuard';
import { haptic } from '../lib/haptics';
import { addDays, today } from '../lib/date';
import { compressDataUrlUnder } from '../lib/imageCompress';
import IconPicker, { IconPreview } from './IconPicker';
import { Sheet } from './ui/Sheet';
import type { Cooldown, Judgement, TimeRec, WishItem } from '../types/entities';

/** ★v1.0.33：删除一律先确认（此前点一下就直删，误触无法挽回）。 */
async function confirmDelete(title: string, message = '删除后不可恢复。'): Promise<boolean> {
  void haptic('medium');
  return useUiStore.getState().confirm({ title, message });
}

/**
 * 生活流四张 sheet（v1.0.22 · M2：借鉴竞品信息结构，命名/文案/色系全部自有）。
 *
 * 纳物自有设计语言（与竞品蓝黑明确区分，贴墨绿纸调）：
 * - 心动清单    → 琥珀（暖沙）主视觉，CTA 墨色；
 * - 冲动冷冻    → 青瓷绿（冷静池同色系）；
 * - 情绪速写    → 归入心底 = 墨绿 Heart / 粉碎 = 陶土红；
 * - 时间切片    → 归/需/否 直接用三判定色（gui 绿 / xu 蓝 / fou 陶土）。
 * 图标铁律：全部 lucide 单色线性，无 emoji 装饰。
 */

/** ★v1.0.33 P0-4：本组专属色收敛为 index.css 语义 tint 令牌（不再写死十六进制）。 */
const TINT_WISH = 'var(--tint-warm)'; // 琥珀（心动清单）
const TINT_COOL = 'var(--tint-cool)'; // 青瓷（冷静池）
const TINT_MOOD = 'var(--gui)'; // 墨绿（归入心底）
const TINT_CRUSH = 'var(--tint-clay)'; // 陶土（粉碎）

/** 弹层骨架（v1.0.33 P1-10：改用显式 Sheet 组件，桌面自动转 30rem 右抽屉，
 *  不再依赖 index.css 全局 CSS hack；返回键守卫由 Sheet 统一负责）。 */
function SheetFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Sheet onClose={onClose} title={title}>
      {children}
    </Sheet>
  );
}

/** 通用小节标题（图标 + 文案，tint 着色）。 */
function SectionTitle({ Icon, text, tint }: { Icon: typeof Snowflake; text: string; tint: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
      <Icon size={14} style={{ color: tint }} />
      {text}
    </p>
  );
}

/** 多选/单选 chips（选中 = tint 14% 底 + tint 文字 + tint 边）。 */
function TintChip({
  selected,
  tint,
  onClick,
  children,
}: {
  selected: boolean;
  tint: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={() => {
        void haptic('select');
        onClick();
      }}
      className="flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-all active:scale-95"
      style={
        selected
          ? { borderColor: tint, background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, fontWeight: 500 }
          : { borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink-3)' }
      }
    >
      {children}
    </button>
  );
}

/* ============================================================================
 * 冷静期时间工具（天数 until / 小时级 untilAt 双轨）
 * ==========================================================================*/

/** 剩余整天数（负数 = 已到期；仅对天级冷静期有意义）。 */
export function cooldownLeftDays(until: string): number {
  const t = new Date(`${today()}T00:00:00`).getTime();
  const u = new Date(`${until}T00:00:00`).getTime();
  if (!Number.isFinite(u)) return 0;
  return Math.round((u - t) / 86400000);
}

/** 是否已到期（兼容小时级 untilAt）。 */
export function cooldownExpired(c: Cooldown): boolean {
  if (c.untilAt) return new Date(c.untilAt).getTime() <= Date.now();
  return cooldownLeftDays(c.until) <= 0;
}

/** 剩余时间文案：小时级「还剩 X 小时」，天级「还剩 X 天」。 */
export function cooldownLeftLabel(c: Cooldown): string {
  if (c.untilAt) {
    const ms = new Date(c.untilAt).getTime() - Date.now();
    if (ms <= 0) return '已到期';
    const h = Math.ceil(ms / 3600000);
    return h < 48 ? `还剩 ${h} 小时` : `还剩 ${Math.ceil(h / 24)} 天`;
  }
  const d = cooldownLeftDays(c.until);
  return d > 0 ? `还剩 ${d} 天` : '已到期';
}

/** 冲动冷冻的时长档位（3 小时/24 小时/3 天/7 天/30 天，小时级走 untilAt）。 */
const COOL_OPTIONS: Array<{ hours?: number; days?: number; label: string; sub: string }> = [
  { hours: 3, label: '3 小时', sub: '微上头' },
  { hours: 24, label: '24 小时', sub: '标准' },
  { days: 3, label: '3 天', sub: '大件慎重' },
  { days: 7, label: '7 天', sub: '长效' },
  { days: 30, label: '30 天', sub: '超长' },
];

function coolUntil(opt: (typeof COOL_OPTIONS)[number]): { until: string; hours?: number; untilAt?: string } {
  if (opt.hours != null) {
    return { until: today(), hours: opt.hours, untilAt: new Date(Date.now() + opt.hours * 3600000).toISOString() };
  }
  return { until: addDays(today(), opt.days ?? 7) };
}

/* ============================================================================
 * 心动清单（WishSheet · 链接/商品图/品名/价格/渠道/心动理由）
 * → 墨色 CTA「记下心动」；列表项支持转冷静池
 * ==========================================================================*/
const WISH_REASONS: Array<{ key: string; label: string; Icon: typeof Sparkles }> = [
  { key: '颜值高', label: '颜值高', Icon: Sparkles },
  { key: '刚需', label: '刚需', Icon: Zap },
  { key: '等降价', label: '等降价', Icon: TrendingDown },
  { key: '礼物', label: '礼物', Icon: Gift },
  { key: '热门', label: '热门', Icon: Flame },
  { key: '心动', label: '心动', Icon: Heart },
  { key: '炫耀', label: '炫耀', Icon: Award },
];

/** 内嵌商品图选择浮层（复用 IconPicker 网络图片 tab，选完即回）。 */
function ImagePickOverlay({
  value,
  onPick,
  onClose,
}: {
  value: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  useBackGuard(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end bg-black/40" onClick={onClose}>
      <div
        className="sheet-enter mx-auto max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 小把手：与全局 Sheet / 对话抽屉一致的底部弹层语言（v1.3.1） */}
        <div className="-mt-1 mb-2 flex justify-center">
          <span className="h-1 w-9 rounded-full bg-line-2" aria-hidden />
        </div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">商品图</p>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-ink-2 active:scale-95"
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <IconPicker
          value={value}
          onChange={(v) => {
            onPick(v);
            onClose();
          }}
          initialTab="img"
        />
      </div>
    </div>,
    document.body,
  );
}

/** 商品图大按钮（虚线框 + 预览），心动清单/冲动冷冻共用。 */
function ImagePickField({ value, onOpen, onClear }: { value: string; onOpen: () => void; onClear: () => void }) {
  if (value) {
    return (
      <div className="relative overflow-hidden rounded-card border border-line bg-surface-2">
        <div className="flex h-36 items-center justify-center">
          <IconPreview icon={value} size={120} />
        </div>
        <button
          onClick={onClear}
          aria-label="移除图片"
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white active:scale-95"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={onOpen}
      className="flex h-36 w-full flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-surface-2 text-ink-3 active:scale-[0.99]"
    >
      <ImagePlus size={30} strokeWidth={1.5} />
      <span className="text-xs">添加商品图</span>
    </button>
  );
}

export function WishSheet({ onClose }: { onClose: () => void }) {
  const wishes = useDataStore((s) => s.wishlist);
  const addWish = useDataStore((s) => s.addWish);
  const removeById = useDataStore((s) => s.removeById);
  const addCooldown = useDataStore((s) => s.addCooldown);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const channelRef = useRef<HTMLInputElement | null>(null);
  const [price, setPrice] = useState('');
  const [image, setImage] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [imgOpen, setImgOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const total = useMemo(() => wishes.reduce((acc, w) => acc + (w.price || 0), 0), [wishes]);

  const add = async (): Promise<void> => {
    const name = (nameRef.current?.value ?? '').trim();
    if (!name) {
      toastError('先写下想买什么');
      return;
    }
    const p = Number(price);
    setBusy(true);
    void haptic('medium');
    try {
      await addWish({
        name,
        price: Number.isFinite(p) && p > 0 ? p : undefined,
        url: (urlRef.current?.value ?? '').trim() || undefined,
        channel: (channelRef.current?.value ?? '').trim() || undefined,
        image: image || undefined,
        reasons: reasons.length ? reasons : undefined,
      });
      if (nameRef.current) nameRef.current.value = '';
      if (urlRef.current) urlRef.current.value = '';
      if (channelRef.current) channelRef.current.value = '';
      setPrice('');
      setImage('');
      setReasons([]);
      toastSuccess('已记下心动');
      // v1.0.28：保存成功后关闭弹层（明确反馈已记录，防重复添加）
      onClose();
    } finally {
      setBusy(false);
    }
  };

  /** 转冷静池：默认冷静 7 天。 */
  const toCooldown = async (w: WishItem): Promise<void> => {
    void haptic('select');
    await addCooldown({
      name: w.name,
      amount: w.price,
      ...coolUntil(COOL_OPTIONS[3]),
      image: w.image,
      url: w.url,
    });
    await removeById('wishlist', w.id);
    toastSuccess(`「${w.name}」进入 7 天冷静期`);
  };

  return (
    <SheetFrame title={`心动清单 (${wishes.length})`} onClose={onClose}>
      {/* —— 添加表单 —— */}
      <div className="mb-3 space-y-2.5 rounded-card border border-line bg-surface-2 p-3">
        <SectionTitle Icon={Link2} text="商品链接" tint={TINT_WISH} />
        <input
          ref={urlRef}
          defaultValue=""
          inputMode="url"
          placeholder="粘贴商品链接 淘宝、京东、拼多多…"
          className="h-10 w-full nw-input"
        />
        <ImagePickField
          value={image}
          onOpen={() => setImgOpen(true)}
          onClear={() => {
            setImage('');
            void haptic('select');
          }}
        />
        <SectionTitle Icon={ShoppingBag} text="品名" tint={TINT_WISH} />
        <input
          ref={nameRef}
          defaultValue=""
          placeholder="例如：Dyson 吹风机…"
          className="h-10 w-full nw-input"
        />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <SectionTitle Icon={Sparkles} text="价格" tint={TINT_WISH} />
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              placeholder="0.00"
              className="mt-1 h-10 w-full nw-input"
            />
          </div>
          <div>
            <SectionTitle Icon={ShoppingBag} text="渠道 / 备注" tint={TINT_WISH} />
            <input
              ref={channelRef}
              defaultValue=""
              placeholder="如：淘宝 / 京东"
              className="mt-1 h-10 w-full nw-input"
            />
          </div>
        </div>
        <SectionTitle Icon={Heart} text="心动理由（多选）" tint={TINT_WISH} />
        <div className="flex flex-wrap gap-1.5">
          {WISH_REASONS.map(({ key, label, Icon }) => (
            <TintChip
              key={key}
              tint={TINT_WISH}
              selected={reasons.includes(key)}
              onClick={() => setReasons((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))}
            >
              <Icon size={12} />
              {label}
            </TintChip>
          ))}
        </div>
        <button
          onClick={() => void add()}
          disabled={busy}
          className="h-11 w-full rounded-btn text-sm font-semibold text-white active:opacity-90 disabled:opacity-40"
          style={{ background: 'var(--ink)' }}
        >
          {busy ? '保存中…' : '记下心动'}
        </button>
      </div>

      {wishes.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-surface-2 p-8 text-center text-xs text-ink-3">
          清单空空的。心动的东西先记下来，过几天再看看还想不想要。
        </p>
      ) : (
        <>
          <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
            {wishes.map((w) => (
              <li key={w.id} className="flex items-center gap-3 px-3.5 py-3">
                {w.image ? (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2">
                    <IconPreview icon={w.image} size={36} />
                  </span>
                ) : (
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: `color-mix(in srgb, ${TINT_WISH} 14%, transparent)`, color: TINT_WISH }}
                  >
                    <ShoppingBag size={17} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{w.name}</p>
                  <p className="truncate text-[11px] text-ink-3">
                    {w.price ? `¥${w.price}` : '未定价'}
                    {w.channel ? ` · ${w.channel}` : w.note ? ` · ${w.note}` : ''}
                  </p>
                  {w.reasons?.length ? (
                    <p className="mt-0.5 flex flex-wrap gap-1">
                      {w.reasons.slice(0, 3).map((r) => (
                        <span
                          key={r}
                          className="rounded-full px-1.5 py-0.5 text-[11px]"
                          style={{
                            background: `color-mix(in srgb, ${TINT_WISH} 12%, transparent)`,
                            color: TINT_WISH,
                          }}
                        >
                          {r}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
                <button
                  onClick={() => void toCooldown(w)}
                  className="shrink-0 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-2 active:scale-95"
                >
                  转冷静池
                </button>
                <button
                  onClick={() =>
                    void (async () => {
                      if (!(await confirmDelete(`删除「${w.name}」？`))) return;
                      await removeById('wishlist', w.id);
                    })()
                  }
                  aria-label="删除"
                  className="shrink-0 text-ink-3 active:text-red-500"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
          {total > 0 ? (
            <p className="mt-2 px-1 text-[11px] text-ink-3">
              合计 ¥{total.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} —— 都是「想要」，不是「需要」
            </p>
          ) : null}
        </>
      )}
      <p className="mt-3 px-1 text-[11px] leading-4 text-ink-3/70">
        小贴士：心动的东西先放冷静期，到期还想要再买——冷静池里一键转成物品建档。
      </p>

      {imgOpen ? (
        <ImagePickOverlay
          value={image}
          onPick={async (v) => {
            // img: dataURL 可能偏大（备份瘦身铁律：进数据的图 ≤100KB）
            if (v.startsWith('img:')) {
              const slim = await compressDataUrlUnder(v);
              setImage(slim ?? v);
            } else {
              setImage(v);
            }
          }}
          onClose={() => setImgOpen(false)}
        />
      ) : null}
    </SheetFrame>
  );
}

/* ============================================================================
 * 购物冷静池（CooldownSheet · 管理 + 简捷添加）
 * ==========================================================================*/
const COOL_DAYS = [3, 7, 14, 30];

export function CooldownSheet({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const items = useDataStore((s) => s.cooldowns);
  const addCooldown = useDataStore((s) => s.addCooldown);
  const removeById = useDataStore((s) => s.removeById);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => [...items].sort((a, b) => a.until.localeCompare(b.until)), [items]);

  const add = async (): Promise<void> => {
    const name = (nameRef.current?.value ?? '').trim();
    if (!name) {
      toastError('先写下想买什么');
      return;
    }
    setBusy(true);
    void haptic('medium');
    try {
      await addCooldown({ name, ...coolUntil(COOL_OPTIONS.find((o) => o.days === days) ?? COOL_OPTIONS[3]) });
      if (nameRef.current) nameRef.current.value = '';
      toastSuccess(`已进入 ${days} 天冷静期`);
      // v1.0.28：保存成功后关闭弹层（明确反馈已记录，防重复添加）
      onClose();
    } finally {
      setBusy(false);
    }
  };

  /** 到期转物品：写预填 → 首页自动开新增表单。 */
  const toGoods = (c: Cooldown): void => {
    void haptic('select');
    try {
      sessionStorage.setItem('gf.prefill.goods', JSON.stringify({ name: c.name, price: c.amount }));
    } catch {
      /* 忽略 */
    }
    onClose();
    nav('/home');
  };

  return (
    <SheetFrame title={`购物冷静池 (${items.length})`} onClose={onClose}>
      {/* 添加行 */}
      <div className="mb-3 space-y-2 rounded-card border border-line bg-surface-2 p-3">
        <div className="flex gap-2">
          <input
            ref={nameRef}
            defaultValue=""
            placeholder="想买什么？先等等"
            className="h-10 min-w-0 flex-1 nw-input"
          />
          <button
            onClick={() => void add()}
            disabled={busy}
            className="flex h-10 shrink-0 items-center gap-1 rounded-btn px-4 text-sm font-medium text-white active:opacity-90 disabled:opacity-40"
            style={{ background: TINT_COOL }}
          >
            <Plus size={14} />
            开始冷静
          </button>
        </div>
        <div className="flex gap-1.5">
          {COOL_DAYS.map((d) => (
            <TintChip key={d} tint={TINT_COOL} selected={days === d} onClick={() => setDays(d)}>
              {d} 天
            </TintChip>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-surface-2 p-8 text-center text-xs text-ink-3">
          冷静池是空的。冲动消费前先把东西放进来，倒计时结束还想要再买。
        </p>
      ) : (
        <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
          {sorted.map((c) => {
            const expired = cooldownExpired(c);
            return (
              <li key={c.id} className="flex items-center gap-3 px-3.5 py-3">
                {c.image ? (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2">
                    <IconPreview icon={c.image} size={36} />
                  </span>
                ) : (
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: `color-mix(in srgb, ${TINT_COOL} 14%, transparent)`, color: TINT_COOL }}
                  >
                    <CalendarClock size={17} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{c.name}</p>
                  <p className="truncate text-[11px] text-ink-3">
                    {c.amount ? `¥${c.amount} · ` : ''}
                    {c.reason ? `${c.reason} · ` : ''}到 {c.until.slice(5)}
                  </p>
                </div>
                {!expired ? (
                  <span
                    className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium"
                    style={{
                      background: `color-mix(in srgb, ${TINT_COOL} 13%, transparent)`,
                      color: TINT_COOL,
                    }}
                  >
                    {cooldownLeftLabel(c)}
                  </span>
                ) : (
                  <button
                    onClick={() => toGoods(c)}
                    className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium text-white active:scale-95"
                    style={{ background: TINT_COOL }}
                  >
                    到期 · 转物品
                  </button>
                )}
                <button
                  onClick={() =>
                    void (async () => {
                      if (!(await confirmDelete(`删除冷静池里的「${c.name}」？`))) return;
                      await removeById('cooldowns', c.id);
                    })()
                  }
                  aria-label="删除"
                  className="shrink-0 text-ink-3 active:text-red-500"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </SheetFrame>
  );
}

/* ============================================================================
 * 冲动冷冻（QuickCooldownSheet · 记一笔「稍后」也走这里）
 * 链接 / 商品图 / 名称 / 金额 / 时长档位 / 冲动来源
 * ==========================================================================*/
const IMPULSE_REASONS: Array<{ key: string; Icon: typeof BadgePercent }> = [
  { key: '限时打折', Icon: BadgePercent },
  { key: '压力发泄', Icon: CloudRain },
  { key: '纯属跟风', Icon: Wind },
  { key: '深夜上头', Icon: MoonStar },
  { key: '凑单满减', Icon: ShoppingCart },
];

export function QuickCooldownSheet({ presetName, onClose }: { presetName?: string; onClose: () => void }) {
  const addCooldown = useDataStore((s) => s.addCooldown);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const [amount, setAmount] = useState('');
  const [optIdx, setOptIdx] = useState(1); // 默认 24 小时标准
  const [reason, setReason] = useState('');
  const [imgOpen, setImgOpen] = useState(false);
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);

  const opt = COOL_OPTIONS[optIdx];

  useEffect(() => {
    if (presetName && nameRef.current) nameRef.current.value = presetName;
  }, [presetName]);

  const confirm = async (): Promise<void> => {
    const n = (nameRef.current?.value ?? '').trim();
    if (!n) {
      toastError('先写下想买什么');
      return;
    }
    const a = Number(amount);
    setBusy(true);
    void haptic('medium');
    try {
      await addCooldown({
        name: n,
        amount: Number.isFinite(a) && a > 0 ? a : undefined,
        reason: reason || undefined,
        url: (urlRef.current?.value ?? '').trim() || undefined,
        image: image || undefined,
        ...coolUntil(opt),
      });
      toastSuccess(`已开启冷静（${opt.label}）`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetFrame title="冲动冷冻" onClose={onClose}>
      {/* 青瓷急救头 */}
      <div
        className="mb-3 flex items-center gap-2.5 rounded-card px-3.5 py-3"
        style={{ background: `color-mix(in srgb, ${TINT_COOL} 12%, transparent)` }}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: `color-mix(in srgb, ${TINT_COOL} 22%, transparent)`, color: TINT_COOL }}
        >
          <Snowflake size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">先把这笔消费冻起来</p>
          <p className="text-[11px] text-ink-3">让头脑降降温——到期还想要，再买也不迟</p>
        </div>
      </div>

      <div className="space-y-2.5 rounded-card border border-line bg-surface-2 p-3">
        <SectionTitle Icon={Link2} text="商品链接" tint={TINT_COOL} />
        <input
          ref={urlRef}
          defaultValue=""
          inputMode="url"
          placeholder="粘贴商品链接 京东、淘宝、拼多多…"
          className="h-10 w-full nw-input"
        />
        <ImagePickField
          value={image}
          onOpen={() => setImgOpen(true)}
          onClear={() => {
            setImage('');
            void haptic('select');
          }}
        />
        <SectionTitle Icon={ShoppingBag} text="商品名称" tint={TINT_COOL} />
        <input
          ref={nameRef}
          defaultValue={presetName ?? ''}
          placeholder="例如：Switch 游戏机…"
          className="h-10 w-full nw-input"
        />
        <SectionTitle Icon={Sparkles} text="金额" tint={TINT_COOL} />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          placeholder="0.00（选填，转物品时自动带上）"
          className="h-10 w-full nw-input"
        />
        <SectionTitle Icon={Snowflake} text="需要冷静多久？" tint={TINT_COOL} />
        <div className="grid grid-cols-3 gap-1.5">
          {COOL_OPTIONS.map((o, i) => (
            <button
              key={o.label}
              onClick={() => {
                void haptic('select');
                setOptIdx(i);
              }}
              className="flex flex-col items-center gap-0.5 rounded-btn border py-2 transition-all active:scale-95"
              style={
                optIdx === i
                  ? { borderColor: TINT_COOL, background: `color-mix(in srgb, ${TINT_COOL} 14%, transparent)` }
                  : { borderColor: 'var(--line)', background: 'var(--surface)' }
              }
            >
              <span
                className="text-xs font-semibold"
                style={optIdx === i ? { color: TINT_COOL } : { color: 'var(--ink-2)' }}
              >
                {o.label}
              </span>
              <span className="text-[11px] text-ink-3">{o.sub}</span>
            </button>
          ))}
        </div>
        <SectionTitle Icon={Flame} text="冲动来源" tint={TINT_COOL} />
        <div className="flex flex-wrap gap-1.5">
          {IMPULSE_REASONS.map(({ key, Icon }) => (
            <TintChip key={key} tint={TINT_COOL} selected={reason === key} onClick={() => setReason(reason === key ? '' : key)}>
              <Icon size={12} />
              {key}
            </TintChip>
          ))}
        </div>
        <button
          onClick={() => void confirm()}
          disabled={busy}
          className="h-11 w-full rounded-btn text-sm font-semibold text-white active:opacity-90 disabled:opacity-40"
          style={{ background: TINT_COOL }}
        >
          {busy ? '保存中…' : `开启冷静（${opt.label}）`}
        </button>
        <p className="text-center text-[11px] text-ink-3">这笔不记支出 —— 冻一冻，到期还想要，再去买也不迟</p>
      </div>

      {imgOpen ? (
        <ImagePickOverlay
          value={image}
          onPick={async (v) => {
            if (v.startsWith('img:')) {
              const slim = await compressDataUrlUnder(v);
              setImage(slim ?? v);
            } else {
              setImage(v);
            }
          }}
          onClose={() => setImgOpen(false)}
        />
      ) : null}
    </SheetFrame>
  );
}

/* ============================================================================
 * 情绪速写（MoodSheet · 想法 + 五档表情 + 粉碎/归入心底）
 * → moods 集合落库
 * ==========================================================================*/
/** ★v1.0.33 P0-4：五档表情色同样收敛到语义令牌（暖=琥珀/墨绿/中性/需蓝/陶土）。 */
const MOOD_FACES: Array<{ label: string; Icon: typeof Smile; tint: string }> = [
  { label: '畅快', Icon: Laugh, tint: 'var(--tint-warm)' },
  { label: '开心', Icon: Smile, tint: 'var(--gui)' },
  { label: '平静', Icon: Meh, tint: 'var(--ink-3)' },
  { label: '低落', Icon: Frown, tint: 'var(--xu)' },
  { label: '烦躁', Icon: Angry, tint: 'var(--tint-clay)' },
];

export function MoodSheet({ onClose }: { onClose: () => void }) {
  const moods = useDataStore((s) => s.moods);
  const addMood = useDataStore((s) => s.addMood);
  const removeById = useDataStore((s) => s.removeById);

  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [faceIdx, setFaceIdx] = useState(2); // 默认「平静」
  const [busy, setBusy] = useState(false);

  const face = MOOD_FACES[faceIdx];

  const save = async (mode: 'crush' | 'heart'): Promise<void> => {
    const text = (textRef.current?.value ?? '').trim();
    if (!text && mode === 'heart') {
      toastError('写下此刻的想法');
      return;
    }
    setBusy(true);
    void haptic('medium');
    try {
      await addMood({
        feeling: face.label,
        text: text || `（无文字 · ${face.label}）`,
        crushed: mode === 'crush',
        inHeart: mode === 'heart',
        date: today(),
      });
      if (textRef.current) textRef.current.value = '';
      toastSuccess(mode === 'crush' ? '已粉碎，翻篇' : '已归入心底');
      // v1.0.28：保存成功后关闭弹层（明确反馈已记录，防重复添加）
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetFrame title="情绪 · 思维" onClose={onClose}>
      <div className="rounded-card border border-line bg-surface-2 p-3">
        <p className="text-center text-sm font-semibold">此刻，心情如何？</p>
        <textarea
          ref={textRef}
          rows={3}
          placeholder="记录下这个瞬间的情绪…"
          className="mt-2 w-full resize-none rounded-btn border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {/* 五档表情（lucide 脸，非 emoji） */}
        <div className="mt-2 flex items-center justify-between px-1">
          {MOOD_FACES.map((f, i) => (
            <button
              key={f.label}
              onClick={() => {
                void haptic('select');
                setFaceIdx(i);
              }}
              aria-label={f.label}
              className="flex h-11 w-11 items-center justify-center rounded-full transition-all active:scale-90"
              style={{
                background: faceIdx === i ? `color-mix(in srgb, ${f.tint} 16%, transparent)` : 'transparent',
                transform: faceIdx === i ? 'scale(1.18)' : undefined,
              }}
            >
              <f.Icon size={faceIdx === i ? 26 : 22} style={{ color: faceIdx === i ? f.tint : 'var(--ink-3)' }} strokeWidth={1.8} />
            </button>
          ))}
        </div>
        <p className="mt-1 text-center text-[11px] text-ink-3">{face.label}</p>
        {/* 双钮：粉碎（否）/ 归入心底 */}
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => void save('crush')}
            disabled={busy}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-surface text-sm font-medium text-ink-2 active:scale-[0.98] disabled:opacity-40"
            style={{ color: TINT_CRUSH, borderColor: `color-mix(in srgb, ${TINT_CRUSH} 35%, transparent)` }}
          >
            <Trash2 size={14} />
            粉碎（否）
          </button>
          <button
            onClick={() => void save('heart')}
            disabled={busy}
            className="flex h-11 flex-[1.4] items-center justify-center gap-1.5 rounded-btn text-sm font-semibold text-white active:scale-[0.98] disabled:opacity-40"
            style={{ background: TINT_MOOD }}
          >
            <Heart size={14} />
            归入心底
          </button>
        </div>
      </div>

      {moods.length > 0 ? (
        <>
          <p className="mb-1.5 mt-3 px-1 text-xs font-medium text-ink-2">最近的心情 · {moods.length} 条</p>
          <ul className="space-y-1.5">
            {moods.slice(0, 5).map((m) => {
              const f = MOOD_FACES.find((x) => x.label === m.feeling) ?? MOOD_FACES[2];
              return (
                <li key={m.id} className="flex items-start gap-2.5 rounded-btn border border-line bg-surface px-3 py-2">
                  <f.Icon size={16} style={{ color: f.tint }} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-ink-3">
                      {m.feeling} · {m.date.slice(5)}
                      {m.crushed ? <span className="ml-1.5" style={{ color: TINT_CRUSH }}>粉碎</span> : null}
                    </p>
                    <p className="mt-0.5 text-sm leading-5">{m.text}</p>
                  </div>
                  <button
                    onClick={() =>
                      void (async () => {
                        if (!(await confirmDelete('删除这条心情记录？'))) return;
                        await removeById('moods', m.id);
                      })()
                    }
                    aria-label="删除"
                    className="mt-1 shrink-0 text-ink-3 active:scale-95"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </SheetFrame>
  );
}

/* ============================================================================
 * 时间切片（TimeSheet · 弧形拨盘选分钟 + 归需否 + Tag）
 * 分钟拨盘（拖拽弧形表盘 + 快捷档）→ 归/需/否 → Tag（+自定义）→ 记录切片
 * ==========================================================================*/

/** 弧形拨盘：5–240 分钟，拖拽弧上把手（快慢随意，快捷 chips 兜底）。 */
function ArcDial({ value, onChange, max = 240 }: { value: number; onChange: (v: number) => void; max?: number }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const START = -210;
  const END = 30;
  const R = 78;
  const CX = 110;
  const CY = 104;
  const pt = (deg: number): [number, number] => [
    CX + R * Math.cos((deg * Math.PI) / 180),
    CY + R * Math.sin((deg * Math.PI) / 180),
  ];
  const frac = Math.min(value / max, 1);
  const ang = START + (END - START) * frac;
  const [sx, sy] = pt(START);
  const [hx, hy] = pt(ang);
  const [tx, ty] = pt(END);
  const largeArc = (deg: number): number => (deg - START > 180 ? 1 : 0);

  /** 指针位置 → 分钟（把任意角度钳回弧区间）。 */
  const fromPointer = (clientX: number, clientY: number): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = ((clientX - rect.left) / rect.width) * 220;
    const my = ((clientY - rect.top) / rect.height) * 208;
    let deg = (Math.atan2(my - CY, mx - CX) * 180) / Math.PI;
    if (deg > 30) deg = deg > 90 ? -210 : 30; // 底部缺口钳回两端
    const f = Math.min(Math.max((deg - START) / (END - START), 0), 1);
    const v = Math.max(Math.round((f * max) / 5) * 5, 5);
    onChange(v);
  };

  return (
    <div className="flex flex-col items-center">
      <svg
        ref={ref}
        viewBox="0 0 220 208"
        className="w-56 touch-none select-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons > 0) fromPointer(e.clientX, e.clientY);
        }}
      >
        <path d={`M ${sx} ${sy} A ${R} ${R} 0 1 1 ${tx} ${ty}`} fill="none" stroke="var(--line-2)" strokeWidth={13} strokeLinecap="round" />
        <path
          d={`M ${sx} ${sy} A ${R} ${R} 0 ${largeArc(ang)} 1 ${hx} ${hy}`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={13}
          strokeLinecap="round"
        />
        <circle cx={hx} cy={hy} r={11} fill="var(--surface)" stroke="var(--accent)" strokeWidth={3} />
        <text x={CX} y={CY - 6} textAnchor="middle" className="fill-ink" style={{ fontSize: 40, fontWeight: 700 }}>
          {value}
        </text>
        <text x={CX} y={CY + 20} textAnchor="middle" style={{ fontSize: 13, fill: 'var(--ink-3)' }}>
          min
        </text>
      </svg>
    </div>
  );
}

const TIME_TAGS: Array<{ key: string; Icon: typeof Briefcase }> = [
  { key: '工作', Icon: Briefcase },
  { key: '游戏', Icon: Gamepad2 },
  { key: '阅读', Icon: BookOpen },
  { key: '通勤', Icon: TrainFront },
  { key: '吃饭', Icon: Utensils },
  { key: '睡觉', Icon: BedDouble },
  { key: '运动', Icon: Dumbbell },
  { key: '陪伴', Icon: Users },
];

const TIME_QUICK = [15, 30, 45, 60, 120];
const TIME_MEANING: Record<Judgement, { label: string; sub: string; color: string }> = {
  gui: { label: '归', sub: '投资/成长', color: 'var(--gui)' },
  xu: { label: '需', sub: '生存/休息', color: 'var(--xu)' },
  fou: { label: '否', sub: '虚度/消耗', color: 'var(--fou)' },
};

export function TimeSheet({ onClose }: { onClose: () => void }) {
  const times = useDataStore((s) => s.times);
  const addTime = useDataStore((s) => s.addTime);
  const removeById = useDataStore((s) => s.removeById);

  const noteRef = useRef<HTMLInputElement | null>(null);
  const [minutes, setMinutes] = useState(45);
  const [tags, setTags] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [meaning, setMeaning] = useState<Judgement>('gui');
  const [busy, setBusy] = useState(false);

  const totalMin = useMemo(() => times.reduce((a, t) => a + (t.durationMin || 0), 0), [times]);

  const save = async (): Promise<void> => {
    setBusy(true);
    void haptic('medium');
    try {
      await addTime({
        durationMin: minutes,
        tags,
        meaning,
        note: (noteRef.current?.value ?? '').trim() || undefined,
        date: today(),
      });
      setTags([]);
      setCustom('');
      if (noteRef.current) noteRef.current.value = '';
      toastSuccess(`已记下 ${minutes} 分钟`);
      // v1.0.28：保存成功后关闭弹层（明确反馈已记录，防重复添加）
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetFrame title="时间切片" onClose={onClose}>
      {totalMin > 0 ? (
        <p className="mb-2 rounded-btn bg-surface-2 px-3 py-2 text-xs text-ink-3">
          累计 <b className="text-ink-2">{(totalMin / 60).toFixed(1)} 小时</b> · {times.length} 段时光
        </p>
      ) : null}

      <div className="rounded-card border border-line bg-surface-2 p-3">
        <SectionTitle Icon={Hourglass} text="刚才做了什么？" tint="var(--accent)" />
        <div className="mt-1">
          <ArcDial value={minutes} onChange={setMinutes} />
        </div>
        <div className="mt-1 flex justify-center gap-1.5">
          {TIME_QUICK.map((q) => (
            <TintChip key={q} tint="var(--accent)" selected={minutes === q} onClick={() => setMinutes(q)}>
              {q}′
            </TintChip>
          ))}
        </div>

        {/* 归 / 需 / 否（三判定色） */}
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {(['gui', 'xu', 'fou'] as const).map((j) => {
            const m = TIME_MEANING[j];
            const on = meaning === j;
            return (
              <button
                key={j}
                onClick={() => {
                  void haptic('select');
                  setMeaning(j);
                }}
                className="flex flex-col items-center gap-0.5 rounded-btn border py-2.5 transition-all active:scale-95"
                style={
                  on
                    ? { borderColor: m.color, background: `color-mix(in srgb, ${m.color} 12%, transparent)` }
                    : { borderColor: 'var(--line)', background: 'var(--surface)' }
                }
              >
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
                  <span className="text-sm font-semibold" style={{ color: on ? m.color : 'var(--ink-2)' }}>
                    {m.label}
                  </span>
                </span>
                <span className="text-[11px] text-ink-3">{m.sub}</span>
              </button>
            );
          })}
        </div>

        {/* Tag（+自定义） */}
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <SectionTitle Icon={Hash} text="做了什么（Tag）" tint="var(--accent)" />
            <span className="text-[11px] text-ink-3">可多选</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TIME_TAGS.map(({ key, Icon }) => (
              <TintChip
                key={key}
                tint="var(--accent)"
                selected={tags.includes(key)}
                onClick={() => setTags((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))}
              >
                <Icon size={12} />
                {key}
              </TintChip>
            ))}
            {custom.trim() ? (
              <TintChip tint="var(--accent)" selected={tags.includes(custom.trim())} onClick={() => {
                const c = custom.trim();
                setTags((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
              }}>
                <Hash size={12} />
                {custom.trim()}
              </TintChip>
            ) : null}
          </div>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="+ 自定义标签（回车外直接点上面生成）"
            className="mt-2 h-9 w-full rounded-btn border border-line bg-surface px-3 text-xs outline-none focus:border-accent"
          />
        </div>

        <input
          ref={noteRef}
          defaultValue=""
          placeholder="备注（选填）"
          className="mt-2 h-10 w-full nw-input"
        />

        <button
          onClick={() => void save()}
          disabled={busy}
          className="mt-2.5 h-11 w-full rounded-btn text-sm font-semibold text-ink active:scale-[0.99] disabled:opacity-40"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
        >
          {busy ? '保存中…' : `记录切片（${minutes} 分钟）`}
        </button>
      </div>

      {times.length > 0 ? (
        <>
          <p className="mb-1.5 mt-3 px-1 text-xs font-medium text-ink-2">最近的切片</p>
          <ul className="space-y-1.5">
            {times.slice(0, 5).map((t: TimeRec) => {
              const m = TIME_MEANING[t.meaning] ?? TIME_MEANING.xu;
              return (
                <li key={t.id} className="flex items-center gap-2.5 rounded-btn border border-line bg-surface px-3 py-2">
                  <span
                    className="flex h-9 w-14 shrink-0 items-center justify-center rounded-btn text-xs font-semibold"
                    style={{ background: `color-mix(in srgb, ${m.color} 12%, transparent)`, color: m.color }}
                  >
                    {t.durationMin}′
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-ink-3">
                      {m.label} · {t.date.slice(5)}
                      {t.tags?.length ? ` · ${t.tags.join('、')}` : ''}
                    </p>
                    {t.note ? <p className="truncate text-xs text-ink-2">{t.note}</p> : null}
                  </div>
                  <button
                    onClick={() =>
                      void (async () => {
                        if (!(await confirmDelete('删除这段专注记录？'))) return;
                        await removeById('times', t.id);
                      })()
                    }
                    aria-label="删除"
                    className="shrink-0 text-ink-3 active:scale-95"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </SheetFrame>
  );
}
