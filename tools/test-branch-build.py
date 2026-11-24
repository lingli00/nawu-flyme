#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性：把白名单改动推到一个【测试分支】并 dispatch Build APK，不动 main。
用法：
  python3 tools/test-branch-build.py --branch test/edge-to-edge \
      --include-from tools/nawu-push-files.txt --local app --out /tmp/testbuild
只创建/更新测试分支，绝不更新 main、不打 tag、不更新 OTA。
"""
import argparse, base64, hashlib, json, os, pathlib, subprocess, sys, tempfile, time, zipfile
import urllib.request, urllib.error

API = 'https://api.github.com'
UA = 'nawu-testbuild/1.0'

def api(path, token, method='GET', body=None, retries=5):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {'User-Agent': UA, 'Accept': 'application/vnd.github+json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if body is not None:
        headers['Content-Type'] = 'application/json'
    last = None
    for a in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (301,302,303,307,308):
                loc = e.headers.get('Location'); 
                if loc:
                    url = loc; continue
            time.sleep(2*(a+1))
        except Exception as e:
            last = e; time.sleep(2*(a+1))
    raise SystemExit(f'[中止] API 失败 {url}: {last}')

def blob_sha1(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()

def put_blob(repo, token, data):
    for a in range(3):
        r = subprocess.run(['curl','-s','--max-time','90','--connect-timeout','20','-X','POST',
            '-H',f'Authorization: Bearer {token}','-H','Accept: application/vnd.github+json',
            '-H','Content-Type: application/json','-H','User-Agent: '+UA,
            '--data-binary','@-','-w','\n%{http_code}',f'{API}/repos/{repo}/git/blobs'],
            input=json.dumps({'content':base64.b64encode(data).decode(),'encoding':'base64'}),
            capture_output=True,text=True)
        try:
            out=json.loads(r.stdout.rsplit('\n',1)[0] or '{}')
            if out.get('sha'): return out['sha']
        except Exception: pass
        time.sleep(2*(a+1))
    return ''

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--repo',default='***/nawu')
    ap.add_argument('--local',default='app')
    ap.add_argument('--token',default=os.environ.get('GITHUB_TOKEN',''))
    ap.add_argument('--branch',required=True)
    ap.add_argument('--base',default='main')
    ap.add_argument('--include-from',required=True)
    ap.add_argument('--message',default='test: edge-to-edge disable')
    ap.add_argument('--out',default='/tmp/testbuild')
    ap.add_argument('--skip-dispatch',action='store_true',help='只推分支，不触发构建')
    a=ap.parse_args()
    root=pathlib.Path(a.local); out=pathlib.Path(a.out); out.mkdir(parents=True,exist_ok=True)

    # 1) 若测试分支不存在，从 base 创建
    refs=api(f'/repos/{a.repo}/git/ref/heads/{a.base}',a.token)
    base_sha=refs['object']['sha']
    try:
        api(f'/repos/{a.repo}/git/ref/heads/{a.branch}',a.token)
        print(f'测试分支已存在：{a.branch}')
    except SystemExit:
        api(f'/repos/{a.repo}/git/refs',a.token,'POST',{'ref':f'refs/heads/{a.branch}','sha':base_sha})
        print(f'已从 {a.base} 创建测试分支：{a.branch}')

    # 2) 测试分支上的 tree 作为 base_tree，只叠加白名单改动
    ref=api(f'/repos/{a.repo}/git/ref/heads/{a.branch}',a.token)
    commit=api(f'/repos/{a.repo}/git/commits/{ref["object"]["sha"]}',a.token)
    base_tree=commit['tree']['sha']

    include=[l.strip() for l in pathlib.Path(a.include_from).read_text(encoding='utf-8').splitlines()
             if l.strip() and not l.strip().startswith('#')]
    keep=set(include)
    # 只推本地存在且在白名单内的文件里，与测试分支不同的
    entries=[]
    for rel in sorted(keep):
        p=root/rel
        if not p.is_file(): continue
        data=p.read_bytes()
        # 与远端比对（测试分支 tree）
        t=api(f'/repos/{a.repo}/git/trees/{base_tree}',a.token)
        # 简化：直接逐个上传并加入 entries（Git tree 会覆盖同名）
        sha=put_blob(a.repo,a.token,data)
        if sha:
            entries.append({'path':rel,'mode':'100644','type':'blob','sha':sha})
    print(f'白名单内可推送文件 {len(entries)} 个')
    if not entries:
        print('无改动'); 
    else:
        tree=api(f'/repos/{a.repo}/git/trees',a.token,'POST',{'base_tree':base_tree,'tree':entries})
        nc=api(f'/repos/{a.repo}/git/commits',a.token,'POST',{'message':a.message,'tree':tree['sha'],'parents':[ref['object']['sha']]})
        api(f'/repos/{a.repo}/git/refs/heads/{a.branch}',a.token,'PATCH',{'sha':nc['sha']})
        print(f'✅ 已推到测试分支 {a.branch}：{nc["sha"][:10]}')

    # 3) dispatch 该分支
    if a.skip_dispatch:
        print('（--skip-dispatch：不触发构建）')
        return
    wf=None
    for w in api(f'/repos/{a.repo}/actions/workflows',a.token).get('workflows',[]):
        if w.get('name')=='Build APK' or w.get('path','').endswith('build-apk.yml'):
            wf=w; break
    before=api(f'/repos/{a.repo}/actions/runs?per_page=1',a.token)['workflow_runs']
    before_id=before[0]['id'] if before else 0
    api(f'/repos/{a.repo}/actions/workflows/{wf["id"]}/dispatches',a.token,'POST',{'ref':a.branch})
    print(f'已触发 Build APK（ref={a.branch}），等待…')
    run=None
    for _ in range(60):
        time.sleep(5)
        runs=api(f'/repos/{a.repo}/actions/runs?per_page=5',a.token)['workflow_runs']
        run=next((r for r in runs if r['id']!=before_id and r['workflow_id']==wf['id']),None)
        if run: break
    print(f'  run #{run["run_number"]} {run["html_url"]}')
    t0=time.time()
    while run['status']!='completed':
        if time.time()-t0>1800: raise SystemExit('[中止] 构建超时')
        time.sleep(15)
        run=api(f'/repos/{a.repo}/actions/runs/{run["id"]}',a.token)
        print(f'  {run["status"]} / {run.get("conclusion") or "-"} …')
    if run['conclusion']!='success':
        raise SystemExit(f'[中止] 构建失败：{run["conclusion"]} {run["html_url"]}')
    print(f'✅ 构建成功，artifact 下载页：{run["html_url"]}')

if __name__=='__main__':
    main()