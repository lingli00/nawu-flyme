/**
 * P2-12 · 品牌字标 Logo —— 「01 净白印」终稿规范（v1.1.4）。
 *
 * 设计规范：1024 画布、圆角磁贴 rx 22.5pct、白底 + 细边 #e4e7e3、
 * 「纳」字衬线粗（苔藓绿 #3f7d67 / 暗版 #63a68c）、安全边距 15pct。
 * 字面高占画布 46pct（INK_RATIO）；「纳」轮廓提取自 SimSun，
 * 经 fontTools 归一化（bbox 高=1、宽=0.9784），三端共用同一几何。
 * 伪粗描边统一字重：SVG 居中描边 strokeWidth=0.0237（归一化视口高=1），
 * 与 PIL 外扩描边（sw=3@140，单侧 0.01071em）视觉一致。
 *
 * 三版：
 * - solid   主色版：白磁贴 + 细边 + 绿「纳」（开屏 / favicon / App 图标）
 * - mono    单色版：仅字形 currentColor（侧边栏深绿底上用反白）
 * - inverse 反白版：solid 的别名保留（浅色背景场景）
 */

export type BrandVariant = 'solid' | 'mono' | 'inverse';

/** 净白印规范色（明） */
export const BRAND_LIGHT = {
  tile: '#ffffff',
  line: '#e4e7e3',
  ink: '#3f7d67',
} as const;

/** 净白印规范色（暗） */
export const BRAND_DARK = {
  tile: '#1a1f1d',
  line: '#2b312e',
  ink: '#63a68c',
} as const;

/** 「纳」归一化轮廓（bbox 高=1、宽=0.9784），SimSun 700 字重几何 */
export const NA_PATH =
  'M0.0690,0.3793 L0.2457,0.3621 C0.3060,0.2428 0.3147,0.2198 0.3147,0.2198 L0.3966,0.2759 L0.3621,0.2974 C0.1408,0.5934 0.1078,0.6336 0.1078,0.6336 C0.3103,0.5833 0.3793,0.5647 0.3793,0.5647 L0.3836,0.5819 C0.1667,0.6753 0.1034,0.7055 0.0776,0.7198 L0.0302,0.6379 C0.1307,0.5460 0.1882,0.4655 0.2371,0.3879 C0.1049,0.4282 0.0647,0.4440 0.0474,0.4526 L0.0086,0.3750 C0.1307,0.1968 0.1810,0.0848 0.1983,0.0302 L0.2888,0.0948 L0.2457,0.1121 C0.1006,0.3319 0.0690,0.3793 0.0690,0.3793 M0.4009,0.7586 C0.1451,0.8793 0.0690,0.9210 0.0517,0.9353 L0.0000,0.8578 C0.3060,0.7687 0.3966,0.7371 0.3966,0.7371 M0.7069,0.0776 C0.7069,0.2256 0.7069,0.2414 0.7069,0.2414 L0.8793,0.2414 L0.9095,0.1983 L0.9784,0.2543 L0.9440,0.2845 L0.9440,0.8664 C0.8822,0.9914 0.8491,1.0000 0.8491,1.0000 C0.7716,0.9224 0.7328,0.9138 0.7328,0.9138 L0.7328,0.8966 C0.8707,0.9052 0.8879,0.8894 0.8879,0.8578 L0.8879,0.2672 L0.7069,0.2672 C0.6968,0.4325 0.6940,0.4569 0.6940,0.4569 C0.8534,0.6049 0.8621,0.6293 0.8621,0.6379 C0.8448,0.6853 0.8333,0.6983 0.8276,0.6983 C0.7989,0.6638 0.7931,0.6466 0.7931,0.6466 C0.7155,0.5101 0.6897,0.4784 0.6897,0.4784 C0.5589,0.7112 0.5129,0.7500 0.5129,0.7500 L0.5000,0.7371 C0.6336,0.4684 0.6494,0.3534 0.6466,0.2672 L0.4784,0.2672 L0.4784,0.9741 L0.4181,1.0000 C0.4224,0.4914 0.4210,0.2701 0.4181,0.2069 L0.4784,0.2414 L0.6466,0.2414 C0.6437,0.0259 0.6422,0.0000 0.6422,0.0000 L0.7414,0.0431';

/** 居中描边等效粗度（归一化视口高=1 时） */
export const NA_STROKE = 0.0237;

/**
 * 描边外扩系数：视觉字面高 = path 高 x 1.0237。
 * PIL 端（启动图标/开屏 PNG）以 path 高 = 46pct 画布绘制、描边外扩，
 * 视觉字面高约为 47.1pct；前端传「视觉字面高」时乘回该系数，
 * 保证 App 内字标与桌面启动图标大小一致。
 */
export const INK_EXPAND = 1.0237;

/**
 * 「纳」字标（正方形 svg）：viewBox 见方 1.0238，
 * x 向 min -0.0227 使 bbox 归一的字形（0..0.9784）精确居中；
 * y 向 min -0.0119 容纳居中描边的一半。
 *
 * @param ink   视觉字面高（px，含描边外扩）
 * @param color 字色
 */
export function NaGlyph({
  ink,
  color,
  className = '',
}: {
  ink: number;
  color: string;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={ink}
      height={ink}
      viewBox="-0.0227 -0.0119 1.0238 1.0238"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path
        d={NA_PATH}
        fill={color}
        stroke={color}
        strokeWidth={NA_STROKE}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandMark({
  size = 24,
  variant = 'solid',
  dark = false,
  className = '',
}: {
  size?: number;
  variant?: BrandVariant;
  /** 暗色主题（深底场景） */
  dark?: boolean;
  className?: string;
}): JSX.Element {
  const pal = dark ? BRAND_DARK : BRAND_LIGHT;
  const isMono = variant === 'mono';
  const sw = size * 0.0238; // 磁贴细边（居中，外沿铺满画布）
  const inset = sw / 2;
  // 「纳」视觉字面高 = 画布 x 0.46 x 1.0237（path 46pct + 描边外扩，
  // 与 PIL 启动图标一致）
  const ink = size * 0.46 * INK_EXPAND;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-hidden
      focusable="false"
    >
      {/* 圆角磁贴 + 细边（rx = 22.5pct） */}
      <rect
        x={inset}
        y={inset}
        width={size - sw}
        height={size - sw}
        rx={size * 0.225}
        strokeWidth={sw}
        {...(isMono
          ? { fill: 'none', stroke: 'currentColor' }
          : { fill: pal.tile, stroke: pal.line })}
      />
      {/* 「纳」字面（NaGlyph 为正方形 svg，直接居中） */}
      <g transform={`translate(${size / 2 - ink / 2}, ${size / 2 - ink / 2})`}>
        <NaGlyph ink={ink} color={isMono ? 'currentColor' : pal.ink} />
      </g>
    </svg>
  );
}
