package com.guifou.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * v1.0.36 · 应用内更新插件（ApkUpdate）。
 *
 * 能力：
 *  - getInfo            已安装 APK 的 sourceDir / 版本号
 *  - download           带进度的 APK/补丁下载（Range 续传 + sha256 校验），
 *                      进度通过 downloadProgress 事件推送
 *  - applyPatch         用已安装 APK + NAWU-PATCH1 补丁合成新 APK（见 NawuPatch）
 *  - sha256File         计算文件 sha256
 *  - install            经 FileProvider 调起系统安装器
 *  - canInstall / openInstallSettings  Android 8+ 的「安装未知应用」授权
 *
 * 下载与合并都放在工作线程里执行，不阻塞 UI；大文件走缓存目录
 * （context.getCacheDir()/apk/，已在 file_paths.xml 的 cache-path 覆盖范围内）。
 */
@CapacitorPlugin(name = "ApkUpdate")
public class ApkUpdatePlugin extends Plugin {

    private static final String APK_SUBDIR = "apk";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int PROGRESS_STEP_BYTES = 512 * 1024;

    /** 净化文件名：只保留安全字符，防路径穿越。 */
    private static String safeName(String name, String fallback) {
        if (name == null || name.trim().isEmpty()) {
            return fallback;
        }
        String s = name.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        if (s.isEmpty() || s.equals(".") || s.equals("..")) {
            return fallback;
        }
        return s;
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put(
                "sourceDir",
                getContext().getPackageManager().getApplicationInfo(getContext().getPackageName(), 0).sourceDir
            );
        } catch (Exception e) {
            ret.put("sourceDir", "");
        }
        ret.put("versionName", BuildConfig.VERSION_NAME);
        ret.put("versionCode", BuildConfig.VERSION_CODE);
        call.resolve(ret);
    }

    /**
     * 下载文件（APK 或差分包）到缓存目录，带进度事件。
     * 参数：{ url, sha256?, fileName? } → { path, size, sha256 }
     */
    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256", "");
        final String fileName = safeName(call.getString("fileName"), "nawu-update.bin");
        if (url == null || url.trim().isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        new Thread(() -> {
            try {
                call.resolve(doDownload(url.trim(), sha256, fileName));
            } catch (Exception e) {
                call.reject("下载失败：" + e.getMessage(), null, e);
            }
        }).start();
    }

    private JSObject doDownload(String url, String sha256, String fileName) throws Exception {
        File dir = new File(getContext().getCacheDir(), APK_SUBDIR);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("无法创建缓存目录");
        }
        final File out = new File(dir, fileName);
        final File part = new File(dir, fileName + ".part");
        long have = part.isFile() ? part.length() : 0;

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("GET");
        conn.setInstanceFollowRedirects(true);
        if (have > 0) {
            conn.setRequestProperty("Range", "bytes=" + have + "-");
        }
        int code = conn.getResponseCode();
        InputStream in;
        if (code == 206) {
            in = conn.getInputStream();
        } else if (code == 200) {
            have = 0; // 上游不支持 Range，重下
            in = conn.getInputStream();
        } else {
            conn.disconnect();
            throw new Exception("更新源返回 HTTP " + code);
        }
        long contentLength = conn.getContentLengthLong();
        long total = have + (contentLength > 0 ? contentLength : 0);

        FileOutputStream fos = new FileOutputStream(part, have > 0);
        try {
            byte[] buf = new byte[65536];
            long received = have;
            long lastNotify = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                fos.write(buf, 0, n);
                received += n;
                if (received - lastNotify >= PROGRESS_STEP_BYTES) {
                    lastNotify = received;
                    JSObject ev = new JSObject();
                    ev.put("received", received);
                    ev.put("total", total);
                    notifyListeners("downloadProgress", ev);
                }
            }
        } finally {
            try {
                in.close();
            } catch (Exception ignored) {
                // ignore
            }
            fos.close();
            conn.disconnect();
        }

        if (total > 0 && part.length() != total) {
            throw new Exception("下载不完整（" + part.length() + "/" + total + "），请重试");
        }
        if (!part.renameTo(out)) {
            // rename 失败（目标已存在等）：拷贝后删临时文件
            copyFile(part, out);
            part.delete();
        }

        String actual = NawuPatch.sha256File(out.getAbsolutePath());
        if (sha256 != null && !sha256.trim().isEmpty() && !actual.equalsIgnoreCase(sha256.trim())) {
            out.delete();
            throw new Exception("文件校验失败（sha256 不匹配）");
        }
        JSObject ev = new JSObject();
        ev.put("received", out.length());
        ev.put("total", out.length());
        notifyListeners("downloadProgress", ev);

        JSObject ret = new JSObject();
        ret.put("path", out.getAbsolutePath());
        ret.put("size", out.length());
        ret.put("sha256", actual);
        return ret;
    }

    private static void copyFile(File src, File dst) throws Exception {
        RandomAccessFile raf = null;
        try {
            raf = new RandomAccessFile(src, "r");
            byte[] buf = new byte[65536];
            FileOutputStream fos = new FileOutputStream(dst);
            try {
                int n;
                while ((n = raf.read(buf)) > 0) {
                    fos.write(buf, 0, n);
                }
            } finally {
                fos.close();
            }
        } finally {
            if (raf != null) {
                raf.close();
            }
        }
    }

    /**
     * 合并差分包：以「已安装的 APK」为旧文件，patchPath 为补丁，输出到缓存目录。
     * 参数：{ patchPath, fileName } → { path, size, sha256 }
     */
    @PluginMethod
    public void applyPatch(PluginCall call) {
        final String patchPath = call.getString("patchPath");
        final String fileName = safeName(call.getString("fileName"), "nawu-merged.apk");
        if (patchPath == null || patchPath.trim().isEmpty()) {
            call.reject("缺少补丁路径");
            return;
        }
        new Thread(() -> {
            try {
                String oldPath = getContext().getPackageManager()
                    .getApplicationInfo(getContext().getPackageName(), 0).sourceDir;
                File dir = new File(getContext().getCacheDir(), APK_SUBDIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new Exception("无法创建缓存目录");
                }
                File out = new File(dir, fileName);
                NawuPatch.apply(oldPath, patchPath.trim(), out.getAbsolutePath());
                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                ret.put("size", out.length());
                ret.put("sha256", NawuPatch.sha256File(out.getAbsolutePath()));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("合并差分包失败：" + e.getMessage(), null, e);
            }
        }).start();
    }

    /** 计算文件 sha256：{ path } → { sha256, size } */
    @PluginMethod
    public void sha256File(PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少文件路径");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("sha256", NawuPatch.sha256File(path.trim()));
            ret.put("size", new File(path.trim()).length());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("计算 sha256 失败：" + e.getMessage(), null, e);
        }
    }

    /** 调起系统安装器：{ path } → { started, reason? } */
    @PluginMethod
    public void install(PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少安装包路径");
            return;
        }
        File f = new File(path.trim());
        if (!f.isFile()) {
            call.reject("安装包不存在");
            return;
        }
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            ret.put("started", false);
            ret.put("reason", "unknown_sources");
            call.resolve(ret);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("started", false);
            ret.put("reason", e.getMessage());
            call.resolve(ret);
        }
    }

    /** 是否已允许安装未知应用 → { allowed } */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("allowed", ok);
        call.resolve(ret);
    }

    /** 打开「安装未知应用」设置页。 */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }
}
