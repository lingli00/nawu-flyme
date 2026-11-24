import type { Goods, GoodsImage } from '../types/entities';
import { cloudSrcOf, isCloudImageUrl, shaFromImageUrl } from './imageCloud';

/**
 * 物品图标单一真相源（v1.0.29 · 「选系统图标无效」根治）。
 *
 * 背景：物品的图片是对象形态 `{ source, ref }`，而 IconPicker 输出的是
 * 三形态字符串（裸 lucide id / `url:` / `img:`）。此前转换逻辑散落在
 * HomePage 内联函数与 shareCard 各写一份：
 * - HomePage 的 `onIconChange` 遇到裸 lucide id 直接 `setImage(undefined)`
 *   → 用户在「系统图标」里点什么都选不中（永远回落分类图标）；
 * - shareCard 的 `goodsIconValue` 缺 builtin 分支 → 分享海报 / 置物墙丢图；
 * - 列表卡与详情弹窗硬编码 `url:${ref}` → 本地图之外的形态全渲染错。
 *
 * 铁律：凡是 Goods.image ↔ icon 字符串互转，一律走这里的两个函数，别再内联。
 *
 * ★v1.7.7（「AI API 导入的物品图片不显示 / 详情打开就崩」根治）新增两条容错：
 * 1. **裸 base64 自愈**：AI API 直写数据库时 `image.ref` 只有 base64、没有
 *    `data:image/…;base64,` 前缀，旧逻辑 `startsWith('data:')` 判不出本地图 →
 *    返回空串 → 图片消失。现在识别为 base64 就自动补前缀（按首字节判真实格式）。
 * 2. **字符串型 image 兼容**：有些调用方 / 导入数据传的是 `"https://…"` 或
 *    `"data:image/…"` 字符串而不是 `{source, ref}` 对象，也要能认。
 *
 * ★v1.8.0 图片云托管（本地存储膨胀 / 每次备份全量传图）新增第四形态：
 *    `{ source:'cloud', ref:'/api/user/images/<sha>?t=&s=', sha256, thumb? }`
 * 关键约定（保证「不丢图 / 不崩」）：
 * - `goodsIconValue()` 输出 **`url:` + 云端 URL** —— 不为云端新增前缀，这样所有
 *   既有分支（IconPreview / CachedUrlImg / 分享卡）零改动就能渲染；
 * - 云端图**手里同时有本地缩略图（thumb）时优先画缩略图**（离线可用、URL 过期也能看），
 *   只有缩略图缺失才走网络；`cloudUrl()` 单独给出网络地址供分享卡抓高清；
 * - 存量 `data:` base64 **完全不受影响**：仍输出 `img:<dataURL>`，仍走原渲染分支。
 */
export type GoodsIconSource = 'local' | 'web' | 'brand' | 'builtin' | (string & {});

/**
 * 本地图可接受的 image 入参：标准对象，或历史/导入遗留的字符串形态。
 *
 * ★v1.8.0 修正：把 `string` 从联合里去掉后，**所有路径**都只有 `ImageLike` 一种入参
 * （原来 `goodsIconValue`/`isLocalImage` 直接收字符串是死代码 —— `Pick<Goods,'image'>`
 * 让入参永远是个对象，传字符串进来运行时 `g?.image` 是 undefined、`ref` 取到 `''`）。
 * 历史「字符串当入参」的写法统一走 `{ image: '<str>' }` 包装，行为完全一致。
 */
type ImageLike =
  | Pick<Goods, 'image'>
  | { image?: GoodsImage | string | null }
  | null
  | undefined;

/** 裸 base64 判定阈值：短串（如 'AA'）不收，避免把普通文本误判成图片。 */
const BARE_BASE64_MIN = 100;
const BARE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * base64 开头几字节 → 真实图片 MIME（判不出按 jpeg，与上传链路默认一致）。
 *
 * - JPEG：`FF D8 FF` → `/9j/`
 * - PNG ：`89 50 4E 47` → `iVBORw0KGgo`
 * - GIF ：`47 49 46 38` → `R0lGOD`
 * - WEBP：`52 49 46 46`…`57 45 42 50` → `UklGR…WEBP`
 */
function mimeOfBase64(body: string): string {
  if (body.startsWith('/9j/')) return 'image/jpeg';
  if (body.startsWith('iVBORw0KGgo')) return 'image/png';
  if (body.startsWith('R0lGOD')) return 'image/gif';
  if (body.startsWith('UklGR') && body.slice(12, 16) === 'WEBP') return 'image/webp';
  if (body.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

/** 字符串是否「看起来像裸 base64」（够长 + 字符集合法 + 不是 URL/单词）。 */
export function isBareBase64Image(ref: string): boolean {
  const s = (ref ?? '').trim();
  if (s.length <= BARE_BASE64_MIN) return false;
  return BARE_BASE64_RE.test(s);
}

/**
 * 任意图片引用 → 可直接塞进 `<img src>` 的 dataURL。
 *
 * - 已带 `data:` 前缀：原样返回（util 已合法）；
 * - 裸 base64：自动补 `data:image/<探测格式>;base64,`；
 * - 其余（URL / lucide id / 空）：返回空串，由调用方走原分支。
 */
export function normalizeImageRef(ref: string): string {
  const s = (ref ?? '').trim();
  if (!s) return '';
  if (/^data:/i.test(s)) return s;
  if (isBareBase64Image(s)) return `data:${mimeOfBase64(s)};base64,${s}`;
  return s;
}

/** 任意入参 → 标准图片形态（含字符串型 image 的兼容展开）。 */
function imageParts(g: ImageLike): { source: string; ref: string; isLocalRef: boolean; isCloudRef: boolean } {
  /**
   * ★v1.8.0：运行期仍可能有人传裸字符串（旧调用 / JS 调用方），类型上已不再声明，
   * 但**不能因此崩** —— 这里用 unknown 逐个字段收敛，任何异常值都退化成「空图」。
   */
  const raw = g as unknown;
  if (typeof raw === 'string') {
    const ref = raw.trim();
    return {
      source: '',
      ref,
      isLocalRef: /^data:/i.test(ref) || isBareBase64Image(ref),
      isCloudRef: isCloudReference(ref),
    };
  }
  const img = (raw && typeof raw === 'object' ? (raw as { image?: unknown }).image : undefined) ?? null;
  if (typeof img === 'string') {
    const ref = img.trim();
    return {
      source: '',
      ref,
      isLocalRef: /^data:/i.test(ref) || isBareBase64Image(ref),
      isCloudRef: isCloudReference(ref),
    };
  }
  if (!img || typeof img !== 'object') {
    return { source: '', ref: '', isLocalRef: false, isCloudRef: false };
  }
  const obj = img as { source?: unknown; ref?: unknown };
  const ref = typeof obj.ref === 'string' ? obj.ref.trim() : '';
  const source = typeof obj.source === 'string' ? obj.source : '';
  return {
    source,
    ref,
    isLocalRef: ref.startsWith('data:') || isBareBase64Image(ref),
    isCloudRef: isCloudReference(ref, source),
  };
}

/**
 * ref（或 source 提示）是否云端托管图引用。
 * 认：`source==='cloud'`、`/api/user/images/<sha>`、`cloud:` 前缀，
 * 以及**服务器绝对地址**的 `/api/user/images/<sha>`（换服务器时也不丢）。
 */
export function isCloudReference(ref: string, source = ''): boolean {
  const s = (ref ?? '').trim();
  if (!s) return false;
  if ((source ?? '').toLowerCase() === 'cloud') return true;
  if (s.startsWith('cloud:')) return true;
  return isCloudImageUrl(s);
}

/** ref 是否本地 dataURL 图（★v1.7.7：裸 base64 也算，AI API 导入全是这种）。 */
export function isLocalImage(g: ImageLike): boolean {
  return imageParts(g).isLocalRef;
}

/** 是否云端托管的图（★v1.8.0）。 */
export function isCloudImage(g: ImageLike): boolean {
  const p = imageParts(g);
  return p.isCloudRef && !p.isLocalRef;
}

/**
 * 云端图的渲染地址（相对路径或原样 URL）；非云端 / 解析失败返回空串。
 *
 * 两种用途：①分享卡抓高清原图（走网络）；②渲染层在没有本地缩略图时才用它。
 */
export function cloudUrl(g: ImageLike): string {
  const p = imageParts(g);
  if (!p.isCloudRef || p.isLocalRef) return '';
  const r = p.ref;
  let url = '';
  if (r.startsWith('cloud:')) {
    const body = r.slice(6).trim();
    // `cloud:<url>` 或 `cloud:<sha>` 两种写法都收
    url = isCloudImageUrl(body) ? body : /^[0-9a-f]{64}$/i.test(body) ? `/api/user/images/${body.toLowerCase()}` : '';
  } else if (r.startsWith('cloud://')) {
    // 防御：故意写成文档里的双斜杠形式时也不会丢图
    const body = r.slice(8).trim();
    url = isCloudImageUrl(body) ? body : '';
  } else if (r.startsWith('url:')) {
    const body = r.slice(4).trim();
    url = isCloudImageUrl(body) ? body : '';
  } else {
    url = r;
  }
  /**
   * ★v1.8.0 关键校验：**只认标准云端路径**（或服务器上的绝对 `/api/user/images/<sha>`）。
   * 脏数据（如 `source:'cloud'` 但 ref 是 `not-a-url`）在这里被挡成空串，
   * 上层据此落 'none' / 回落分类图标 —— 而不是把垃圾当图片地址塞给 `<img>`。
   */
  return isCloudImageUrl(url) ? url : '';
}

/**
 * 云端图在本地留的缩略图（≤256px 的 dataURL，约 3~6KB）。
 *
 * 「不丢图」的最后一层：离线 / URL 过期 / 换服务器时优先画它，而不是满屏灰块。
 */
export function cloudThumb(g: ImageLike): string {
  if (typeof g === 'string') return '';
  const img = g?.image;
  if (!img || typeof img === 'string') return '';
  const t = typeof img.thumb === 'string' ? img.thumb.trim() : '';
  return t.startsWith('data:image/') ? t : '';
}

/** 云端图的 sha256（优先用字段，其次从 URL 解析）。 */
export function cloudSha256(g: ImageLike): string {
  if (typeof g !== 'string') {
    const img = g?.image;
    if (img && typeof img !== 'string') {
      const s = (img.sha256 ?? '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(s)) return s;
    }
  }
  return shaFromImageUrl(cloudUrl(g));
}

/** ref 是否网络图标（http(s) 直链 / `url:` 前缀）。 */
export function isWebImage(g: ImageLike): boolean {
  const { ref } = imageParts(g);
  if (!ref) return false;
  return ref.startsWith('http') || ref.startsWith('url:');
}

/**
 * Goods.image → icon 字符串（img:/url:/brand:/裸 lucide id）。
 * ★builtin 分支是 v1.0.29 新增：`source:'builtin'` 的 ref 就是 lucide id，
 * 直接透传给 IconPreview / IconPicker 即可选中并渲染。
 * ★v1.7.7：本地图统一输出**补全前缀**的 dataURL，下游（<img src> / canvas / 分享卡）
 * 拿到的永远是合法 dataURL，不再需要各自处理裸 base64。
 * ★v1.8.0 云端图输出 `url:<云端地址>`（不新增前缀，复用全部既有 url: 渲染分支）。
 */
export function goodsIconValue(g: ImageLike): string {
  const { source, ref, isLocalRef, isCloudRef } = imageParts(g);
  if (!ref) return '';
  if (ref.startsWith('brand:')) return ref; // v1.0.19 内置品牌引用码
  if (isLocalRef) return `img:${normalizeImageRef(ref)}`;
  /* ★v1.8.0：云端图 → `url:<标准云端路径>`（复用全部既有 url: 渲染分支）。
     判定只看「有没有合法的云端地址」——脏数据（source:'cloud' 但 ref 不是云端路径）
     直接返回空，绝不让它掉进 builtin 分支渲染成一只看不懂的 lucide 图标。 */
  if (isCloudRef || ref.startsWith('cloud:') || ref.startsWith('cloud://')) {
    const url = cloudUrl(g);
    return url ? `url:${url}` : '';
  }
  // 非云端形态（source:'web' / 裸 URL）若 ref 自己带着 `url:` 前缀，先剥掉再拼，
  // 否则会拼出 `url:url:…` 让顶层判定认不出来（★v1.8.0 顺手修正）
  if (ref.startsWith('url:')) {
    const body = ref.slice(4).trim();
    if (body) return `url:${body}`;
  }
  if (source === 'web' || /^https?:\/\//i.test(ref)) return `url:${ref}`;
  if (source === 'builtin') return ref;
  return '';
}

/**
 * icon 字符串 → Goods.image（可能为 undefined = 无自定义图标，回落分类图标）。
 * 裸 lucide id 落到 `source:'builtin'`，不再被丢掉。
 * ★v1.7.7：`img:` 后面的裸 base64 同样补全前缀后落库，保证来回转换形状一致。
 * ★v1.8.0：`url:/api/user/images/<sha>` 与 `cloud:<url>` 都回落成 `source:'cloud'`
 * （旧数据里此类字符串会被当成 web 形态，语义上仍是「网络图」，不影响渲染）。
 */
export function goodsImageFromIcon(v: string): GoodsImage | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  if (s.startsWith('brand:')) return { source: 'brand', ref: s };
  if (s.startsWith('img:')) return { source: 'local', ref: normalizeImageRef(s.slice(4)) };
  // ★v1.8.0：source:'cloud' 但 ref 解析不出云端地址（脏数据）→ 明确当作「无图」，
  // 不许掉进 builtin 分支（否则详情页会冒出一张看不懂的 lucide 图标）
  if (/^cloud:/i.test(s)) {
    const url = cloudSrcOf(s);
    return url ? { source: 'cloud', ref: url } : undefined;
  }
  if (s.startsWith('url:')) {
    const body = s.slice(4).trim();
    if (isCloudImageUrl(body)) return { source: 'cloud', ref: body };
    return { source: 'web', ref: body };
  }
  if (isBareBase64Image(s)) return { source: 'local', ref: normalizeImageRef(s) };
  if (isCloudImageUrl(s)) return { source: 'cloud', ref: s };
  return { source: 'builtin', ref: s };
}

/** 物品是否有自定义图标（区别于「回落分类图标」）。 */
export function hasOwnIcon(g: ImageLike): boolean {
  return goodsIconValue(g) !== '';
}

/**
 * 安全取「可直接渲染」的图片三种值（★v1.7.7）。
 *
 * GoodsPhoto 旧实现先 `v.startsWith('img:')` 才判空 —— 若上游哪天返回 undefined
 * 就会整树崩。这里保证：**返回值一定是 string**；`src` 只在 `kind === 'img'`
 * 且非空时才给出，调用方永远不需要再做空值防御。
 *
 * ★v1.8.0：新增 `kind:'cloud'`，且**凡是云端图都优先给 `src = 本地缩略图`**
 * （离线可看、URL 过期也能看）；`url` 字段另给网络地址，分享卡/无缩略图时才用。
 * 云端图既没有缩略图又没有 URL → `kind:'none'`，调用方回落分类图标（不崩）。
 */
export function goodsIconView(g: ImageLike): {
  kind: 'img' | 'cloud' | 'brand' | 'url' | 'builtin' | 'none';
  value: string;
  src: string;
  /** 云端图专用：网络地址（相对路径或原样 URL），非云端为空串。 */
  url: string;
} {
  let v = goodsIconValue(g) ?? '';
  if (v.startsWith('img:')) {
    const src = normalizeImageRef(v.slice(4));
    return src ? { kind: 'img', value: v, src, url: '' } : { kind: 'none', value: '', src: '', url: '' };
  }
  if (v.startsWith('brand:')) return { kind: 'brand', value: v, src: '', url: '' };
  if (v.startsWith('url:')) {
    const src = v.slice(4).trim();
    if (!src) return { kind: 'none', value: '', src: '', url: '' };
    if (isCloudImageUrl(src)) {
      const thumb = cloudThumb(g);
      if (thumb) return { kind: 'cloud', value: v, src: thumb, url: src };
      return { kind: 'cloud', value: v, src: '', url: src };
    }
    return { kind: 'url', value: v, src, url: '' };
  }
  if (v) return { kind: 'builtin', value: v, src: '', url: '' };
  return { kind: 'none', value: '', src: '', url: '' };
}