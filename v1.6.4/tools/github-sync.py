#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纳物 NaWu · GitHub 同步/发版（v1.6.4）
================================================================================
背景：本机 `github.com:443` 被代理阻断，`git clone/push` 全失败
（见《踩坑与注意事项.md》第七节第 4 条）。所以走 **Git Data API**：
blobs → trees(base_tree) → commits → 更新 refs，全程 HTTPS API，不依赖 git 协议。

三个动作，可单独执行：

    # ① 看差异（不需要写权限，匿名也能跑）
    python tools/github-sync.py --local 工程/app --repo lingli00/nawu

    # ② 推送（需要 contents:write）
    python tools/github-sync.py --local 工程/app --repo lingli00/nawu \
        --token $GITHUB_TOKEN --push --message "v1.6.4: ..."

    # ③ 触发云端打包并下载产物（需要 actions:write）
    python tools/github-sync.py --repo lingli00/nawu --token $GITHUB_TOKEN \
        --build-apk --out dist-ota

比较用 **git blob sha1**（sha1("blob <len>\\0" + 内容)）与远端 tree 里的 sha 直接对比：
相同 → 跳过上传（不产生 diff）；不同 → 才算改动。所以「推全量」也不会产生无意义变更。

注意：
- 新文件路径必须相对仓库根（写错会 422 "malformed path component"）；
- 代理偶发 400/401/408，本脚本对 blob 上传做 3 次重试；
- 提交信息第一行 ≤ 50 字，GitHub 上好看。
"""

import argparse
import base64
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.github.com'
UA = 'nawu-sync/1.6.4'

SKIP_DIRS = {'node_modules', 'dist', '.gradle', 'build', '.git', '.idea', '.vscode', '__pycache__'}
SKIP_NAMES = {'.env', 'local.properties'}


def api(path, token=None, method='GET', body=None, raw=False, retries=3):
    url = path if path.startswith('http') else API + path
    data = None
    headers = {'User-Agent': UA, 'Accept': 'application/vnd.github+json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=120) as r:
                payload = r.read()
                return payload if raw else (json.loads(payload.decode('utf-8')) if payload else None)
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:300]
            last = RuntimeError(f'{method} {url} → {e.code} {detail}')
            if e.code in (400, 401, 408, 422, 502, 503) and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise last
        except Exception as e:  # noqa: BLE001
            last = RuntimeError(f'{method} {url} 失败：{e}')
            time.sleep(1.5 * (attempt + 1))
    raise last


def blob_sha1(data):
    """git 的 blob 对象 id：sha1("blob <len>\\0" + content)。"""
    h = hashlib.sha1()
    h.update(b'blob %d\0' % len(data))
    h.update(data)
    return h.hexdigest()


def local_files(root: pathlib.Path):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for fn in sorted(filenames):
            if fn in SKIP_NAMES:
                continue
            p = pathlib.Path(dirpath, fn)
            rel = p.relative_to(root).as_posix()
            out[rel] = p
    return out


def repo_tree(repo, ref='main', token=None):
    data = api(f'/repos/{repo}/git/trees/{ref}?recursive=1', token)
    if data.get('truncated'):
        print('⚠ 仓库树被截断（文件太多），差异比对可能不完整', file=sys.stderr)
    return {t['path']: t for t in data['tree'] if t['type'] == 'blob'}


def plan(repo, root, token):
    remote = repo_tree(repo, 'main', token)
    local = local_files(root)
    added, modified, same = [], [], 0
    for rel, p in local.items():
        data = p.read_bytes()
        sha = blob_sha1(data)
        r = remote.get(rel)
        if r is None:
            added.append(rel)
        elif r.get('sha') != sha:
            modified.append(rel)
        else:
            same += 1
    deleted = sorted(set(remote) - set(local))
    return remote, local, added, modified, deleted, same


def push(repo, root, token, message, do_deletes=False, include=None):
    remote, local, added, modified, deleted, same = plan(repo, root, token)
    if include:
        # 只推白名单里的文件：纯净包里混有大量「脱敏占位」(192.168.1.100 等)，
        # 整目录同步会把私有仓库里的真实地址冲成占位（《踩坑》七.2 付过学费）。
        keep = set(include)
        added = [f for f in added if f in keep]
        modified = [f for f in modified if f in keep]
        deleted = []
        print(f'白名单模式：只处理 {len(keep)} 个指定路径')
    print(f'远端 {len(remote)} 个文件 / 本地 {len(local)} 个：'
          f'新增 {len(added)}、修改 {len(modified)}、未变 {same}、远端多出 {len(deleted)}')
    if not added and not modified and not (do_deletes and deleted):
        print('没有需要推送的内容。')
        return
    if do_deletes and deleted:
        print(f'将删除远端 {len(deleted)} 个文件（本地已不存在）')

    ref = api(f'/repos/{repo}/git/ref/heads/main', token)
    base_commit = ref['object']['sha']
    commit = api(f'/repos/{repo}/git/commits/{base_commit}', token)
    base_tree = commit['tree']['sha']

    entries = []
    total = len(added) + len(modified) + (len(deleted) if do_deletes else 0)
    i = 0
    for rel in added + modified:
        i += 1
        data = local[rel].read_bytes()
        blob = api(f'/repos/{repo}/git/blobs', token, 'POST',
                   {'content': base64.b64encode(data).decode('ascii'), 'encoding': 'base64'})
        entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        if i % 10 == 0 or i == total:
            print(f'  已上传 {i}/{total} …')
    if do_deletes:
        for rel in deleted:
            entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': None})

    tree = api(f'/repos/{repo}/git/trees', token, 'POST',
               {'base_tree': base_tree, 'tree': entries})
    new_commit = api(f'/repos/{repo}/git/commits', token, 'POST',
                     {'message': message, 'tree': tree['sha'], 'parents': [base_commit]})
    api(f'/repos/{repo}/git/refs/heads/main', token, 'PATCH',
        {'sha': new_commit['sha'], 'force': False})
    print(f'✅ 已提交 {new_commit["sha"][:10]}：{message.splitlines()[0]}')
    print(f'   https://github.com/{repo}/commit/{new_commit["sha"]}')


def find_workflow(repo, token, name='Build APK'):
    for w in api(f'/repos/{repo}/actions/workflows', token).get('workflows', []):
        if w.get('name') == name or w.get('path', '').endswith('build-apk.yml'):
            return w
    raise SystemExit(f'[中止] 没找到工作流「{name}」')


def build_apk(repo, token, out_dir, ref='main', timeout=1800):
    wf = find_workflow(repo, token)
    before = api(f'/repos/{repo}/actions/runs?per_page=1', token)['workflow_runs']
    before_id = before[0]['id'] if before else 0
    api(f'/repos/{repo}/actions/workflows/{wf["id"]}/dispatches', token, 'POST', {'ref': ref})
    print(f'已触发工作流「{wf["name"]}」（ref={ref}），等待开始…')

    run = None
    for _ in range(60):
        time.sleep(5)
        runs = api(f'/repos/{repo}/actions/runs?per_page=5', token)['workflow_runs']
        run = next((r for r in runs if r['id'] != before_id and r['workflow_id'] == wf['id']), None)
        if run:
            break
    if not run:
        raise SystemExit('[中止] 工作流没有启动（检查 PAT 是否有 actions:write）')
    print(f'  run #{run["run_number"]} {run["html_url"]}')

    started = time.time()
    while run['status'] != 'completed':
        if time.time() - started > timeout:
            raise SystemExit('[中止] 等待构建超时')
        time.sleep(15)
        run = api(f'/repos/{repo}/actions/runs/{run["id"]}', token)
        print(f'  {run["status"]} / {run.get("conclusion") or "-"} …')
    if run['conclusion'] != 'success':
        raise SystemExit(f'[中止] 构建失败：{run["conclusion"]} 详见 {run["html_url"]}')

    arts = api(f'/repos/{repo}/actions/runs/{run["id"]}/artifacts', token)['artifacts']
    if not arts:
        raise SystemExit('[中止] 构建成功但没有产物')
    art = arts[0]
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f'{art["name"]}.zip'
    data = api(art['archive_download_url'], token, raw=True)
    zip_path.write_bytes(data)
    import zipfile
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            if n.lower().endswith('.apk'):
                target = out_dir / os.path.basename(n)
                target.write_bytes(z.read(n))
                print(f'✅ 安装包：{target}  ({target.stat().st_size / 1048576:.2f} MB)')
    zip_path.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser(description='纳物 · GitHub 同步 / 云端出包')
    ap.add_argument('--repo', default='lingli00/nawu')
    ap.add_argument('--local', default='工程/app', help='本地源码目录（对应仓库根）')
    ap.add_argument('--token', default=os.environ.get('GITHUB_TOKEN', ''))
    ap.add_argument('--push', action='store_true', help='真的推送（默认只比对）')
    ap.add_argument('--message', default='', help='提交信息')
    ap.add_argument('--delete-missing', action='store_true', help='删除远端多余文件（危险，默认关）')
    ap.add_argument('--build-apk', action='store_true', help='触发 Build APK 并下载产物')
    ap.add_argument('--out', default='dist-ota')
    ap.add_argument('--include-from', default='', help='只推白名单文件（每行一个仓库相对路径）')
    args = ap.parse_args()

    token = args.token or None
    if args.push or args.build_apk:
        if not token:
            raise SystemExit('[中止] 需要 --token（或环境变量 GITHUB_TOKEN）')

    if args.push:
        include = None
        if args.include_from:
            include = [l.strip() for l in pathlib.Path(args.include_from).read_text(encoding='utf-8').splitlines()
                       if l.strip() and not l.strip().startswith('#')]
        push(args.repo, pathlib.Path(args.local), token,
             args.message or 'chore: sync', args.delete_missing, include)
        return

    if args.build_apk:
        build_apk(args.repo, token, pathlib.Path(args.out))
        return

    root = pathlib.Path(args.local)
    remote, local, added, modified, deleted, same = plan(args.repo, root, token)
    print(f'仓库 {args.repo} main：{len(remote)} 个文件；本地 {root}：{len(local)} 个文件')
    print(f'  新增 {len(added)} / 修改 {len(modified)} / 未变 {same} / 远端多出 {len(deleted)}')
    for rel in added[:40]:
        print('  + ' + rel)
    if len(added) > 40:
        print(f'  … 另有 {len(added) - 40} 个新增')
    for rel in modified[:40]:
        print('  M ' + rel)
    if len(modified) > 40:
        print(f'  … 另有 {len(modified) - 40} 个修改')
    for rel in deleted[:10]:
        print('  - ' + rel)
    print('\n（默认只比对；加 --push 才会写入）')


if __name__ == '__main__':
    sys.exit(main())
