# 纳物 · UI 设计规范（DESIGN-SYSTEM v1.0）

> 适用范围：`工程/app`（网页版 + Android App 同一套代码）。
> 依据：v1.6.5 源码实测（`src/index.css` / `tailwind.config.ts` / `src/components/ui` / 全站 grep 扫描）。
> 生成日期：2026-11-12。本文档可直接交付前端执行，新增条目均标注 ★。

---

## 0. 完整度总评

| 维度 | 现状评分 | 结论 |
|---|---|---|
| 颜色令牌 | 8.5/10 | 语义令牌 + 深色映射 + 三套桌面皮肤齐全，已做过 WCAG AA 对比度修复（v1.0.33 P0-3）；残留少量硬编码与失效令牌引用 |
| 字体层级 | 8/10 | 七档字号阶梯完整、Tailwind 同步映射、`.tnum` 等宽数字是记账类产品的正确决策；缺 10–13px 微字号令牌档位 |
| 间距体系 | 7.5/10 | Tailwind 4px 栅格事实上被遵守，safe-area / 44px 触摸令牌已定义；间距令牌未成文，触摸目标 `hit` 使用率不足 |
| 基础组件库 | 7/10 | `components/ui` 已有 9 个组件 + `nw-*` CSS 底座收敛 48 处重复；缺 Toast / Skeleton / Badge / Progress 等组件化封装，**键盘 focus-visible 全站缺失** |
| 响应式断点 | 9/10 | `dt:`/`dtxl:`/`dt2xl:` 壳感知变体 + 双壳架构是全项目最亮眼的设计；旧全局 CSS hack 与 Sheet.tsx 双轨并存待清退 |

**总评：8/10。** 自研产品中属于规范度极高的项目——「组件只许用语义令牌、禁止写死色值」的铁律已落地且有三轮版本注释背书。剩余工作集中在：清退历史残留（硬编码色值 / 失效令牌 / 全局 CSS hack）、补齐微字号档位、组件库补缺、键盘焦点可访问性。

---

## 1. 颜色令牌

### 1.1 现有令牌（维持不变）

| 令牌 | 亮色 | 暗色 | 角色 |
|---|---|---|---|
| `--paper` | `#f4f5f3` | `#121513` | 页面底色（纸感） |
| `--surface` | `#ffffff` | `#1a1f1d` | 卡片/面板 |
| `--surface-2` | `#fafbfa` | `#202623` | 次级面板 / 输入框底 |
| `--ink` | `#18201c` | `#e9ecea` | 主文字 |
| `--ink-2` | `#4d5751` | `#b2bab5` | 次要文字 |
| `--ink-3` | `#6b7370`（4.87:1） | `#8a938d`（5.28:1） | 辅助文字，已达 WCAG AA |
| `--line` / `--line-2` | `#e4e7e3` / `#eef0ed` | `#2b312e` / `#232925` | 分割线两级 |
| `--accent` / `--accent-2` / `--accent-soft` | `#3f7d67` / `#346a57` / `#e7f0ec` | `#63a68c` / `#7bb99f` / `#1e2c26` | 苔藓绿主色系 |
| `--gui` / `--xu` / `--fou` | `#3f8f6a` / `#4a7fb5` / `#c2603f` | 同亮色 | 吉/需/否 三色判断点 |
| `--warn` / `--warn-soft` | `#b98a1f` / `#f6eeda` | `#cf9f3f` / `#3a2f18` | 警示 |
| `--danger` / `--danger-soft` | `#c0483c` / `#f7e3e0` | `#d07067` / `#3a2320` | 危险/删除 |
| `--tint-warm/cool/clay/violet` | 琥珀/青瓷/陶土/紫 | 各提亮一档 | 记录入口与生活流语义色 |

铁律（继续执行）：**组件内禁止写死十六进制色值，只许写 `bg-surface text-ink border-line` 等语义类名或 `var(--*)`。** 深浅色只换 `index.css` 里的变量。

### 1.2 ★ 必修项（P0，本轮修复）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `BillSheet.tsx:23` | `var(--xu, #d97706)` —— fallback 写成了琥珀色，而 `--xu` 实为蓝色 `#4a7fb5`。一旦变量缺失会跳色 | fallback 改为 `#4a7fb5`，或干脆去掉 fallback |
| 2 | `RetireSellCard.tsx:134` | `var(--danger, #c0392b)` —— fallback 与真实 `--danger`（`#c0483c`）不一致 | 统一引用 `var(--danger)` |
| 3 | `RetireSellCard.tsx:279` | `var(--ui-green, #1f8b4c)` —— **`--ui-green` 令牌不存在**，实际一直在吃 fallback | 新增正式令牌（见 1.3），此处改用之 |
| 4 | `SplashOverlay.tsx:64` | `DOT_COLORS = ['#3f8f6a', '#4a7fb5', '#c2603f']` 硬编码 | 改为 `['var(--gui)', 'var(--xu)', 'var(--fou)']`（深浅色自动跟随） |
| 5 | `MainShell.tsx:307` 等 | `color: '#fff'` 内联写死 | 用 Tailwind `text-white`，并确认仅出现在 `bg-accent` 实底之上（对比度 ≥ 4.5:1） |
| 6 | `BrandMark.tsx` | 品牌磁贴内置亮暗两组硬编码 | 属图形资产豁免区，**在文件头注释中声明「品牌资产豁免」**，防止后续被误改 |

### 1.3 ★ 新增令牌

```css
:root {
  /* 信息色：目前全站用 --xu 兼任「信息」，语义混用；独立出来 */
  --info: #4a7fb5;
  --info-soft: #e5edf6;
  /* 成功色：RetireSellCard 净赚、记账成功态当前用临时的 --ui-green fallback */
  --success: #1f8b4c;
  --success-soft: #e3f0e8;
}
[data-theme='dark'] {
  --info: #6f9ecb;
  --info-soft: #1c2733;
  --success: #5cab7f;
  --success-soft: #1c2b22;
}
```

同步进 `tailwind.config.ts`：`info` / `info-soft` / `success` / `success-soft` 四个键。

### 1.4 阴影令牌补档

现仅两档（`--shadow` / `--shadow-lg`），但 `UiHost.tsx` 已在用 Tailwind 的 `shadow-2xl`（未令牌化）。★ 新增中档并收敛：

```css
--shadow-sm: 0 1px 2px rgba(24,32,28,0.05);                       /* 描边级浮起 */
--shadow:    0 1px 2px rgba(24,32,28,0.05), 0 2px 8px rgba(24,32,28,0.04);  /* 卡片（现有） */
--shadow-lg: （现有，浮层/抽屉）;
```

规则：卡片用 `shadow-card`，浮层用 `shadow-lg`；`shadow-2xl` 等裸类逐步替换为 `shadow-lg`。玻璃皮肤（glass/night）已通过变量覆写自动继承，无需另调。

---

## 2. 字体层级

### 2.1 现有阶梯（维持不变）

| 类名 | Tailwind | 字号/行高 | 字重 | 用途 |
|---|---|---|---|---|
| `.t-h1` | `text-h1` | 22/30 | 600 | 页面大标题 |
| `.t-h2` | `text-h2` | 17/24 | 600 | 区块标题 |
| `.t-h3` | `text-h3` | 15/22 | 500 | 卡片标题 |
| `.t-body` | `text-body` | 14/20 | 400 | 正文 |
| `.t-caption` | `text-caption` | 12/16 | 400 | 说明文字 |
| `.t-num` | `text-num` | 28/34 | 700 | 核心金额 |
| `.t-num-sm` | `text-num-sm` | 16/22 | 600 | 次级金额 |

保留规则：所有金额必须加 `.tnum`（tabular-nums）；输入框 16px 防 iOS 聚焦缩放（已有全局规则）；字重只用 400/500/600/700 四档。

### 2.2 ★ 新增微字号档位（P1）

实测全站 **100+ 处 `text-[11px]`、`text-[10px]`、`text-[13px]` 任意值**——这是令牌体系最大的漏口：字号阶梯里没有对应档位，导致大家只能写任意值。正式收编：

| 类名 | 字号/行高 | 字重 | 用途 |
|---|---|---|---|
| ★ `.t-micro` | 11/16 | 400 | 标签、时间戳、表单行首字段名（当前 text-[11px] 的规范归宿） |
| ★ `.t-mini` | 10/14 | 500 | 徽标内文字（当前 text-[10px]，仅限徽标） |

同步进 `tailwind.config.ts` 的 `fontSize`。**收编后铁律：`text-[Npx]` 任意字号类全站禁用，ESLint/评审直接打回。** 迁移方式：全局把 `text-[11px]` → `t-micro`、`text-[10px]` → `t-mini`、`text-[13px]` → `text-[13px]` 归入 `t-body` 或 `t-h3`（13px 与 14px 视觉差可忽略，统一到 14）。

> 11px 是移动端可读下限（配合 `--ink-2` 以上对比度可用；11px + `--ink-3` 时行高必须 ≥16px，已在现有代码中达成）。

### 2.3 品牌衬线

开屏品牌名规范为 Noto Serif SC，当前降级 `font-family: serif`。★ 若后续追求一致性：仅在 `SplashOverlay` 与 `BrandMark` 内引入 `Noto Serif SC 600` 子集（woff2 按需子集化，只含「纳物」等数字符，控制在 ~20KB）；否则维持系统衬线降级，**不要**为此引入整包字体。

---

## 3. 间距体系

### 3.1 基准栅格（成文确认）

- 基准单位 **4px**，允许半步 `1.5 / 2.5`（6/10px），与 Tailwind 默认刻度一致。
- 页面级内边距：移动端 `px-4 (16px)`，桌面壳 `.nw-main` 由 `index.css` 统一 `32px 32px 96px`（勿在页面内另写）。
- 卡片内边距：`p-3 (12px)` 或 `p-4 (16px)`，二选一，同一卡片内不混用。
- 组件间距：`gap-2 (8px)` 起步，同组内元素 `gap-1.5`，组间 `space-y-2.5 ~ 3`。
- ★v1.7.6 硬规则（实测发现全站 20% 的 gap 用法低于 8px 后新增）：
  - **并排按钮必须包在 `<ButtonRow>` 里**，间距由 `.nw-btn-group` 决定，页面不得自己写 `gap`；
  - **按钮组横向间距不得小于 `gap-2`（8px）**；`gap-1`(4px) / `gap-0.5`(2px) 仅允许用于「图标内部图标↔文字」，不得用于两个可点控件之间；
  - 同一类控件（筛选 chip / 图标钮 / 卡片操作行）**在全站只能有一个间距值**，禁止各页自定义。

### 3.2 触摸目标（P1 整改）

`--spacing-hit: 44px` 令牌已定义，但实际使用率低。分级规范：

| 级别 | 最小尺寸 | 适用 | 现状 |
|---|---|---|---|
| 一级交互 | ≥44px | 主按钮、Tab 项、Sheet 关闭钮、MoreMenu 项（已达标 min-h-[44px]/48px） | ✅ |
| 二级密集控件 | ≥32px（视觉）+ 命中区扩到 44px | `nw-chip`（h-8）、日历格（h-9）、筛选按钮 | ⚠ 视觉尺寸可保留，**需用负 margin 或 padding 扩大点击热区** |
| 纯展示 | 无要求 | 徽标、标签 | — |

★ 落地做法：为 chip/日历格加 `relative before:absolute before:-inset-1.5 before:content-['']` 式隐形热区（不改变视觉布局），或统一封装进 `Chip` 组件内部。

### 3.3 安全区（维持不变）

`--safe-t/--safe-b` + `.pt-safe/.pb-safe` + `.topbar/.tabbar`（56px+safe）已系统化，继续沿用；新页面顶部/底部一律挂 safe 类，禁止手写 `env()`。

---

## 4. 基础组件库

### 4.1 现有清单（继续用，禁止绕过）

| 组件 | 位置 | 说明 |
|---|---|---|
| `Button` | `components/ui/Button.tsx` | ★v1.7.6 已真正落地（此前文档声称存在、实际缺失）。5 变体（primary/soft/outline/ghost/danger）× 3 尺寸（sm/md/lg）+ `dt:` 桌面增高（h-9/11/12）。★ 文档化：**默认 variant 是 `outline`**——用于表单「取消」等场景；主 CTA 必须显式传 `variant="primary"`。样式全部来自 `.nw-btn` CSS 底座，组件内不拼 Tailwind 类 |
| `IconButton` | `components/ui/Button.tsx` | 圆形图标按钮，36px 视觉（PC 40px）+ 44px 隐形命中区（`::before` 扩热区）。带 `label` 强制提供无障碍名称 |
| `ButtonRow` / `ButtonRowActions` | `components/ui/Button.tsx` | ★按钮组容器：**全站按钮间距的唯一来源**（`gap-2`，PC `gap-2.5`）。页面禁止自己写 gap |
| `Sheet` | `components/ui/Sheet.tsx` | `side="bottom"`（移动底部弹层 → 桌面右抽屉 30rem）/ `"center"`（居中弹窗）/ `"page"`（移动整页表单）。★ 新弹层一律用它，禁用旧全局 CSS hack |
| `Input` / `PageField` | `components/ui/` | 消费 `.nw-input` / `.nw-textarea` 底座 |
| `Chip` / `Segmented` / `Toggle` / `MoreMenu` / `EmptyState` / `UiHost` | `components/ui/` | chip/分段/开关/菜单/空态/确认框 |
| `.nw-input/.nw-textarea/.nw-chip/.nw-seg` | `index.css @layer` | CSS 底座，与组件一一对应 |

### 4.2 ★ 缺口补齐（P1 优先级排序）

| 缺口 | 现状 | 规格 |
|---|---|---|
| **Skeleton 骨架屏组件** | ~~只有 `.shimmer` CSS 类~~ → ★v1 已建 `components/ui/Skeleton.tsx`（`<Skeleton className>` + `SkeletonList rows` 预设，reduce-motion 由全局 `.shimmer` 降级承担） | 各页可从手搓 div 迁移到组件 |
| **Toast 组件** | ~~缺口~~ → **复核修正：已组件化于 `UiHost.tsx`**（store 契约：`useUiStore.toast`，3.5s 自动消失、tone 配色、动作按钮），★v1 已补 `aria-live="polite"`。无需另建 Toast.tsx | 保持 store 契约不变 |
| **Badge 徽标** | ~~各页手写~~ → ★v1 已建 `components/ui/Badge.tsx`（tone 六态，内部锁 `.t-mini`） | 新代码一律用组件 |
| **Progress 进度条** | ~~SmartRecordDock 手写~~ → ★v1 已建 `components/ui/Progress.tsx`（size sm=3px/md=6px，`role="progressbar"` + `aria-valuenow`） | SmartRecordDock 后续接入 |
| **ListItem 列表行** | 记账列表各页结构相似但样式散落 | 抽 `ListItem`：左 icon 区 40px / 中标题+副文 / 右金额（`.tnum`）+ 箭头，min-h 44px，`active:bg-surface-2` |
| **Dialog 确认框** | UiHost 已承担 | 保持，补 `role="alertdialog"` + Esc 关闭 + 焦点圈定（focus trap） |

### 4.3 ★ 交互状态规范（全组件统一）

| 状态 | 规格 |
|---|---|
| 按压 | `active:scale-[0.98]`（Button/Chip 已有）或 `active:opacity-70`（列表行）+ `haptic('select')` |
| 禁用 | `disabled:opacity-50` / 输入类 `opacity-60 cursor-not-allowed` |
| 加载 | 骨架屏优先于 Spinner；按钮内 loading 用 16px 旋转图标 + 文案不变 |
| 空态 | 一律 `EmptyState` 组件（带引导动作），禁止裸写「暂无数据」 |
| **键盘焦点（P0）** | **全站 `outline-none` 后没有替代焦点指示——键盘用户在网页版无法感知位置。** 全局新增：`*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: inherit; }`。此规则只影响键盘 Tab（`:focus-visible`），不改变鼠标/触摸观感，零回归风险 |
| **桌面悬停（★v1.7.6 新增成文）** | 此前全站 `:hover` 规则只有 6 条——作为电脑网页版，绝大多数可点元素悬停无任何反馈。现规范：图标钮 `bg-surface-2`；`.nw-chip` `border-line-2 + text-ink`；primary 按钮 `bg-accent-2`；卡片 `border-line-2 + shadow-lg`；侧栏/列表行 `bg-surface-2`。**实现一律加 `dt:` 前缀或 `html:not([data-shell='mobile'])` 限定**，禁止裸 `hover:`（会污染触摸端） |
| **禁用态（★v1.7.6 修正）** | 禁止用整体 `opacity`。旧写法 `opacity-40` 让主按钮白字压在混合色上只有 **1.85:1**，看起来像文字消失。统一改语义令牌：`bg-surface-2 + text-ink-3`（约 4.87:1），由 `.nw-btn:disabled` 承担 |
| **对比度硬门槛（★v1.7.6）** | 深色下 `--accent` 提亮为 `#63a68c`，白字仅 **2.85:1**（不达 AA）。故 `--on-accent` 在深色主题下改为深墨色 `#0f1a15`（**6.25:1**），浅色下仍为白（4.84:1）。新增 accent 底文字一律用 `text-on-accent` 而不是 `text-white` |

---

## 5. 响应式断点策略

### 5.1 双壳架构（本项目核心资产，成文固化）

- `<html data-shell="pc|mobile">` 由 MainShell 挂载；`pc` = 桌面浏览完整网页，`mobile` = 手机/App/强制手机版网页（内容 576px）。
- **断点铁律（已由 v1.0.29 事故确立，务必写进评审清单）：**
  - **页面级桌面布局：只用 `dt:` / `dtxl:` / `dt2xl:`**（壳感知变体，≥1024/1280/1536 且非移动壳），**禁止裸 `lg:`/`xl:`/`2xl:`**。
  - 组件级自适应（组件自身在两种壳下都需要响应）：可用 `sm:`/`md:`（如 WeatherLine），但不得改变页面级布局结构。
- 内容列宽：classic 1240（2xl 1320）/ glass·night 1120（2xl 1180），由 `.nw-main` 统一控制。

### 5.2 弹层双轨清退（P1）

`index.css` 中 `@media (min-width: 1024px) { .fixed.inset-0.items-end ... }` 全局 hack 仅作为未迁移旧弹层的兜底，与 `Sheet.tsx` 并存。★ 路线：逐页把 `items-end + .sheet-enter` 手写弹层迁到 `<Sheet>`，全部迁完后**删除该全局规则块**（预期影响 3–5 处）。在删除前，任何新弹层 code review 直接打回。

### 5.3 断点速查

| 名称 | 值 | 触发方式 | 用途 |
|---|---|---|---|
| 移动壳 | <1024 或 data-shell=mobile | 默认 | 单列布局，底部 Tab |
| 桌面 | ≥1024 | `dt:` | 侧栏、12 列栅格、右抽屉 |
| 宽桌面 | ≥1280 | `dtxl:` | 报表/我的页双列增强 |
| 超宽 | ≥1536 | `dt2xl:` | 内容列上限放宽 |
| 移动壳高度 | — | `100dvh`（`nw-pager-shell` 已带 vh 回退） | 全屏壳容器 |

---

## 6. 无障碍规范（新增成文）

| 项 | 要求 | 现状 |
|---|---|---|
| 对比度 | 正文 ≥4.5:1（`--ink`/`--ink-2`/`--ink-3` 已达标），大字 ≥3:1 | ✅ 已系统性修复 |
| 键盘焦点 | `:focus-visible` 全局指示（见 §4.3） | ❌ P0 补 |
| 触摸目标 | §3.2 分级 | ⚠ 密集控件补热区 |
| 动效偏好 | `prefers-reduced-motion` 已全站降级（动画/shimmer/位移全关） | ✅ 样板级实现 |
| 图形回退 | `backdrop-filter` 已有 `@supports` 兜底 | ✅ |
| 屏幕阅读器 | Sheet/MoreMenu 已有 `aria-label`；★ 补：Toast `aria-live`、Dialog `role="alertdialog"`、Progress `aria-valuenow`、纯装饰 icon 一律 `aria-hidden`（现有多数已做） | ⚠ 增量补 |
| 文字缩放 | 系统字号放大至 200% 时布局不碎：★ 新页面验证一次 `font-size` 放大场景，重点查 11px 标签与固定宽列（`w-12`）的组合 | ⚠ 抽查 |

---

## 7. 落地路线图

### P0（已落地 ✅ 2026-11-12）
1. ✅ `:focus-visible` 全局焦点样式（index.css 一行 + 逐页抽查遮挡）。
2. ✅ §1.2 六处硬编码/失效令牌修复（`--ui-green` → `text-success`，SplashOverlay 三色点转变量）。
3. ✅ `.t-micro` / `.t-mini` 令牌新增 + Tailwind 映射。

### P1（已落地 ✅ 2026-11-12）
4. ✅ 全站 `text-[11px]/[10px]/[13px]` → `text-micro`/`text-mini`/`text-sm`（一次性脚本，**308 处 / 31 文件**，tsc + 543 例测试全绿）。
5. ✅ `Skeleton` / `Badge` / `Progress` 组件化新建；`UiHost` Toast 区补 `aria-live="polite"`（Toast 本就已组件化，评估时误判为缺口，已修正）。
6. ✅ 密集控件 44px 热区扩展——`.nw-chip::before`（全站 chip 一次生效）+ `SubCalendar` 日历格 `before:-inset-y-1 before:-inset-x-1.5`。
7. ✅ `--info` / `--success` 语义令牌已建；BillSheet、RetireSellCard 已接入 `text-success`/`text-danger`。

### P2（持续）
8. 旧弹层逐页迁移 `Sheet.tsx`，迁完删除全局 CSS hack。（远端仓库中部分文档/环境文件较本包新，迁移前先以远端为准同步）
9. `ListItem` 抽取；`UiHost` 补 focus trap。
10. 文字缩放 200% 抽查清单化，纳入发版 QA。
11. ★图表字号豁免区：报表 SVG 图内 `text-[9/26/32/44px]`、`NotFoundPage` 的 `text-[56px]` 为数据展示例外，不纳入文本阶梯（DESIGN-SYSTEM v1.0 首次记录）。

### QA 门槛（沿用项目现有两道门）
```bash
cd 工程/app && npx tsc --noEmit && npx vitest run   # 0 error / 520+ 例全绿
```
另加视觉自查：暗色模式过一遍改动页 → 三套皮肤（classic/glass/night）过一遍桌面页 → 键盘 Tab 走一遍表单页。

---

*文档完。令牌即法律：改令牌请同步本文档、`index.css`、`tailwind.config.ts` 三处，并在变更日志记录版本号。*
