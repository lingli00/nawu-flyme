<?php
/**
 * 纳物 NaWu · 更新通道面板（单文件版）
 * ==========================================================================
 * 用途：在宝塔上 5 分钟搭出一条「App 增量/全量 + 服务端全量」的更新通道，
 *       对外的两个清单文件名与客户端约定完全一致：
 *
 *          http://你的域名:2233/app-manifest.json     ← App 端检查更新用
 *          http://你的域名:2233/manifest.json         ← 服务端「在线更新」用
 *
 * 依赖：PHP 7.2+（需要 zip 扩展；宝塔默认自带），无需 MySQL、无需任何 Composer 包。
 *
 * 部署（宝塔）：
 *   1. 网站 → 添加站点，域名随便（用 IP 也行），**PHP 版本选 7.2 及以上**，
 *      站点目录设成 /www/wwwroot/nawu-update；
 *   2. 把这个文件上传到该目录，浏览器打开 http://IP:2233/nawu-update-panel.php；
 *   3. 首次进入会让你设置管理口令（写进同目录 panel.config.json，不要提交到仓库）；
 *   4. 站点端口改成 2233（网站 → 设置 → 配置文件里的 listen 80 → 2233），
 *      并确认该端口已在宝塔「安全」和云厂商安全组放行；
 *   5. 上传 `nawu-v1.3.6.apk`、`1.3.5-to-1.3.6.patch`、`nawu-server-v1.3.6.zip`，
 *      点「重建清单」即可。清单与包都是本目录下的真实文件，Nginx 直接静态分发。
 *
 * 目录约定（全部放在本文件同目录）：
 *   app-manifest.json      App 更新清单（脚本自动生成，勿手改）
 *   manifest.json          服务端在线更新清单（脚本自动生成，勿手改）
 *   nawu-v1.3.6.apk        全量安装包（文件名即版本来源）
 *   1.3.5-to-1.3.6.patch   增量差分包（NAWU-PATCH1 格式，来自老版本 → 新版本）
 *   nawu-server-v1.3.6.zip 服务端全量包（脚本会读 zip 内每个文件算 sha256）
 *   panel.config.json      口令与发布备注（脚本自己维护）
 *
 * 安全提示：面板只应该在内网/管理 IP 访问；公网暴露请务必改掉默认口令，
 *          并在宝塔「网站 → 访问限制」里加 IP 白名单。
 */

declare(strict_types=1);

if (PHP_VERSION_ID < 70200) {
    http_response_code(500);
    exit('需要 PHP 7.2 及以上（当前 ' . PHP_VERSION . '）');
}

const PANEL_FILE   = 'nawu-update-panel.php';
const CONFIG_FILE  = 'panel.config.json';
const APP_MANIFEST = 'app-manifest.json';
const SRV_MANIFEST = 'manifest.json';
const APP_ID       = 'nawu-app';
/** 单文件上传上限（字节）：APK + 服务端包都够用 */
const MAX_UPLOAD   = 268435456; // 256MB
/** 默认口令（仅首次使用；登录后在「设置」里改成自己的） */
const DEFAULT_PASSWORD = 'nawu2233';

$BASE = __DIR__;

/* ==========================================================================
 * 基础工具
 * ========================================================================== */

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json_file(string $path, array $default = []): array
{
    if (!is_file($path)) {
        return $default;
    }
    $raw = @file_get_contents($path);
    if (!is_string($raw) || $raw === '') {
        return $default;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

function write_json_file(string $path, array $data): bool
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if (!is_string($json)) {
        return false;
    }
    return @file_put_contents($path, $json . "\n", LOCK_EX) !== false;
}

function human_size(int $bytes): string
{
    if ($bytes >= 1048576) {
        return round($bytes / 1048576, 2) . ' MB';
    }
    if ($bytes >= 1024) {
        return round($bytes / 1024, 1) . ' KB';
    }
    return $bytes . ' B';
}

/** 只允许安全的文件名（防路径穿越）。 */
function safe_name(string $name): bool
{
    return (bool) preg_match('/^[A-Za-z0-9._\-]+$/', $name) && strpos($name, '..') === false;
}

/** 版本号比较（1.3.10 > 1.3.9）。 */
function version_cmp(string $a, string $b): int
{
    $pa = array_map('intval', explode('.', $a));
    $pb = array_map('intval', explode('.', $b));
    $n = max(count($pa), count($pb));
    for ($i = 0; $i < $n; $i++) {
        $x = $pa[$i] ?? 0;
        $y = $pb[$i] ?? 0;
        if ($x !== $y) {
            return $x < $y ? -1 : 1;
        }
    }
    return 0;
}

/** 从文件名推版本：nawu-v1.3.6.apk / nawu-1.3.6.apk / nawu-server-v1.3.6.zip。 */
function version_from_name(string $name): string
{
    if (preg_match('/v?(\d+\.\d+(?:\.\d+)?)/', $name, $m)) {
        return $m[1];
    }
    return '';
}

/** 从增量包名推 from/to：1.3.5-to-1.3.6.patch / 1.3.5-1.3.6.patch / patch-1.3.5→1.3.6.patch。 */
function patch_versions(string $name): array
{
    // 直接取文件名里前两个版本号，避免「-to-」「→」各种写法各配一条正则
    if (preg_match_all('/(\d+\.\d+(?:\.\d+)?)/', $name, $m) && count($m[1]) >= 2) {
        return [$m[1][0], $m[1][1]];
    }
    return ['', ''];
}

/* ==========================================================================
 * 配置与登录
 * ========================================================================== */

function load_config(string $base): array
{
    $cfg = read_json_file($base . '/' . CONFIG_FILE, []);
    if (!isset($cfg['passwordHash']) || !is_string($cfg['passwordHash']) || $cfg['passwordHash'] === '') {
        // 首次运行：用默认口令初始化（登录后必须改）
        $cfg['passwordHash'] = password_hash(DEFAULT_PASSWORD, PASSWORD_DEFAULT);
        $cfg['notes'] = isset($cfg['notes']) ? $cfg['notes'] : '';
        $cfg['minVersion'] = isset($cfg['minVersion']) ? $cfg['minVersion'] : '';
        $cfg['initialized'] = 0;
        write_json_file($base . '/' . CONFIG_FILE, $cfg);
    }
    return $cfg;
}

function save_config(string $base, array $cfg): void
{
    write_json_file($base . '/' . CONFIG_FILE, $cfg);
}

function start_session(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        // 用旧版 6 参数签名：数组式签名要 PHP 7.3+，而本面板声明支持 7.2
        @session_set_cookie_params(0, '/', '', false, true);
        @session_start();
    }
}

function is_logged_in(): bool
{
    start_session();
    return isset($_SESSION['nawu_update_ok']) && $_SESSION['nawu_update_ok'] === true;
}

/* ==========================================================================
 * 频道扫描与清单生成（纯函数式，页面首屏与 API 共用）
 * ========================================================================== */

/** 扫描频道目录：APK / 增量包 / 服务端包。 */
function scan_channel(string $base): array
{
    $apks = [];
    $patches = [];
    $servers = [];
    $entries = @scandir($base);
    if (!is_array($entries)) {
        return ['apk' => [], 'patch' => [], 'server' => []];
    }
    foreach ($entries as $name) {
        if ($name === '.' || $name === '..' || !safe_name($name)) {
            continue;
        }
        $full = $base . '/' . $name;
        if (!is_file($full)) {
            continue;
        }
        $lower = strtolower($name);
        $size = (int) @filesize($full);
        $mtime = (int) @filemtime($full);
        if (substr($lower, -4) === '.apk') {
            $apks[] = [
                'name' => $name,
                'size' => $size,
                'mtime' => $mtime,
                'version' => version_from_name($name),
                'sha256' => (string) @hash_file('sha256', $full),
            ];
        } elseif (substr($lower, -6) === '.patch') {
            list($from, $to) = patch_versions($name);
            $patches[] = [
                'name' => $name,
                'size' => $size,
                'mtime' => $mtime,
                'from' => $from,
                'to' => $to,
                'sha256' => (string) @hash_file('sha256', $full),
            ];
        } elseif (substr($lower, -4) === '.zip') {
            $servers[] = [
                'name' => $name,
                'size' => $size,
                'mtime' => $mtime,
                'version' => version_from_name($name),
                'sha256' => (string) @hash_file('sha256', $full),
            ];
        }
    }
    // APK 按版本倒序，最新的在最前
    usort($apks, function ($a, $b) {
        return version_cmp($b['version'], $a['version']);
    });
    usort($servers, function ($a, $b) {
        return version_cmp($b['version'], $a['version']);
    });
    usort($patches, function ($a, $b) {
        return version_cmp($b['to'], $a['to']);
    });
    return ['apk' => $apks, 'patch' => $patches, 'server' => $servers];
}

/** Apache 风格相对地址（清单里一律用相对路径，客户端自己拼 origin）。 */
function rel_url(string $name): string
{
    return rawurlencode($name);
}

/**
 * 生成 app-manifest.json（App 端检查更新用）。
 *
 * @param array $channel scan_channel() 的结果
 * @return array [manifest|null, error]
 */
function build_app_manifest(array $channel, string $notes, string $minVersion, string $base): array
{
    if (count($channel['apk']) === 0) {
        return [null, '目录里还没有 APK，先上传 nawu-v1.3.6.apk'];
    }
    $apk = $channel['apk'][0];
    if ($apk['version'] === '') {
        return [null, 'APK 文件名里没有版本号，请命名成 nawu-v1.3.6.apk'];
    }
    $patches = [];
    foreach ($channel['patch'] as $p) {
        // 只带「能升到当前最新版」的补丁，其他留着当历史
        if ($p['to'] !== $apk['version'] || $p['from'] === '') {
            continue;
        }
        $patches[] = [
            'from' => $p['from'],
            'url' => rel_url($p['name']),
            'size' => $p['size'],
            'sha256' => $p['sha256'],
            // 合成结果必须与全量包逐字节一致，客户端会拿它校验
            'apkSha256' => $apk['sha256'],
        ];
    }
    $manifest = [
        'app' => APP_ID,
        'version' => $apk['version'],
        'publishedAt' => gmdate('c', $apk['mtime'] > 0 ? $apk['mtime'] : time()),
        'notes' => $notes,
        'minVersion' => $minVersion,
        'apk' => [
            'url' => rel_url($apk['name']),
            'size' => $apk['size'],
            'sha256' => $apk['sha256'],
        ],
        'patches' => $patches,
    ];
    return [$manifest, ''];
}

/**
 * 生成 manifest.json（服务端在线更新用）。
 * 把服务端全量 zip 里的每个条目算成 files[]，客户端据此比对本地文件。
 *
 * @return array [manifest|null, error]
 */
function build_server_manifest(array $channel, string $notes, string $minVersion, string $base): array
{
    if (count($channel['server']) === 0) {
        return [null, '目录里还没有服务端包，先上传 nawu-server-v1.3.6.zip'];
    }
    if (!class_exists('ZipArchive')) {
        return [null, 'PHP 缺少 zip 扩展，无法读取服务端包（宝塔里安装 php-zip 即可）'];
    }
    $pkg = $channel['server'][0];
    $zipPath = $base . '/' . $pkg['name'];
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        return [null, '服务端包打不开：' . $pkg['name']];
    }
    $files = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $stat = $zip->statIndex($i);
        if (!is_array($stat)) {
            continue;
        }
        $name = (string) $stat['name'];
        if (substr($name, -1) === '/' || $name === '') {
            continue; // 目录条目
        }
        $path = str_replace('\\', '/', $name);
        // 去掉包内顶层目录（打 zip 时经常多套一层 v1.3.6/）
        if (strpos($path, '/') !== false) {
            $parts = explode('/', $path, 2);
            if (preg_match('/^v?\d+\.\d+/', $parts[0]) && $parts[0] !== 'server' && $parts[0] !== 'app') {
                $path = $parts[1];
            }
        }
        if ($path === 'storage' || strpos($path, 'storage/') === 0) {
            continue; // 运行时数据不参与覆盖
        }
        if (preg_match('/\.(zip|part|log|bak|old|tmp)$/i', $path)) {
            continue;
        }
        // 直接读条目内容算哈希：不落临时文件，避免权限/rename 失败
        $content = $zip->getFromIndex($i);
        if (!is_string($content)) {
            continue;
        }
        $files[] = [
            'path' => $path,
            'sha256' => hash('sha256', $content),
            'size' => strlen($content),
        ];
        if (count($files) >= 6000) {
            break; // 与服务端 MAX_FILES 一致
        }
    }
    $zip->close();

    if (count($files) === 0) {
        return [null, '服务端包里没有可用文件，检查压缩包结构'];
    }
    $manifest = [
        'version' => $pkg['version'] !== '' ? $pkg['version'] : '1.0.0',
        'publishedAt' => gmdate('c', $pkg['mtime'] > 0 ? $pkg['mtime'] : time()),
        'notes' => $notes,
        'minVersion' => $minVersion,
        'packageUrl' => rel_url($pkg['name']),
        'packageSize' => $pkg['size'],
        'packageSha256' => $pkg['sha256'],
        'files' => $files,
    ];
    return [$manifest, ''];
}

/* ==========================================================================
 * 路由
 * ========================================================================== */

$action = isset($_REQUEST['action']) ? (string) $_REQUEST['action'] : '';
$config = load_config($BASE);

/* —— 登录 / 登出 —— */
if ($action === 'login') {
    start_session();
    $pwd = isset($_POST['password']) ? (string) $_POST['password'] : '';
    if (password_verify($pwd, (string) $config['passwordHash'])) {
        $_SESSION['nawu_update_ok'] = true;
        json_out(['ok' => true]);
    }
    json_out(['ok' => false, 'error' => '口令不正确'], 401);
}

if ($action === 'logout') {
    start_session();
    $_SESSION = [];
    @session_destroy();
    header('Location: ' . PANEL_FILE);
    exit;
}

/* —— 健康检查（给运维用，无需登录：只吐版本号，不泄露文件清单） —— */
if ($action === 'health') {
    $appM = read_json_file($BASE . '/' . APP_MANIFEST, []);
    $srvM = read_json_file($BASE . '/' . SRV_MANIFEST, []);
    json_out([
        'ok' => true,
        'app' => ['version' => $appM['version'] ?? '', 'apk' => $appM['apk']['url'] ?? ''],
        'server' => ['version' => $srvM['version'] ?? '', 'files' => isset($srvM['files']) ? count($srvM['files']) : 0],
        'time' => gmdate('c'),
    ]);
}

if ($action !== '' && !is_logged_in()) {
    json_out(['ok' => false, 'error' => '未登录'], 401);
}

/* —— 设置：改口令 / 发布说明 —— */
if ($action === 'save-settings') {
    $notes = isset($_POST['notes']) ? trim((string) $_POST['notes']) : '';
    $minVersion = isset($_POST['minVersion']) ? trim((string) $_POST['minVersion']) : '';
    $pwd = isset($_POST['password']) ? (string) $_POST['password'] : '';
    if ($pwd !== '') {
        if (strlen($pwd) < 6) {
            json_out(['ok' => false, 'error' => '口令至少 6 位'], 400);
        }
        $config['passwordHash'] = password_hash($pwd, PASSWORD_DEFAULT);
        $config['initialized'] = 1;
    }
    $config['notes'] = $notes;
    $config['minVersion'] = $minVersion;
    save_config($BASE, $config);
    json_out(['ok' => true]);
}

/* —— 上传：apk / patch / server —— */
if ($action === 'upload') {
    if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
        json_out(['ok' => false, 'error' => '没有收到文件'], 400);
    }
    $f = $_FILES['file'];
    if (($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        json_out(['ok' => false, 'error' => '上传失败（码 ' . ($f['error'] ?? '?') . '，超过 php.ini 的 upload_max_filesize 也会这样）'], 400);
    }
    if (($f['size'] ?? 0) > MAX_UPLOAD) {
        json_out(['ok' => false, 'error' => '文件超过 256MB'], 400);
    }
    $kind = isset($_POST['kind']) ? (string) $_POST['kind'] : 'apk';
    $name = basename((string) $f['name']);
    // 允许中文以外的安全字符；空格转下划线
    $name = preg_replace('/[^A-Za-z0-9._\-]/', '_', $name);
    if ($name === '' || !safe_name($name)) {
        json_out(['ok' => false, 'error' => '文件名不合法'], 400);
    }
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $expect = $kind === 'apk' ? 'apk' : ($kind === 'patch' ? 'patch' : 'zip');
    if ($ext !== $expect) {
        json_out(['ok' => false, 'error' => '文件类型不符：' . $kind . ' 需要 .' . $expect], 400);
    }
    $dest = $BASE . '/' . $name;
    if (!@move_uploaded_file($f['tmp_name'], $dest)) {
        json_out(['ok' => false, 'error' => '写入失败，检查目录权限（宝塔 www 用户可写）'], 500);
    }
    @chmod($dest, 0644);
    json_out([
        'ok' => true,
        'name' => $name,
        'size' => (int) @filesize($dest),
        'sha256' => (string) @hash_file('sha256', $dest),
    ]);
}

/* —— 删除 —— */
if ($action === 'delete') {
    $name = isset($_POST['name']) ? (string) $_POST['name'] : '';
    if (!safe_name($name) || !is_file($BASE . '/' . $name)) {
        json_out(['ok' => false, 'error' => '文件不存在'], 404);
    }
    if (!@unlink($BASE . '/' . $name)) {
        json_out(['ok' => false, 'error' => '删除失败（目录权限）'], 500);
    }
    json_out(['ok' => true]);
}

/* —— 重建清单 —— */
if ($action === 'rebuild') {
    $channel = scan_channel($BASE);
    $notes = isset($config['notes']) ? (string) $config['notes'] : '';
    $minVersion = isset($config['minVersion']) ? (string) $config['minVersion'] : '';
    $result = ['ok' => true, 'app' => null, 'server' => null, 'errors' => []];

    list($appM, $appErr) = build_app_manifest($channel, $notes, $minVersion, $BASE);
    if ($appM !== null) {
        write_json_file($BASE . '/' . APP_MANIFEST, $appM);
        $result['app'] = ['version' => $appM['version'], 'patches' => count($appM['patches'])];
    } else {
        $result['errors'][] = $appErr;
    }

    list($srvM, $srvErr) = build_server_manifest($channel, $notes, $minVersion, $BASE);
    if ($srvM !== null) {
        write_json_file($BASE . '/' . SRV_MANIFEST, $srvM);
        $result['server'] = ['version' => $srvM['version'], 'files' => count($srvM['files'])];
    } else {
        $result['errors'][] = $srvErr;
    }
    json_out($result);
}

/* —— 状态（前端轮询/自检） —— */
if ($action === 'state') {
    $channel = scan_channel($BASE);
    $appM = read_json_file($BASE . '/' . APP_MANIFEST, []);
    $srvM = read_json_file($BASE . '/' . SRV_MANIFEST, []);
    json_out([
        'ok' => true,
        'channel' => $channel,
        'appManifest' => $appM,
        'serverManifest' => [
            'version' => $srvM['version'] ?? '',
            'packageUrl' => $srvM['packageUrl'] ?? '',
            'fileCount' => isset($srvM['files']) && is_array($srvM['files']) ? count($srvM['files']) : 0,
            'publishedAt' => $srvM['publishedAt'] ?? '',
        ],
        'config' => [
            'notes' => $config['notes'] ?? '',
            'minVersion' => $config['minVersion'] ?? '',
            'initialized' => (int) ($config['initialized'] ?? 0),
        ],
        'origin' => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https://' : 'http://')
            . ($_SERVER['HTTP_HOST'] ?? 'localhost'),
    ]);
}

/* ==========================================================================
 * 页面
 * ========================================================================== */
$logged = is_logged_in();
$channel = scan_channel($BASE);
$appM = read_json_file($BASE . '/' . APP_MANIFEST, []);
$srvM = read_json_file($BASE . '/' . SRV_MANIFEST, []);
$origin = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https://' : 'http://')
    . ($_SERVER['HTTP_HOST'] ?? 'localhost');
$needInit = (int) ($config['initialized'] ?? 0) === 0;
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>纳物 · 更新通道面板</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --ink:#1b1d22; --ink2:#5b6270; --ink3:#8b93a1;
    --line:#e6e8ec; --accent:#e8453c; --ok:#12a058; --warn:#b7791f;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:28px 18px 60px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--ink3);font-size:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
  .card h2{font-size:14px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .tag{font-size:11px;padding:1px 8px;border-radius:99px;background:#f0f1f4;color:var(--ink2);font-weight:500}
  .tag.ok{background:#e8f7ef;color:var(--ok)}
  .tag.warn{background:#fdf4e3;color:var(--warn)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--ink3);font-weight:500;font-size:12px}
  code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  input[type=text],input[type=password],textarea,select{
    width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:#fafbfc;font:inherit;color:inherit}
  textarea{min-height:76px;resize:vertical}
  button{
    padding:9px 14px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);
    font:inherit;cursor:pointer}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.ghost{padding:5px 9px;font-size:12px}
  button:disabled{opacity:.45;cursor:not-allowed}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .grid{display:grid;gap:12px;grid-template-columns:1fr 1fr}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}
  .muted{color:var(--ink3);font-size:12px}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1b1d22;color:#fff;
    padding:10px 16px;border-radius:12px;font-size:13px;opacity:0;pointer-events:none;transition:.2s;z-index:99}
  .toast.on{opacity:1}
  .kpi{display:flex;gap:20px;flex-wrap:wrap}
  .kpi div span{display:block;font-size:12px;color:var(--ink3)}
  .kpi div b{font-size:18px}
  .drop{border:1.5px dashed var(--line);border-radius:12px;padding:18px;text-align:center;color:var(--ink3);background:#fafbfc}
  .login{max-width:360px;margin:80px auto}
  .warnbar{background:#fdf4e3;border:1px solid #f3e0b8;color:var(--warn);padding:10px 14px;border-radius:10px;font-size:12px;margin-bottom:14px}
</style>
</head>
<body>
<div class="wrap">

<?php if (!$logged): ?>
  <div class="card login">
    <h1>纳物 · 更新通道</h1>
    <p class="sub">输入管理口令进入</p>
    <form onsubmit="return doLogin(event)">
      <input type="password" id="pwd" placeholder="管理口令" autofocus>
      <div style="height:10px"></div>
      <button class="primary" style="width:100%" type="submit">进入</button>
    </form>
    <p class="muted" style="margin-top:14px">首次使用默认口令 <code><?= DEFAULT_PASSWORD ?></code>，进去后请立刻在「发布设置」里改掉。</p>
  </div>
<?php else: ?>

  <h1>纳物 · 更新通道</h1>
  <p class="sub">
    频道根目录 <code><?= htmlspecialchars($BASE, ENT_QUOTES) ?></code> ·
    对外地址 <code><?= htmlspecialchars($origin, ENT_QUOTES) ?></code>
    &nbsp;|&nbsp;<a href="?action=logout">退出</a>
  </p>

  <?php if ($needInit): ?>
    <div class="warnbar">当前还是默认口令 <code><?= DEFAULT_PASSWORD ?></code>，请到下方「发布设置」立刻改成自己的口令。</div>
  <?php endif; ?>

  <!-- 概览 -->
  <div class="card">
    <h2>概览 <span class="tag">实时扫描</span></h2>
    <div class="kpi">
      <div><span>App 已发布版本</span><b><?= htmlspecialchars((string) ($appM['version'] ?? '—')) ?></b></div>
      <div><span>增量补丁</span><b><?= count($appM['patches'] ?? []) ?></b></div>
      <div><span>服务端版本</span><b><?= htmlspecialchars((string) ($srvM['version'] ?? '—')) ?></b></div>
      <div><span>服务端文件数</span><b><?= isset($srvM['files']) ? count($srvM['files']) : 0 ?></b></div>
    </div>
    <div style="height:12px"></div>
    <div class="row">
      <button class="primary" onclick="rebuild()">重建两个清单</button>
      <button onclick="loadState()">刷新</button>
      <span class="muted">清单文件名固定：<code>app-manifest.json</code> / <code>manifest.json</code>，客户端按这两个名字取。</span>
    </div>
  </div>

  <!-- 发布设置 -->
  <div class="card">
    <h2>发布设置</h2>
    <div class="grid">
      <div>
        <label class="muted">版本更新说明（写进两份清单的 notes，App 的更新弹窗会显示）</label>
        <textarea id="notes" placeholder="v1.3.6：二手买卖一体、已提交可复制/编辑、端侧语音、附加费用名称修复"><?= htmlspecialchars((string) ($config['notes'] ?? ''), ENT_QUOTES) ?></textarea>
      </div>
      <div>
        <label class="muted">最低可升级版本（留空=不限制；低于它的老版本只能装全量）</label>
        <input type="text" id="minVersion" value="<?= htmlspecialchars((string) ($config['minVersion'] ?? ''), ENT_QUOTES) ?>" placeholder="1.0.0">
        <div style="height:10px"></div>
        <label class="muted">改管理口令（留空则不修改，至少 6 位）</label>
        <input type="password" id="newPwd" placeholder="新口令">
      </div>
    </div>
    <div style="height:12px"></div>
    <button class="primary" onclick="saveSettings()">保存设置</button>
  </div>

  <!-- 上传 -->
  <div class="card">
    <h2>上传发布产物</h2>
    <div class="grid">
      <div>
        <label class="muted">① 全量安装包（.apk，文件名带版本：<code>nawu-v1.3.6.apk</code>）</label>
        <input type="file" id="fApk" accept=".apk" onchange="upload('apk','fApk')">
        <p class="muted">新装用户用这个；也是增量失败的兜底。</p>
      </div>
      <div>
        <label class="muted">② 增量差分包（.patch，文件名带 from/to：<code>1.3.5-to-1.3.6.patch</code>）</label>
        <input type="file" id="fPatch" accept=".patch" onchange="upload('patch','fPatch')">
        <p class="muted">老版本走这里，省流量；sha256 与 apkSha256 由脚本自动填。</p>
      </div>
      <div>
        <label class="muted">③ 服务端全量包（.zip，<code>nawu-server-v1.3.6.zip</code>）</label>
        <input type="file" id="fServer" accept=".zip" onchange="upload('server','fServer')">
        <p class="muted">上传后重建清单，会把 zip 里每个文件的 sha256 算进 manifest.json。</p>
      </div>
      <div class="drop">
        <div>文件上限 256MB</div>
        <div class="muted" style="margin-top:6px">超大文件建议直接用宝塔文件管理器放进本目录，<br>再回来点「重建两个清单」。</div>
      </div>
    </div>
  </div>

  <!-- 文件列表 -->
  <div class="card">
    <h2>频道文件</h2>
    <table>
      <thead><tr><th>文件</th><th>版本</th><th>大小</th><th>sha256</th><th>操作</th></tr></thead>
      <tbody id="fileRows">
        <?php
        $rows = [];
        foreach ($channel['apk'] as $a) {
            $rows[] = ['kind' => 'APK 全量', 'name' => $a['name'], 'version' => $a['version'], 'size' => $a['size'], 'sha' => $a['sha256']];
        }
        foreach ($channel['patch'] as $p) {
            $rows[] = ['kind' => '增量', 'name' => $p['name'], 'version' => ($p['from'] ?: '?') . ' → ' . ($p['to'] ?: '?'), 'size' => $p['size'], 'sha' => $p['sha256']];
        }
        foreach ($channel['server'] as $s) {
            $rows[] = ['kind' => '服务端', 'name' => $s['name'], 'version' => $s['version'], 'size' => $s['size'], 'sha' => $s['sha256']];
        }
        if (count($rows) === 0) {
            echo '<tr><td colspan="5" class="muted">还没有任何包，先上传上面那三个文件。</td></tr>';
        }
        foreach ($rows as $r) {
            echo '<tr>';
            echo '<td><span class="tag">' . htmlspecialchars($r['kind'], ENT_QUOTES) . '</span><br><code>' . htmlspecialchars($r['name'], ENT_QUOTES) . '</code></td>';
            echo '<td>' . htmlspecialchars((string) $r['version'], ENT_QUOTES) . '</td>';
            echo '<td>' . human_size((int) $r['size']) . '</td>';
            echo '<td class="mono">' . substr((string) $r['sha'], 0, 16) . '…</td>';
            echo '<td><a class="mono" href="' . htmlspecialchars(rel_url($r['name']), ENT_QUOTES) . '" target="_blank">下载</a> · '
                . '<button class="ghost" onclick="del(\'' . htmlspecialchars($r['name'], ENT_QUOTES) . '\')">删除</button></td>';
            echo '</tr>';
        }
        ?>
      </tbody>
    </table>
    <p class="muted" style="margin-top:12px">
      客户端取用地址：<br>
      App 更新：<code><?= htmlspecialchars($origin, ENT_QUOTES) ?>/app-manifest.json</code><br>
      服务端更新源：<code><?= htmlspecialchars($origin, ENT_QUOTES) ?>/</code>（后台「在线更新」里填这个）
    </p>
  </div>

  <!-- 部署提示 -->
  <div class="card">
    <h2>部署备忘</h2>
    <ol class="muted" style="margin:0;padding-left:20px;line-height:1.9">
      <li>站点端口 <code>2233</code> 要在宝塔「安全」和云厂商安全组都放行，否则手机连不上。</li>
      <li>Nginx 用默认的静态站点即可；<code>.json</code> 与 <code>.apk</code> 都可直接下载。</li>
      <li>传完 APK 记得同步更新 <code>app/src/lib/appVersion.ts</code> 与 <code>build.gradle</code> 的版本号，否则客户端认不出更新。</li>
      <li>服务端包里不要带 <code>storage/</code>（运行数据），脚本会跳过，但打包时最好就别打进去。</li>
    </ol>
  </div>

<?php endif; ?>
</div>
<div class="toast" id="toast"></div>

<script>
function toast(msg, ms){
  var el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(el._t); el._t = setTimeout(function(){ el.classList.remove('on'); }, ms || 2600);
}
function post(url, data){
  var body = new FormData();
  Object.keys(data || {}).forEach(function(k){ body.append(k, data[k]); });
  return fetch(url, { method:'POST', body: body }).then(function(r){ return r.json(); });
}
function doLogin(e){
  e.preventDefault();
  var pwd = document.getElementById('pwd').value;
  post('?action=login', { password: pwd }).then(function(r){
    if (r.ok) location.reload(); else toast(r.error || '口令不正确');
  });
  return false;
}
function rebuild(){
  toast('正在生成清单…', 6000);
  post('?action=rebuild', {}).then(function(r){
    if (r.ok) {
      var msg = [];
      if (r.app) msg.push('App v' + r.app.version + '（补丁 ' + r.app.patches + '）');
      if (r.server) msg.push('服务端 v' + r.server.version + '（' + r.server.files + ' 文件）');
      toast(msg.length ? '已生成：' + msg.join(' · ') : (r.errors || []).join('；'));
      setTimeout(function(){ location.reload(); }, 1400);
    } else {
      toast((r.errors || ['生成失败']).join('；'));
    }
  });
}
function saveSettings(){
  post('?action=save-settings', {
    notes: document.getElementById('notes').value,
    minVersion: document.getElementById('minVersion').value,
    password: document.getElementById('newPwd').value
  }).then(function(r){ toast(r.ok ? '已保存' : (r.error || '保存失败')); });
}
function upload(kind, inputId){
  var el = document.getElementById(inputId);
  if (!el.files || !el.files[0]) return;
  var f = el.files[0];
  toast('上传中：' + f.name + '（' + (f.size/1048576).toFixed(1) + 'MB）', 60000);
  post('?action=upload&kind=' + kind, { kind: kind, file: f }).then(function(r){
    if (r.ok) {
      toast('已上传：' + r.name);
      rebuild();
    } else {
      toast(r.error || '上传失败');
    }
    el.value = '';
  });
}
function del(name){
  if (!confirm('确定删除 ' + name + '？删掉后重建清单即可生效。')) return;
  post('?action=delete', { name: name }).then(function(r){
    toast(r.ok ? '已删除' : (r.error || '删除失败'));
    if (r.ok) setTimeout(function(){ location.reload(); }, 800);
  });
}
</script>
</body>
</html>
