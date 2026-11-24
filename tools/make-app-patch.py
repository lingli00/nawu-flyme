"""生成 NAWU-PATCH1 增量补丁，并自校验。

格式（小端，与 NawuPatch.java 严格一致）：
  magic     "NAWUPATCH1"      10 字节
  newSize   int64
  ctrlLen / diffLen / extraLen  int32 x3
  ctrl 块  raw deflate：int64 (x, y, z) x N
  diff 块  raw deflate：y 字节叠加量（new = (old + diff) & 0xFF）
  extra 块 raw deflate：z 字节字面内容

应用语义（与 NawuPatch.apply 一致）：
  oldPos += x; 复制 y 字节 old[oldPos..] + diff; oldPos += y; 追加 z 字节 extra。
  因此「拷贝旧文件某区间」= x 跳到该区间，diff 全 0；「新内容」= y=0, z=len。

本脚本按 ZIP 条目对齐：未改动的条目整段从旧 APK 拷贝，改动条目写字面量，
这样补丁只包含真正变化的字节。
"""
import hashlib
import struct
import sys
import zlib

MAGIC = b"NAWUPATCH1"


# ---------- ZIP 解析 ----------
def zip_entries(path):
    """返回 [(name, local_off, span_len, comp_sha)]，span_len 含本地头。"""
    data = open(path, "rb").read()
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise SystemExit("找不到 EOCD：" + path)
    cd_off = struct.unpack_from("<I", data, eocd + 16)[0]
    cd_size = struct.unpack_from("<I", data, eocd + 12)[0]
    count = struct.unpack_from("<H", data, eocd + 10)[0]

    entries = []
    p = cd_off
    end = cd_off + cd_size
    while p < end and data[p:p + 4] == b"PK\x01\x02":
        comp_size = struct.unpack_from("<I", data, p + 20)[0]
        name_len = struct.unpack_from("<H", data, p + 28)[0]
        extra_len = struct.unpack_from("<H", data, p + 30)[0]
        comment_len = struct.unpack_from("<H", data, p + 32)[0]
        local_off = struct.unpack_from("<I", data, p + 42)[0]
        name = data[p + 46:p + 46 + name_len].decode("utf-8", "replace")

        if data[local_off:local_off + 4] != b"PK\x03\x04":
            raise SystemExit("本地头签名不符: %s @%d" % (name, local_off))
        l_name = struct.unpack_from("<H", data, local_off + 26)[0]
        l_extra = struct.unpack_from("<H", data, local_off + 28)[0]
        data_off = local_off + 30 + l_name + l_extra
        span = data_off + comp_size - local_off
        comp = data[data_off:data_off + comp_size]
        entries.append((name, local_off, span, hashlib.sha256(comp).hexdigest()))
        p += 46 + name_len + extra_len + comment_len

    if len(entries) != count:
        print("警告：CD 条目数 %d 与 EOCD 声明 %d 不一致" % (len(entries), count))
    return data, entries


# ---------- 分段 ----------
def build_segments(old_data, old_entries, new_data, new_entries):
    """返回 [('copy', old_off, len) | ('lit', bytes)]，按 new 文件顺序无缝覆盖。"""
    old_by_name = {}
    for name, off, span, sha in old_entries:
        old_by_name.setdefault(name, []).append((off, span, sha))
    for k in old_by_name:
        old_by_name[k].sort()

    segs = []
    pos = 0
    copied = 0
    literal = 0

    new_sorted = sorted(new_entries, key=lambda e: e[1])
    for name, off, span, sha in new_sorted:
        if off > pos:
            gap = new_data[pos:off]
            segs.append(("lit", gap))
            literal += len(gap)
            pos = off
        # 本地头 + 压缩数据完全一致才整段拷贝
        hit = None
        for o_off, o_span, o_sha in old_by_name.get(name, []):
            if o_sha == sha and o_span == span and old_data[o_off:o_off + span] == new_data[off:off + span]:
                hit = o_off
                break
        if hit is not None:
            segs.append(("copy", hit, span))
            copied += span
        else:
            segs.append(("lit", new_data[off:off + span]))
            literal += span
        pos = off + span

    if pos < len(new_data):
        tail = new_data[pos:]
        segs.append(("lit", tail))
        literal += len(tail)

    print("拷贝自旧包: %.2f MB | 字面新增: %.2f MB" % (copied / 1048576, literal / 1048576))
    return segs


def encode(segs, new_size):
    ctrl = bytearray()
    diff = bytearray()
    extra = bytearray()
    old_pos = 0
    for seg in segs:
        if seg[0] == "copy":
            _tag, target, length = seg
            x = target - old_pos
            ctrl += struct.pack("<qqq", x, length, 0)
            diff += b"\x00" * length
            old_pos = target + length
        else:
            payload = seg[1]
            if not payload:
                continue
            ctrl += struct.pack("<qqq", 0, 0, len(payload))
            extra += payload

    def deflate(b):
        co = zlib.compressobj(9, zlib.DEFLATED, -15)
        return co.compress(bytes(b)) + co.flush()

    c, d, e = deflate(ctrl), deflate(diff), deflate(extra)
    header = MAGIC + struct.pack("<qiii", new_size, len(c), len(d), len(e))
    return header + c + d + e


# ---------- 自校验（严格复刻 NawuPatch.apply） ----------
def apply_patch(old, patch):
    if len(patch) < 30 or patch[:10] != MAGIC:
        raise SystemExit("magic 不符")
    new_size, ctrl_len, diff_len, extra_len = struct.unpack_from("<qiii", patch, 10)
    off = 30
    if off + ctrl_len + diff_len + extra_len > len(patch):
        raise SystemExit("块长度越界")

    def inflate(o, n):
        if n == 0:
            return b""
        return zlib.decompressobj(-15).decompress(patch[o:o + n])

    ctrl = inflate(off, ctrl_len)
    off += ctrl_len
    diff = inflate(off, diff_len)
    off += diff_len
    extra = inflate(off, extra_len)

    out = bytearray(new_size)
    new_pos = old_pos = ctrl_pos = diff_pos = extra_pos = 0
    while new_pos < new_size:
        if ctrl_pos + 24 > len(ctrl):
            raise SystemExit("控制块不完整")
        x, y, z = struct.unpack_from("<qqq", ctrl, ctrl_pos)
        ctrl_pos += 24
        if y < 0 or z < 0 or new_pos + y + z > new_size or diff_pos + y > len(diff) or extra_pos + z > len(extra):
            raise SystemExit("控制块数值越界")
        old_pos += x
        if old_pos < 0:
            old_pos = 0
        for i in range(y):
            oi = old_pos + i
            o = old[oi] if 0 <= oi < len(old) else 0
            out[new_pos + i] = (o + diff[diff_pos + i]) & 0xFF
        new_pos += y
        diff_pos += y
        old_pos += y
        if z > 0:
            out[new_pos:new_pos + z] = extra[extra_pos:extra_pos + z]
            new_pos += z
            extra_pos += z
    return bytes(out)


def main():
    old_path, new_path, out_path = sys.argv[1:4]
    old_data, old_entries = zip_entries(old_path)
    new_data, new_entries = zip_entries(new_path)
    print("旧包条目 %d（%.2f MB）| 新包条目 %d（%.2f MB）" % (
        len(old_entries), len(old_data) / 1048576, len(new_entries), len(new_data) / 1048576))

    segs = build_segments(old_data, old_entries, new_data, new_entries)
    patch = encode(segs, len(new_data))
    open(out_path, "wb").write(patch)
    print("补丁已写入 %s（%.2f MB，%.1f%% of 全量）" % (
        out_path, len(patch) / 1048576, 100.0 * len(patch) / len(new_data)))

    merged = apply_patch(old_data, patch)
    ok = hashlib.sha256(merged).hexdigest() == hashlib.sha256(new_data).hexdigest()
    print("自校验合成结果与新 APK 一致:", "是" if ok else "否")
    print("  新 APK sha256 :", hashlib.sha256(new_data).hexdigest())
    print("  合成包 sha256 :", hashlib.sha256(merged).hexdigest())
    if not ok:
        sys.exit(2)


if __name__ == "__main__":
    main()
