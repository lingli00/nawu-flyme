#!/usr/bin/env node
/**
 * 把 App 端的前端构建产物同步到服务端（网页版）。
 *
 * 纳物是「一套 React 源码 → 两个产物」：
 *   · App 端   app/dist/  → 打进 APK（Capacitor 原生壳，相对路径）
 *   · 服务端   server/    → 网页版 / PC 版（Nginx 直接托管，绝对路径）
 * 所以改完 app/src 之后，必须把新的 dist 同步过来，否则网页版还是旧界面。
 *
 * 用法（在工程根目录执行）：
 *   node tools/sync-web-to-server.mjs
 *   node tools/sync-web-to-server.mjs --check     # 只体检不同步
 *
 * 前置：先在 app/ 里跑过 `npm run build`（会生成 app/dist/）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP_DIST = path.join(ROOT, 'app', 'dist');
const SERVER = path.join(ROOT, 'server');
const SERVER_ASSETS = path.join(SERVER, 'assets');
const SPA = path.join(SERVER, 'app', 'spa-m.html');

const CHECK_ONLY = process.argv.includes('--check');
const log = (...a) => console.log(...a);

if (!fs.existsSync(APP_DIST)) {
  console.error('[中止] 找不到 app/dist —— 请先在 app/ 目录执行：npm run build');
  process.exit(1);
}
if (!fs.existsSync(SERVER) || !fs.existsSync(SPA)) {
  console.error('[中止] 找不到 server/ 或 server/app/spa-m.html，确认目录结构没被改动');
  process.exit(1);
}

/* ---------- 1. 解析 dist/index.html 的构建注入标签 ---------- */
const distHtml = fs.readFileSync(path.join(APP_DIST, 'index.html'), 'utf8');
const tagRe = /<(script|link)\b[^>]*?(?:src|href)="\.\/(assets\/[^"]+)"[^>]*>(?:<\/script>)?/g;
const injected = [];
for (const m of distHtml.matchAll(tagRe)) {
  const raw = m[0].replace(/href="\.\//g, 'href="/').replace(/src="\.\//g, 'src="/');
  injected.push(raw);
}
if (!injected.length) {
  console.error('[中止] 没能从 app/dist/index.html 里解析出任何 assets 引用，构建产物可能不完整');
  process.exit(1);
}
const entry = injected.find((t) => t.startsWith('<script'));
const referenced = new Set();
for (const t of injected) {
  const m = t.match(/["']\/assets\/([^"']+)["']/);
  if (m) referenced.add(m[1]);
}

log('== 本次构建 ===');
for (const t of injected) log('  ' + t);

/* ---------- 2. 拷贝 assets ---------- */
fs.mkdirSync(SERVER_ASSETS, { recursive: true });
let copied = 0, unchanged = 0;
const srcAssets = fs.readdirSync(path.join(APP_DIST, 'assets'));
for (const name of srcAssets) {
  const from = path.join(APP_DIST, 'assets', name);
  const to = path.join(SERVER_ASSETS, name);
  const same = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to));
  if (same) { unchanged++; continue; }
  if (!CHECK_ONLY) fs.copyFileSync(from, to);
  copied++;
  log(`  ${CHECK_ONLY ? '待更新' : '已更新'}  assets/${name}`);
}
log(`\nassets: ${copied} 个${CHECK_ONLY ? '待更新' : '已更新'}，${unchanged} 个无变化`);

/* ---------- 3. 提示旧 chunk（不自动删，避免误伤） ---------- */
const stale = fs.readdirSync(SERVER_ASSETS).filter((n) => !srcAssets.includes(n));
if (stale.length) {
  log(`\n⚠ server/assets/ 里有 ${stale.length} 个本次构建未产出的历史 chunk：`);
  for (const n of stale.slice(0, 12)) log('    ' + n);
  if (stale.length > 12) log(`    …… 另有 ${stale.length - 12} 个`);
  log('  留着不影响运行（index.php 对不存在的 chunk 直接 404），想清理可手动删除；');
  log('  注意：若有用户浏览器还停留在旧页面，删了会导致其动态加载 chunk 失败。');
}

/* ---------- 4. 同步静态资源（品牌图标 / OCR） ---------- */
for (const rel of ['brand-icons', 'tess', 'tessdata']) {
  const from = path.join(APP_DIST, rel);
  if (!fs.existsSync(from)) { log(`  [跳过] app/dist/${rel} 不存在`); continue; }
  let n = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const name of fs.readdirSync(s)) {
      const sf = path.join(s, name), df = path.join(d, name);
      if (fs.statSync(sf).isDirectory()) { walk(sf, df); continue; }
      const same = fs.existsSync(df) && fs.readFileSync(sf).equals(fs.readFileSync(df));
      if (same) continue;
      if (!CHECK_ONLY) fs.copyFileSync(sf, df);
      n++;
    }
  };
  walk(from, path.join(SERVER, rel));
  log(`  ${rel}: ${n} 个文件${CHECK_ONLY ? '待同步' : '已同步'}`);
}
{
  const a = path.join(APP_DIST, 'logo.svg'), b = path.join(SERVER, 'logo.svg');
  if (fs.existsSync(a)) {
    const same = fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
    if (!same && !CHECK_ONLY) fs.copyFileSync(a, b);
    if (!same) log(`  logo.svg: ${CHECK_ONLY ? '待同步' : '已同步'}`);
  }
}

/* ---------- 5. 重写 server/app/spa-m.html 的入口标签 ---------- */
let spa = fs.readFileSync(SPA, 'utf8');
// 删掉上一轮注入的内容：BUILD:HEAD 标记 + 构建注入的 script / modulepreload / stylesheet
spa = spa.replace(/^[ \t]*<!--\s*BUILD:HEAD[\s\S]*?-->[ \t]*\r?\n?/gm, '')
         .replace(/^[ \t]*<script type="module"[^>]*><\/script>[ \t]*\r?\n?/gm, '')
         .replace(/^[ \t]*<link rel="modulepreload"[^>]*>[ \t]*\r?\n?/gm, '')
         .replace(/^[ \t]*<link rel="stylesheet"[^>]*>[ \t]*\r?\n?/gm, '')
         .replace(/\n{3,}/g, '\n\n');
const block = '    <!-- BUILD:HEAD — 由 tools/sync-web-to-server.mjs 自动维护，勿手改 -->\n'
  + injected.map((t) => '    ' + t).join('\n') + '\n';
spa = spa.replace(/^[ \t]*<\/head>/m, block + '  </head>');
if (!CHECK_ONLY) fs.writeFileSync(SPA, spa, 'utf8');
log(`\nserver/app/spa-m.html 入口${CHECK_ONLY ? '待重写' : '已重写'}为 → ${entry ?? '(未识别)'}`);
log(`进入网页版入口引用的 chunk 共 ${referenced.size} 个，已全部就位。`);

log('\n完成。' + (CHECK_ONLY ? '（--check 模式，未写入任何文件）' : ''));
log('接下来：把 server/ 里的内容重新上传到站点根，或只上传变化的 assets/ 与 app/spa-m.html。');
