# storage/app-release —— App 内更新用的发布目录

本目录**刻意留空**（只放一个空白 `manifest.json`），因为你手上的这份是工程基线，
不含任何历史安装包。

## 想启用「App 内检查更新」时

1. 把编译好的 `nawu-vX.Y.Z.apk` 放进本目录；
2. 编辑同目录的 `manifest.json`：

   ```json
   {
     "version": "1.0.34",
     "notes": "本次更新说明（App 弹窗里会原样显示）",
     "file": "nawu-v1.0.34.apk",
     "fileSize": 11700000,
     "publishedAt": "2026-10-20 10:00",
     "history": []
   }
   ```

3. 浏览器访问 `http://你的域名/api/app/version` 确认返回新版本号；
4. 想留升级记录就往下追加到 `history` 数组（App 的版本历史页会读它）。

> `fileSize` 必须与 APK 实际字节数一致，App 用它来校验下载完整性。
> 留空（`version: ""`）时，App 显示「已是最新版」，不会提示升级。
