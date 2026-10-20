import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, LayoutGrid, Link2, Search, Upload } from 'lucide-react';
import { SUB_ICON_GROUPS, subIconOf } from '../lib/subIcons';
import {
  BRAND_GROUPS,
  brandIconRef,
  brandIconSrc,
  compressIconFile,
  faviconChain,
  iconApiUrl,
  normalizeDomainInput,
  searchBrands,
  toImgIcon,
  toUrlIcon,
  type BrandItem,
} from '../lib/brandIcon';
import { GLYPH_GROUPS, glyphBySlug, searchGlyphs, type GlyphItem } from '../lib/simpleBrand';
import { compressDataUrlUnder, IMAGE_MAX_KB } from '../lib/imageCompress';
import { currentServer, toastError } from '../store';
import { SYSTEM_ICON_GROUPS } from '../lib/systemIcons';
import { get } from '../net/httpClient';
import { fetchIconAsDataUrl, iconCacheFetchAndStore, iconCacheLookup, iconCacheLookupSync, normIconKey, warmIconCache } from '../lib/iconCache';
import { haptic } from '../lib/haptics';

/**
 * 统一图标选择器（订阅 / 物品共用）。
 *
 * ★v1.0.18 重构（对齐用户四条反馈）：
 * ① 【性能】分类网格一律懒渲染（LazySection：滚到可视区附近才挂载图标）——
 *    根治「点开系统图标反复闪屏」：v1.0.17 一次性同步渲染 1090 个图标组件，
 *    主线程阻塞数百 ms，WebView 白屏 + 入场动画掉帧，三端同修。
 * ② 【系统图标】不再放搜索框；分类按「衣食住行 + 电子设备」常用度重排，
 *    646 个杂项（basic）沉底。
 * ③ 【品牌图片】新增内置 glyph 层（simple-icons 192 个常用品牌，路径打进安装包）：
 *    浏览/搜索零网络秒出、App 离线可用；点选光栅化为 img: dataURL 随备份走。
 *    不在内置库的品牌继续走 favicon 链（自建代理缓存 30 天）。
 * ④ 【相册·拍照】合并为同一 tab，两个入口按钮；App 端零跳转。
 *
 * 存储约定：裸 lucide id / url:<https> / img:<dataURL>（与备份管线兼容）。
 * ⚠️ 铁律：搜索框文本输入非受控（defaultValue + onInput 存 state 仅供过滤）——IME 铁律。
 */

export type Tab = 'lib' | 'web' | 'img' | 'upload';

/** tab 定义：物品模式（系统图标 / 品牌图片 / 网络图片 / 相册·拍照）与订阅模式。 */
function tabsOf(systemMode: boolean): Array<{ key: Tab; label: string; Icon: typeof LayoutGrid }> {
  return systemMode
    ? [
        { key: 'lib', label: '系统图标', Icon: LayoutGrid },
        { key: 'web', label: '品牌图片', Icon: Link2 },
        { key: 'img', label: '网络图片', Icon: ImageIcon },
        { key: 'upload', label: '相册·拍照', Icon: Camera },
      ]
    : [
        { key: 'lib', label: '图标库', Icon: LayoutGrid },
        { key: 'web', label: '网络图标', Icon: Link2 },
        { key: 'upload', label: '本地上传', Icon: Upload },
      ];
}

/** 系统图标分类展示顺序：衣食住行 + 电子设备优先，basic 杂项（646 个）沉底。 */
const SYS_ORDER = [
  'clothing', 'kitchen', 'appliances', 'dianqi', 'furniture',
  'digital', 'traffic', 'tools', 'sports', 'toys',
  'cosmetic', 'jewelry', 'instruments', 'art', 'basic',
];
/** 重排后的系统图标分类（模块级常量，只算一次）。 */
const SYS_GROUPS_ORDERED: typeof SYSTEM_ICON_GROUPS = (() => {
  const map = new Map(SYSTEM_ICON_GROUPS.map((g) => [g.key, g]));
  return SYS_ORDER.map((k) => map.get(k)).filter(Boolean) as typeof SYSTEM_ICON_GROUPS;
})();

/** 图标服务基址：浏览器 = 当前站点；App = 当前服务器。
 *  ★v1.3.0 导出：SmartIconRow 的智能推荐链要用同一口径（不各写一份）。 */
export function iconBaseOf(): string {
  return currentServer()?.url ?? (typeof window !== 'undefined' ? window.location.origin : '');
}

/** 在线搜索结果（site 站点域名 / icon 图形图标；img 商品图片；thumb 缩略直链）。 */
interface OnlineHit {
  type?: 'site' | 'icon' | 'img';
  domain?: string;
  icon?: string;
  url?: string;
  thumb?: string;
}

/** 商品图预览渲染（缓存优先 + 原生通道抓取，永不裸 img 直连）。 */
function HitImg({ abs, alt }: { abs: string; alt?: string }) {
  const chain = useMemo(() => [abs], [abs]);
  const { src, done } = useCachedIconSrc(chain);
  if (!done || !src) {
    return <span className="h-full w-full rounded bg-surface-2" aria-label={alt} />;
  }
  return <img src={src} alt={alt ?? abs} className="h-full w-full" style={{ objectFit: 'contain' }} />;
}

/** 商品图代理相对路径（任意图床统一走自己服务器的 /api/img/get，缓存放心）。 */
function imgProxyUrl(raw: string): string {
  return `/api/img/get?u=${encodeURIComponent(raw)}`;
}

/** 商品图预览渲染（缓存优先 + 原生通道抓取，永不裸 img 直连；优先 Bing 缩略直链秒开）。 */
function ProductImg({ raw, thumb, alt }: { raw: string; thumb?: string; alt?: string }) {
  const chain = useMemo(() => [thumb ?? imgProxyUrl(raw)], [raw, thumb]);
  const { src, done } = useCachedIconSrc(chain);
  if (!done || !src) {
    return (
      <span
        className="flex h-full w-full items-center justify-center rounded-lg bg-surface-2 text-ink-3/40"
        aria-label={alt}
      >
        <ImageIcon size={16} />
      </span>
    );
  }
  return <img src={src} alt={alt ?? raw} className="h-full w-full rounded-lg" style={{ objectFit: 'cover' }} />;
}

/** 任意 dataURL 中心方裁到 ≤max 的正方形 JPEG（商品图入库用，随备份走）。 */
async function cropSquareDataUrl(dataUrl: string, max = 512): Promise<string> {
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    const t = setTimeout(() => resolve(null), 6000);
    el.onload = () => {
      clearTimeout(t);
      resolve(el);
    };
    el.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    el.src = dataUrl;
  });
  if (!img) return dataUrl; // 解码失败原样存
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const out = Math.min(max, side);
  const cv = document.createElement('canvas');
  cv.width = out;
  cv.height = out;
  const ctx = cv.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
  return cv.toDataURL('image/jpeg', 0.85);
}

/** 候选链 → 缓存 dataURL（命中即用；未命中走网络层抓取入库）。
 *  ★v1.0.30：初始值先走**同步** memo 命中 —— 品牌页上百按钮不再各自触发
 *  「await 查缓存 → setState」的渲染风暴（低端机主线程卡死白屏的直接来源）。 */
/**
 * ★v1.0.32：随包品牌资产（`/brand-icons/…`）直出。
 *
 * 为什么必须短路：这些图**已经在包里**（APK 的 assets / 站点的 /brand-icons/），
 * 再走 `iconCacheFetchAndStore` 就是「联网抓自己包里的图」——离线必挂、还白写一份
 * 缓存。且 URL 必须用**源站相对路径**而不是 `iconBaseOf()` 拼服务器地址，
 * 这样网页端解析到站点、APK 端解析到 `https://localhost`，两边同一个字面量都对。
 */
function bundledDirectSrc(chain: string[]): string | null {
  const first = chain[0];
  return first && first.startsWith('/brand-icons/') ? first : null;
}

function useCachedIconSrc(chain: string[]): { src: string | null; done: boolean } {
  const direct = bundledDirectSrc(chain);
  const key = chain.map((c) => normIconKey(c)).join('|');
  const [state, setState] = useState<{ src: string | null; done: boolean }>(() => {
    if (direct) return { src: direct, done: true };
    const hit = iconCacheLookupSync(chain);
    return hit ? { src: hit, done: true } : { src: null, done: false };
  });
  useEffect(() => {
    if (direct) {
      setState((prev) => (prev.done && prev.src === direct ? prev : { src: direct, done: true }));
      return;
    }
    let alive = true;
    const syncHit = iconCacheLookupSync(chain);
    if (syncHit) {
      setState((prev) => (prev.done && prev.src === syncHit ? prev : { src: syncHit, done: true }));
      return;
    }
    setState({ src: null, done: false });
    void (async () => {
      const hit = await iconCacheLookup(key.split('|'));
      if (hit) {
        if (alive) setState({ src: hit, done: true });
        return;
      }
      const data = await iconCacheFetchAndStore(key.split('|').map((k) => absFromKey(k)));
      if (alive) setState({ src: data, done: true });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, direct]);
  return state;
}

/** 相对键 → 抓取用绝对 URL。 */
function absFromKey(k: string): string {
  if (/^https?:\/\//i.test(k)) return k;
  const base = iconBaseOf();
  return base ? `${base}${k.startsWith('/') ? '' : '/'}${k}` : k;
}

/** 网络图标（缓存 dataURL 优先）+ 固定尺寸容器：任何站点的图标都显示成一样大。 */
export function BrandImg({
  base,
  domain,
  size = 24,
  alt,
}: {
  base: string;
  domain: string;
  size?: number;
  alt?: string;
}) {
  const chain = useMemo(() => faviconChain(base, domain), [base, domain]);
  const { src, done } = useCachedIconSrc(chain);
  if (!done) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-3/40"
        style={{ width: size, height: size }}
        aria-label={alt}
      />
    );
  }
  if (src) {
    return (
      <span className="flex shrink-0 items-center justify-center overflow-hidden" style={{ width: size, height: size }}>
        <img
          src={src}
          width={size}
          height={size}
          alt={alt ?? domain}
          className="h-full w-full"
          style={{ objectFit: 'contain' }}
        />
      </span>
    );
  }
  // 全部源失败：中性兜底（域名首字符）
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-3"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      aria-label={alt}
    >
      {domain.charAt(0).toUpperCase()}
    </span>
  );
}

/** 相对代理路径（/api/icon/proxy?u=…）→ 绝对 URL；已是绝对原样返回。 */
export function absIconUrl(u: string | undefined, base: string): string {
  if (!u) return '';
  return u.startsWith('/') ? `${base}${u}` : u;
}

/** 内置品牌 glyph 渲染（内联 SVG，零网络零延迟）。 */
export function GlyphImg({ item, size = 24 }: { item: GlyphItem; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={item.name}>
      <path d={item.path} fill={`#${item.hex}`} />
    </svg>
  );
}

/** 预览：任意 icon 值（builtin / url: / img:）→ 可视节点。
 *  网络值不吃 WebView 直连：本地缓存 dataURL 命中即显；未命中统一网络层抓取入库。
 *  ★v1.0.31 铁律修复：brand 分支必须独立成组件——旧写法在同组件内
 *  「brand 提前 return（1 个 hook）↔ 非 brand 走满 7 个 hook」，值一切换
 *  hooks 数量变化 → React #300 整树崩溃（「添加物品选品牌图片必崩」的真凶，
 *  v1.0.19 起埋雷）。 */
export function IconPreview({
  icon,
  size = 22,
  className,
  fallbackBg,
  fallbackFg,
}: {
  icon: string;
  size?: number;
  className?: string;
  fallbackBg?: string;
  fallbackFg?: string;
}) {
  const v = (icon ?? '').trim();

  /* brand: 引用码 → 内置 glyph 即时渲染（v1.0.19，零网络零数据）。 */
  if (v.startsWith('brand:')) {
    const glyph = glyphBySlug(v.slice(6));
    if (glyph) {
      return (
        <span
          className={`flex items-center justify-center ${className ?? ''}`}
          style={{ width: size, height: size }}
        >
          <GlyphImg item={glyph} size={Math.round(size * 0.92)} />
        </span>
      );
    }
    const Fb = subIconOf('tag');
    return <Fb size={size} className={className} />;
  }
  return (
    <IconPreviewPlain
      v={v}
      size={size}
      className={className}
      fallbackBg={fallbackBg}
      fallbackFg={fallbackFg}
    />
  );
}

/** 非 brand 预览（url: / img: / 裸 lucide id）。hooks 全部无条件执行，不可提前 return 到 hooks 之前。 */
function IconPreviewPlain({
  v,
  size,
  className,
  fallbackBg,
  fallbackFg,
}: {
  v: string;
  size: number;
  className?: string;
  fallbackBg?: string;
  fallbackFg?: string;
}) {
  const isUrl = v.startsWith('url:');
  const isImg = v.startsWith('img:');
  const raw = isUrl ? v.slice(4).trim() : '';
  /** ★v1.0.33：随包分发的品牌图标（/brand-icons/…）——直出，零网络零缓存。 */
  const isBundled = isUrl && raw.startsWith('/brand-icons/');

  const chain = useMemo<string[]>(() => {
    if (!isUrl || !raw || isBundled) return [];
    const list = [raw];
    if (raw.includes('api.iconify.design')) {
      const base = iconBaseOf();
      if (base) list.unshift(`${base}/api/icon/proxy?u=${encodeURIComponent(raw)}`);
    } else {
      const m = raw.match(/[?&]d=([^&]+)/);
      if (m) {
        const d = decodeURIComponent(m[1]);
        list.push(`https://icon.horse/i/${d}`, `https://favicon.im/${d}`);
      }
    }
    return list;
  }, [isUrl, raw, isBundled]);

  const { src, done } = useCachedIconSrc(chain);
  const [imgBroken, setImgBroken] = useState(false);
  useEffect(() => setImgBroken(false), [v]);

  if (isBundled) {
    return (
      <span
        className={`flex items-center justify-center overflow-hidden ${className ?? ''}`}
        style={{ width: size, height: size, background: fallbackBg }}
      >
        <img src={raw} width={size} height={size} alt="" className="h-full w-full object-contain" />
      </span>
    );
  }

  if (isImg && !imgBroken) {
    return (
      <img
        src={v.slice(4).trim()}
        width={size}
        height={size}
        alt=""
        className={className}
        style={{ borderRadius: 6, objectFit: 'cover' }}
        onError={() => setImgBroken(true)}
      />
    );
  }
  if (isUrl) {
    if (src) {
      return (
        <img
          src={src}
          width={size}
          height={size}
          alt=""
          className={className}
          style={{ borderRadius: 6, objectFit: 'contain', background: fallbackBg }}
        />
      );
    }
    if (!done) {
      const Placeholder = subIconOf(v);
      return <Placeholder size={size} className={`${className ?? ''} opacity-30`} style={fallbackFg ? { color: fallbackFg } : undefined} />;
    }
  }
  const Cmp = subIconOf(v);
  return <Cmp size={size} className={className} style={fallbackFg ? { color: fallbackFg } : undefined} />;
}

/** 品牌图标按钮（favicon 链，固定 24px 容器）。 */
function BrandButton({
  brand,
  base,
  active,
  onPick,
}: {
  brand: BrandItem;
  base: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={brand.name}
      className={`flex flex-col items-center gap-1 rounded-btn border py-2 transition-all active:scale-95 ${
        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2'
      }`}
    >
      <BrandImg base={base} domain={brand.domain} size={24} alt={brand.name} />
      <span className="w-full truncate px-0.5 text-center text-[11px] text-ink-2">{brand.name}</span>
    </button>
  );
}

/** 内置品牌按钮（内联 SVG 秒显；点选光栅化为 img: dataURL）。 */
function GlyphButton({
  item,
  active,
  onPick,
}: {
  item: GlyphItem;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={item.name}
      className={`flex flex-col items-center gap-1 rounded-btn border py-2 transition-all active:scale-95 ${
        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2'
      }`}
    >
      <span className="flex h-6 items-center justify-center">
        <GlyphImg item={item} size={22} />
      </span>
      <span className="w-full truncate px-0.5 text-center text-[11px] text-ink-2">{item.name}</span>
    </button>
  );
}

/** 分区标题。 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-medium text-ink-3">{children}</p>;
}

/* ============================================================================
 * 懒渲染分区：滚到可视区附近才挂载网格（v1.0.18 闪屏根治）。
 * 占位高度按行列估算，滚动不跳动；挂载后不再卸载。
 * ==========================================================================*/
function LazySection({
  id,
  label,
  count,
  cols,
  rowH,
  rootMargin = '500px 0px',
  children,
}: {
  id?: string;
  label: string;
  count: number;
  cols: number;
  /** 单元格高 + 间距（px）。 */
  rowH: number;
  /**
   * 提前挂载距离（v1.0.29）。默认 500px；**网络图标区一律收紧到 150px**——
   * 品牌页 187 个 favicon，挂载就得抓网络 + 写磁盘，提前太多会把首屏拖垮。
   */
  rootMargin?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;
    // ★v1.0.30 兜底：IntersectionObserver 回调在主线程拥堵时会显著延迟，
    // 表现为「分组标题在、内容整块空白」（用户录屏实测）。挂载时先同步量一次
    // 视口位置，本来就在可视范围内的直接显示，不等 IO。
    try {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight + 500 && rect.bottom > -500) {
        setShown(true);
        return;
      }
    } catch {
      /* 忽略 */
    }
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  const minH = 24 + Math.ceil(count / cols) * rowH;

  return (
    <div ref={ref} id={id} style={shown ? undefined : { minHeight: minH }}>
      <SectionLabel>
        {label}
        <span className="ml-1 text-ink-3/70">({count})</span>
      </SectionLabel>
      {shown ? children : null}
    </div>
  );
}

/**
 * 分片网格（v1.0.29 · 卡死根治）：单个分区最多可达 646 个节点（basic 杂项），
 * 一次性同步渲染就是一个几百毫秒的长任务 → WebView 白屏卡顿、点不动。
 * 这里改为「先出一屏，其余分帧补齐」，把长任务切成多帧，交互不被阻塞。
 */
function ProgressiveGrid<T>({
  items,
  cols,
  rowH,
  step = 80,
  render,
}: {
  items: readonly T[];
  cols: number;
  rowH: number;
  step?: number;
  render: (item: T, i: number) => React.ReactNode;
}) {
  const [n, setN] = useState(0);
  const total = items.length;
  useEffect(() => {
    setN(0);
  }, [items]);
  useEffect(() => {
    if (total === 0) return;
    if (n === 0) {
      setN(Math.min(step, total));
      return;
    }
    if (n >= total) return;
    const id = window.setTimeout(() => setN((v) => Math.min(total, v + step)), 16);
    return () => window.clearTimeout(id);
  }, [n, total, step]);
  const shown = items.slice(0, Math.max(n, Math.min(step, total)));
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {shown.map((it, i) => render(it, i))}
      {shown.length < total ? (
        <div
          aria-hidden
          className="rounded-btn border border-dashed border-line/60"
          style={{ height: Math.max(rowH - 8, 24) }}
        />
      ) : null}
    </div>
  );
}

export default function IconPicker({
  value,
  onChange,
  onFilePicked,
  systemMode = false,
  initialTab,
}: {
  value: string;
  onChange: (icon: string) => void;
  /** 传入则接管本地上传（如物品表单的大图裁剪流程）；不传走默认 96px 压缩。 */
  onFilePicked?: (file: File) => void;
  /** 物品模式：系统图标大库 + 品牌内置层 + 网络图片 + 相册·拍照。 */
  systemMode?: boolean;
  /** 初始 tab。 */
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'lib');
  /** 搜索关键词（只用于过滤，不回写输入框——IME 铁律）。 */
  const [query, setQuery] = useState('');
  const [onlineHits, setOnlineHits] = useState<OnlineHit[] | null>(null);
  const [imgHits, setImgHits] = useState<OnlineHit[] | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const albumRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const base = useMemo(iconBaseOf, []);

  /**
   * 切 tab：★v1.0.19 修复「搜完品牌切系统图标没法选」——
   * 搜索词跨 tab 残留会让 lib tab 卡在（空的）搜索态，只有退出重进。
   * 切换即清空全部搜索状态并重置输入框 DOM 值。
   */
  const switchTab = (k: Tab): void => {
    if (k === tab) return;
    setTab(k);
    setQuery('');
    setOnlineHits(null);
    setImgHits(null);
    setOnlineBusy(false);
    if (searchRef.current) searchRef.current.value = '';
  };

  const q = query.trim().toLowerCase();

  /** 图标库过滤（订阅模式用；物品模式系统图标不搜索）。 */
  const subGroups = useMemo(
    () => SUB_ICON_GROUPS.map((g) => ({ label: g.label, items: g.items.map((it) => ({ id: it.id })) })),
    [],
  );
  const libGroups = useMemo(() => {
    if (!q) return subGroups;
    return subGroups.map((g) => ({ ...g, items: g.items.filter((it) => it.id.includes(q)) })).filter(
      (g) => g.items.length > 0,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, subGroups]);

  /** 本地搜索：内置品牌 glyph + favicon 品牌库（双库一次出齐，零网络秒出）。 */
  const glyphHits = useMemo(() => (q && tab === 'web' ? searchGlyphs(query) : null), [q, query, tab]);
  const brandHits = useMemo(() => (q ? searchBrands(query) : null), [q, query]);
  const domainHit = useMemo(
    () => (q && tab === 'web' && !glyphHits?.length && !brandHits?.length ? normalizeDomainInput(query) : null),
    [q, glyphHits, brandHits, query, tab],
  );

  /** 品牌搜索结果即时预热缓存（下次点开秒显，利用本机网络并行抓取）。 */
  useEffect(() => {
    if (!brandHits || brandHits.length === 0) return;
    void warmIconCache(
      brandHits
        .slice(0, 12)
        .map((b) => brandIconSrc(base, b.domain))
        // ★v1.0.32：随包资产（/brand-icons/…）已在包里，预热等于联网抓自己的图
        .filter((u) => !u.startsWith('/brand-icons/')),
      base,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandHits, base]);

  /* 在线搜索：走统一网络层 get()（CapacitorHttp 原生通道不受 CORS 限制）。 */
  const runOnlineSearch = (kwRaw: string): void => {
    const kw = kwRaw.trim();
    setOnlineHits(null);
    setImgHits(null);
    if (kw.length < 2) {
      setOnlineBusy(false);
      return;
    }
    setOnlineBusy(true);
    if (tab === 'img') {
      get<{ ok?: boolean; items?: OnlineHit[] }>({ url: base }, '/api/img/search', { q: kw }, 10000)
        .then((res) => {
          const items = res.data?.ok && Array.isArray(res.data.items) ? res.data.items : [];
          setImgHits(items);
          const urls = items
            .map((h) => (h.thumb ? absIconUrl(h.thumb, base) : ''))
            .filter(Boolean);
          if (urls.length > 0) void warmIconCache(urls, base);
        })
        .catch(() => setImgHits([]))
        .finally(() => setOnlineBusy(false));
      return;
    }
    get<{ ok?: boolean; items?: OnlineHit[] }>({ url: base }, '/api/icon/search', { q: kw }, 8000)
      .then((res) => {
        const items = res.data?.ok && Array.isArray(res.data.items) ? res.data.items : [];
        setOnlineHits(items);
        const urls = items
          .map((h) =>
            h.type === 'icon' && h.url
              ? absIconUrl(h.url, base)
              : h.domain
                ? brandIconSrc(base, h.domain)
                : '',
          )
          .filter(Boolean);
        if (urls.length > 0) void warmIconCache(urls, base);
      })
      .catch(() => setOnlineHits([]))
      .finally(() => setOnlineBusy(false));
  };

  /**
   * 点选商品图片（v1.0.20 兜底链）：原图代理 → Bing 缩略直链 → 缩略经代理，
   * 抓取上限放宽到 8MB（原图 500KB+ 曾被 400KB 限制拦截报「抓取失败」）；
   * 到手即中心方裁 ≤512 → 压缩 ≤100KB → 存 img: dataURL。
   */
  const pickProductImage = async (raw: string, thumb?: string): Promise<void> => {
    const BIG = 8_000_000;
    const candidates = [
      absIconUrl(imgProxyUrl(raw), base),
      ...(thumb ? [absIconUrl(thumb, base), absIconUrl(imgProxyUrl(thumb), base)] : []),
    ];
    try {
      let data: string | null = null;
      for (const c of candidates) {
        data = await fetchIconAsDataUrl(c, BIG);
        if (data) break;
      }
      if (!data) {
        toastError('图片抓取失败，换一张试试');
        return;
      }
      const square = await cropSquareDataUrl(data, 512);
      const slim = await compressDataUrlUnder(square, IMAGE_MAX_KB, 512);
      void haptic('select');
      onChange(toImgIcon(slim));
      void warmIconCache([absIconUrl(imgProxyUrl(raw), base)], base);
    } catch {
      toastError('图片处理失败，换一张试试');
    }
  };

  /**
   * 点选内置品牌 glyph → 存 `brand:slug` 引用码（v1.0.19）。
   * 渲染时由 IconPreview / 分享海报即时绘制，备份只带几个字节（原 dataURL 方案一套头像就几十 KB）。
   */
  const pickGlyph = (g: GlyphItem): void => {
    void haptic('select');
    onChange(`brand:${g.slug}`);
  };

  /** ★v1.0.33：品牌点选值 = 随包资产优先（/brand-icons/…），无资产才回落代理直链。
   *  物品与订阅共用同一份品牌库与同一套引用 → 同一品牌天然共享同一张图。 */
  const brandValueOf = (domain: string): string => toUrlIcon(brandIconRef(base, domain));
  const isBrandValuePicked = (domain: string): boolean =>
    value === brandValueOf(domain) || value === toUrlIcon(iconApiUrl(base, domain)); // 兼容旧数据

  /** 点选图标：写值 + 立即预热入库。 */
  const pickIcon = (iconValue: string, warmSrc?: string): void => {
    void haptic('select');
    onChange(iconValue);
    if (warmSrc) void warmIconCache([warmSrc], base);
  };

  /* 防抖 300ms 自动检索。 */
  useEffect(() => {
    const kw = query.trim();
    if (kw.length < 2) {
      setOnlineBusy(false);
      return;
    }
    const timer = setTimeout(() => runOnlineSearch(kw), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, base]);

  /* 搜索触发：事件 + 150ms 轮询双保险（IME 铁律）。 */
  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;
    let last = el.value;
    const sync = (): void => {
      if (el.value === last) return;
      last = el.value;
      setQuery(el.value);
    };
    const fire = (): void => runOnlineSearch(el.value);
    const onKeyUp = (e: KeyboardEvent): void => {
      if ((e.key === 'Enter' || e.keyCode === 13) && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        fire();
      }
    };
    const onCompoEnd = (): void => {
      sync();
      fire();
    };
    el.addEventListener('input', sync);
    el.addEventListener('compositionupdate', sync);
    el.addEventListener('compositionend', onCompoEnd);
    el.addEventListener('keyup', onKeyUp);
    el.addEventListener('search', fire);
    const iv = window.setInterval(sync, 150);
    return () => {
      window.clearInterval(iv);
      el.removeEventListener('input', sync);
      el.removeEventListener('compositionupdate', sync);
      el.removeEventListener('compositionend', onCompoEnd);
      el.removeEventListener('keyup', onKeyUp);
      el.removeEventListener('search', fire);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, tab]);

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (onFilePicked) {
      onFilePicked(file);
      return;
    }
    setUploadBusy(true);
    try {
      const dataUrl = await compressIconFile(file, 96);
      onChange(toImgIcon(dataUrl));
    } catch (e) {
      toastError(e instanceof Error ? e.message : '图片处理失败');
    } finally {
      setUploadBusy(false);
    }
  };

  /* —— 搜索态派生 —— */
  /** 物品模式 lib tab：无搜索框（需求 v1.0.18③），永远浏览态（不受残留搜索词影响）。 */
  const sysLib = systemMode && tab === 'lib';
  const searching = q !== '' && !sysLib && (tab === 'lib' || tab === 'web');
  const imgSearching = q !== '' && tab === 'img';
  const iconHits = useMemo(
    () => (onlineHits ?? []).filter((h) => h.type === 'icon' && h.url),
    [onlineHits],
  );
  const siteHits = useMemo(
    () => (onlineHits ?? []).filter((h) => h.domain),
    [onlineHits],
  );
  const onlineEmpty =
    !onlineBusy && onlineHits !== null && iconHits.length === 0 && siteHits.length === 0;
  const localEmpty = libGroups.length === 0 && !glyphHits?.length && (!brandHits || brandHits.length === 0) && !domainHit;
  const allEmpty = searching && localEmpty && (q.length < 2 || onlineEmpty);

  /** 通用搜索框（IME 铁律：非受控）。 */
  const SearchBox = (
    <div className="flex h-9 items-center gap-2 rounded-btn border border-line bg-surface-2 px-2.5 focus-within:border-accent">
      <button
        type="button"
        aria-label="搜索"
        onClick={() => searchRef.current && runOnlineSearch(searchRef.current.value)}
        className="shrink-0 text-ink-3 active:text-accent"
      >
        <Search size={14} />
      </button>
      <input
        ref={searchRef}
        type="search"
        defaultValue=""
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          const ke = e.nativeEvent;
          if ((e.key === 'Enter' || ke.keyCode === 13) && !ke.isComposing && ke.keyCode !== 229) {
            e.preventDefault();
            runOnlineSearch((e.target as HTMLInputElement).value);
          }
        }}
        enterKeyHint="search"
        placeholder={systemMode ? '搜品牌 / 任意英文词…' : '搜图标：耳机、水杯、微信、任一英文词…'}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-3"
      />
    </div>
  );

  /* —— 浏览态：系统图标 tab（无搜索 + 常用分类前置 + 懒渲染） —— */
  const sysLibView = (
    <>
      <div className="sticky top-0 z-10 -mx-1 flex gap-1.5 overflow-x-auto bg-surface px-1 py-1">
        {SYS_GROUPS_ORDERED.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => document.getElementById(`sysgrp-${g.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="shrink-0 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-2 active:scale-95"
          >
            {g.label}
            <span className="ml-0.5 text-ink-3/70">{g.items.length}</span>
          </button>
        ))}
      </div>
      {SYS_GROUPS_ORDERED.map((g) => (
        <LazySection key={g.key} id={`sysgrp-${g.key}`} label={g.label} count={g.items.length} cols={8} rowH={48}>
          <ProgressiveGrid
            items={g.items}
            cols={8}
            rowH={48}
            render={(id) => {
              const Icon = subIconOf(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    void haptic('select');
                    onChange(id);
                  }}
                  aria-label={id}
                  title={id}
                  className={`flex h-10 items-center justify-center rounded-btn border transition-all active:scale-95 ${
                    value === id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-ink-2'
                  }`}
                >
                  <Icon size={18} />
                </button>
              );
            }}
          />
        </LazySection>
      ))}
    </>
  );

  /* —— 浏览态：订阅模式图标库 tab（★v1.0.31 修复：此前误落到品牌 favicon
     网格，导致「图标库跟网络图标一模一样」） —— */
  const subLibView = (
    <>
      {libGroups.map((g) => (
        <LazySection key={g.label} label={g.label} count={g.items.length} cols={8} rowH={48}>
          <div className="grid grid-cols-8 gap-2">
            {g.items.map(({ id }) => {
              const Icon = subIconOf(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    void haptic('select');
                    onChange(id);
                  }}
                  aria-label={id}
                  title={id}
                  className={`flex h-10 items-center justify-center rounded-btn border transition-all active:scale-95 ${
                    value === id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-ink-2'
                  }`}
                >
                  <Icon size={18} />
                </button>
              );
            })}
          </div>
        </LazySection>
      ))}
    </>
  );

  /* —— 浏览态：品牌图片 tab（内置 glyph 组 + favicon 品牌组，全部懒渲染） —— */
  /**
   * favicon 品牌组：每组独立懒挂载 + 提前量收紧到 150px（v1.0.29）。
   * 旧实现把 187 个 BrandButton 塞进**一个** LazySection —— 一旦触发展开，
   * 187 次网络抓取 + 187 次 Preferences 写同时排队，主线程直接被压死（实测白屏 15s）。
   * 按组拆分后首屏只挂载 1~2 组（20~30 个），其余滚动到眼前才动。
   */
  const brandSections = BRAND_GROUPS.map((group) => (
    <LazySection
      key={group.label}
      label={group.label}
      count={group.items.length}
      cols={5}
      rowH={64}
      rootMargin="150px 0px"
    >
      <div className="grid grid-cols-5 gap-2">
        {group.items.map((b) => (
          <BrandButton
            key={b.domain + b.name}
            brand={b}
            base={base}
            active={isBrandValuePicked(b.domain)}
            onPick={() => pickIcon(toUrlIcon(brandIconRef(base, b.domain)), brandIconSrc(base, b.domain))}
          />
        ))}
      </div>
    </LazySection>
  ));

  const brandBrowse = systemMode ? (
    <>
      {GLYPH_GROUPS.map((g) => (
        <LazySection key={g.label} label={`${g.label} · 内置`} count={g.items.length} cols={5} rowH={64}>
          <div className="grid grid-cols-5 gap-2">
            {g.items.map((it) => (
              <GlyphButton key={it.slug} item={it} active={value === `brand:${it.slug}`} onPick={() => pickGlyph(it)} />
            ))}
          </div>
        </LazySection>
      ))}
      <SectionLabel>
        更多品牌（官网图标）
        <span className="ml-1 text-ink-3/70">({BRAND_GROUPS.reduce((a, g) => a + g.items.length, 0)})</span>
      </SectionLabel>
      {brandSections}
    </>
  ) : (
    brandSections
  );

  return (
    <div>
      {/* 来源 tab */}
      <div className="mb-2 flex gap-1 rounded-btn bg-surface-2 p-1">
        {tabsOf(systemMode).map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-btn text-xs font-medium ${
              tab === key ? 'bg-surface text-accent shadow-sm' : 'text-ink-3'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* 当前选中预览 */}
      <div className="mb-2 flex items-center gap-2.5">
        <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-accent-soft text-accent">
          <IconPreview icon={value} size={22} />
        </span>
        <span className="text-xs text-ink-3">
          {tab === 'upload'
            ? uploadBusy
              ? '处理中…'
              : '相册选一张或现场拍一张，自动裁方'
            : tab === 'img'
              ? '搜商品名称或型号，出真实商品图'
              : sysLib
              ? '按分类浏览 · 点击即选中'
            : tab === 'lib' && !systemMode
              ? '点击即选中，或搜索过滤'
              : searching
                ? '内置品牌秒出，在线图标随后补齐'
                : '内置品牌离线秒显，点击即采用'}
        </span>
      </div>

      {tab === 'img' ? (
        /* —— 网络图片：商品图专用搜索（大图九宫格） —— */
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {SearchBox}
          {imgSearching ? (
            onlineBusy ? (
              <p className="py-6 text-center text-xs text-ink-3">正在检索商品图…</p>
            ) : imgHits && imgHits.length > 0 ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {imgHits.map((h) =>
                    h.url ? (
                      <button
                        key={h.url}
                        type="button"
                        onClick={() => void pickProductImage(h.url!, h.thumb)}
                        title="采用此商品图"
                        aria-label="采用此商品图"
                        className="aspect-square overflow-hidden rounded-xl border border-line bg-surface-2 transition-all active:scale-95"
                      >
                        <ProductImg raw={h.url} thumb={h.thumb} />
                      </button>
                    ) : null,
                  )}
                </div>
                <p className="text-[11px] text-ink-3">点选自动裁正方形存入本地 · 随备份携带 · 永久离线可用</p>
              </>
            ) : (
              <p className="rounded-card border border-dashed border-line bg-surface-2 p-4 text-center text-xs text-ink-3">
                没有找到「{query}」的商品图，换个说法（品牌 + 型号）试试
              </p>
            )
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-line bg-surface-2 px-4 py-8 text-center">
              <ImageIcon size={24} className="text-ink-3/60" />
              <p className="text-xs text-ink-3">搜「手机型号 / 相机 / 家电」等，直接出真实商品缩略图</p>
            </div>
          )}
        </div>
      ) : tab === 'upload' ? (
        /* —— 相册·拍照（v1.0.18 合并双入口） —— */
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => albumRef.current?.click()}
            disabled={uploadBusy}
            className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-surface-2 text-xs text-ink-3 disabled:opacity-50"
          >
            <ImageIcon size={22} />
            {uploadBusy ? '压缩处理中…' : '从相册选一张'}
          </button>
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            disabled={uploadBusy}
            className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-surface-2 text-xs text-ink-3 disabled:opacity-50"
          >
            <Camera size={22} />
            现场拍一张
          </button>
          <input
            ref={albumRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              void pickFile(f);
            }}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              void pickFile(f);
            }}
          />
        </div>
      ) : (
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {/* 物品模式系统图标 tab：无搜索框（v1.0.18③）；其余 tab 保留搜索 */}
          {!sysLib ? SearchBox : null}

          {searching ? (
            <>
              {/* ① 本地图标库（订阅模式 lib 搜索 / 网页模式兜底） */}
              {tab === 'lib' && libGroups.length > 0 ? (
                <div>
                  <SectionLabel>内置图标</SectionLabel>
                  <div className="space-y-3">
                    {libGroups.map((group) => (
                      <div key={group.label}>
                        <p className="mb-1 text-[11px] text-ink-3/80">{group.label}</p>
                        <div className="grid grid-cols-8 gap-2">
                          {group.items.map(({ id }) => {
                            const Icon = subIconOf(id);
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => onChange(id)}
                                aria-label={id}
                                title={id}
                                className={`flex h-10 items-center justify-center rounded-btn border transition-all active:scale-95 ${
                                  value === id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-ink-2'
                                }`}
                              >
                                <Icon size={18} />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ② 内置品牌（本地数据零网络秒出） */}
              {glyphHits && glyphHits.length > 0 ? (
                <div>
                  <SectionLabel>内置品牌</SectionLabel>
                  <div className="grid grid-cols-5 gap-2">
                    {glyphHits.map((g) => (
                      <GlyphButton key={g.slug} item={g} active={value === `brand:${g.slug}`} onPick={() => pickGlyph(g)} />
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ③ favicon 品牌库 */}
              {brandHits && brandHits.length > 0 ? (
                <div>
                  <SectionLabel>品牌图标（官网）</SectionLabel>
                  <div className="grid grid-cols-5 gap-2">
                    {brandHits.map((b) => (
                      <BrandButton
                        key={b.domain + b.name}
                        brand={b}
                        base={base}
                        active={isBrandValuePicked(b.domain)}
                        onPick={() => pickIcon(toUrlIcon(brandIconRef(base, b.domain)), brandIconSrc(base, b.domain))}
                      />
                    ))}
                  </div>
                </div>
              ) : domainHit ? (
                <div>
                  <SectionLabel>域名直取</SectionLabel>
                  <button
                    type="button"
                    onClick={() => pickIcon(toUrlIcon(brandIconRef(base, domainHit)), brandIconSrc(base, domainHit))}
                    className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line bg-surface-2 py-3 text-xs text-ink-2 active:scale-[0.99]"
                  >
                    <BrandImg base={base} domain={domainHit} size={20} />
                    获取 {domainHit} 的图标
                  </button>
                </div>
              ) : null}

              {/* ④ 在线图标（同一关键词自动检索） */}
              {q.length >= 2 && tab === 'web' ? (
                <div>
                  <SectionLabel>
                    在线图标
                    {onlineBusy ? <span className="ml-1 font-normal text-ink-3/70">搜索中…</span> : null}
                  </SectionLabel>
                  {onlineBusy ? (
                    <p className="py-3 text-center text-xs text-ink-3">正在检索图标…</p>
                  ) : (
                    <>
                      {iconHits.length > 0 ? (
                        <div className="mb-2 grid grid-cols-8 gap-2">
                          {iconHits.map((h) => {
                            const abs = absIconUrl(h.url, base);
                            return (
                              <button
                                key={h.icon}
                                type="button"
                                onClick={() => pickIcon(`url:${abs}`, abs)}
                                title={h.icon}
                                aria-label={h.icon}
                                className={`flex h-10 items-center justify-center rounded-btn border bg-surface p-1.5 transition-all active:scale-95 ${
                                  value === `url:${abs}` ? 'border-accent bg-accent-soft' : 'border-line'
                                }`}
                              >
                                <HitImg abs={abs} alt={h.icon} />
                              </button>
                            );
                          })}
                        </div>
                      ) : null}

                      {siteHits.length > 0 ? (
                        <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
                          {siteHits.map((h) => (
                            <li key={h.domain}>
                              <button
                                type="button"
                                onClick={() => pickIcon(toUrlIcon(brandIconRef(base, h.domain!)), brandIconSrc(base, h.domain!))}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left active:bg-surface-2 ${
                                  value === brandValueOf(h.domain!) ? 'bg-accent-soft' : ''
                                }`}
                              >
                                <BrandImg base={base} domain={h.domain!} size={22} />
                                <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{h.domain}</span>
                                <span className="text-[11px] text-accent">采用</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {allEmpty ? (
                <p className="rounded-card border border-dashed border-line bg-surface-2 p-4 text-center text-xs text-ink-3">
                  没有找到「{query}」，换个说法试试，或切「网络图片 / 相册·拍照」
                </p>
              ) : null}
            </>
          ) : (
            /* 浏览态：lib tab = 系统图标（物品）/ 订阅图标库（订阅）；web tab = 品牌 */
            sysLib ? sysLibView : tab === 'lib' ? subLibView : brandBrowse
          )}
        </div>
      )}
    </div>
  );
}
