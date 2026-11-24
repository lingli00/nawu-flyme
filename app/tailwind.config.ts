import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

/**
 * Tailwind 令牌映射。
 * 组件里只允许写语义类名（`bg-surface text-ink border-line`），
 * 禁止写死色值 —— 深浅色切换只换 CSS 变量（见 `src/index.css`）。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        line: 'var(--line)',
        'line-2': 'var(--line-2)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        'accent-soft': 'var(--accent-soft)',
        /* ★v1.7.6：补登记 on-accent —— AdminPage 里 3 处已经在用 `text-on-accent`，
           但这个令牌既没在 tailwind 声明、也没在 index.css 定义变量，
           实际是条失效类名（文字颜色靠继承，深浅色下对比度不可控）。 */
        'on-accent': 'var(--on-accent)',
        gui: 'var(--gui)',
        xu: 'var(--xu)',
        fou: 'var(--fou)',
        warn: 'var(--warn)',
        'warn-soft': 'var(--warn-soft)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
        /* ★DESIGN-SYSTEM v1：信息/成功语义色（组件禁止写死色值的口径下补齐的缺位令牌） */
        info: 'var(--info)',
        'info-soft': 'var(--info-soft)',
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        btn: 'var(--radius-btn)',
        sheet: '20px',
      },
      boxShadow: {
        card: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      spacing: {
        'safe-t': 'var(--safe-t)',
        'safe-b': 'var(--safe-b)',
        topbar: '56px',
        tabbar: '56px',
        hit: '44px',
      },
      fontSize: {
        h1: ['22px', { lineHeight: '30px', fontWeight: '600' }],
        h2: ['17px', { lineHeight: '24px', fontWeight: '600' }],
        h3: ['15px', { lineHeight: '22px', fontWeight: '500' }],
        body: ['14px', { lineHeight: '20px', fontWeight: '400' }],
        caption: ['12px', { lineHeight: '16px', fontWeight: '400' }],
        num: ['28px', { lineHeight: '34px', fontWeight: '700' }],
        'num-sm': ['16px', { lineHeight: '22px', fontWeight: '600' }],
        /* ★DESIGN-SYSTEM v1：微字号档（对齐 index.css 的 .t-micro / .t-mini），
           收编后 text-[10px]/text-[11px] 任意字号类全站禁用 */
        micro: ['11px', { lineHeight: '16px', fontWeight: '400' }],
        mini: ['10px', { lineHeight: '14px', fontWeight: '500' }],
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Noto Sans SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
      },
      transitionDuration: {
        page: '200ms',
        sheet: '250ms',
      },
    },
  },
  plugins: [
    /**
     * ★v1.0.29「电脑版浏览手机版网页畸形」根治：
     * 旧版页面级桌面栅格直接用 `lg:`（纯视口媒体查询）—— 用户在宽屏上手动切到
     * 「手机版网页」（或开 /m/）时，移动壳内容只有 576px，桌面栅格照样生效，
     * 「我的页」右列被 340px 左列挤成 ~100px 竖条。
     * 新增 shell 感知的桌面变体：`dt:`（≥1024px 且当前不是移动壳）、`dtxl:`（≥1280px）、`dt2xl:`（≥1536px）。
     * 壳层在 <html data-shell="pc|mobile"> 上声明，MainShell 挂载/切换时同步。
     * 铁律：**页面级桌面布局一律用 dt 系列，别再用裸 lg:/xl:/2xl:**。
     */
    plugin(({ addVariant }) => {
      addVariant('dt', '@media (min-width: 1024px) { html:not([data-shell="mobile"]) & }');
      addVariant('dtxl', '@media (min-width: 1280px) { html:not([data-shell="mobile"]) & }');
      addVariant('dt2xl', '@media (min-width: 1536px) { html:not([data-shell="mobile"]) & }');
    }),
  ],
};

export default config;
