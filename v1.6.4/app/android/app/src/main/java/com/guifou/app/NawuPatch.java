package com.guifou.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * v1.0.36 · NAWU-PATCH1 差分包合并（bspatch 的简化同构实现）。
 *
 * 为什么不直接用 bsdiff：bsdiff 的三个块是 bzip2 压缩的，Android 侧没有现成
 * 的 bzip2 流解码器；这里把压缩换成 deflate（java.util.zip.Inflater 原生支持），
 * 控制块/差异块/字面块的结构与 bsdiff 完全一致（x/y/z 三元组），
 * 生成端见 .gh/make-app-patch.py（Python，两端严格对齐）。
 *
 * 文件格式（小端）：
 *   magic   "NAWUPATCH1"      10 字节
 *   newSize int64              新文件总长
 *   ctrlLen/diffLen/extraLen  int32 ×3   三块 deflate 后的长度
 *   ctrl 块（deflate）  int64 三元组 (x, y, z) × N
 *        x = oldPos 增量跳转；y = 从旧文件拷贝的长度（叠加 diff）；z = 字面字节数
 *   diff 块（deflate）  y 字节的叠加量（new = (old + diff) & 0xFF）
 *   extra 块（deflate） z 字节的字面内容
 */
public final class NawuPatch {
    private static final byte[] MAGIC = "NAWUPATCH1".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    private static final int HEADER_LEN = 10 + 8 + 4 + 4 + 4; // 30
    private static final long MAX_NEW_SIZE = 512L * 1024 * 1024;

    private NawuPatch() {
    }

    /** 合并差分包：oldPath（已安装 APK）+ patchPath → outPath。 */
    public static void apply(String oldPath, String patchPath, String outPath) throws IOException {
        byte[] old   = readFile(oldPath);
        byte[] patch = readFile(patchPath);
        if (patch.length < HEADER_LEN || !Arrays.equals(Arrays.copyOfRange(patch, 0, 10), MAGIC)) {
            throw new IOException("不是有效的差分包（magic 不匹配）");
        }
        ByteBuffer bb = ByteBuffer.wrap(patch).order(ByteOrder.LITTLE_ENDIAN);
        bb.position(10);
        long newSize = bb.getLong();
        int ctrlLen  = bb.getInt();
        int diffLen  = bb.getInt();
        int extraLen = bb.getInt();
        if (newSize < 0 || newSize > MAX_NEW_SIZE) {
            throw new IOException("差分包声明的新文件大小异常：" + newSize);
        }
        int off = HEADER_LEN;
        if ((long) off + ctrlLen + diffLen + extraLen > patch.length) {
            throw new IOException("差分包块长度越界");
        }
        byte[] ctrl  = inflate(patch, off, ctrlLen);
        off += ctrlLen;
        byte[] diff  = inflate(patch, off, diffLen);
        off += diffLen;
        byte[] extra = inflate(patch, off, extraLen);

        byte[] out = new byte[(int) newSize];
        long newPos  = 0;
        long oldPos  = 0;
        int ctrlPos  = 0;
        int diffPos  = 0;
        int extraPos = 0;
        ByteBuffer cbb = ByteBuffer.wrap(ctrl).order(ByteOrder.LITTLE_ENDIAN);
        while (newPos < newSize) {
            if (ctrlPos + 24 > ctrl.length) {
                throw new IOException("差分包控制块不完整");
            }
            long x = cbb.getLong(ctrlPos);
            long y = cbb.getLong(ctrlPos + 8);
            long z = cbb.getLong(ctrlPos + 16);
            ctrlPos += 24;
            if (y < 0 || z < 0 || newPos + y + z > newSize || diffPos + y > diff.length || extraPos + z > extra.length) {
                throw new IOException("差分包控制块数值越界");
            }
            oldPos += x;
            if (oldPos < 0) {
                oldPos = 0;
            }
            for (long i = 0; i < y; i++) {
                long oi = oldPos + i;
                int o = (oi >= 0 && oi < old.length) ? (old[(int) oi] & 0xFF) : 0;
                int d = diff[diffPos + (int) i] & 0xFF;
                out[(int) (newPos + i)] = (byte) ((o + d) & 0xFF);
            }
            newPos += y;
            diffPos += (int) y;
            oldPos += y;
            if (z > 0) {
                System.arraycopy(extra, extraPos, out, (int) newPos, (int) z);
                newPos += z;
                extraPos += (int) z;
            }
        }

        File outFile = new File(outPath);
        File parent = outFile.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建输出目录：" + parent);
        }
        FileOutputStream fos = new FileOutputStream(outFile);
        try {
            fos.write(out);
        } finally {
            fos.close();
        }
    }

    /** raw deflate 解压（wbits = -15）。 */
    private static byte[] inflate(byte[] src, int off, int len) throws IOException {
        if (len == 0) {
            return new byte[0];
        }
        Inflater inf = new Inflater(true);
        inf.setInput(src, off, len);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(1024, len * 4));
        byte[] buf = new byte[16384];
        try {
            while (!inf.finished()) {
                int n = inf.inflate(buf);
                if (n > 0) {
                    bos.write(buf, 0, n);
                } else if (inf.needsInput() || inf.needsDictionary()) {
                    break;
                }
            }
        } catch (DataFormatException e) {
            throw new IOException("差分包解压失败（数据损坏）");
        } finally {
            inf.end();
        }
        return bos.toByteArray();
    }

    private static byte[] readFile(String path) throws IOException {
        File f = new File(path);
        if (!f.isFile()) {
            throw new IOException("文件不存在：" + path);
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream((int) Math.min(f.length(), 64L * 1024 * 1024));
        InputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
        } finally {
            in.close();
        }
        return bos.toByteArray();
    }

    /** 文件 sha256（小写十六进制）。 */
    public static String sha256File(String path) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("当前环境不支持 SHA-256");
        }
        InputStream in = new FileInputStream(path);
        try {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
        } finally {
            in.close();
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
