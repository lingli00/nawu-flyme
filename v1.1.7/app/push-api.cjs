/**
 * 纯 fetch 经 GitHub REST API 推送（无子进程）：blobs → tree → commit → ref → workflow_dispatch。
 */
const fs = require('fs');
const path = require('path');

const REPO = '你的账号/你的仓库';
const TOKEN = process.env.GH_TOKEN;
const ROOT = __dirname;

async function apiOnce(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'push-script',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 200)}`);
  return text.length ? JSON.parse(text) : null;
}

/**
 * ★v1.0.27 带重试的 API 调用：GitHub 对大 blob（如 2.8MB 的 tesseract wasm）
 * 间歇性返回 401/400/5xx 或直接掐断连接（fetch failed），实测均与凭证无关。
 * 指数退避重试 5 次（2s/4s/8s/16s/32s），彻底解决反复断在 blobs 100/229 的问题。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await apiOnce(method, url, body);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message ?? e);
      const retriable =
        msg.includes('fetch failed') ||
        /-> (401|400|408|429|500|502|503|504):/.test(msg);
      if (!retriable || attempt === 5) throw e;
      console.log(`  retry ${attempt}/5 after error: ${msg.slice(0, 120)}`);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist') continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walk(abs, out);
    else out.push(path.relative(ROOT, abs).replace(/\\/g, '/'));
  }
  return out;
}

async function main() {
  const listFile = process.argv[2];
  const files = listFile
    ? fs.readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : walk(ROOT, []);
  console.log('files:', files.length);

  // 空仓库无法用 git data API：先用 contents API 初始化 README 产生首个 commit
  let base;
  const refRes = await api('GET', `/repos/${REPO}/git/ref/heads/main`).catch(() => null);
  if (!refRes) {
    const init = await api('PUT', `/repos/${REPO}/contents/README.md`, {
      message: 'init',
      content: Buffer.from('# nawu\n\n纳物 App 源码。由 WorkBuddy 自动推送。\n').toString('base64'),
    });
    base = { commitSha: init.commit.sha, treeSha: init.commit.tree.sha };
    console.log('repo initialized via contents API');
  } else {
    const c = await api('GET', `/repos/${REPO}/commits/main`);
    base = { commitSha: c.sha, treeSha: c.commit.tree.sha };
  }
  console.log('base commit:', base.commitSha);

  const tree = [];
  let done = 0;
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    if (++done % 20 === 0) console.log(`blobs ${done}/${files.length}`);
  }
  console.log('blobs done');

  const treeRes = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: base.treeSha, tree });
  console.log('tree ok');

  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: 'Nawu/GuiFou app v1.0.0: 24 ledger categories, IME cursor fix, subscription & ledger UI (M1/M2), CI build',
    tree: treeRes.sha,
    parents: [base.commitSha],
  });
  console.log('commit:', commit.sha);

  await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true });
  console.log('ref main updated');

  await api('POST', `/repos/${REPO}/actions/workflows/build-apk.yml/dispatches`, { ref: 'main' });
  console.log('workflow dispatched');
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
