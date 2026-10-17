<?php
/**
 * 纳物 NaWu · PHP 版 —— 站点前置入口
 *
 * 职责（按优先级）：
 *   1. 未安装 → 跳转到安装向导 install.php
 *   2. /api/*  → 交给后端 REST 控制器
 *   3. 其他路径 → 命中真实静态文件就直接输出（兼容 nginx 未配置 try_files 的场景）
 *                未命中则输出 SPA index.html（前端用的 HashRouter，任意路径都可回落到首页）
 *
 * 兼容目标：Nginx 1.21 + PHP 7.2 ~ 8.0 + MySQL 5.5
 * 无任何 Composer 依赖，上传即用。
 */

if (!defined('GF_ROOT')) {
    define('GF_ROOT', dirname(__FILE__));
}

// 一律屏蔽 PHP 报错直接输出到页面，避免破坏 JSON
error_reporting(E_ALL);
ini_set('display_errors', '0');

require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/Config.php';
// v1.0.33 安全修复：公开代理端点（/api/icon/*、/api/img/*）在进入 Api.php 之前
// 就要用限流能力，这里提前把 Db / Schema 装上（两者均为懒连接，无额外开销）
require_once GF_ROOT . '/app/lib/Db.php';
require_once GF_ROOT . '/app/lib/Schema.php';

/* ---------------- 全局安全响应头（v1.0.33 安全修复） ---------------- */
if (!headers_sent()) {
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
}

/* 公开端点的 IP 限流：超限返回 429（防刷上游 / 防拖垮服务器） */
function flyme_rate_limit($scope, $max, $windowSec)
{
    $ip = flyme_client_ip();
    list($allow, $wait) = flyme_throttle_check($scope, $ip, $max, $windowSec);
    if (!$allow) {
        header('Cache-Control: no-store');
        flyme_json(array('ok' => false, 'error' => '请求太频繁，请 ' . $wait . ' 秒后再试'), 429);
    }
    flyme_throttle_fail($scope, $ip, $max, $windowSec, $windowSec);
}

/* 图片代理输出的公共响应头（v1.0.33 安全修复）：
 * nosniff 防 MIME 混淆；CSP default-src 'none' 保证这些响应被直接在浏览器
 * 打开时，SVG 里内嵌的 <script> 也不会执行（旧版等于把 XSS 挂在自己域名下）。 */
function flyme_proxy_headers($type)
{
    header('Content-Type: ' . $type);
    header('Access-Control-Allow-Origin: *');
    header('Cache-Control: public, max-age=2592000');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'");
}

/* ---------------- 请求路径解析 ---------------- */

$requestUri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$scriptDir  = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : ''));
if ($scriptDir === '/' || $scriptDir === '.') {
    $scriptDir = '';
}

$path = parse_url($requestUri, PHP_URL_PATH);
if ($path === null || $path === '') {
    $path = '/';
}
$path = str_replace('\\', '/', $path);
$path = rawurldecode($path);

// 去掉站点子目录前缀（把程序放在二级目录运行时也能正常解析）
if ($scriptDir !== '' && strpos($path, $scriptDir) === 0) {
    $path = substr($path, strlen($scriptDir));
}
if ($path === '' || $path[0] !== '/') {
    $path = '/' . $path;
}
if ($path !== '/' && substr($path, -1) === '/') {
    $path = rtrim($path, '/');
}

/* ---------------- 安装状态检查 ---------------- */

if (!GF_Config::installed()) {
    // 放行 install.php 自身、静态资源、品牌标与 favicon，其余一律去安装
    // （品牌标/favicon 放行是为了让安装向导页也有正常图标，不至于请求被 302 成破图）
    $base = basename($path);
    $staticPass = strpos($path, '/api/') !== 0 && strpos($path, '/assets/') !== 0
        && $path !== '/logo.svg' && $path !== '/favicon.ico';
    if ($base !== 'install.php' && $staticPass) {
        $target = $scriptDir . '/install.php';
        header('Location: ' . $target, true, 302);
        exit;
    }
    if (strpos($path, '/api/') === 0) {
        flyme_json(array('ok' => false, 'error' => '站点尚未安装，请先访问 install.php 完成安装引导'), 503);
    }
}

/* ---------------- 禁止直接访问内部目录 ---------------- */

$lower = strtolower($path);
foreach (array('/app/', '/storage/', '/.git/') as $deny) {
    if (strpos($lower, $deny) === 0) {
        flyme_json(array('ok' => false, 'error' => 'forbidden'), 403);
    }
}

/* ---------------- 在线图标服务（免鉴权，v1.0.4） ---------------- */

/* 域名合法性：至少两段、无特殊字符 */
function flyme_valid_domain($d)
{
    return is_string($d)
        && preg_match('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i', $d)
        && strlen($d) <= 120;
}

/* HTTP GET（v1.0.33 安全修复重写）。
 * 与旧版的差别：
 *  ① 每个 URL（含重定向的每一跳）都先过 flyme_ssrf_check_url()：
 *     内网 IP / 云元数据 / 十进制与十六进制伪装的 IP / 非 Web 端口一律拒绝；
 *  ② 关闭 curl 自动跟随重定向，改为手动跟随并逐跳复检 —— 旧版
 *     CURLOPT_FOLLOWLOCATION=true 会让「公网 URL 302 跳到 127.0.0.1」直接得逞；
 *  ③ 默认校验上游 TLS 证书（防止中间人往我们的图标/图片缓存里投毒），
 *     仅当失败原因确为证书问题且重试可通过时才降级（详见 _once 内部）。
 * 返回 array(body, finalUrl, contentType, status, location) 或 null
 *
 * v1.0.36：$extraPorts 供管理端「在线更新」拉取官方频道用（频道可能在
 * 非标端口，如 2233）。普通用户可触发的调用点一律不传，防护面不变。 */
function flyme_http_get($url, $timeout = 6, $maxBytes = 524288, $referer = '', $extraPorts = array())
{
    $cur  = $url;
    $hops = 0;
    while ($hops <= 3) {
        if (!flyme_ssrf_check_url($cur, $extraPorts)) {
            return null;
        }
        $r = flyme_http_get_once($cur, $timeout, $maxBytes, $referer);
        if ($r === null) {
            return null;
        }
        $status = isset($r['status']) ? (int) $r['status'] : 0;
        if ($status >= 300 && $status < 400 && isset($r['location']) && $r['location'] !== '') {
            $next = flyme_resolve_redirect($cur, $r['location']);
            if ($next === null) {
                return null;
            }
            $cur = $next;
            $hops++;
            continue;
        }
        if ($status >= 400) {
            return null;
        }
        return $r;
    }
    return null; // 重定向层数过多
}

/* 单次请求（绝不自动跟随重定向）。
 * $verify=false 仅在「证书问题导致失败」时由内部降级路径使用。 */
function flyme_http_get_once($url, $timeout = 6, $maxBytes = 524288, $referer = '', $verify = true)
{
    $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    if (function_exists('curl_init')) {
        $ch   = curl_init($url);
        $hdrs = '';
        $opts = array(
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_FOLLOWLOCATION => false,   // 重定向由上层手动复检
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_SSL_VERIFYPEER => $verify,  // v1.0.33：默认校验上游证书
            CURLOPT_SSL_VERIFYHOST => $verify ? 2 : 0,
            CURLOPT_USERAGENT => $ua,
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$hdrs) {
                $hdrs .= $line;
                return strlen($line);
            },
        );
        if ($referer !== '') {
            $opts[CURLOPT_REFERER] = $referer;
        }
        curl_setopt_array($ch, $opts);
        $body   = curl_exec($ch);
        $ctype  = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $errno  = curl_errno($ch);
        curl_close($ch);
        if ($body === false) {
            // 仅「证书问题」允许降级重试一次（部分虚拟主机 CA 根证书库不全）
            if ($verify && ($errno === 60 || $errno === 77 || $errno === 51 || $errno === 58 || $errno === 59)) {
                return flyme_http_get_once($url, $timeout, $maxBytes, $referer, false);
            }
            return null;
        }
        if (is_string($body) && strlen($body) > $maxBytes) {
            $body = substr($body, 0, $maxBytes);
        }
        $loc = '';
        if (preg_match('/^\s*Location:\s*(.+)$/mi', (string) $hdrs, $m)) {
            $loc = trim($m[1]);
        }
        return array(
            'body'        => (string) $body,
            'finalUrl'    => $url,
            'contentType' => (string) $ctype,
            'status'      => $status,
            'location'    => $loc,
        );
    }
    $hdr = "User-Agent: $ua\r\n";
    if ($referer !== '') {
        $hdr .= "Referer: $referer\r\n";
    }
    $ctx = stream_context_create(array('http' => array(
        'timeout' => $timeout,
        'header'  => $hdr,
        'ignore_errors' => true,
    ), 'ssl' => array(
        'verify_peer'      => $verify,
        'verify_peer_name' => $verify,
    )));
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false || $body === '') {
        // 流包装器区分不出具体错误码：https 地址且开了校验时，允许降级重试一次
        if ($verify && preg_match('#^https://#i', $url)) {
            return flyme_http_get_once($url, $timeout, $maxBytes, $referer, false);
        }
        return null;
    }
    if (strlen($body) > $maxBytes) {
        $body = substr($body, 0, $maxBytes);
    }
    $status = 0;
    $loc    = '';
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                $status = (int) $m[1];
            }
            if (preg_match('/^\s*Location:\s*(.+)$/i', $line, $m)) {
                $loc = trim($m[1]);
            }
        }
    }
    return array(
        'body'        => (string) $body,
        'finalUrl'    => $url,
        'contentType' => '',
        'status'      => $status,
        'location'    => $loc,
    );
}

/* 把 Location 头解析成绝对 URL；非法/跨协议时返回 null */
function flyme_resolve_redirect($base, $loc)
{
    $loc = trim((string) $loc);
    if ($loc === '' || strlen($loc) > 2048) {
        return null;
    }
    if (preg_match('#^https?://#i', $loc)) {
        return $loc;
    }
    $p = parse_url($base);
    if (!is_array($p) || empty($p['scheme']) || empty($p['host'])) {
        return null;
    }
    $origin = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . (int) $p['port'] : '');
    if (strpos($loc, '//') === 0) {
        return $p['scheme'] . ':' . $loc;
    }
    if (strpos($loc, '/') === 0) {
        return $origin . $loc;
    }
    $path = isset($p['path']) ? (string) $p['path'] : '/';
    $dir  = rtrim(str_replace('\\', '/', dirname($path)), '/');
    return $origin . $dir . '/' . $loc;
}

/* 判断字节串是否像图片（PNG/JPEG/GIF/ICO/WEBP/SVG） */
function flyme_body_is_image($body)
{
    if (!is_string($body) || strlen($body) < 8) {
        return false;
    }
    if (strpos($body, '<svg') !== false || strpos($body, '<?xml') === 0) {
        return true; // SVG
    }
    foreach (array("\x89PNG", "\xFF\xD8\xFF", 'GIF8', "\x00\x00\x01\x00", 'RIFF') as $magic) {
        if (strpos($body, $magic) === 0) {
            return true;
        }
    }
    return false;
}

/* 服务端解析某域名的真实站点图标并代理（缓存 7 天）。
 * 为什么不用第三方 favicon 镜像：favicon.im / icon.horse 对大量国内政企站
 * （联通/电信/国网/云闪付/顺丰…）只会返回统一灰色占位图，覆盖太差。
 * 这里直接抓目标站 HTML 里的 <link rel="icon"/apple-touch-icon>，拿到真品牌图。 */
if ($path === '/api/icon/img') {
    $d = isset($_GET['d']) ? strtolower(trim((string) $_GET['d'])) : '';
    if (!flyme_valid_domain($d)) {
        flyme_json(array('ok' => false, 'error' => 'invalid domain'), 400);
    }
    /* ★v1.0.33 安全修复：
     * ① IP 限流 60 次/分钟，防刷；
     * ② SSRF 预检 —— 旧版 flyme_valid_domain 的正则会放行 "127.0.0.1"
     *    这类纯数字「域名」，且内网黑名单漏掉 0.x、十进制 IP、云元数据，
     *    等于给了一个免鉴权的盲 SSRF 口子。现在域名必须解析到公网 IP。 */
    flyme_rate_limit('iconimg', 60, 60);
    if (!flyme_ssrf_check_url('https://' . $d . '/')) {
        flyme_json(array('ok' => false, 'error' => 'host not allowed'), 400);
    }

    /* ★v1.0.33：随包采集的品牌图标优先（storage/brand-icons/<domain>.<ext>）。
     * 永久落盘、离线可用、不依赖任何第三方镜像，且能挡住旧客户端拿到过期占位图。 */
    $brandDir = GF_ROOT . '/storage/brand-icons';
    if (is_dir($brandDir)) {
        foreach (array('png', 'svg', 'webp', 'jpg', 'jpeg', 'gif', 'ico') as $brandExt) {
            $brandFile = $brandDir . '/' . $d . '.' . $brandExt;
            if (is_file($brandFile)) {
                $brandType = $brandExt === 'svg' ? 'image/svg+xml'
                    : ($brandExt === 'png' ? 'image/png'
                    : ($brandExt === 'webp' ? 'image/webp'
                    : ($brandExt === 'ico' ? 'image/x-icon'
                    : ($brandExt === 'gif' ? 'image/gif' : 'image/jpeg'))));
                flyme_proxy_headers($brandType);
                header('X-Icon-Source: bundled');
                readfile($brandFile);
                exit;
            }
        }
    }

    $cacheDir = GF_ROOT . '/storage/icon-cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0755, true);
    }
    $key     = md5($d);
    $binFile = $cacheDir . '/' . $key . '.bin';
    $typFile = $cacheDir . '/' . $key . '.type';
    if (is_file($binFile) && is_file($typFile) && (time() - filemtime($binFile)) < 2592000) {
        $type = (string) file_get_contents($typFile);
        flyme_proxy_headers($type !== '' ? $type : 'image/png');
        header('X-Icon-Source: cache');
        readfile($binFile);
        exit;
    }

    $found = null; // array(bytes, type)

    /* 入口候选：https/http × 裸域/www 前缀。
     * 大量国内政企站（联通/国网/云闪付…）只在其中一两种组合上可达。 */
    $hosts = array($d);
    if (strpos($d, 'www.') !== 0) {
        $hosts[] = 'www.' . $d;
    }
    $entryUrls = array();
    foreach ($hosts as $h) {
        foreach (array('https', 'http') as $sch) {
            $entryUrls[] = $sch . '://' . $h . '/';
        }
    }

    // 1) 逐个入口抓首页 HTML，找 <link ... icon ...>
    foreach ($entryUrls as $entry) {
        $page = flyme_http_get($entry, 5, 524288);
        if ($page === null) {
            continue;
        }
        $base = $page['finalUrl'] !== '' ? $page['finalUrl'] : $entry;
        $bp = parse_url($base);
        $origin = ($bp['scheme'] ?? 'https') . '://' . ($bp['host'] ?? $d);
        $dir = $origin . rtrim(str_replace('\\', '/', dirname($bp['path'] ?? '/')), '/') . '/';

        $cands = array();
        if (preg_match_all('#<link[^>]+>#si', $page['body'], $tags)) {
            foreach ($tags[0] as $tag) {
                if (preg_match('#rel=["\']([^"\']*icon[^"\']*)["\']#i', $tag, $rel)
                    && preg_match('#href=["\']([^"\']+)["\']#i', $tag, $href)) {
                    $hrefVal = html_entity_decode(trim($href[1]), ENT_QUOTES);
                    if ($hrefVal === '' || strpos($hrefVal, 'data:') === 0) {
                        continue;
                    }
                    $relLow = strtolower($rel[1]);
                    $prio   = (strpos($relLow, 'apple-touch') !== false || strpos($relLow, 'apple') !== false) ? 0 : 1;
                    // 解析相对地址
                    if (strpos($hrefVal, '//') === 0) {
                        $hrefVal = 'https:' . $hrefVal;
                    } elseif (strpos($hrefVal, 'http') !== 0) {
                        $hrefVal = (strpos($hrefVal, '/') === 0 ? $origin : rtrim($dir, '/')) . (strpos($hrefVal, '/') === 0 ? $hrefVal : '/' . $hrefVal);
                    }
                    $cands[] = array('prio' => $prio, 'url' => $hrefVal);
                }
            }
        }
        usort($cands, function ($a, $b) { return $a['prio'] - $b['prio']; });
        $cands = array_slice($cands, 0, 4);

        foreach ($cands as $c) {
            $img = flyme_http_get($c['url'], 5, 1048576);
            if ($img !== null && flyme_body_is_image($img['body'])) {
                $found = array($img['body'], 'image/png');
                break;
            }
        }
        if ($found !== null) {
            break;
        }
    }
    // 2) 兜底：逐入口直接要 /favicon.ico
    if ($found === null) {
        foreach ($entryUrls as $entry) {
            $img = flyme_http_get(rtrim($entry, '/') . '/favicon.ico', 4, 1048576);
            if ($img !== null && flyme_body_is_image($img['body'])) {
                $found = array($img['body'], 'image/x-icon');
                break;
            }
        }
    }

    if ($found === null) {
        header('Cache-Control: no-store');
        flyme_json(array('ok' => false, 'error' => 'icon not found'), 404);
    }

    @file_put_contents($binFile, $found[0]);
    @file_put_contents($typFile, $found[1]);
    flyme_proxy_headers($found[1]);
    header('X-Icon-Source: live');
    echo $found[0];
    exit;
}

/* 图形图标代理（v1.0.14）：api.iconify.design 在部分手机网络不可达/被墙，
 * 且 App WebView(https 源) 加载 http 自建代理受限。这里由服务器中转 Iconify
 * SVG（严格白名单 + 7 天缓存 + CORS 头），客户端只依赖自己那台服务器。 */
if ($path === '/api/icon/proxy') {
    $u = isset($_GET['u']) ? trim((string) $_GET['u']) : '';
    if ($u === '' || strlen($u) > 500) {
        flyme_json(array('ok' => false, 'error' => 'invalid url'), 400);
    }
    $up = parse_url($u);
    if (!$up || ($up['host'] ?? '') !== 'api.iconify.design'
        || !preg_match('#^/[a-z0-9\-]+/[a-z0-9\-]+\.svg$#i', $up['path'] ?? '')) {
        flyme_json(array('ok' => false, 'error' => 'host not allowed'), 400);
    }

    $cacheDir = GF_ROOT . '/storage/icon-cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0755, true);
    }
    $key     = md5('proxy:' . $u);
    $binFile = $cacheDir . '/' . $key . '.bin';
    $typFile = $cacheDir . '/' . $key . '.type';
    if (is_file($binFile) && is_file($typFile) && (time() - filemtime($binFile)) < 2592000) {
        $type = (string) file_get_contents($typFile);
        flyme_proxy_headers($type !== '' ? $type : 'image/svg+xml');
        readfile($binFile);
        exit;
    }

    $svg = flyme_http_get($u, 6, 1048576);
    if ($svg === null || !flyme_body_is_image($svg['body'])) {
        header('Cache-Control: no-store');
        flyme_json(array('ok' => false, 'error' => 'upstream failed'), 502);
    }
    $type = isset($svg['contentType']) ? (string) $svg['contentType'] : 'image/svg+xml';
    if (strpos($type, 'svg') === false && strpos($type, 'image') === false) {
        $type = 'image/svg+xml';
    }
    @file_put_contents($binFile, $svg['body']);
    @file_put_contents($typFile, $type);
    flyme_proxy_headers($type);
    echo $svg['body'];
    exit;
}

/* ---------- 商品图片搜索（v1.0.16 引入，v1.0.17 二次重写）----------
 * 用户诉求：加物品搜「iPhone 17」「一加 15」要出真实、相关的商品缩略图。
 * v1.0.17 改进（针对「错误率高 + 15s 加载不出来」）：
 *  ① 速度：预览改用 Bing 自家缩略 CDN（tse*-mm.cn.bing.net，~7KB/张，秒开），
 *     原图 murl 只在点选时经 /api/img/get 抓取；请求带 mkt=zh-CN&setlang=zh-hans
 *     （旧 form=HDRSC2 会拉进企业站/SEO 垃圾图）。
 *  ★② 相关性（本轮重点）：纯中文 + 数字组合词（「一加15」）会让 Bing 返回
 *    **汉字字形图**（字典/字帖站的「一」「加」楷书 PNG、GIF）——用户反馈
 *    「结果是完全不相关的东西」。对策：
 *      a) 来源黑名单：字典/字库/字体/图标站一律丢弃（flyme_img_relevant）；
 *      b) 品牌词典**主动改写**：含中文品牌先按官方拼写（一加→OnePlus）查，
 *         结果不足 6 条再补原词结果去重合并。
 *  ③ 配对：缩略 <img src> 与 m JSON 的 murl 按文档顺序一一对应。 */
if ($path === '/api/img/search') {
    $q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
    if ($q === '' || strlen($q) > 60) {
        flyme_json(array('ok' => false, 'error' => 'invalid query'), 400);
    }
    // v1.0.33 安全修复：限流 30 次/分钟（每次搜索都要打 Bing/360 上游，无限制会被当免费代理刷）
    flyme_rate_limit('imgsearch', 30, 60);

    /** 单次 Bing 图搜：返回 [ [url=murl, thumb=缩略直链], ... ] */
    function flyme_bing_imgs($q)
    {
        $items = array();
        $resp = flyme_http_get(
            'https://cn.bing.com/images/search?q=' . rawurlencode($q) . '&mkt=zh-CN&setlang=zh-hans&first=1',
            8,
            2097152
        );
        if ($resp === null || $resp['body'] === '') {
            return $items;
        }
        $html = html_entity_decode($resp['body'], ENT_QUOTES | ENT_HTML5, 'UTF-8');

        $thumbs = array();
        if (preg_match_all('#src="(https://tse\d+-mm\.cn\.bing\.net/th/id/[^"]+)"#', $html, $tm)) {
            $thumbs = $tm[1];
        }
        $murls = array();
        if (preg_match_all('/m="(\{.*?\})"/', $html, $mm)) {
            foreach ($mm[1] as $j) {
                $d = json_decode($j, true);
                if (is_array($d) && isset($d['murl']) && is_string($d['murl']) && $d['murl'] !== '') {
                    $murls[] = $d['murl'];
                }
            }
        }
        $n = min(count($thumbs), count($murls));
        for ($i = 0; $i < $n; $i++) {
            $u = (string) $murls[$i];
            if (strlen($u) > 500) {
                continue;
            }
            $items[] = array('type' => 'img', 'url' => $u, 'thumb' => $thumbs[$i]);
            if (count($items) >= 16) {
                break;
            }
        }
        return $items;
    }

    /**
     * 相关性守卫：挡掉「不是商品图」的来源（v1.0.17）。
     * 黑名单主要针对字典/字库/字帖/字体/图标站 —— 中文查询里混数字时
     * Bing 极爱返回这些每一笔业务的字形图。
     */
    function flyme_img_relevant($url)
    {
        $u = strtolower((string) $url);
        $host = strtolower((string) (parse_url($u, PHP_URL_HOST) ?? ''));
        $badHosts = array(
            'hanyuguoxue.com', 'zdic.net', 'zdicimg', 'zitupic', 'zitianchina', 'zidian',
            'hanziyuan.net', '39017.com', 'pinyinzi', 'yedict.com', 'kaishu.cc',
            'iconfont.cn', 'easyicon.net', 'iconarchive.com', 'css88.com',
            'quanjing.com', 'tukuchina',
            // 图片社交 / 搜索缓存站：图源杂乱，命中尺寸/水的概率高
            'huaban.com', 'hbimg', 'qhimg.com', '360pic',
        );
        foreach ($badHosts as $b) {
            if (strpos($host, $b) !== false) {
                return false;
            }
        }
        // 路径特征：/zidian/、/kai400/、/zitupic/zi/ 等字形图目录
        if (preg_match('#/(zidian|kai\d{2,4}|zitupic|zititupian|zi)/#', $u)) {
            return false;
        }
        return true;
    }

    /**
     * 查询候选列表（按优先级）：中文品牌 → 官方拼写 (+空格型号) → 无空格 → 原词。
     *
     * ★为什么要自带空格跑一次：「OnePlus15」在 Bing 里会被当成一个生造词，
     *   而「OnePlus 15」才是它会给出手机产品图的写法。
     */
    function flyme_img_queries($q)
    {
        static $brandMap = array(
            '一加' => 'OnePlus', '魅族' => 'Meizu', '红米' => 'Redmi', '小米' => 'Xiaomi',
            '华为' => 'Huawei', '荣耀' => 'HONOR', '苹果' => 'Apple iPhone', '三星' => 'Samsung',
            '佳能' => 'Canon', '尼康' => 'Nikon', '索尼' => 'Sony', '富士' => 'Fujifilm',
            '任天堂' => 'Nintendo', '戴森' => 'Dyson', '大疆' => 'DJI', '联想' => 'Lenovo',
            '惠普' => 'HP', '戴尔' => 'Dell', '微软' => 'Microsoft', '雅马哈' => 'Yamaha',
        );
        foreach ($brandMap as $cn => $en) {
            if (mb_strpos($q, $cn) !== false) {
                $rest = trim((string) str_replace($cn, '', $q));
                if ($rest !== '') {
                    return array($en . ' ' . $rest, $en . $rest, $q);
                }
                return array($en, $q);
            }
        }
        return array($q);
    }

    /** 搜狗/360 第二来源（v1.0.20）：image.so.com JSON 直出，img=原图 thumb=缩略。 */
    function flyme_so360_imgs($q)
    {
        $items = array();
        $resp = flyme_http_get(
            'https://image.so.com/j?q=' . rawurlencode($q) . '&src=srp&correct=&pn=20&sn=0',
            8,
            2097152,
            'https://image.so.com/'
        );
        if ($resp === null || $resp['body'] === '') {
            return $items;
        }
        $j = json_decode($resp['body'], true);
        if (!is_array($j) || !isset($j['list']) || !is_array($j['list'])) {
            return $items;
        }
        foreach ($j['list'] as $row) {
            if (!is_array($row)) {
                continue;
            }
            $img = (string) ($row['img'] ?? '');
            $thumb = (string) ($row['thumb'] ?? '');
            if ($img === '' || strlen($img) > 500) {
                continue;
            }
            if (!preg_match('#^https?://#i', $img)) {
                continue;
            }
            $items[] = array('type' => 'img', 'url' => $img, 'thumb' => $thumb !== '' ? $thumb : $img);
            if (count($items) >= 16) {
                break;
            }
        }
        return $items;
    }

    /** 搜一次并做相关性过滤。 */
    function flyme_img_clean($qq)
    {
        $out = array();
        foreach (flyme_bing_imgs($qq) as $it) {
            if (!flyme_img_relevant($it['url'])) {
                continue;
            }
            if (strlen($it['url']) > 500) {
                continue;
            }
            $out[] = $it;
        }
        return $out;
    }

    /* 执行：按候选顺序搜（够 12 条就停）→ 按 url 去重 → 关键词命中项排前 */
    $items = array();
    $seen = array();
    $usedQuery = $q;
    foreach (flyme_img_queries($q) as $i => $qq) {
        foreach (flyme_img_clean($qq) as $it) {
            if (isset($seen[$it['url']])) {
                continue;
            }
            $seen[$it['url']] = true;
            $items[] = $it;
        }
        if ($i === 0 && count($items) > 0) {
            $usedQuery = $qq;
        }
        if (count($items) >= 12) {
            break;
        }
    }
    /* ★v1.0.20 第二来源兜底：Bing 结果不足（上游偶发降级/拦截）时用 360 图片补足，
       避免「搜索页空白」。两来源去重合并，共用同一套相关性过滤。 */
    if (count($items) < 8) {
        foreach (flyme_so360_imgs($q) as $it) {
            if (!flyme_img_relevant($it['url'])) {
                continue;
            }
            if (isset($seen[$it['url']])) {
                continue;
            }
            $seen[$it['url']] = true;
            $items[] = $it;
            if (count($items) >= 16) {
                break;
            }
        }
    }
    /* 相关性加权：URL 里出现查询词片段（品牌/型号）的排前面 */
    $terms = preg_split('/[\s,，、]+/u', $q, -1, PREG_SPLIT_NO_EMPTY);
    $terms = $terms ? array_values(array_filter($terms, function ($t) {
        return strlen($t) >= 2;
    })) : array();
    if (count($terms) > 0 && count($items) > 1) {
        usort($items, function ($a, $b) use ($terms) {
            $sa = 0;
            $sb = 0;
            foreach ($terms as $t) {
                if (stripos($a['url'], $t) !== false) {
                    $sa += 1;
                }
                if (stripos($b['url'], $t) !== false) {
                    $sb += 1;
                }
            }
            return $sb - $sa;
        });
    }
    flyme_json(array('ok' => true, 'items' => $items, 'query' => $usedQuery));
}

/* /api/img/get?u= ：任意主机图片代理（v1.0.16；v1.0.20 放宽 ≤8MB + Referer 兜底重试）。
 * 商品图散落在各种图床域名，客户端（App WebView https 源）无法直连——
 * 一律经自己服务器中转：仅 image/* 内容、30 天磁盘缓存、CORS 头。 */
if ($path === '/api/img/get') {
    $u = isset($_GET['u']) ? trim((string) $_GET['u']) : '';
    if ($u === '' || strlen($u) > 500) {
        flyme_json(array('ok' => false, 'error' => 'invalid url'), 400);
    }
    $up = parse_url($u);
    if (!$up || !isset($up['host']) || !preg_match('#^https?$#i', $up['scheme'] ?? '')) {
        flyme_json(array('ok' => false, 'error' => 'host not allowed'), 400);
    }
    /* ★v1.0.33 安全修复：原来的「内网黑名单」可被多种方式绕过 ——
     *   ① 十进制 IP：2130706433 == 127.0.0.1，正则只匹配 "127." 前缀；
     *   ② 172.16~31 只挡了三段前缀，0.x / 169.254 / 100.100.100.200 全漏；
     *   ③ curl 跟随重定向：公网 URL 一个 302 就能打到内网；
     *   ④ host 形如 "127.0.0.1."（带尾点）等变形。
     * 现在统一走 flyme_ssrf_check_url()：归一化 + 逐 IP 判定 + 重定向逐跳复检。
     * 同时加 IP 限流（300 次/分钟）与代理安全响应头。 */
    flyme_rate_limit('imgget', 300, 60);
    if (!flyme_ssrf_check_url($u)) {
        flyme_json(array('ok' => false, 'error' => 'host not allowed'), 400);
    }

    $cacheDir = GF_ROOT . '/storage/icon-cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0755, true);
    }
    $key     = md5('img:' . $u);
    $binFile = $cacheDir . '/' . $key . '.bin';
    $typFile = $cacheDir . '/' . $key . '.type';
    if (is_file($binFile) && is_file($typFile) && (time() - filemtime($binFile)) < 2592000) {
        $type = (string) file_get_contents($typFile);
        flyme_proxy_headers($type !== '' ? $type : 'image/jpeg');
        readfile($binFile);
        exit;
    }

    $r = flyme_http_get($u, 10, 8388608, $up['scheme'] . '://' . $up['host'] . '/');
    $type = $r !== null ? strtolower((string) $r['contentType']) : '';
    if ($r === null || strpos($type, 'image') === false) {
        /* 首选失败（部分图床校验 Referer/超时）：换「无 Referer」再试一次 */
        $r = flyme_http_get($u, 10, 8388608);
    }
    $type = $r !== null ? strtolower((string) $r['contentType']) : '';
    if ($r === null || strpos($type, 'image') === false) {
        /* 上游不是图片或失败：不缓存，直接报错 */
        header('Cache-Control: no-store');
        flyme_json(array('ok' => false, 'error' => 'upstream failed'), 502);
    }
    if (strpos($type, ';') !== false) {
        $type = substr($type, 0, strpos($type, ';'));
    }
    @file_put_contents($binFile, $r['body']);
    @file_put_contents($typFile, $type);
    flyme_proxy_headers($type);
    echo $r['body'];
    exit;
}

/* 在线图标搜索（v1.0.11 扩全网）：两类结果一次出齐 ——
 * ① 图形图标：中文关键词经词典映射成英文后查 Iconify（开源图标集，
 *    数码/生活用品都能搜到具体图形）；纯英文词直接查。
 * ② 站点图标：关键词 → 搜索引擎结果域名（原逻辑），前端用 /api/icon/img 出真图标。
 * 图形图标点击后前端存为 url:（Iconify SVG 直链，有 CORS，canvas 分享海报不脏）。 */
if ($path === '/api/icon/search') {
    $q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
    if ($q === '' || strlen($q) > 60) {
        flyme_json(array('ok' => false, 'error' => 'invalid query'), 400);
    }
    // v1.0.33 安全修复：限流 30 次/分钟
    flyme_rate_limit('iconsearch', 30, 60);

    /* 中文 → 英文词典（最长包含词匹配；覆盖数码/家电/穿戴/家居/文娱/餐饮/交通等高频记账物品）。 */
    $dict = array(
        '耳机'=>'headphones', '蓝牙耳机'=>'headphones', '手机'=>'smartphone', '平板'=>'tablet',
        '电脑'=>'computer', '笔记本'=>'laptop', '键盘'=>'keyboard', '鼠标'=>'mouse', '显示器'=>'monitor',
        '充电器'=>'power-plug', '充电宝'=>'battery-charging', '电池'=>'battery', '数据线'=>'cable',
        '相机'=>'camera', '摄像头'=>'cctv', '手表'=>'watch', '手环'=>'watch-variant',
        '台灯'=>'lamp', '灯'=>'lightbulb', '风扇'=>'fan', '空调'=>'air-conditioner', '冰箱'=>'fridge',
        '洗衣机'=>'washing-machine', '电视'=>'television', '音响'=>'speaker', '音箱'=>'speaker',
        '麦克风'=>'microphone', '路由器'=>'router', '加湿器'=>'air-humidifier', '吹风机'=>'hair-dryer',
        '水杯'=>'cup', '杯子'=>'cup', '水壶'=>'kettle', '保温杯'=>'bottle', '雨伞'=>'umbrella',
        '眼镜'=>'glasses', '太阳镜'=>'sunglasses', '衣服'=>'tshirt', '衬衫'=>'tshirt', '鞋子'=>'shoe-sneaker',
        '袜子'=>'socks', '帽子'=>'hat-variant', '背包'=>'bag', '钱包'=>'wallet', '钥匙'=>'key',
        '书'=>'book', '笔'=>'pen', '桌子'=>'table', '椅子'=>'chair', '沙发'=>'sofa', '床'=>'bed',
        '牙刷'=>'toothbrush', '毛巾'=>'towel', '剃须刀'=>'knife', '闹钟'=>'alarm', '自行车'=>'bicycle',
        '汽车'=>'car', '摩托车'=>'motorbike', '电动车'=>'motorbike', '飞机'=>'airplane', '火车'=>'train',
        '吉他'=>'guitar', '钢琴'=>'piano', '篮球'=>'basketball', '足球'=>'soccer', '羽毛球'=>'badminton',
        '哑铃'=>'dumbbell', '健身'=>'dumbbell', '药'=>'pill', '花'=>'flower', '盆栽'=>'sprout',
        '猫'=>'cat', '狗'=>'dog', '鱼'=>'fish', '鸟'=>'bird', '宠物'=>'paw',
        '咖啡'=>'coffee', '咖啡机'=>'coffee-maker', '奶茶'=>'cup', '蛋糕'=>'cake', '面包'=>'bread',
        '披萨'=>'pizza', '汉堡'=>'hamburger', '水果'=>'fruit', '牛奶'=>'milk', '饮料'=>'bottle-soda',
        '零食'=>'cookie', '饼干'=>'cookie', '会员'=>'crown', '游戏'=>'gamepad', '手柄'=>'gamepad',
        '手办'=>'toy-brick', '乐高'=>'toy-brick', '电影'=>'movie', '音乐'=>'music', '票'=>'ticket',
        '行李箱'=>'bag-checked', '快递'=>'package', '购物'=>'cart', '外卖'=>'food', '话费'=>'phone',
        '网费'=>'wifi', '房租'=>'home', '戒指'=>'ring', '项链'=>'necklace', '口红'=>'lipstick',
        '支付宝'=>'alipay', '微信支付'=>'alipay', '淘宝'=>'taobao', '京东'=>'jd', '美团'=>'meituan',
        '拼多多'=>'pinduoduo', '抖音'=>'douyin', '哔哩哔哩'=>'bilibili', '网易云'=>'netease-cloud',
        '香水'=>'spray', '护肤品'=>'lotion', '剪刀'=>'scissors', '锤子'=>'hammer', '工具'=>'screwdriver',
        '蜡烛'=>'candle', '扫地机器人'=>'robot-vacuum', '无人机'=>'quadcopter', '游戏机'=>'nintendo-switch',
        '手表带'=>'watch', '苹果'=>'apple', '香蕉'=>'banana', '西瓜'=>'watermelon', '鸡蛋'=>'egg',
    );
    $en = '';
    if (preg_match('/^[a-z0-9][a-z0-9 _+\-\.]{1,}$/i', $q)) {
        $en = strtolower($q); // 纯英文词直接查
    } else {
        $best = 0;
        foreach ($dict as $zh => $mapped) {
            if (mb_strpos($q, $zh) !== false && mb_strlen($zh) > $best) {
                $best = mb_strlen($zh);
                $en = $mapped;
            }
        }
    }

    $iconItems = array();
    if ($en !== '') {
        $SET_W = array(
            'mdi' => 0, 'material-symbols' => 1, 'material-symbols-rounded' => 1, 'tabler' => 2,
            'ic' => 3, 'ri' => 4, 'ph' => 5, 'simple-icons' => 6, 'lucide' => 7, 'solar' => 8,
            'mingcute' => 9, 'iconoir' => 10, 'fluent' => 11,
        );
        $resp = flyme_http_get('https://api.iconify.design/search?query=' . rawurlencode($en) . '&limit=32', 6, 524288);
        if ($resp !== null) {
            $j = json_decode($resp['body'], true);
            $icons = is_array($j) && isset($j['icons']) && is_array($j['icons']) ? $j['icons'] : array();
            $ranked = array();
            foreach ($icons as $full) {
                if (!is_string($full) || strpos($full, ':') === false) {
                    continue;
                }
                $p = substr($full, 0, strpos($full, ':'));
                $w = isset($SET_W[$p]) ? $SET_W[$p] : 20;
                $ranked[] = array('full' => $full, 'w' => $w);
            }
            usort($ranked, function ($a, $b) { return $a['w'] - $b['w']; });
            foreach (array_slice($ranked, 0, 12) as $r) {
                $iconItems[] = array(
                    'type' => 'icon',
                    'icon' => $r['full'],
                    /* v1.0.14：改走自建代理相对路径（前端补全 origin），不再直连
                     * api.iconify.design —— 手机网络对该域经常不可达，且 App WebView
                     * 加载 http 自建域受限时由服务器统一中转。 */
                    'url'  => '/api/icon/proxy?u=' . rawurlencode('https://api.iconify.design/' . str_replace(':', '/', $r['full']) . '.svg?height=96&color=%232f3b35'),
                );
            }
        }
    }

    $domains = array();
    foreach (array('https://cn.bing.com/search?q=', 'https://www.bing.com/search?q=') as $base) {
        $rss = flyme_http_get($base . rawurlencode($q) . '&format=rss&count=20', 6, 262144);
        if ($rss === null) {
            continue;
        }
        if (preg_match_all('#<link>([^<]+)</link>#i', $rss['body'], $m)) {
            foreach ($m[1] as $link) {
                $host = parse_url(trim($link), PHP_URL_HOST);
                if (!$host) {
                    continue;
                }
                $host = strtolower(preg_replace('/^www\./i', '', $host));
                // 过滤搜索引擎自家与不合法域
                if (!flyme_valid_domain($host)) {
                    continue;
                }
                if (preg_match('/(bing|microsoft|msn|live|bing)\.(com|cn)$/i', $host)) {
                    continue;
                }
                $domains[$host] = true;
                if (count($domains) >= 10) {
                    break 2;
                }
            }
        }
        if (count($domains) >= 3) {
            break;
        }
    }
    $items = $iconItems;
    /* 根域名优先（auth.alipay.com 这种子域对用户没用，alipay.com 才是想要的），
     * 同长度按字母序稳定输出。 */
    $siteKeys = array_keys($domains);
    usort($siteKeys, function ($a, $b) {
        $da = substr_count($a, '.');
        $db = substr_count($b, '.');
        if ($da !== $db) return $da - $db;
        return strcmp($a, $b);
    });
    foreach (array_slice($siteKeys, 0, 6) as $d) {
        $items[] = array('type' => 'site', 'domain' => $d);
    }
    header('Cache-Control: no-store');
    flyme_json(array('ok' => true, 'items' => $items));
    exit;
}

/* ---------------- API ---------------- */

if ($path === '/api' || strpos($path, '/api/') === 0) {
    require_once GF_ROOT . '/app/Api.php';
    GF_Api::handle($path);
    exit;
}

/* ---------------- 小图标：避免每条 favicon 请求都回spa页面 ---------------- */

if ($path === '/favicon.ico') {
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        . '<rect width="64" height="64" rx="14" fill="#2f6b4f"/>'
        . '<text x="32" y="44" font-size="36" text-anchor="middle" fill="#fff" font-family="serif">归</text></svg>';
    header('Content-Type: image/svg+xml');
    header('Cache-Control: public, max-age=604800');
    echo $svg;
    exit;
}

/* ---------------- 静态资源 ---------------- */

if ($path !== '/') {
    // 静态资源目录：文件不存在就明确 404，不要回落到 SPA（否则前端会误以为拿到 index.html）
    if (strpos($lower, '/assets/') === 0) {
        $afile = realpath(GF_ROOT . $path);
        if ($afile === false || !is_file($afile) || strpos(str_replace('\\', '/', $afile), str_replace('\\', '/', GF_ROOT) . '/assets/') !== 0) {
            flyme_json(array('ok' => false, 'error' => 'asset not found'), 404);
        }
    }

    $file = realpath(GF_ROOT . $path);
    if ($file !== false && is_file($file) && strpos(str_replace('\\', '/', $file), str_replace('\\', '/', GF_ROOT) . '/') === 0) {
        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        // 只有白名单类型的文件才允许直接输出，避免源码泄露
        $mime = flyme_mime($ext);
        if ($mime !== null) {
            $etag = '"' . md5($file . '|' . filemtime($file) . '|' . filesize($file)) . '"';
            $mod  = isset($_SERVER['HTTP_IF_MODIFIED_SINCE']) ? strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE']) : false;
            header('Content-Type: ' . $mime);
            header('Content-Length: ' . filesize($file));
            header('X-Content-Type-Options: nosniff');
            if ($ext === 'js' || $ext === 'css' || $ext === 'ico' || $ext === 'svg') {
                header('Cache-Control: public, max-age=604800');
                header('ETag: ' . $etag);
                if ($mod !== false && $mod >= filemtime($file)) {
                    http_response_code(304);
                    exit;
                }
                header('Last-Modified: ' . gmdate('D, d M Y H:i:s', filemtime($file)) . ' GMT');
            } else {
                header('Cache-Control: no-store');
            }
            readfile($file);
            exit;
        }
    }
}

/* ---------------- SPA 入口（v1.0.7：旧 PC 网页彻底退役） ----------------
 * - 全站所有路径（含 /admin）一律输出统一代码库的新 SPA：
 *   · 手机壳（底部标签栏）/ PC 桌面壳（深绿侧边栏）按屏宽 + 用户偏好自动切换；
 *   · 管理后台为 SPA 内路由 /#/admin（管理员账号与用户账号相互独立）。
 * - 旧 PC 网页（无源码压缩 bundle）及其文件已全部删除，不再保留逃生口。 */
function flyme_emit_spa($file): void
{
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache, must-revalidate');
    echo is_file($file) ? file_get_contents($file) : '<h1>SPA html missing</h1>';
    exit;
}

flyme_emit_spa(GF_ROOT . '/app/spa-m.html');
