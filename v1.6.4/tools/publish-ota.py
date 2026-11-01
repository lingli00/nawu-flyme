#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纳物 NaWu · 更新渠道清单生成器（v1.6.4）
================================================================================
把一个「渠道目录」里的安装包/增量包扫一遍，生成客户端要读的两个清单：

    app-manifest.json   App 端检查更新用（字段与客户端 ChannelManifest 一一对应）
    manifest.json       服务端「在线更新」用（可选，给了服务端包才生成）

字段口径与 tools/update-panel/nawu-update-panel.php 的 build_app_manifest() 完全一致，
所以用本脚本生成的清单，和用面板「重建清单」得到的结果可以互相替换。

★v1.6.4 起渠道 = 服务端站点根目录（见 app/src/lib/appVersion.ts），
  因此清单里的 url 一律写**相对文件名**，客户端会自己拼 origin：
      https://x.133388.xyz/app-manifest.json
      https://x.133388.xyz/nawu-v1.6.4.apk

用法（在工程根目录）：

    # 1) 把渠道目录准备好（文件名就是版本来源）
    #    <dir>/nawu-v1.6.4.apk
    #    <dir>/1.6.3-to-1.6.4.patch        （可选，有就优先走增量）
    #    <dir>/nawu-server-v1.6.4.zip      （可选，服务端自更新用）
    python tools/publish-ota.py --dir dist-ota --notes "修复输入框光标跳末尾"

    # 2) 直接上传到站点根（FTP）
    python tools/publish-ota.py --dir dist-ota --upload \
        --ftp-host 113.44.1.3 --ftp-user genxin --ftp-pass genxin

    # 3) 只体检不写文件
    python tools/publish-ota.py --dir dist-ota --check
"""

import argparse
import ftplib
import hashlib
import json
import os
import re
import sys
import time
import zipfile

APP_ID = 'nawu-app'

APK_RE = re.compile(r'^nawu-v?(\d+(?:\.\d+)*)\.apk$', re.I)
PATCH_RE = re.compile(r'^v?(\d+(?:\.\d+)*)-to-v?(\d+(?:\.\d+)*)\.patch$', re.I)
SERVER_RE = re.compile(r'^nawu-server-v?(\d+(?:\.\d+)*)\.(zip|bin)$', re.I)

# 服务端包里不入清单的路径（运行时数据 / 垃圾文件），与面板逻辑一致
SKIP_PREFIX = ('storage/',)
SKIP_EXT = re.compile(r'\.(zip|part|log|bak|old|tmp)$', re.I)
MAX_FILES = 6000


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def vkey(v):
    """版本号比较用的键：缺失段按 0 补齐。"""
    parts = [int(x) for x in v.split('.') if x.isdigit()]
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts[:4])


def scan(channel_dir):
    apks, patches, servers = [], [], []
    for name in sorted(os.listdir(channel_dir)):
        full = os.path.join(channel_dir, name)
        if not os.path.isfile(full):
            continue
        low = name.lower()
        info = {'name': name, 'size': os.path.getsize(full), 'mtime': int(os.path.getmtime(full))}
        if low.endswith('.apk'):
            m = APK_RE.match(name)
            info['version'] = m.group(1) if m else ''
            apks.append(info)
        elif low.endswith('.patch'):
            m = PATCH_RE.match(name)
            info['from'] = m.group(1) if m else ''
            info['to'] = m.group(2) if m else ''
            patches.append(info)
        elif (low.endswith('.zip') or low.endswith('.bin')) and SERVER_RE.match(name):
            m = SERVER_RE.match(name)
            info['version'] = m.group(1) if m else ''
            info['kind'] = (m.group(2) if m else 'zip').lower()
            servers.append(info)

    apks.sort(key=lambda a: vkey(a['version']), reverse=True)
    servers.sort(key=lambda a: vkey(a['version']), reverse=True)
    patches.sort(key=lambda p: vkey(p['to']), reverse=True)
    return apks, patches, servers


def build_app_manifest(channel_dir, apks, patches, notes, min_version):
    if not apks:
        raise SystemExit('[中止] 渠道目录里没有 APK（命名规范：nawu-v1.6.4.apk）')
    apk = apks[0]
    if not apk['version']:
        raise SystemExit(f"[中止] APK 文件名里没有版本号：{apk['name']}")
    apk_sha = sha256_of(os.path.join(channel_dir, apk['name']))

    plist = []
    for p in patches:
        # 只带「能升到当前最新版」的补丁；其余留作历史
        if p['to'] != apk['version'] or not p['from']:
            continue
        plist.append({
            'from': p['from'],
            'url': p['name'],
            'size': p['size'],
            'sha256': sha256_of(os.path.join(channel_dir, p['name'])),
            'apkSha256': apk_sha,   # 合成结果必须与全量包逐字节一致
        })

    return {
        'app': APP_ID,
        'version': apk['version'],
        'publishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(apk['mtime'])),
        'notes': notes,
        'minVersion': min_version,
        'apk': {'url': apk['name'], 'size': apk['size'], 'sha256': apk_sha},
        'patches': plist,
    }


def build_server_manifest(channel_dir, servers, notes, min_version):
    if not servers:
        return None
    pkg = servers[0]
    path = os.path.join(channel_dir, pkg['name'])
    files = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            name = info.filename.replace('\\', '/')
            if name.endswith('/') or not name:
                continue
            # 去掉多套的一层版本目录（v1.6.4/xxx）
            if '/' in name:
                top, rest = name.split('/', 1)
                if re.match(r'^v?\d+\.\d+', top) and top not in ('server', 'app'):
                    name = rest
            if name.startswith(SKIP_PREFIX) or SKIP_EXT.search(name):
                continue
            data = z.read(info)
            files.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
            if len(files) >= MAX_FILES:
                break
    if not files:
        raise SystemExit('[中止] 服务端包里没有可用文件')
    return {
        'version': pkg['version'] or '1.0.0',
        'publishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(pkg['mtime'])),
        'notes': notes,
        'minVersion': min_version,
        'packageUrl': pkg['name'],
        'packageSize': pkg['size'],
        'packageSha256': sha256_of(path),
        'files': files,
    }


def dump(path, data):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def ftp_upload(host, user, password, local_files, remote_dir='/'):
    ftp = ftplib.FTP()
    ftp.connect(host, 21, timeout=60)
    ftp.login(user, password)
    ftp.set_pasv(True)
    if remote_dir not in ('', '/'):
        ftp.cwd(remote_dir)
    for local, remote in local_files:
        size = os.path.getsize(local)
        with open(local, 'rb') as f:
            ftp.storbinary(f'STOR {remote}', f, blocksize=256 * 1024)
        print(f'  上传 {remote} ({size / 1048576:.2f} MB)')
    try:
        ftp.quit()
    except Exception:
        ftp.close()


def main():
    ap = argparse.ArgumentParser(description='生成纳物更新渠道清单（app-manifest.json / manifest.json）')
    ap.add_argument('--dir', required=True, help='渠道目录（放 apk / patch / 服务端 zip）')
    ap.add_argument('--notes', default='', help='更新说明（显示在更新弹窗里）')
    ap.add_argument('--min-version', default='', help='最低可更新版本（低于它的必须整包重装）')
    ap.add_argument('--check', action='store_true', help='只打印结果，不写文件')
    ap.add_argument('--upload', action='store_true', help='生成后直接上传到站点根')
    ap.add_argument('--ftp-host', default='113.44.1.3')
    ap.add_argument('--ftp-user', default='genxin')
    ap.add_argument('--ftp-pass', default='genxin')
    ap.add_argument('--no-server', action='store_true', help='忽略服务端 zip，不生成 manifest.json')
    args = ap.parse_args()

    d = args.dir
    if not os.path.isdir(d):
        raise SystemExit(f'[中止] 目录不存在：{d}')

    apks, patches, servers = scan(d)
    app_m = build_app_manifest(d, apks, patches, args.notes, args.min_version)
    srv_m = None if args.no_server else build_server_manifest(d, servers, args.notes, args.min_version)

    print('== 渠道目录 ==', os.path.abspath(d))
    print(f'  APK      : {", ".join(a["name"] for a in apks) or "（无）"}')
    print(f'  增量包   : {", ".join(p["name"] for p in patches) or "（无）"}')
    print(f'  服务端包 : {", ".join(s["name"] for s in servers) or "（无）"}')
    print()
    print(f'== app-manifest.json ==  version={app_m["version"]}  apk={app_m["apk"]["size"] / 1048576:.2f} MB'
          f'  patches={len(app_m["patches"])}')
    print(f'   sha256={app_m["apk"]["sha256"]}')
    if srv_m:
        print(f'== manifest.json ==  version={srv_m["version"]}  files={len(srv_m["files"])}'
              f'  pkg={srv_m["packageSize"] / 1048576:.2f} MB')
    if srv_m['packageUrl'].endswith('.zip'):
        print('  ⚠ 服务端包用 .zip 命名：宝塔/Nginx 默认屏蔽 .zip 扩展名（HTTP 取回会 404），'
              '请改名为 .bin 再发布（内容仍是 zip，ZipArchive 按内容解包，不看扩展名）')

    if args.check:
        print('\n（--check：未写入任何文件）')
        return

    app_path = os.path.join(d, 'app-manifest.json')
    dump(app_path, app_m)
    print(f'\n已写入 {app_path}')
    uploads = [(app_path, 'app-manifest.json')]
    if srv_m:
        srv_path = os.path.join(d, 'manifest.json')
        dump(srv_path, srv_m)
        print(f'已写入 {srv_path}')
        uploads.append((srv_path, 'manifest.json'))

    # 安装包与补丁一起传，避免清单先到、包没到（客户端 404）
    for a in apks[:1]:
        uploads.append((os.path.join(d, a['name']), a['name']))
    for p in patches[:3]:
        uploads.append((os.path.join(d, p['name']), p['name']))
    if srv_m:
        uploads.append((os.path.join(d, servers[0]['name']), servers[0]['name']))

    if args.upload:
        print(f'\n== 上传到 ftp://{args.ftp_host} 站点根 ==')
        ftp_upload(args.ftp_host, args.ftp_user, args.ftp_pass, uploads)
        print('完成。')


if __name__ == '__main__':
    sys.exit(main())
