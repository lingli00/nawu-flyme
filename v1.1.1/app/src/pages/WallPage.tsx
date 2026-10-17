import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2 } from 'lucide-react';
import { useDataStore, useSettingsStore, toastSuccess, toastError } from '../store';
import PageShell from '../components/layout/PageShell';
import { haptic } from '../lib/haptics';
import { IconPreview } from '../components/IconPicker';
import { formatMoney } from '../lib/money';
import { goodsIconValue, shareOrDownload, drawGoodsCard, drawWallSheet } from '../lib/shareCard';
import type { Goods } from '../types/entities';

/**
 * 置物墙（v1.0.10）：在役物品的展示墙——纯展示页，可从「我的」进入，
 * 桌面端多列大卡、移动端三列。物品卡可单独生成分享海报。
 */

function holdDays(g: Goods): number {
  return Math.max(0, Math.floor((Date.now() - new Date(g.buyDate).getTime()) / 86400000));
}

function WallCard({
  g,
  categoryName,
  symbol,
  onShare,
}: {
  g: Goods;
  categoryName: string | null;
  symbol: string;
  onShare: (g: Goods) => void;
}): JSX.Element {
  return (
    <div className="page-enter overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex aspect-square items-center justify-center bg-surface-2 p-4">
        <IconPreview icon={goodsIconValue(g)} size={72} className="text-ink-2" />
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold">{g.name}</p>
        <p className="tnum mt-0.5 text-xs text-ink-3">
          {symbol}
          {Number(g.price ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} · 陪伴 {holdDays(g)} 天
        </p>
        {categoryName ? <p className="mt-1 text-[11px] text-accent">{categoryName}</p> : null}
        <button
          onClick={() => onShare(g)}
          aria-label={`分享 ${g.name}`}
          className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-btn border border-line text-xs text-ink-2 active:bg-surface-2"
        >
          <Share2 size={13} strokeWidth={1.8} aria-hidden />
          分享卡片
        </button>
      </div>
    </div>
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

  const active = useMemo(() => goods.filter((g) => g.status !== 'retired'), [goods]);
  const catNameOf = (id: string): string | null => categories.find((c) => c.id === id)?.name ?? null;

  const share = async (g: Goods): Promise<void> => {
    try {
      const dataUrl = await drawGoodsCard(g, catNameOf(g.categoryId));
      const how = await shareOrDownload(dataUrl, `纳物-${g.name}.png`);
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
      const how = await shareOrDownload(dataUrl, '纳物-置物墙.png');
      toastSuccess(how === 'shared' ? '已分享' : how === 'saved' ? '已保存到系统相册「纳物」' : '长图已下载');
    } catch (e) {
      toastError(e instanceof Error ? e.message : '生成整墙海报失败');
    } finally {
      setWallBusy(false);
    }
  };

  return (
    /* ★v1.0.33：页头统一为子页壳（返回 + 常规字号标题 + 右侧动作）——
       此前用 text-3xl 大标题，与「分类管理/设置」等子页明显不一致。 */
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 dt:grid-cols-4 dtxl:grid-cols-5">
            {active.map((g) => (
              <WallCard key={g.id} g={g} categoryName={catNameOf(g.categoryId)} symbol={symbol} onShare={(x) => void share(x)} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
