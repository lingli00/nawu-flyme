import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2 } from 'lucide-react';
import { useDataStore, useSettingsStore, toastSuccess, toastError } from '../store';
import PageShell from '../components/layout/PageShell';
import GoodsPhoto from '../components/GoodsPhoto';
import { haptic } from '../lib/haptics';
import { formatMoney } from '../lib/money';
import { shareOrDownload, drawGoodsCard, drawWallSheet } from '../lib/shareCard';
import { getCategoryIcon } from '../lib/categoryIcons';
import { holdDays } from '../domain/goods';
import type { Goods } from '../types/entities';

/**
 * 置物墙（v1.0.10；★v1.6.2 整体重构）。
 *
 * 定位：在役物品的**视觉墙**。三条硬约束（用户原话）：
 * 1. **数据不重复录入** —— 直接读 `useDataStore().goods`，图片走 `GoodsPhoto`
 *    （同一个 `goods.image`，与首页列表 / 详情页完全同源）；
 * 2. **图片是主体，文字默认藏起来** —— 鼠标悬浮（桌面）或轻点（手机）才浮出
 *    名称与花费；导出分享时文字再完整出现（见 lib/shareCard.ts）；
 * 3. **网格不再细长畸形** —— 旧版用断点列数（`dt:grid-cols-4`），但置物墙在电脑端
 *    是 32rem 宽的抽屉，视口 1440 也照样套 4~5 列 → 每格不到 120px 却要竖排名称+价格，
 *    卡片被压成细长条。现在改成 **容器自适应** 的 `auto-fill` 网格（不依赖视口断点），
 *    抽屉里 3 列、手机上 2 列、极窄屏 1 列，格子统一 4:5 比例 + cover 裁切。
 */

/** 单格：图片铺满，文字仅在悬浮/轻点时浮出（默认不占版面）。 */
function WallTile({
  g,
  symbol,
  categoryName,
  shown,
  onToggle,
  onShare,
  fallback,
}: {
  g: Goods;
  symbol: string;
  categoryName: string | null;
  shown: boolean;
  onToggle: () => void;
  onShare: () => void;
  fallback: JSX.Element;
}): JSX.Element {
  const days = holdDays(g);
  const price = `${symbol}${Number(g.price ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  const label = `${g.name || '未命名物品'} · ${price} · 陪伴 ${days} 天`;
  return (
    <li className="group relative">
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        onClick={() => {
          void haptic('select');
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="relative block aspect-[4/5] w-full cursor-pointer overflow-hidden rounded-2xl bg-surface-2 outline-none ring-accent transition-transform focus-visible:ring-2 active:scale-[0.985]"
      >
        <GoodsPhoto g={g} alt={g.name} fallback={fallback} />

        {/* 悬浮层：渐变只压在图片底部，不额外占高度；默认透明，悬浮/轻点才出来。
            ⚠️ 透明度只能用 5 的倍数（默认 opacity scale）：写成 from-black/78 这类
            非 scale 值 Tailwind **不会报错但整条规则不生成**，遮罩层会静默消失。 */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-2.5 pb-2 pt-10 transition-opacity duration-200 ${
            shown ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <p className="truncate text-[12px] font-semibold leading-4 text-white">{g.name || '未命名物品'}</p>
          <p className="tnum mt-0.5 truncate text-[11px] leading-4 text-white/80">
            {price} · 陪伴 {days} 天
            {categoryName ? ` · ${categoryName}` : ''}
          </p>
        </div>

        {/* 单件分享：随悬浮层一起出现，不占常驻版面 */}
        <button
          type="button"
          aria-label={`分享 ${g.name || '物品'} 的卡片`}
          onClick={(e) => {
            e.stopPropagation();
            void haptic('select');
            onShare();
          }}
          className={`absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-opacity duration-200 active:scale-90 ${
            shown ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <Share2 size={14} strokeWidth={1.9} aria-hidden />
        </button>
      </div>
    </li>
  );
}

export default function WallPage(): JSX.Element {
  const nav = useNavigate();
  const goods = useDataStore((s) => s.goods);
  const categories = useDataStore((s) => s.categories);
  const currency = useSettingsStore((s) => s.settings.currency);
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '¥';
  /** 整墙海报生成中（防连点）。 */
  const [wallBusy, setWallBusy] = useState(false);
  /** 手机端没有 hover：轻点一次浮出文字（再点收起）。 */
  const [infoId, setInfoId] = useState<string | null>(null);

  const active = useMemo(() => goods.filter((g) => g.status !== 'retired'), [goods]);
  const catNameOf = (id: string): string | null => categories.find((c) => c.id === id)?.name ?? null;

  const share = async (g: Goods): Promise<void> => {
    try {
      const dataUrl = await drawGoodsCard(g, catNameOf(g.categoryId));
      const how = await shareOrDownload(dataUrl, `纳物-${g.name || '物品'}.jpg`);
      if (how === 'saved') toastSuccess('已保存到系统相册「纳物」');
      else if (how === 'downloaded') toastSuccess('海报已下载');
    } catch (e) {
      toastError(e instanceof Error ? e.message : '生成海报失败');
    }
  };

  /** 分享全部物品：一张大图导出整面墙。 */
  const shareAll = async (): Promise<void> => {
    if (wallBusy || active.length === 0) return;
    setWallBusy(true);
    try {
      const dataUrl = await drawWallSheet(active.map((g) => ({ g, categoryName: catNameOf(g.categoryId) })));
      const how = await shareOrDownload(dataUrl, '纳物-置物墙.jpg');
      toastSuccess(how === 'shared' ? '已分享' : how === 'saved' ? '已保存到系统相册「纳物」' : '长图已下载');
    } catch (e) {
      toastError(e instanceof Error ? e.message : '生成整墙海报失败');
    } finally {
      setWallBusy(false);
    }
  };

  return (
    <PageShell
      title="置物墙"
      subtitle={`${active.length} 件在役 · 总投入 ${formatMoney(
        active.reduce((acc, g) => acc + Number(g.price ?? 0), 0),
        currency,
      )}`}
      right={
        <>
          <button
            onClick={() => {
              void haptic('select');
              void shareAll();
            }}
            disabled={wallBusy}
            className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-xs text-ink-2 active:bg-surface-2 disabled:opacity-50"
          >
            <Share2 size={13} strokeWidth={1.8} aria-hidden />
            {wallBusy ? '生成中…' : '分享全部'}
          </button>
          <button
            onClick={() => {
              void haptic('select');
              nav('/home');
            }}
            className="ml-2 h-9 rounded-full border border-line bg-surface px-3.5 text-xs text-ink-2 active:bg-surface-2"
          >
            去添置
          </button>
        </>
      }
    >
      <div className="page-enter">
        {active.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-surface p-10 text-center text-sm text-ink-3">
            墙上还空着，先去首页入库第一件物品
          </div>
        ) : (
          <>
            {/* ★容器自适应列：不跟视口断点走 —— 抽屉 512px / 手机 375px / 平板 768px
                各自算出合适列数，格子恒定 4:5，不再出现细长条 */}
            <ul
              className="grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 128px), 1fr))' }}
            >
              {active.map((g) => {
                const CatIcon = getCategoryIcon(categories.find((c) => c.id === g.categoryId)?.icon);
                return (
                  <WallTile
                    key={g.id}
                    g={g}
                    symbol={symbol}
                    categoryName={catNameOf(g.categoryId)}
                    shown={infoId === g.id}
                    onToggle={() => setInfoId((cur) => (cur === g.id ? null : g.id))}
                    onShare={() => void share(g)}
                    fallback={
                      <span className="flex h-full w-full items-center justify-center">
                        <CatIcon size={40} className="text-ink-3/70" aria-hidden />
                      </span>
                    }
                  />
                );
              })}
            </ul>
            <p className="mt-3 text-center text-[11px] leading-5 text-ink-3">
              轻点图片查看名称与花费 · 「分享全部」导出时文字会完整出现
            </p>
          </>
        )}
      </div>
    </PageShell>
  );
}
