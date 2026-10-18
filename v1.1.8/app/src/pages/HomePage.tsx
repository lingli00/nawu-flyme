import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { onSheetOpen } from '../lib/sheetBus';
import {
  LayoutGrid,
  Grid2x2,
  List,
  Search,
  Plus,
  X,
  Star,
  Share2,
  ChevronDown,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import PageField from '../components/ui/PageField';
import { Sheet } from '../components/ui/Sheet';
import { MoreMenuButton } from '../components/ui/MoreMenu';
import { EmptyState } from '../components/ui/EmptyState';
import { Chip } from '../components/ui/Chip';
import { Segmented } from '../components/ui/Segmented';
import { Toggle } from '../components/ui/Toggle';
import RecordMenu from '../components/RecordMenu';
import { useBackGuard } from '../lib/backGuard';
import { useShellMode } from '../components/layout/MainShell';
import SubListPage from './SubListPage';
import CategoryManageSheet from '../components/CategoryManageSheet';
import WeatherLine from '../components/WeatherLine';
import IconPicker, { IconPreview, type Tab as PickerTab } from '../components/IconPicker';
import {
  goodsIconValue,
  goodsImageFromIcon,
  hasOwnIcon,
  isLocalImage,
  isWebImage,
} from '../lib/goodsIcon';
import { GLASS_STYLE } from '../components/layout/MainShell';
import { useDataStore, useSettingsStore, useUiStore, toastSuccess, toastError } from '../store';
import { dailyCost, holdDays, perUseCost, sortGoods, totalInvest, achieveRate } from '../domain/goods';
import { formatMoney, symbolOf, round } from '../lib/money';
import { fmtDate, today } from '../lib/date';
import { drawGoodsCard, shareOrDownload } from '../lib/shareCard';
import { compressDataUrlUnder, IMAGE_MAX_KB } from '../lib/imageCompress';
import { getCategoryIcon } from '../lib/categoryIcons';
import type { Goods, GoodsImage } from '../types/entities';
import logger from '../lib/log';
import { haptic } from '../lib/haptics';

/* ============================================================================
 * 首页（对齐原版竞品布局）：
 * 大字标题 + 视图/搜索/记一笔 三按钮 → 物品/订阅 pill tab → 今日卡（P1-5） →
 * 筛选与排序 chips → 三列/两列网格 或 列表。
 * 交互（v1.0.33 P0-1 起）：单击物品卡 → 详情卡片（纯查看）；卡片常驻「⋯」更多
 * 菜单（查看/编辑/删除）是编辑的可视化主入口；长按 500ms → 编辑保留为快捷方式，
 * 首次出现时有 toast 教学。顶栏「＋」与 FAB/侧边栏统一开加号动作菜单（P0-2）。
 *
 * ⚠️ 两条铁律（踩过的坑）：
 * 1. 弹层一律 createPortal 挂 document.body —— Android WebView 上带 transform
 *    的动画祖先（page-enter）会成为 fixed 定位的包含块，遮罩只盖内容盒。
 * 2. 文本输入一律非受控（defaultValue + onChange 收集，无 value prop）——
 *    受控输入在安卓 IME 组合输入期显示值与实际值不同步。
 * ==========================================================================*/

type ViewMode = 'grid3' | 'grid2' | 'list';
type StatusFilter = 'all' | 'active' | 'retired' | 'favorite';
type SortKey = 'buyDate' | 'dailyCost' | 'price' | 'name';

/** 视图切换按钮图标（3列 → 2列 → 列表 循环）。 */
const VIEW_ICON: Record<ViewMode, LucideIcon> = { grid3: LayoutGrid, grid2: Grid2x2, list: List };

/** 无图物品的柔和底色（网格卡 / 列表头像 / 详情弹窗共用）。 */
const FALLBACK_BG = 'color-mix(in srgb, var(--accent-soft) 55%, var(--surface))';

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '在役' },
  { key: 'retired', label: '退役' },
  { key: 'favorite', label: '收藏' },
];

const SORT_CHIPS: Array<{ key: SortKey; label: string }> = [
  { key: 'buyDate', label: '最近购入' },
  { key: 'dailyCost', label: '日均↓' },
  { key: 'price', label: '价格↓' },
  { key: 'name', label: '名称' },
];

/**
 * 持有时长文案（原版「7 个月11天」风格）：不足 1 个月显示「N 天」。
 */
function holdLabel(buyDate: string, ref: string = today()): string {
  const valid = dayjs(buyDate);
  if (!buyDate || !valid.isValid()) return '1 天';
  const m = dayjs(ref).diff(valid, 'month');
  if (m <= 0) return `${Math.max(dayjs(ref).diff(valid, 'day'), 0) + 1} 天`;
  const d = dayjs(ref).diff(valid.add(m, 'month'), 'day');
  return `${m} 个月${d} 天`;
}

/** 图片 ref 是否已转卖：退役且填了出售价。 */
function isSold(g: Goods): boolean {
  return g.status === 'retired' && Number.isFinite(g?.sellPrice) && (g.sellPrice as number) > 0;
}

/**
 * 网格卡金额（转卖赚了显示「净赚¥xx」，否则显示购价）。
 * 口径与 domain/goods 对齐：净赚 = sellPrice − totalInvest(price+extraFees)。
 */
function cardAmount(g: Goods): { label: string; text: string } {
  const sold = Number.isFinite(g?.sellPrice) ? (g.sellPrice as number) : 0;
  const profit = sold - totalInvest(g);
  if (sold > 0 && profit > 0) return { label: '净赚', text: formatMoney(profit, g.currency) };
  return { label: '', text: formatMoney(g.price, g.currency) };
}

/** 图片选择 → canvas 压缩到 max 边长 → dataURL。 */
function compressImage(file: File, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('解析图片失败'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('画布不可用'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================================
 * 小开关：v1.0.33 起改用 components/ui/Toggle（消灭此前的文件内复制实现，
 * 与 SettingsPage 版细节不一致的问题随之消失）。
 * ==========================================================================*/

/* ============================================================================
 * 详情弹窗字段（两栏网格单元：上标签下数值，左右列均衡）。
 * ==========================================================================*/
function DetailField({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-ink-3">{label}</p>
      <p className="tnum truncate text-sm font-semibold" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  );
}

/* ============================================================================
 * 裁剪弹层（全屏，portal 挂 body）：
 * 方形视口 + 单指拖动平移 / 双指捏合缩放 / 双击重置 / 鼠标拖拽与滚轮（dev）。
 * 确认时按 scale/offset 的逆映射从原图裁出视口区域 → ≤512px 方形 JPEG dataURL。
 * ==========================================================================*/
function CropSheet({
  src,
  onConfirm,
  onCancel,
  onPickAnother,
}: {
  /** 裁剪源图（dataURL） */
  src: string;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
  /** 「重选」：重新打开文件选择 */
  onPickAnother: () => void;
}) {
  useBackGuard(true, onCancel);
  /** 视口边长：屏宽 - 48px（上限 480 防 dev 大屏、下限 200 防极端小窗）。 */
  const vp = useMemo(() => Math.max(200, Math.min(window.innerWidth - 48, 480)), []);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dimsRef = useRef<{ w: number; h: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const vpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      dimsRef.current = { w: img.naturalWidth, h: img.naturalHeight };
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = src;
  }, [src]);

  const baseScale = dims ? Math.max(vp / dims.w, vp / dims.h) : 1;

  /* —— 手势：原生监听（React 的 touchmove/wheel 是 passive，preventDefault 无效）—— */
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return undefined;

    const pinchDist = (t: TouchList): number =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    /** offset 夹紧：任何缩放下图片都至少铺满视口（cover）。 */
    const clampOffset = (scale: number, x: number, y: number): { x: number; y: number } => {
      const d = dimsRef.current;
      if (!d) return { x, y };
      const base = Math.max(vp / d.w, vp / d.h);
      const mx = Math.max(0, (d.w * base * scale - vp) / 2);
      const my = Math.max(0, (d.h * base * scale - vp) / 2);
      return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
    };

    let mode: 'none' | 'pan' | 'pinch' = 'none';
    let sx = 0;
    let sy = 0;
    let bx = 0;
    let by = 0;
    let pinchD = 0;
    let pinchS = 1;
    let lastTap = 0;

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length === 1) {
        mode = 'pan';
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        bx = viewRef.current.x;
        by = viewRef.current.y;
      } else if (e.touches.length >= 2) {
        mode = 'pinch';
        pinchD = pinchDist(e.touches);
        pinchS = viewRef.current.scale;
        sx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        sy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        bx = viewRef.current.x;
        by = viewRef.current.y;
      }
    };

    const onMove = (e: TouchEvent): void => {
      if (mode === 'none') return;
      e.preventDefault();
      const v = viewRef.current;
      if (mode === 'pan' && e.touches.length === 1) {
        const p = clampOffset(v.scale, bx + e.touches[0].clientX - sx, by + e.touches[0].clientY - sy);
        setView({ scale: v.scale, ...p });
      } else if (mode === 'pinch' && e.touches.length >= 2) {
        const scale = Math.min(4, Math.max(1, (pinchS * pinchDist(e.touches)) / pinchD));
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const p = clampOffset(scale, bx + cx - sx, by + cy - sy);
        setView({ scale, ...p });
      }
    };

    const onEnd = (e: TouchEvent): void => {
      if (e.touches.length === 0) {
        // 双击（<300ms 两次抬起）重置
        const now = Date.now();
        if (mode === 'pan' && now - lastTap < 300) {
          setView({ scale: 1, x: 0, y: 0 });
          lastTap = 0;
        } else if (mode === 'pan') {
          lastTap = now;
        }
        mode = 'none';
      } else if (e.touches.length === 1 && mode === 'pinch') {
        // 双指抬起一指：以剩余指重新锚定平移，避免跳变
        mode = 'pan';
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        bx = viewRef.current.x;
        by = viewRef.current.y;
      }
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const v = viewRef.current;
      const scale = Math.min(4, Math.max(1, v.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      const p = clampOffset(scale, v.x, v.y);
      setView({ scale, ...p });
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [vp]);

  /* —— 鼠标拖拽（dev 用）—— */
  const dragRef = useRef<{ x: number; y: number; bx: number; by: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent): void => {
    dragRef.current = { x: e.clientX, y: e.clientY, bx: viewRef.current.x, by: viewRef.current.y };
  };
  const onMouseMove = (e: React.MouseEvent): void => {
    const d = dragRef.current;
    const dd = dimsRef.current;
    if (!d || !dd) return;
    const base = Math.max(vp / dd.w, vp / dd.h);
    const scale = viewRef.current.scale;
    const mx = Math.max(0, (dd.w * base * scale - vp) / 2);
    const my = Math.max(0, (dd.h * base * scale - vp) / 2);
    const x = Math.min(mx, Math.max(-mx, d.bx + e.clientX - d.x));
    const y = Math.min(my, Math.max(-my, d.by + e.clientY - d.y));
    setView({ scale, x, y });
  };
  const onMouseUp = (): void => {
    dragRef.current = null;
  };

  /** 确认裁剪：视口 → 原图逆映射，裁出方形区域，输出 ≤512px JPEG 并压到 ≤100KB（备份瘦身铁律）。 */
  const confirmCrop = (): void => {
    const img = imgRef.current;
    const d = dimsRef.current;
    if (!img || !d) return;
    const v = viewRef.current;
    const base = Math.max(vp / d.w, vp / d.h);
    const unit = base * v.scale; // 显示px → 原图px 的比例
    // 图片左上角在视口坐标系中的位置（视口左上为原点）
    const topLeftX = vp / 2 + v.x - (d.w * unit) / 2;
    const topLeftY = vp / 2 + v.y - (d.h * unit) / 2;
    const sw = vp / unit;
    const sh = sw;
    const sx0 = Math.min(Math.max(-topLeftX / unit, 0), Math.max(d.w - sw, 0));
    const sy0 = Math.min(Math.max(-topLeftY / unit, 0), Math.max(d.h - sh, 0));
    const out = Math.min(512, Math.round(Math.max(sw, 1)));
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, out, out);
    void compressDataUrlUnder(canvas.toDataURL('image/jpeg', 0.85), IMAGE_MAX_KB, 512).then(onConfirm);
  };

  const corner = 'pointer-events-none absolute h-6 w-6 border-white/90';

  return createPortal(
    /* ★v1.0.33：裁剪层 z-50 → z-[60]（表单 sheet 本身已是 z-50，嵌套层必须稳定在上） */
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black" onClick={onCancel}>
      <p className="mb-3 text-xs text-white/70">拖动调整位置 · 双指缩放 · 双击重置</p>
      {/* 方形视口 */}
      <div
        ref={vpRef}
        className="relative shrink-0 select-none overflow-hidden rounded-3xl bg-black"
        style={{ width: vp, height: vp, touchAction: 'none' }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={() => setView({ scale: 1, x: 0, y: 0 })}
      >
        {dims ? (
          <img
            src={src}
            alt="裁剪预览"
            draggable={false}
            className="pointer-events-none"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: dims.w * baseScale,
              height: dims.h * baseScale,
              maxWidth: 'none',
              transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`,
              transformOrigin: 'center',
            }}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-sm text-white/60">图片加载中…</span>
        )}
        {/* 四角 L 形参考线 */}
        <span className={`${corner} left-3 top-3 rounded-tl-lg border-l-2 border-t-2`} />
        <span className={`${corner} right-3 top-3 rounded-tr-lg border-r-2 border-t-2`} />
        <span className={`${corner} bottom-3 left-3 rounded-bl-lg border-b-2 border-l-2`} />
        <span className={`${corner} bottom-3 right-3 rounded-br-lg border-b-2 border-r-2`} />
      </div>

      {/* 底部按钮行 */}
      <div className="mt-5 flex items-center justify-center gap-3 px-6" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onPickAnother}
          className="h-11 rounded-btn border border-white/40 px-4 text-sm text-white/90 active:scale-95 transition-transform"
        >
          重选
        </button>
        <button
          onClick={onCancel}
          className="h-11 rounded-btn border border-white/40 px-4 text-sm text-white/90 active:scale-95 transition-transform"
        >
          取消
        </button>
        <button
          onClick={confirmCrop}
          disabled={!dims}
          className="h-11 rounded-btn bg-accent px-5 text-sm font-semibold text-white active:scale-95 transition-transform disabled:opacity-40"
        >
          ✓ 确认裁剪
        </button>
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================================
 * 物品表单 sheet（新增 / 编辑共用，portal 挂 body）。
 * `initial` 存在 → 编辑模式：预填全量字段（基础 + 成本核算 + 转卖与收益 + 保修），
 *   保存走 updateGoods 一次提交全部 patch；
 *   填了出售价且物品在役 → confirm 询问是否同时标记为已转卖（退役）；
 * 否则 → 新增模式：仅基础信息（轻量），走 addGoods。
 * 口径说明：targetDailyCost/sellPrice/extraFees 全部交给 domain/goods.ts 的
 *   dailyCost/netInvest/totalInvest 消费，本文件不自造任何公式；
 *   incomes（unknown[]）全项目无消费处、无定义形状，编辑时不展示、原样保留。
 * ==========================================================================*/
export function GoodsFormSheet({
  initial,
  prefill,
  onClose,
}: {
  initial?: Goods;
  /** 冷静池「转物品」预填（仅新增模式生效）。 */
  prefill?: { name?: string; price?: number };
  onClose: () => void;
}) {
  /* 返回键守卫由 Sheet 组件统一负责（v1.0.33 P1-10），此处不再自挂，避免双重占位历史。 */
  const categories = useDataStore((s) => s.categories);
  const addGoods = useDataStore((s) => s.addGoods);
  const updateGoods = useDataStore((s) => s.updateGoods);
  const syncSaleIncome = useDataStore((s) => s.syncSaleIncome);
  const currency = useSettingsStore((s) => s.settings.currency);
  const { confirm } = useUiStore.getState();

  const isEdit = Boolean(initial);
  /* 文本输入非受控：defaultValue + onChange 收集（IME 铁律）；关闭即卸载，无需重置 */
  const [name, setName] = useState(initial?.name ?? prefill?.name ?? '');
  const [price, setPrice] = useState(
    initial ? String(initial.price ?? '') : prefill?.price != null ? String(prefill.price) : '',
  );
  const [buyDate, setBuyDate] = useState(initial?.buyDate ?? today());
  const [catId, setCatId] = useState(initial?.categoryId ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [image, setImage] = useState<GoodsImage | undefined>(initial?.image);
  /** 裁剪源图（dataURL）：选文件后先进入 CropSheet，确认后才写入 image。 */
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  /** 裁剪弹层里「换一张」用（IconPicker 的 input 在其内部，这里自持一个）。 */
  const cropFileRef = useRef<HTMLInputElement>(null);
  /** 就地管理物品分类（对标竞品：不打断添加流程）。 */
  const [managingCats, setManagingCats] = useState(false);
  /** v1.1.4：分类默认只铺 8 个，其余收进「更多」——避免分类区把备注挤到屏外。 */
  const [catsExpanded, setCatsExpanded] = useState(false);
  /** v1.0.18：点图标区直接开 picker（跳过五来源 sheet），默认系统图标。 */
  const [pickerTab, setPickerTab] = useState<PickerTab | null>(null);

  /**
   * image ↔ icon 字符串互转一律走 goodsIcon（v1.0.29）：旧版遇到裸 lucide id
   * 会 setImage(undefined) —— 这正是「系统图标选不中」的根因。
   */
  const iconValue = goodsIconValue(image ? { image } : {});
  const onIconChange = (v: string): void => {
    setImage(goodsImageFromIcon(v));
  };

  /* —— 编辑模式全量字段（新增模式不展示）—— */
  const [targetDailyCost, setTargetDailyCost] = useState(
    initial?.targetDailyCost != null ? String(initial.targetDailyCost) : '',
  );
  const [countEnabled, setCountEnabled] = useState(initial?.countEnabled ?? false);
  const [totalCount, setTotalCount] = useState(initial?.totalCount != null ? String(initial.totalCount) : '');
  const [usedCount, setUsedCount] = useState(String(initial?.usedCount ?? 0));
  const [sellPrice, setSellPrice] = useState(initial?.sellPrice != null ? String(initial.sellPrice) : '');
  /** 附加费本地行（amount 用字符串方便输入，保存时转数字）。 */
  const [fees, setFees] = useState<Array<{ name: string; amount: string }>>(
    initial?.extraFees?.map((f) => ({ name: f.name, amount: f.amount ? String(f.amount) : '' })) ?? [],
  );
  const [warrantyDate, setWarrantyDate] = useState(initial?.warrantyDate ?? '');

  const setFee = (i: number, patch: Partial<{ name: string; amount: string }>): void => {
    setFees((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };

  const goodsCats = useMemo(
    () => categories.filter((c) => c.kind === 'goods').sort((a, b) => a.order - b.order),
    [categories],
  );
  /* v1.1.4：折叠态只显示前 8 个；当前选中的分类始终补在可见列表里。 */
  const GOODS_CAT_PREVIEW = 8;
  const shownGoodsCats = useMemo(() => {
    const activeId = catId || goodsCats[0]?.id || '';
    if (catsExpanded || goodsCats.length <= GOODS_CAT_PREVIEW) return goodsCats;
    const head = goodsCats.slice(0, GOODS_CAT_PREVIEW);
    const sel = goodsCats.find((c) => c.id === activeId);
    if (sel && !head.some((c) => c.id === sel.id)) return [...head, sel];
    return head;
  }, [goodsCats, catsExpanded, catId]);

  const onPickImage = (file: File | undefined): void => {
    if (!file) return;
    // 先压到 ≤2048 作裁剪源（控内存），裁剪确认后再出 ≤512 方形结果
    compressImage(file, 2048)
      .then((raw) => setCropSrc(raw))
      .catch(() => toastError('图片读取失败'));
  };

  const submit = async (): Promise<void> => {
    const p = Number(price);
    if (!name.trim() || !Number.isFinite(p) || p <= 0) {
      toastError('请填写名称和大于 0 的价格');
      return;
    }
    const base = {
      name: name.trim(),
      price: p,
      buyDate,
      categoryId: catId || goodsCats[0]?.id,
      note: note.trim() || undefined,
      image,
    };
    // ★v1.0.29：任何一步异常都要给用户明确反馈。旧代码把异常直接吞掉：
    // 弹层不关也不提示，用户感知就是「点了保存没反应 / 添加失败」。
    try {
      if (isEdit && initial) {
        // 出售价语义：填了出售价且仍在役 → 询问是否同时标记为已转卖（退役）
        const sp = sellPrice.trim() ? Number(sellPrice) : 0;
        let markSold = false;
        if (Number.isFinite(sp) && sp > 0 && initial.status !== 'retired') {
          // ★v1.1.3：confirm 里就把净赚算出来——用户答「是」时知道会计入生活流收入
          const invest = round(p + fees.reduce((acc, f) => acc + (Number(f.amount) || 0), 0));
          const profit = round(sp - invest);
          markSold = await confirm({
            title: '标记为已转卖？',
            message:
              profit > 0
                ? `已填写出售价，是否同时标记为已转卖（退役）？净赚 ${formatMoney(profit, currency)} 将记入生活流收入`
                : '已填写出售价，是否同时标记为已转卖（退役）？按此价格暂无净收益，不会记入生活流',
          });
        }
        // 编辑：一次提交全量 patch（空值=清除该字段；incomes 不在 patch 里 → 原样保留）
        const extraFees = fees
          .filter((f) => f.name.trim() !== '' || Number(f.amount) > 0)
          .map((f) => ({ name: f.name.trim(), amount: Number(f.amount) || 0 }));
        await updateGoods(initial.id, {
          ...base,
          targetDailyCost: targetDailyCost.trim() ? Number(targetDailyCost) : undefined,
          countEnabled,
          totalCount: countEnabled && totalCount.trim() ? Number(totalCount) : undefined,
          usedCount: Math.max(0, Math.round(Number(usedCount) || 0)),
          sellPrice: sellPrice.trim() ? Number(sellPrice) : undefined,
          extraFees,
          warrantyDate: warrantyDate || undefined,
          ...(markSold ? { status: 'retired' as const } : {}),
        });
        // ★v1.1.3：净赚同步生活流（改出售价 / 恢复在用也会走到这里，store 内幂等）
        const sync = await syncSaleIncome(initial.id);
        let msg = markSold ? '已保存并标记为已转卖' : '已保存';
        if (sync.action === 'created' || sync.action === 'updated') {
          msg += `，净赚 ${formatMoney(sync.amount ?? 0, currency)} 已记入生活流`;
        } else if (sync.action === 'removed') {
          msg += '，生活流中的转卖收益已移除';
        }
        toastSuccess(msg);
      } else {
        // 新增：轻量基础信息，其余字段走 store 默认值
        await addGoods(base);
        toastSuccess('已入库');
      }
      void haptic('medium');
    } catch (e) {
      logger.error('goods', '保存失败', e);
      toastError('保存失败，请重试');
      return;
    }
    onClose();
  };

  return (
    /* ★v1.0.33 P1-10：改用显式 Sheet 组件（原全局 CSS hack 把底部 sheet 偷改成
       26rem 右抽屉，20+ 字段的表单被挤成窄条；现在桌面抽屉 34rem 双列空间）。
       返回键守卫由 Sheet 组件统一负责（v1.0.33 P1-10），此处不再自挂，避免双重占位历史。 */
    <>
      <Sheet side="bottom" onClose={onClose} title={isEdit ? '编辑物品' : '物品入库'} drawerWidth="34rem">
        <div className="space-y-3">
              <PageField label="名称">
                <input
                  defaultValue={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="买了什么"
                  className="h-11 w-full nw-input"
                />
              </PageField>
              <div className="grid grid-cols-2 gap-3">
                <PageField label={`价格（${currency}）`}>
                  <input
                    defaultValue={price}
                    onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="h-11 w-full nw-input"
                  />
                </PageField>
                <PageField label="购买日期">
                  <input
                    type="date"
                    value={buyDate}
                    onChange={(e) => setBuyDate(e.target.value)}
                    className="h-11 w-full nw-input"
                  />
                </PageField>
              </div>
              {/* 图标 / 图片（v1.0.18：点击直接进选择器，相册/拍照在「相册·拍照」tab） */}
              <PageField label="图标 / 图片">
                <button
                  type="button"
                  onClick={() => setPickerTab('lib')}
                  className="flex w-full items-center gap-3 rounded-btn border border-line bg-surface-2 px-3 py-2.5 text-left active:scale-[0.99]"
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent-soft text-accent">
                    <IconPreview icon={iconValue} size={26} fallbackBg="transparent" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">选择图标 / 图片</span>
                    <span className="block text-[11px] text-ink-3">系统图标 / 品牌 / 网络商品图 / 相册·拍照</span>
                  </span>
                </button>
              </PageField>
              <div>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-ink-2">分类</p>
                  <div className="flex items-center gap-3">
                    {goodsCats.length > GOODS_CAT_PREVIEW ? (
                      <button onClick={() => setCatsExpanded((v) => !v)} className="text-xs font-medium text-ink-2">
                        {catsExpanded ? '收起' : `更多 ${goodsCats.length - GOODS_CAT_PREVIEW} 个`}
                      </button>
                    ) : null}
                    <button onClick={() => setManagingCats(true)} className="text-xs font-medium text-accent">
                      管理
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {shownGoodsCats.map((c) => {
                    const ChipIcon = getCategoryIcon(c.icon);
                    return (
                      <button
                        key={c.id}
                        onClick={() => setCatId(c.id)}
                        className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-all active:scale-95 ${
                          (catId || goodsCats[0]?.id) === c.id
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-line text-ink-2'
                        }`}
                      >
                        <ChipIcon size={13} />
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <PageField label="备注（可选）">
                <input
                  defaultValue={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="h-10 w-full nw-input"
                />
              </PageField>

              {/* ============ 编辑模式：全量字段（新增 sheet 保持轻量） ============ */}
              {isEdit ? (
                <>
                  {/* —— 成本核算 —— */}
                  <p className="pt-1 text-xs font-semibold text-ink-3">成本核算</p>
                  <div className="grid grid-cols-2 gap-3">
                    <PageField label="目标日均（留空不启用）">
                      <input
                        defaultValue={targetDailyCost}
                        onChange={(e) => setTargetDailyCost(e.target.value.replace(/[^\d.]/g, ''))}
                        inputMode="decimal"
                        placeholder="0.00"
                        className="h-11 w-full nw-input"
                      />
                    </PageField>
                    <PageField label="使用次数">
                      <input
                        defaultValue={usedCount}
                        onChange={(e) => setUsedCount(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                        placeholder="0"
                        className="h-11 w-full nw-input"
                      />
                    </PageField>
                  </div>
                  <div className="flex items-center justify-between rounded-btn border border-line bg-surface-2 px-3 py-2.5">
                    <span className="text-sm">启用使用计数</span>
                    <Toggle
                      on={countEnabled}
                      onClick={() => setCountEnabled(!countEnabled)}
                      label="启用使用计数"
                    />
                  </div>
                  {countEnabled ? (
                    <PageField label="累计次数（计划使用总次数）">
                      <input
                        defaultValue={totalCount}
                        onChange={(e) => setTotalCount(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                        placeholder="0"
                        className="h-11 w-full nw-input"
                      />
                    </PageField>
                  ) : null}

                  {/* —— 转卖与收益 —— */}
                  <p className="pt-1 text-xs font-semibold text-ink-3">转卖与收益</p>
                  <PageField label="出售价（退役转卖时填，填了会询问是否标记已转卖）">
                    <input
                      defaultValue={sellPrice}
                      onChange={(e) => setSellPrice(e.target.value.replace(/[^\d.]/g, ''))}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-11 w-full nw-input"
                    />
                  </PageField>
                  <div>
                    <p className="text-xs font-medium text-ink-2">附加费用（计入总投入）</p>
                    {fees.map((f, i) => (
                      <div key={i} className="mt-1.5 flex items-center gap-2">
                        <input
                          defaultValue={f.name}
                          onChange={(e) => setFee(i, { name: e.target.value })}
                          placeholder="说明（如运费）"
                          className="h-10 min-w-0 flex-1 nw-input"
                        />
                        <input
                          defaultValue={f.amount}
                          onChange={(e) => setFee(i, { amount: e.target.value.replace(/[^\d.]/g, '') })}
                          inputMode="decimal"
                          placeholder="0.00"
                          className="tnum h-10 w-20 shrink-0 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent"
                        />
                        <button
                          onClick={() => setFees((rows) => rows.filter((_, idx) => idx !== i))}
                          aria-label="删除附加费"
                          className="flex h-10 w-8 shrink-0 items-center justify-center text-ink-3 active:opacity-70"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setFees((rows) => [...rows, { name: '', amount: '' }])}
                      className="mt-2 h-9 w-full rounded-btn border border-dashed border-line text-xs text-ink-3 active:opacity-70"
                    >
                      ＋ 添加附加费
                    </button>
                  </div>

                  {/* —— 保修 —— */}
                  <p className="pt-1 text-xs font-semibold text-ink-3">保修</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={warrantyDate}
                      onChange={(e) => setWarrantyDate(e.target.value)}
                      className="h-11 min-w-0 flex-1 nw-input"
                    />
                    {warrantyDate ? (
                      <button
                        onClick={() => setWarrantyDate('')}
                        className="h-11 shrink-0 rounded-btn px-2 text-xs text-ink-3 active:opacity-70"
                      >
                        清除
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}

              <button
                onClick={() => void submit()}
                disabled={!name.trim() || !Number(price)}
                className="h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:scale-[0.98] transition-transform disabled:opacity-40"
              >
                {isEdit ? '保存' : '入库'}
              </button>
        </div>
      </Sheet>
      {/* 图标选择视图（v1.0.18：直接进 picker，无中间来源 sheet）
          ★v1.0.33：z-50 → z-[60]（表单 sheet 本身已是 z-50，嵌套层必须在上） */}
      {pickerTab ? (
        createPortal(
          <div className="fixed inset-0 z-[60] flex items-end bg-black/40" onClick={() => setPickerTab(null)}>
            <div
              className="sheet-enter mx-auto max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold">选择图标 / 图片</p>
                <button
                  onClick={() => setPickerTab(null)}
                  aria-label="完成"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-ink-2 active:scale-95"
                >
                  ✕
                </button>
              </div>
              <IconPicker
                value={iconValue}
                onChange={onIconChange}
                onFilePicked={onPickImage}
                systemMode
                initialTab={pickerTab}
              />
            </div>
          </div>,
          document.body,
        )
      ) : null}

      {/* 裁剪弹层（全屏，盖在表单 sheet 之上） */}
      {cropSrc ? (
        <CropSheet
          src={cropSrc}
          onConfirm={(dataUrl) => {
            setImage({ source: 'local', ref: dataUrl });
            setCropSrc(null);
          }}
          onCancel={() => setCropSrc(null)}
          onPickAnother={() => cropFileRef.current?.click()}
        />
      ) : null}
      {/* 就地管理物品分类（与表单 sheet 是兄弟节点，遮罩点击不互相穿透） */}
      {managingCats ? <CategoryManageSheet kind="goods" onClose={() => setManagingCats(false)} /> : null}
    </>
  );
}

/** 首页（P07/P14/P17 合一）。 */
export default function HomePage() {
  const goods = useDataStore((s) => s.goods);
  const categories = useDataStore((s) => s.categories);
  const records = useDataStore((s) => s.valueRecords);
  const updateGoods = useDataStore((s) => s.updateGoods);
  const syncSaleIncome = useDataStore((s) => s.syncSaleIncome);
  const removeById = useDataStore((s) => s.removeById);
  const useGoodsOnce = useDataStore((s) => s.useGoodsOnce);
  const currency = useSettingsStore((s) => s.settings.currency);
  const { confirm } = useUiStore.getState();
  const location = useLocation();
  const navigate = useNavigate();
  /** 当前壳型（P2-14 空态文案分流：移动指底部 FAB / 桌面指左上角侧边栏按钮）。
   *  注意不能读 html[data-shell] —— 那是 MainShell 的 effect 副作用，首帧不可靠。 */
  const shellMode = useShellMode();
  const recordHint = shellMode === 'desktop' ? '点左上角「记一笔」' : '点底部 ＋ 记一笔';

  /* —— 顶栏与视图 —— */
  const [tab, setTab] = useState<'goods' | 'subs'>('goods');
  const [view, setView] = useState<ViewMode>('grid3');
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  /** ★v1.0.33 P0-2：顶栏＋统一开加号动作菜单（与侧边栏「记一笔」/底部 FAB 同一组件），
   *  一个记录入口 —— 旧行为是直接开物品表单，三个入口两种行为。 */
  const [menuOpen, setMenuOpen] = useState(false);

  /* —— 物品筛选 / 排序（默认「在役」：打开即见在役物品）—— */
  const [status, setStatus] = useState<StatusFilter>('active');
  const [sortBy, setSortBy] = useState<SortKey>('buyDate');

  /* —— 弹层 —— */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Goods | null>(null);
  const [subAdding, setSubAdding] = useState(false);
  /** 分享生图进行中（防连点）。 */
  const [sharing, setSharing] = useState(false);
  /** AI 记一笔添加订阅后跳转过来：传给 SubListPage 自动弹出 SubEditSheet。 */
  const [subEditHint, setSubEditHint] = useState<string | null>(null);
  /** P1-5：今日卡内资产汇总展开态。 */
  const [assetOpen, setAssetOpen] = useState(false);
  /** 冷静池「到期转物品」预填（sessionStorage gf.prefill.goods，v1.0.20）。 */
  const [prefill, setPrefill] = useState<{ name?: string; price?: number } | undefined>(undefined);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('gf.prefill.goods');
      if (raw) {
        sessionStorage.removeItem('gf.prefill.goods');
        setPrefill(JSON.parse(raw) as { name?: string; price?: number });
        setAdding(true);
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  /** v1.0.22：加号菜单「手动录入 / 新增订阅」跨页展开（gf.open.goods / gf.open.sub）。 */
  useEffect(() => {
    try {
      if (sessionStorage.getItem('gf.open.goods')) {
        sessionStorage.removeItem('gf.open.goods');
        setAdding(true);
      }
      if (sessionStorage.getItem('gf.open.sub')) {
        sessionStorage.removeItem('gf.open.sub');
        setTab('subs');
        setSubAdding(true);
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  /** v1.0.22：同路由时加号菜单走 sheetBus 信号即时开层（不依赖 navigate 重装）。 */
  useEffect(
    () =>
      onSheetOpen('goods', () => {
        setAdding(true);
      }),
    [],
  );
  useEffect(
    () =>
      onSheetOpen('sub', () => {
        setTab('subs');
        setSubAdding(true);
      }),
    [],
  );

  /* AI 记一笔创建物品/订阅后导航过来（location.state 带目标 id）：
     自动弹出对应编辑面板，消费一次后立即清掉 state，防止返回键重弹。 */
  useEffect(() => {
    const st = location.state as { editGoodsId?: string; editSubId?: string } | null;
    if (!st || (!st.editGoodsId && !st.editSubId)) return;
    navigate(location.pathname, { replace: true, state: null });
    if (st.editGoodsId) {
      const g = useDataStore.getState().goods.find((x) => x.id === st.editGoodsId);
      if (g) setEditing(g);
    } else if (st.editSubId) {
      setTab('subs');
      setSubEditHint(st.editSubId);
    }
  }, [location.state, location.pathname, navigate]);

  const catNameOf = (id: string) => categories.find((c) => c.id === id)?.name;
  /** 分类 lucide 图标（旧 emoji 数据由 categoryIcons 兜底回落 Tag）。 */
  const catIconOf = (id: string) => getCategoryIcon(categories.find((c) => c.id === id)?.icon);

  /* —— 汇总（我的资产卡）—— */
  const summary = useMemo(() => {
    const active = goods.filter((g) => g.status !== 'retired');
    const retired = goods.filter((g) => g.status === 'retired');
    const favorites = goods.filter((g) => g.status === 'favorite');
    const invest = active.reduce((acc, g) => acc + totalInvest(g), 0);
    const daily = active.reduce((acc, g) => acc + dailyCost(g), 0);
    /* 已转卖收益口径：sellPrice − totalInvest（与卡片「净赚」同口径，不发明新字段） */
    const soldProfit = goods.reduce((acc, g) => {
      const sold = Number.isFinite(g?.sellPrice) ? (g.sellPrice as number) : 0;
      return sold > 0 ? acc + (sold - totalInvest(g)) : acc;
    }, 0);
    return { active: active.length, retired: retired.length, favorites: favorites.length, invest, daily, soldProfit };
  }, [goods]);

  /* —— P1-5「今日卡」：今天花了多少 + 归需否结构（记账产品第一眼应是今日视角）—— */
  const todaySummary = useMemo(() => {
    const t = today();
    const rows = records.filter((r) => r.date === t && r.type === 'expense');
    const sum = (j?: string): number =>
      rows.filter((r) => (j ? r.judgement === j : true)).reduce((a, r) => a + (r.amount || 0), 0);
    return { total: sum(), gui: sum('gui'), xu: sum('xu'), fou: sum('fou'), count: rows.length };
  }, [records]);

  /* —— P0-1：首次出现时 toast 教会「长按可直接编辑」（⋯ 菜单是主入口，长按是快捷方式）—— */
  useEffect(() => {
    if (goods.length === 0) return;
    try {
      if (localStorage.getItem('gf.hint.longpress')) return;
      localStorage.setItem('gf.hint.longpress', '1');
      const timer = window.setTimeout(() => toastSuccess('长按物品卡片可直接编辑'), 600);
      return () => window.clearTimeout(timer);
    } catch {
      /* 隐私模式忽略 */
    }
    return undefined;
  }, [goods.length]);

  /* —— 列表：状态 → 关键词 → 排序 → 在役优先 —— */
  const list = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const byStatus = goods.filter((g) => {
      if (status === 'all') return true;
      return g.status === status;
    });
    /* ★v1.0.33 P1-7：搜索匹配扩展到备注（原只匹配名称/标签，备注里的
       「通勤降噪主力」这类关键信息搜不到） */
    const byKw = kw
      ? byStatus.filter(
          (g) =>
            g.name.toLowerCase().includes(kw) ||
            g.tags.some((t) => t.toLowerCase().includes(kw)) ||
            (g.note ?? '').toLowerCase().includes(kw),
        )
      : byStatus;
    const sorted = sortGoods(byKw, sortBy);
    // 在役优先：退役/已转卖一律沉底（稳定排序，同组内保持所选排序键；
    // 用户显式选「退役」筛选时全部沉底组，顺序不变）
    return [
      ...sorted.filter((g) => g.status !== 'retired'),
      ...sorted.filter((g) => g.status === 'retired'),
    ];
  }, [goods, status, keyword, sortBy]);

  /* detail 派生自 goods 列表：编辑/+1/退役后详情内容自动刷新 */
  const detail = detailId ? goods.find((g) => g.id === detailId) ?? null : null;

  /** 分享生图：canvas 绘制物品海报 → 系统分享（降级为保存图片）。 */
  const shareDetail = async (): Promise<void> => {
    if (!detail || sharing) return;
    setSharing(true);
    try {
      const dataUrl = await drawGoodsCard(detail, catNameOf(detail.categoryId) ?? '未分类');
      const how = await shareOrDownload(dataUrl, `纳物-${detail.name || '物品'}.png`);
      if (how === 'saved') toastSuccess('已保存到系统相册「纳物」');
      else if (how === 'downloaded') toastSuccess('海报已下载');
      else toastSuccess('已分享');
    } catch (e) {
      toastError(e instanceof Error ? e.message : '生成分享卡片失败');
    } finally {
      setSharing(false);
    }
  };
  /** 详情卡净赚（出售价 − 总投入，负数不展示）。 */
  const detailSoldProfit = detail
    ? Math.max(
        (Number.isFinite(detail.sellPrice) ? (detail.sellPrice as number) : 0) - totalInvest(detail),
        0,
      )
    : 0;

  /* —— 单击=详情 / 长按 500ms=编辑 —— */
  const pressRef = useRef<{ timer: number | null; fired: boolean; x: number; y: number }>({
    timer: null,
    fired: false,
    x: 0,
    y: 0,
  });

  const onCardDown = (g: Goods, e: React.PointerEvent): void => {
    const pr = pressRef.current;
    pr.fired = false;
    pr.x = e.clientX;
    pr.y = e.clientY;
    pr.timer = window.setTimeout(() => {
      pr.fired = true;
      setEditing(g); // 长按 500ms → 直接进编辑
    }, 500);
  };
  const onCardUp = (g: Goods): void => {
    const pr = pressRef.current;
    if (pr.timer) {
      clearTimeout(pr.timer);
      pr.timer = null;
    }
    if (!pr.fired) setDetailId(g.id); // 单击 → 详情卡片
  };
  const onCardMove = (e: React.PointerEvent): void => {
    const pr = pressRef.current;
    // 滚动/拖动超过 10px 取消长按
    if (pr.timer && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 10) {
      clearTimeout(pr.timer);
      pr.timer = null;
    }
  };
  const onCardLeave = (): void => {
    const pr = pressRef.current;
    if (pr.timer) {
      clearTimeout(pr.timer);
      pr.timer = null;
    }
  };

  const del = async (g: Goods) => {
    const ok = await confirm({ title: `删除「${g.name}」？`, message: '删除后不可恢复（建议先退役保留记录）。' });
    if (!ok) return;
    await removeById('goods', g.id);
    // ★v1.1.3：清掉该物品关联的转卖收益记录，避免生活流里留下孤儿收入
    const sync = await syncSaleIncome(g.id);
    setDetailId(null);
    toastSuccess(sync.action === 'removed' ? '已删除，关联的转卖收益已一并移除' : '已删除');
  };

  const symbol = symbolOf(currency);
  const soldProfitText = `${summary.soldProfit >= 0 ? '+' : ''}${formatMoney(summary.soldProfit, currency)}`;

  return (
    <div className="page-enter">
      {/* ============ 顶栏：大字标题 + 视图 / 搜索 / 新增 ============
          ★v1.0.33 P1-7：搜索从「点图标展开下方输入框」改为「顶行整框 + 取消」，
          自动聚焦、两级操作变一级；P0-2：＋ 与 FAB / 侧边栏统一开加号菜单。 */}
      <header className="flex items-center justify-between pb-1 pt-2">
        <h1 className="text-3xl font-bold leading-9">纳物</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView(NEXT_VIEW_SAFE(view))}
            aria-label="切换视图"
            className="flex h-9 w-9 items-center justify-center rounded-full text-ink-2 active:scale-95 active:bg-surface transition-transform"
          >
            {(() => {
              const Icon = VIEW_ICON[view];
              return <Icon size={19} />;
            })()}
          </button>
          <button
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) setKeyword('');
            }}
            aria-label="搜索"
            className={`flex h-9 w-9 items-center justify-center rounded-full active:scale-95 active:bg-surface transition-transform ${
              searchOpen ? 'bg-surface text-accent' : 'text-ink-2'
            }`}
          >
            <Search size={19} />
          </button>
          <button
            onClick={() => {
              void haptic('medium');
              setMenuOpen(true);
            }}
            aria-label="记一笔"
            className="flex h-9 w-9 items-center justify-center rounded-full text-accent active:scale-95 active:bg-surface transition-transform"
          >
            <Plus size={22} />
          </button>
        </div>
      </header>

      {/* 天气行（v1.1.4）：一行 11px 次级信息，取不到数据时整行不渲染 */}
      <WeatherLine className="mb-3" />

      {/* 搜索行（P1-7：整行搜索框 + 取消按钮；非受控：关闭即卸载，重开为空） */}
      {searchOpen ? (
        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              defaultValue=""
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchOpen(false);
                  setKeyword('');
                }
              }}
              placeholder="搜索物品 / 标签 / 备注"
              className="h-10 w-full nw-input pl-9 pr-3"
            />
          </div>
          <button
            onClick={() => {
              setSearchOpen(false);
              setKeyword('');
            }}
            className="h-10 shrink-0 px-2 text-sm text-ink-2 active:opacity-70"
          >
            取消
          </button>
        </div>
      ) : null}

      {/* ============ 物品 / 订阅 分段 tab（v1.0.33 P1-9：统一 Segmented 组件） ============ */}
      <Segmented
        className="mb-3"
        value={tab}
        onChange={(v) => setTab(v)}
        options={[
          { value: 'goods', label: '物品' },
          { value: 'subs', label: '订阅' },
        ]}
      />

      {tab === 'goods' ? (
        <>
          {/* ============ P1-5 今日卡（原「我的资产」四行数据卡 → 今日视角） ============
              打开 App 第一眼是「今天花了多少 + 归需否结构」；资产汇总降级为
              一行次级信息（点击展开），记一笔主按钮与 FAB/＋ 同一加号菜单。 */}
          <div className="mb-3 rounded-2xl p-4" style={GLASS_STYLE}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-ink-3">
                  今日支出 · {todaySummary.count} 笔
                  {todaySummary.count === 0 ? ' · 今天还没有记录' : ''}
                </p>
                <p className="tnum mt-0.5 text-[28px] font-bold leading-9">
                  {symbol}
                  {todaySummary.total.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
                </p>
                {/* 归需否迷你条（三段式，与产品方法论同构） */}
                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line-2">
                  {todaySummary.total > 0 ? (
                    <>
                      <span style={{ width: `${(todaySummary.gui / todaySummary.total) * 100}%`, background: 'var(--gui)' }} />
                      <span style={{ width: `${(todaySummary.xu / todaySummary.total) * 100}%`, background: 'var(--xu)' }} />
                      <span style={{ width: `${(todaySummary.fou / todaySummary.total) * 100}%`, background: 'var(--fou)' }} />
                    </>
                  ) : null}
                </div>
                <p className="tnum mt-1.5 flex flex-wrap gap-x-2.5 text-[11px]">
                  <span style={{ color: 'var(--gui)' }}>归 {formatMoney(todaySummary.gui, currency)}</span>
                  <span style={{ color: 'var(--xu)' }}>需 {formatMoney(todaySummary.xu, currency)}</span>
                  <span style={{ color: 'var(--fou)' }}>否 {formatMoney(todaySummary.fou, currency)}</span>
                </p>
              </div>
              <button
                onClick={() => {
                  void haptic('medium');
                  setMenuOpen(true);
                }}
                className="flex h-10 shrink-0 items-center gap-1 rounded-full bg-accent px-4 text-sm font-medium text-white shadow active:scale-95"
                style={{ boxShadow: '0 6px 16px color-mix(in srgb, var(--accent) 35%, transparent)' }}
              >
                <Plus size={15} strokeWidth={2.4} aria-hidden />
                记一笔
              </button>
            </div>

            {/* 资产汇总：一行次级信息，点击展开（原四行数据的主视觉位置让位给今日视角） */}
            <button
              onClick={() => {
                void haptic('select');
                setAssetOpen(!assetOpen);
              }}
              aria-expanded={assetOpen}
              className="mt-3 flex w-full items-center justify-between gap-2 border-t border-line-2 pt-2.5 text-left"
            >
              <span className="tnum min-w-0 truncate text-[11px] text-ink-2">
                在役购入 {symbol}
                {summary.invest.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} · 在役日均{' '}
                {formatMoney(summary.daily, currency)} · 已转卖净赚 {soldProfitText}
              </span>
              <ChevronDown
                size={13}
                className={`shrink-0 text-ink-3 transition-transform ${assetOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
            {assetOpen ? (
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div className="rounded-btn bg-surface-2 p-2.5">
                  <p className="text-[11px] text-ink-3">在役购入</p>
                  <p className="tnum text-sm font-semibold">
                    {symbol}
                    {summary.invest.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div className="rounded-btn bg-surface-2 p-2.5">
                  <p className="text-[11px] text-ink-3">在役日均</p>
                  <p className="tnum text-sm font-semibold" style={{ color: 'var(--gui)' }}>
                    {formatMoney(summary.daily, currency)}
                  </p>
                </div>
                <div className="rounded-btn bg-surface-2 p-2.5">
                  <p className="text-[11px] text-ink-3">已转卖净赚</p>
                  <p
                    className="tnum text-sm font-semibold"
                    style={{ color: summary.soldProfit > 0 ? 'var(--gui)' : 'var(--ink-3)' }}
                  >
                    {soldProfitText}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {/* ============ 筛选 chips + 排序 chips（P1-9：统一 Chip 组件） ============ */}
          <div className="no-scrollbar -mx-4 mb-2 flex gap-2 overflow-x-auto px-4">
            {STATUS_CHIPS.map((c) => (
              <Chip key={c.key} selected={status === c.key} onClick={() => setStatus(c.key)}>
                {c.label}
              </Chip>
            ))}
            <span className="mx-0.5 my-1 w-px shrink-0 bg-line" />
            {SORT_CHIPS.map((c) => (
              <Chip key={c.key} selected={sortBy === c.key} onClick={() => setSortBy(c.key)}>
                {c.label}
              </Chip>
            ))}
          </div>

          {/* ============ 主体：网格 / 列表 / 空态 ============ */}
          {list.length === 0 ? (
            <EmptyState
              title={goods.length === 0 ? '还没有物品' : '没有匹配的物品'}
              sub={goods.length === 0 ? `${recordHint}，入库第一件物品` : '换个筛选条件或关键词试试'}
              actionLabel={goods.length === 0 ? '记一笔' : undefined}
              onAction={goods.length === 0 ? () => setMenuOpen(true) : undefined}
            />
          ) : view === 'list' ? (
            /* —— 列表视图 —— */
            <ul className="space-y-2 dt:grid dt:grid-cols-2 dt:gap-2 dt:space-y-0">
              {list.map((g) => {
                const retired = g.status === 'retired';
                const CatIcon = catIconOf(g.categoryId);
                return (
                  <li key={g.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => onCardDown(g, e)}
                      onPointerUp={() => onCardUp(g)}
                      onPointerMove={onCardMove}
                      onPointerLeave={onCardLeave}
                      onContextMenu={(e) => e.preventDefault()}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-card border border-line bg-surface px-3.5 py-3 text-left active:scale-[0.98] transition-transform"
                    >
                      {isLocalImage(g) ? (
                        <img
                          src={g.image?.ref}
                          alt={g.name}
                          className="h-10 w-10 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                          style={{ background: FALLBACK_BG }}
                        >
                          {/* v1.0.29：builtin / url / brand 三形态统一 —— 旧代码硬编码 url: 前缀，系统图标永远不显示 */}
                          {hasOwnIcon(g) ? (
                            <IconPreview icon={goodsIconValue(g)} size={28} className="h-7 w-7" />
                          ) : (
                            <CatIcon size={18} className="text-ink-3" />
                          )}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm font-medium ${retired ? 'line-through opacity-60' : ''}`}>
                          {g.name}
                          {isSold(g) ? <span className="text-ink-3"> · 已转卖</span> : null}
                        </p>
                        <p className="tnum text-[11px] text-ink-3">
                          {formatMoney(g.price, g.currency)} · 持有 {holdDays(g)} 天
                          {g.countEnabled ? ` · 用了 ${g.usedCount ?? 0} 次` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p
                          className="tnum text-sm font-semibold"
                          style={{ color: retired ? 'var(--ink-3)' : 'var(--accent)' }}
                        >
                          {formatMoney(dailyCost(g), g.currency)}
                        </p>
                        <p className="text-[11px] text-ink-3">日均</p>
                      </div>
                      {/* ★v1.0.33 P0-1：常驻 ⋯ 菜单（长按编辑的唯一可视化入口） */}
                      <MoreMenuButton
                        items={[
                          { key: 'detail', label: '查看详情', onSelect: () => setDetailId(g.id) },
                          { key: 'edit', label: '编辑', onSelect: () => setEditing(g) },
                          { key: 'del', label: '删除', danger: true, onSelect: () => void del(g) },
                        ]}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            /* —— 网格视图（3 列默认 / 2 列）—— */
            <ul className={`grid gap-2 ${view === 'grid3' ? 'grid-cols-3 dt:grid-cols-4 dtxl:grid-cols-5' : 'grid-cols-2 dt:grid-cols-3 dtxl:grid-cols-4'}`}>
              {list.map((g) => {
                const amt = cardAmount(g);
                const CatIcon = catIconOf(g.categoryId);
                return (
                  <li key={g.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => onCardDown(g, e)}
                      onPointerUp={() => onCardUp(g)}
                      onPointerMove={onCardMove}
                      onPointerLeave={onCardLeave}
                      onContextMenu={(e) => e.preventDefault()}
                      className="block w-full cursor-pointer overflow-hidden rounded-2xl border border-line bg-surface text-left active:scale-95 transition-transform"
                    >
                      {/* 图片区 */}
                      <div
                        className="relative aspect-square w-full"
                        style={isLocalImage(g) || isWebImage(g) ? undefined : { background: FALLBACK_BG }}
                      >
                        {isLocalImage(g) ? (
                          <img src={g.image?.ref} alt={g.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center" style={{ background: FALLBACK_BG }}>
                            {hasOwnIcon(g) ? (
                              <IconPreview icon={goodsIconValue(g)} size={96} className="h-3/5 w-3/5" />
                            ) : (
                              <CatIcon size={36} className="text-ink-3" />
                            )}
                          </span>
                        )}
                        {/* 状态角标（v1.0.33 起移到左上，右上让给 ⋯ 菜单）：
                            在役=绿点（高关注）；已转卖/退役=中性灰 pill（低视觉权重） */}
                        {g.status === 'retired' ? (
                          <span
                            className="absolute left-1 top-1.5 rounded-full bg-surface/85 px-2 text-[11px] leading-4 text-ink-2"
                          >
                            {isSold(g) ? '已转卖' : '退役'}
                          </span>
                        ) : g.status === 'active' ? (
                          <span
                            className="absolute left-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface/85"
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--gui)' }} />
                          </span>
                        ) : (
                          <span className="absolute left-1 top-1 flex h-4 w-4 items-center justify-center">
                            <Star size={13} style={{ color: 'var(--warn)', fill: 'var(--warn)' }} />
                          </span>
                        )}
                        {/* ★v1.0.33 P0-1：⋯ 更多菜单浮层（编辑/删除/详情的可视化入口） */}
                        <div className="absolute right-1 top-1">
                          <MoreMenuButton
                            compact
                            items={[
                              { key: 'detail', label: '查看详情', onSelect: () => setDetailId(g.id) },
                              { key: 'edit', label: '编辑', onSelect: () => setEditing(g) },
                              { key: 'del', label: '删除', danger: true, onSelect: () => void del(g) },
                            ]}
                          />
                        </div>
                      </div>
                      {/* 信息区（v1.0.33 P1-6 三层信息：名称 12px / 价格 16px 600 / meta 一行 12px；
                          单次成本移入详情页，3 列卡宽下不再四行小字竞争注意力） */}
                      <div className="p-2 pt-1.5">
                        <p className="line-clamp-2 min-h-[2.5em] text-xs font-medium leading-[1.25]">{g.name}</p>
                        <p className="tnum mt-1 text-base font-semibold leading-5">
                          {amt.label ? `${amt.label}${amt.text}` : amt.text}
                        </p>
                        <p className="tnum mt-0.5 truncate text-xs text-ink-2">
                          {formatMoney(dailyCost(g), g.currency)}
                          <span className="text-ink-3">/天</span>
                          <span className="text-ink-3"> · {holdLabel(g.buyDate)}</span>
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        /* ============ 订阅 tab：内嵌 SubListPage（功能一行不减）============ */
        <div key="subs" className="page-enter">
          <SubListPage
            embedded
            addOpen={subAdding}
            onAddOpenChange={setSubAdding}
            openEditId={subEditHint}
          />
        </div>
      )}

      {/* ============ 物品详情大弹窗（长按触发；portal 挂 body）============ */}
      {detail
        ? createPortal(
            <div
              className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
              onClick={() => setDetailId(null)}
            >
              {/* max-h + 内部滚动区防内容超高；✕ 浮钮在滚动区外保证不被裁切 */}
              <div
                className="pop-enter mx-auto flex max-h-[86vh] w-full max-w-sm flex-col rounded-3xl bg-surface"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {/* 大图区 + 状态 pill */}
                  <div
                    className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-t-3xl"
                    style={isLocalImage(detail) || isWebImage(detail) ? undefined : { background: FALLBACK_BG }}
                  >
                    {isLocalImage(detail) ? (
                      <img src={detail.image?.ref} alt={detail.name} className="h-full w-full object-cover" />
                    ) : (
                      /* v1.0.29：三形态统一（builtin / url / img / brand）——
                         旧代码只在 web 形态走 IconPreview，系统图标点开是空白 */
                      <span className="flex h-full w-full items-center justify-center" style={{ background: FALLBACK_BG }}>
                        {hasOwnIcon(detail) ? (
                          <IconPreview icon={goodsIconValue(detail)} size={140} className="h-2/5 w-2/5" />
                        ) : (
                          <span className="text-ink-3">
                            {(() => {
                              const CatIcon = catIconOf(detail.categoryId);
                              return <CatIcon size={56} />;
                            })()}
                          </span>
                        )}
                      </span>
                    )}
                    <span
                      className="absolute right-3 top-3 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                      style={{ background: 'color-mix(in srgb, var(--surface) 90%, transparent)' }}
                    >
                      {isSold(detail) ? (
                        '已转卖'
                      ) : detail.status === 'active' ? (
                        <span className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--gui)' }} />
                          服役中
                        </span>
                      ) : detail.status === 'retired' ? (
                        '退役'
                      ) : (
                        <span className="flex items-center gap-1">
                          <Star size={11} style={{ color: 'var(--warn)', fill: 'var(--warn)' }} />
                          收藏
                        </span>
                      )}
                    </span>
                  </div>

                  {/* 信息区：两栏均衡字段网格（分类/价格/天数/使用/净赚/保修一目了然） */}
                  <div className="px-5 pb-3 pt-4">
                    <h2 className="line-clamp-2 text-lg font-semibold leading-6">{detail.name}</h2>
                    <div className="mt-2 flex items-end justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] text-ink-3">购入价</p>
                        <p className="t-num tnum">{formatMoney(detail.price, detail.currency)}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="tnum rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-ink-2">
                          {formatMoney(dailyCost(detail), detail.currency)} / 天
                        </span>
                        {detailSoldProfit > 0 ? (
                          <span
                            className="tnum rounded-full px-2.5 py-0.5 text-[11px] font-medium text-white"
                            style={{ background: 'var(--gui)' }}
                          >
                            净赚 +{formatMoney(detailSoldProfit, detail.currency)}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                      <DetailField label="分类" value={catNameOf(detail.categoryId) ?? '未分类'} />
                      <DetailField label="陪伴" value={`${holdDays(detail)} 天`} />
                      <DetailField label="购入日期" value={fmtDate(detail.buyDate)} />
                      <DetailField
                        label="单次成本"
                        value={`${formatMoney(perUseCost(detail), detail.currency)}/次`}
                      />
                      <DetailField
                        label="使用次数"
                        value={
                          detail.countEnabled && detail.totalCount
                            ? `${detail.usedCount ?? 0} / ${detail.totalCount} 次`
                            : `${detail.usedCount ?? 0} 次`
                        }
                      />
                      {detail.targetDailyCost ? (
                        <DetailField
                          label="目标达成"
                          value={`${Math.round(achieveRate(detail) * 100)}%`}
                        />
                      ) : null}
                      {detail.extraFees.length > 0 ? (
                        <DetailField label="总投入" value={formatMoney(totalInvest(detail), detail.currency)} />
                      ) : null}
                      {Number.isFinite(detail.sellPrice) && (detail.sellPrice as number) > 0 ? (
                        <DetailField
                          label="出售价"
                          value={formatMoney(detail.sellPrice as number, detail.currency)}
                        />
                      ) : null}
                      {detail.warrantyDate ? (
                        <DetailField label="保修至" value={fmtDate(detail.warrantyDate)} />
                      ) : null}
                    </div>

                    {detail.note ? <p className="mt-3 text-xs leading-5 text-ink-2">{detail.note}</p> : null}

                    {/* 操作按钮行（分享生图 / ＋1 使用 / 编辑 / 退役|恢复 / 删除） */}
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={() => void shareDetail()}
                        disabled={sharing}
                        className="flex h-10 flex-1 items-center justify-center gap-1 rounded-btn border border-line text-xs font-medium text-ink-2 active:scale-95 transition-transform disabled:opacity-50"
                      >
                        <Share2 size={13} strokeWidth={1.8} aria-hidden />
                        {sharing ? '生成中…' : '分享'}
                      </button>
                      {detail.status !== 'retired' ? (
                        <button
                          onClick={() => void useGoodsOnce(detail.id).then(() => toastSuccess('已 +1'))}
                          className="h-10 flex-1 rounded-btn bg-accent-soft text-xs font-medium text-accent active:scale-95 transition-transform"
                        >
                          ＋1 使用
                        </button>
                      ) : null}
                      <button
                        onClick={() => {
                          setEditing(detail);
                          setDetailId(null);
                        }}
                        className="h-10 flex-1 rounded-btn border border-accent text-xs font-medium text-accent active:scale-95 transition-transform"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => {
                          // ★v1.1.3：退役/恢复后用后净赚同步生活流（store 内幂等）：
                          // 标记退役且填过出售价 → 记收入；恢复在用 → 撤回收入。
                          const toRetired = detail.status !== 'retired';
                          void updateGoods(detail.id, { status: toRetired ? 'retired' : 'active' })
                            .then(() => syncSaleIncome(detail.id))
                            .then((res) => {
                              const base = toRetired ? '已标记退役' : '已恢复在用';
                              if (res.action === 'created' || res.action === 'updated') {
                                toastSuccess(`${base}，净赚 ${formatMoney(res.amount ?? 0, currency)} 已记入生活流`);
                              } else if (res.action === 'removed') {
                                toastSuccess(`${base}，生活流中的转卖收益已移除`);
                              } else {
                                toastSuccess(base);
                              }
                            })
                            .catch(() => toastError('操作失败，请重试'));
                        }}
                        className="h-10 flex-1 rounded-btn border border-line text-xs text-ink-2 active:scale-95 transition-transform"
                      >
                        {detail.status === 'retired' ? '恢复在用' : '标记退役'}
                      </button>
                      <button
                        onClick={() => void del(detail)}
                        className="h-10 flex-1 rounded-btn border border-line text-xs active:scale-95 transition-transform"
                        style={{ color: 'var(--fou)' }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>

                {/* 底部中央圆形 ✕ */}
                <button
                  onClick={() => setDetailId(null)}
                  aria-label="关闭"
                  className="mx-auto -mb-6 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface text-ink-2 shadow-lg active:scale-95 transition-transform"
                >
                  <X size={18} />
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* ============ 新增物品 sheet（portal 挂 body）============ */}
      {adding ? <GoodsFormSheet prefill={prefill} onClose={() => setAdding(false)} /> : null}

      {/* ============ 编辑物品 sheet（点卡直接打开；portal 挂 body）============ */}
      {editing ? <GoodsFormSheet initial={editing} onClose={() => setEditing(null)} /> : null}

      {/* ============ ★v1.0.33 P0-2：加号动作菜单（与侧边栏/底部 FAB 同一组件）============ */}
      {menuOpen ? <RecordMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}

/** 视图循环：3列 → 2列 → 列表 → 3列（独立函数便于测试与阅读）。 */
function NEXT_VIEW_SAFE(v: ViewMode): ViewMode {
  return v === 'grid3' ? 'grid2' : v === 'grid2' ? 'list' : 'grid3';
}
