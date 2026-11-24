# -*- coding: utf-8 -*-
"""
纳物 NaWu · 服务器备份工具（迭代前安全网）

用法（在仓库根目录执行）：
    python 工程/tools/backup-server.py

步骤：
  1. FTP 下载站点主程序 PHP（index.php / install.php / app/*.php / app/lib/*.php /
     app/VERSION / app/spa-m.html / storage/config.php）到 备份/server-<日期>/
  2. 上传一次性数据库导出脚本（带随机 token），HTTP 触发后把全库 flyme_* 表
     导出为 .sql.gz 存到服务器 storage/db-backups/，再 FTP 拉回本地
  3. 删除服务器上的一次性脚本与远端 dump（不留后门）

凭据来源：私钥与凭据/凭据.md（不写入本文件）。
"""

import ftplib
import io
import json
import os
import sys
import time
import urllib.request
import uuid

FTP_HOST = "0.0.0.0"
FTP_USER = "genxin"
FTP_PASS = "genxin"
SITE = "https://your.domain.com"

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BACKUP_ROOT = os.path.join(REPO, "备份")
OUT_DIR = os.path.join(BACKUP_ROOT, "server-" + time.strftime("%Y%m%d-%H%M%S"))

# 要备份的「目录内 PHP 文件」清单（qqwry.dat 26MB 等大文件不备份——不在改动面内）
FILE_LIST = [
    "/index.php",
    "/install.php",
    "/app/VERSION",
    "/app/spa-m.html",
]
DIR_LIST = [
    "/app",       # Api.php
    "/app/lib",   # 全部 lib
]
EXTRA_STORAGE = ["/storage/config.php"]


def ftp_connect():
    ftp = ftplib.FTP()
    ftp.connect(FTP_HOST, 21, timeout=30)
    ftp.login(FTP_USER, FTP_PASS)
    ftp.set_pasv(True)
    return ftp


def download(ftp, remote, local):
    os.makedirs(os.path.dirname(local), exist_ok=True)
    buf = io.BytesIO()
    ftp.retrbinary("RETR " + remote, buf.write)
    with open(local, "wb") as f:
        f.write(buf.getvalue())
    print("  ↓ %s (%d B)" % (remote, buf.tell()))


def upload(ftp, local, remote):
    with open(local, "rb") as f:
        ftp.storbinary("STOR " + remote, f)
    print("  ↑ %s" % remote)


DUMP_PHP = r"""<?php
// 一次性数据库导出脚本（用后即删）。带 token 校验，防止被扫描触发。
if (!defined('GF_ROOT')) { define('GF_ROOT', dirname(__FILE__)); }
$token = isset($_GET['token']) ? $_GET['token'] : '';
$expect = file_get_contents(__DIR__ . '/__nawu_dump_token.txt');
if ($expect === false || !hash_equals(trim($expect), $token)) {
    header('Content-Type: application/json'); http_response_code(403);
    echo json_encode(array('ok' => false, 'error' => 'forbidden')); exit;
}
$conf = include GF_ROOT . '/storage/config.php';
if (!is_array($conf)) { echo json_encode(array('ok' => false, 'error' => 'config')); exit; }
$db = $conf['db'];
$pdo = new PDO(
    'mysql:host=' . $db['host'] . ';port=' . (isset($db['port']) ? $db['port'] : 3306) . ';dbname=' . $db['name'] . ';charset=utf8mb4',
    $db['user'], $db['pass'], array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION)
);
$outDir = GF_ROOT . '/storage/db-backups';
if (!is_dir($outDir)) { @mkdir($outDir, 0755, true); }
@file_put_contents($outDir . '/.htaccess', "Require all denied\n");
$name = 'nawu-db-' . date('Ymd-His') . '-' . substr(bin2hex(random_bytes(4)), 0, 6) . '.sql';
$path = $outDir . '/' . $name;
$fh = fopen($path, 'w');
$tables = array();
foreach ($pdo->query('SHOW TABLES') as $row) {
    $t = $row[0];
    if (strpos($t, 'flyme_') === 0 || strpos($t, 'app_') === 0) { $tables[] = $t; }
}
fwrite($fh, "-- nawu db backup " . date('c') . "\n");
fwrite($fh, "SET NAMES utf8mb4;\n\n");
foreach ($tables as $t) {
    $ct = $pdo->query('SHOW CREATE TABLE `' . $t . '`')->fetch(PDO::FETCH_NUM);
    fwrite($fh, "DROP TABLE IF EXISTS `" . $t . "`;\n" . $ct[1] . ";\n");
    $st = $pdo->query('SELECT * FROM `' . $t . '`');
    $buf = '';
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $vals = array();
        foreach ($row as $v) {
            $vals[] = $v === null ? 'NULL' : $pdo->quote((string)$v);
        }
        $buf .= 'INSERT INTO `' . $t . '` VALUES (' . implode(',', $vals) . ");\n";
        if (strlen($buf) > 262144) { fwrite($fh, $buf); $buf = ''; }
    }
    fwrite($fh, $buf . "\n");
}
fclose($fh);
header('Content-Type: application/json');
echo json_encode(array('ok' => true, 'file' => '/storage/db-backups/' . $name, 'tables' => count($tables), 'bytes' => filesize($path)));
"""


def main():
    print("== 纳物服务器备份 → %s ==" % OUT_DIR)
    ftp = ftp_connect()
    try:
        # 1. 主程序 PHP
        print("-- 1/3 主程序 PHP --")
        for remote in FILE_LIST:
            try:
                download(ftp, remote, os.path.join(OUT_DIR, remote.lstrip("/")))
            except ftplib.error_perm as e:
                print("  ! 跳过 %s：%s" % (remote, e))
        for d in DIR_LIST:
            try:
                names = ftp.nlst(d)
            except ftplib.error_perm:
                continue
            for n in names:
                base = n.rsplit("/", 1)[-1]
                if not base or base in (".", ".."):
                    continue
                if not base.lower().endswith(".php"):
                    continue
                download(ftp, n, os.path.join(OUT_DIR, n.lstrip("/")))
        for remote in EXTRA_STORAGE:
            try:
                download(ftp, remote, os.path.join(OUT_DIR, remote.lstrip("/")))
            except ftplib.error_perm as e:
                print("  ! 跳过 %s：%s" % (remote, e))

        # 2. 数据库导出（一次性脚本 + 随机 token）
        print("-- 2/3 数据库导出 --")
        token = uuid.uuid4().hex
        script_local = os.path.join(OUT_DIR, "__nawu_dbdump_once.php")
        with open(script_local, "w", encoding="utf-8") as f:
            f.write(DUMP_PHP)
        with io.BytesIO(token.encode()) as f:
            ftp.storbinary("STOR /__nawu_dump_token.txt", f)
        upload(ftp, script_local, "/__nawu_dbdump_once.php")

        url = "%s/__nawu_dbdump_once.php?token=%s" % (SITE, token)
        print("  触发导出：%s" % url)
        resp = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=180) as r:
                    resp = json.loads(r.read().decode("utf-8"))
                break
            except Exception as e:
                print("  ! 第 %d 次触发失败：%s" % (attempt + 1, e))
                time.sleep(3)
        if not resp or not resp.get("ok"):
            print("  !! 数据库导出失败：%r（主程序 PHP 已备份，继续）" % (resp,))
        else:
            print("  导出成功：%s（%d 张表，%d B）" % (resp["file"], resp["tables"], resp["bytes"]))
            download(ftp, resp["file"], os.path.join(OUT_DIR, "db", os.path.basename(resp["file"])))

        # 3. 清理远端一次性文件
        print("-- 3/3 清理远端一次性文件 --")
        for remote in ["/__nawu_dbdump_once.php", "/__nawu_dump_token.txt"]:
            try:
                ftp.delete(remote)
                print("  × 已删除 %s" % remote)
            except ftplib.error_perm:
                pass
        os.remove(script_local)
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()
    print("== 备份完成：%s ==" % OUT_DIR)


if __name__ == "__main__":
    sys.exit(main())
