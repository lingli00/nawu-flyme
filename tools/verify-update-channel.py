#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纳物 NaWu · 更新渠道体检（v1.6.4）
================================================================================
模拟 App 端 `api/appUpdate.ts` 的检查链路，对着**线上渠道**逐项验证：

  1. 清单能不能拿到（客户端要求：HTTP 200 + 合法 JSON）
  2. 字段是否齐全（version 字符串、apk.url 非空 —— 缺了就静默回退用户服务器）
  3. 相对 url 能不能拼成绝对地址（客户端 absUrl 用 new URL(url, 渠道)）
  4. 安装包是否真的存在、大小是否与清单一致
  5. 是否支持 Range（断点续传依赖 206；客户端原生下载失败会重试续传）
  6. 全量 sha256 是否与清单一致（客户端装前校验，不一致直接拒绝安装）
  7. 给定「当前版本」时，客户端的判定结论（有更新 / 已是最新）

用法：
    python tools/verify-update-channel.py
    python tools/verify-update-channel.py --current 1.6.1 --download
"""

import argparse
import hashlib
import json
import sys
import urllib.request
from urllib.parse import urljoin

CHANNEL = 'https://your.domain.com/'


def get(url, headers=None, timeout=30, method='GET'):
    req = urllib.request.Request(url, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read()


def cmp_ver(a, b):
    """与客户端 compareVersions 同口径：分段数字比较，缺段按 0。"""
    pa = [int(x) if x.isdigit() else 0 for x in str(a).split('.')]
    pb = [int(x) if x.isdigit() else 0 for x in str(b).split('.')]
    n = max(len(pa), len(pb))
    pa += [0] * (n - len(pa))
    pb += [0] * (n - len(pb))
    return (pa > pb) - (pa < pb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--channel', default=CHANNEL)
    ap.add_argument('--current', default='1.6.2', help='模拟的客户端当前版本')
    ap.add_argument('--download', action='store_true', help='下载整个安装包校验 sha256（约 14MB）')
    args = ap.parse_args()

    base = args.channel if args.channel.endswith('/') else args.channel + '/'
    ok_all = True

    def check(name, cond, detail=''):
        nonlocal ok_all
        ok_all = ok_all and bool(cond)
        print(f"  [{'OK ' if cond else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")

    print(f'渠道：{base}   （模拟客户端当前版本：{args.current}）')

    # 1) 清单
    url = urljoin(base, 'app-manifest.json')
    try:
        status, headers, body = get(url)
    except Exception as e:                       # noqa: BLE001
        print(f'  [FAIL] 清单请求失败：{e}')
        return 1
    check('清单 HTTP 200', status == 200, f'{status} {headers.get("Content-Type", "")}')
    try:
        m = json.loads(body.decode('utf-8'))
    except Exception as e:                       # noqa: BLE001
        check('清单是合法 JSON', False, str(e))
        return 1
    check('清单是合法 JSON', True, f'{len(body)} 字节')

    # 2) 字段（对应 fetchChannelManifest 的校验）
    check('version 是字符串', isinstance(m.get('version'), str), repr(m.get('version')))
    apk = m.get('apk') or {}
    check('apk.url 非空', isinstance(apk.get('url'), str) and apk['url'] != '', repr(apk.get('url')))
    if not ok_all:
        return 1

    # 3) 绝对地址（客户端 absUrl：相对地址按渠道 origin 补全）
    apk_url = urljoin(base, apk['url'])
    check('安装包地址可解析', apk_url.startswith('http'), apk_url)
    print(f'        → 客户端实际下载：{apk_url}')

    # 4) 安装包存在 + 大小一致
    try:
        status, headers, _ = get(apk_url, method='HEAD')
        size = int(headers.get('Content-Length') or 0)
        check('安装包 HTTP 200', status == 200, f'{size} 字节')
        check('大小与清单一致', size == int(apk.get('size') or 0),
              f'清单 {apk.get("size")} / 实际 {size}')
        # 5) 断点续传
        status_r, _, part = get(apk_url, headers={'Range': 'bytes=0-1023'})
        check('支持 Range（206）', status_r == 206 and len(part) == 1024,
              f'{status_r} {len(part)} 字节')
    except Exception as e:                       # noqa: BLE001
        check('安装包可访问', False, str(e))
        return 1

    # 6) sha256
    if args.download:
        print('  下载整个安装包校验 sha256…')
        _, _, data = get(apk_url, timeout=600)
        got = hashlib.sha256(data).hexdigest()
        want = (apk.get('sha256') or '').lower()
        check('sha256 与清单一致', got == want, f'{got[:16]}… / 期望 {want[:16]}…')
    else:
        print('  （跳过 sha256 全量校验，加 --download 打开）')

    # 7) 客户端判定
    remote = m['version']
    rel = cmp_ver(remote, args.current)
    if rel > 0:
        patch = next((p for p in (m.get('patches') or []) if p.get('from') == args.current), None)
        print(f'\n  客户端判定：有更新 {args.current} → {remote}'
              f'（{"走增量包 " + patch["url"] if patch else "全量包"}）')
    else:
        print(f'\n  客户端判定：已是最新（远端 {remote} ≤ 本机 {args.current}）')
    print(f'  更新说明：{m.get("notes") or "（空）"}')

    print('\n结论：' + ('渠道可用 ✔' if ok_all else '渠道存在问题 ✘'))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
