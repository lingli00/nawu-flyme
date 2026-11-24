#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
推服务端文件到 ***/nawu 的 server/ 目录。

背景：`github-sync.py --local 工程/app` 只把 app 目录当仓库根，
服务端源码在 `工程/server`（仓库里的 `server/`），脚本没有跨根映射能力。
这里复用它的底层 `api()`，只做一次「追加 server/* 的树更新」。
"""
import sys, hashlib, base64, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import importlib.util

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("ghsync", HERE / "github-sync.py")
gh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gh)

REPO = "***/nawu"
SERVER_DIR = pathlib.Path(r"C:\Users\Administrator\Desktop\DSH-工作目录\项目\纳物\工程\server")
TOKEN = sys.argv[1]
MESSAGE = sys.argv[2] if len(sys.argv) > 2 else "chore: sync server"

# 只推这些（白名单），避免把 storage/ 测试脚本等推上去
WHITELIST = [
    "server/index.php",
    "server/app/Api.php",
    "server/app/VERSION",
    "server/app/spa-m.html",
    "server/app/lib/AiApi.php",
    "server/app/lib/AiSchema.php",
    "server/app/lib/EntityNormalize.php",
    "server/app/lib/ImageStore.php",
    "server/app/lib/BrandIndex.php",
    "server/app/lib/Update.php",
    "server/app/lib/Support.php",
]

def main():
    # 1. 取 main 最新 commit 与其 tree
    ref = gh.api(f"/repos/{REPO}/git/ref/heads/main", TOKEN)
    head_sha = ref["object"]["sha"]
    commit = gh.api(f"/repos/{REPO}/git/commits/{head_sha}", TOKEN)
    base_tree = commit["tree"]["sha"]
    print(f"base commit: {head_sha[:10]}")

    # 2. 逐个上传 blob
    tree_entries = []
    for rel in WHITELIST:
        # rel 形如 server/app/lib/X.php → 本地路径去 server/ 前缀
        local_rel = rel[len("server/"):]
        lp = SERVER_DIR / local_rel.replace("/", "\\")
        if not lp.is_file():
            print(f"  ✘ 缺失 {lp}")
            continue
        data = lp.read_bytes()
        sha = gh.put_blob(data) if hasattr(gh, "put_blob") else None
        if sha is None:
            # 兜底：直接调 API
            b = gh.api(f"/repos/{REPO}/git/blobs", TOKEN, method="POST",
                       body={"content": base64.b64encode(data).decode(), "encoding": "base64"})
            sha = b["sha"]
        tree_entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": sha})
        print(f"  ✔ {rel} ({len(data)} B)")

    if not tree_entries:
        print("没有可推的文件")
        return 1

    # 3. 建新 tree
    tree = gh.api(f"/repos/{REPO}/git/trees", TOKEN, method="POST",
                  body={"base_tree": base_tree, "tree": tree_entries})
    print(f"new tree: {tree['sha'][:10]}")

    # 4. 建 commit
    new_commit = gh.api(f"/repos/{REPO}/git/commits", TOKEN, method="POST",
                        body={"message": MESSAGE, "tree": tree["sha"], "parents": [head_sha]})
    print(f"new commit: {new_commit['sha'][:10]}")

    # 5. 更新 ref
    gh.api(f"/repos/{REPO}/git/refs/heads/main", TOKEN, method="PATCH",
           body={"sha": new_commit["sha"]})
    print(f"OK pushed {len(tree_entries)} server files")
    return 0

if __name__ == "__main__":
    sys.exit(main())