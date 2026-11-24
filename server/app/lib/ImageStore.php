<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * ★v1.8.0 图片云托管（内容寻址对象存储）—— 「本地存储膨胀 / 每次备份全量传图」根治。
 *
 * 背景（用户反馈）：物品图片一直以 base64 dataURL 内嵌在记录里，
 * 本地 localStorage 从 600KB 暴涨到 1.8MB，每次备份/同步都要把整张图重传一遍，
 * 弱网下卡顿几秒。目标：**本地与传输链路里不再出现 base64，只留几十字节的引用**。
 *
 * 存储布局：storage/images/<ownerHash>/<sha256前2位>/<sha256>.<ext>
 *   · 与 v1.5.1 分片上传的 storage/uploads/<ownerHash>/ 同一套 ownerHash 机制
 *     （ownerHash = sha256(email) 前 16 位，不可逆，不暴露账号）；
 *   · 内容寻址：同一张图无论上传几次都落同一个文件 → 天然去重，重复上传秒返回；
 *   · 分两级目录（前 2 位）：单目录文件数可控，避免大目录拖慢文件系统。
 *
 * 鉴权（两级）：
 *   1. 写（POST 上传 / LIST）：必须 Bearer token（Api.php::user 分区，GF_Auth::currentUser）。
 *   2. 读（GET <img src> 直接访问，浏览器**无法**带 Authorization 头）：
 *      签名短时效 URL —— `<url>?t=<exp>&s=<sig>`，
 *      sig = HMAC-SHA256(站点 secret, "<sha256>|<exp>") 前 32 位 hex。
 *      secret 存在 storage/config.php 的 `secret` 字段（安装时随机生成，浏览器永远读不到）。
 *      签名只绑定 **sha256 + 过期时间**，不绑定账号 —— 这样 ①前端无需知道 ownerHash；
 *      ②请求落到**哪台设备/哪个账号**都能验签（换机 / 服务器迁移不失效）；
 *      ③sha256 是不可猜测的内容摘要（它在签名之前，等于一道能力令牌）。
 *   另：同机浏览器（网页版）请求时带同源 Cookie `nawu_img`（服务端下发，HttpOnly），
 *   与签名互为兜底 —— Cookie 丢失（App WebView / 隐私模式）也不影响渲染。
 *
 * 兼容：老服务器没有这些接口时，前端 `imageCloud` 全部短路，图片仍是本地 base64，
 * 离线/未登录场景完全不受影响。
 */
class GF_ImageStore
{
    /** 单张图片字节上限（与 GF_EntityNormalize::IMAGE_MAX_BYTES 一致）。 */
    const MAX_BYTES = 2097152;
    /** 单张图片 base64 字符串上限（约 2.8MB，留出 JSON 包装余量）。 */
    const MAX_B64_CHARS = 3200000;
    /** 读取 URL 签名有效期：24 小时（分享卡/长图渲染一次足够，越短越安全）。 */
    const SIGN_TTL = 86400;
    /** 渲染 URL 过期后的提前重签阈值：剩余 < 2 小时就让客户端重签。 */
    const SIGN_REFRESH = 7200;
    /** LIST 单次返回 hash 数上限（防超大响应）。 */
    const LIST_LIMIT = 20000;
    /** 上传频控：300 张/小时（正常新增物品远低于此，仅防滥用）。 */
    const UPLOAD_THROTTLE_MAX = 300;
    const UPLOAD_THROTTLE_WINDOW = 3600;
    /** 同源 Cookie 名（图片 GET 的第二道鉴权兜底）。 */
    const COOKIE_NAME = 'nawu_img';
    const COOKIE_TTL = 2592000;

    /* ==========================================================
     * 路径 / 目录
     * ========================================================== */

    /** 账号 → 目录哈希（不可逆，与 Api.php::uploadDir 口径一致）。 */
    public static function ownerHash($owner)
    {
        return substr(hash('sha256', (string) $owner), 0, 16);
    }

    /** ownerHash → 该账号的图片根目录。 */
    private static function ownerDir($ownerHash)
    {
        return GF_ROOT . '/storage/images/' . $ownerHash;
    }

    /** 全站 sha256 索引文件（跨账号，用于「对象被任意账号引用 → 不回收」判定）。 */
    private static function indexFile()
    {
        return GF_ROOT . '/storage/images/index.json';
    }

    /**
     * 一张图在某个账号目录下的文件路径。
     * 同一 sha256 的内容在站内**只存一份字节**：优先本账号目录，
     * 其次 fallback 到「索引里记录的任一其他账号目录」（跨设备/跨账号去重），
     * 都没有则返回本账号目标路径（调用方写入时用）。
     *
     * @return array array('path' => 现有文件绝对路径|null, 'write' => 应写入的绝对路径, 'ext' => 扩展名)
     */
    public static function locate($ownerHash, $sha, $mime = null)
    {
        $sha = self::validSha($sha);
        if ($sha === null) {
            return array('path' => null, 'write' => '', 'ext' => 'bin');
        }
        $ext = self::extOf($mime);
        $dir = self::ownerDir($ownerHash) . '/' . substr($sha, 0, 2);
        $target = $dir . '/' . $sha . '.' . $ext;

        // ① 本账号目录（扩展名可能因 MIME 嗅探不同而不同，逐种探测）
        foreach (array_unique(array($ext, 'jpg', 'png', 'webp', 'gif', 'bmp', 'ico')) as $e) {
            $p = $dir . '/' . $sha . '.' . $e;
            if (is_file($p)) {
                return array('path' => $p, 'write' => $p, 'ext' => $e);
            }
        }
        // ② 站内其它账号（跨账号去重：同一张图只存一份字节）
        $idx = self::readIndex();
        if (isset($idx[$sha])) {
            $theirs = self::ownerDir($idx[$sha]) . '/' . substr($sha, 0, 2);
            foreach (array_unique(array($ext, 'jpg', 'png', 'webp', 'gif', 'bmp', 'ico')) as $e) {
                $p = $theirs . '/' . $sha . '.' . $e;
                if (is_file($p)) {
                    return array('path' => $p, 'write' => $p, 'ext' => $e);
                }
            }
        }
        return array('path' => null, 'write' => $target, 'ext' => $ext);
    }

    /** sha256 合法性（严格 64 位小写 hex —— 防路径穿越）。 */
    public static function validSha($sha)
    {
        $s = strtolower(trim((string) $sha));
        return preg_match('/^[0-9a-f]{64}$/', $s) ? $s : null;
    }

    /** MIME → 文件扩展名（只收位图，SVG 一律拒绝：可能内嵌脚本）。 */
    public static function extOf($mime)
    {
        static $map = array(
            'image/jpeg'   => 'jpg',
            'image/png'    => 'png',
            'image/webp'   => 'webp',
            'image/gif'    => 'gif',
            'image/bmp'    => 'bmp',
            'image/x-icon' => 'ico',
        );
        $m = strtolower(trim((string) $mime));
        return isset($map[$m]) ? $map[$m] : 'jpg';
    }

    /** 扩展名 → Content-Type。 */
    public static function mimeOfExt($ext)
    {
        static $map = array(
            'jpg'  => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'png'  => 'image/png',
            'webp' => 'image/webp',
            'gif'  => 'image/gif',
            'bmp'  => 'image/bmp',
            'ico'  => 'image/x-icon',
        );
        $e = strtolower(trim((string) $ext));
        return isset($map[$e]) ? $map[$e] : 'application/octet-stream';
    }

    /* ==========================================================
     * 全站索引（sha256 → ownerHash）
     * ==========================================================
     * 作用有两个：
     *   ① 「这内容站内还在不在」——被别的账号引用着就不能回收，否则会把别人的图删掉；
     *   ② GET 读图时按索引找文件，**不依赖请求方是哪台设备/哪个账号**。
     * 写入走「读-改-写 + 加锁」；文件控制在 1MB 以内、只在新增内容时才写，
     * 日常渲染完全不碰它。损坏/不可写时自动降级（只影响跨账号去重与 GC 精度）。
     */
    private static $indexCache = null;

    public static function readIndex()
    {
        if (self::$indexCache !== null) {
            return self::$indexCache;
        }
        $file = self::indexFile();
        $raw = is_file($file) ? @file_get_contents($file) : false;
        $arr = is_string($raw) && $raw !== '' ? json_decode($raw, true) : array();
        self::$indexCache = is_array($arr) ? $arr : array();
        return self::$indexCache;
    }

    private static function writeIndex($idx)
    {
        self::$indexCache = $idx;
        $file = self::indexFile();
        $dir = dirname($file);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
            return false;
        }
        $json = json_encode($idx, JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return false;
        }
        $tmp = $file . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $json) === false) {
            return false;
        }
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
            return false;
        }
        return true;
    }

    /** 登记一条内容（已有条目不改写，保持「首个写入者」为规范位置）。 */
    private static function indexPut($sha, $ownerHash)
    {
        $idx = self::readIndex();
        if (isset($idx[$sha])) {
            return;
        }
        $idx[$sha] = (string) $ownerHash;
        self::writeIndex($idx);
    }

    /* ==========================================================
     * 签名 URL
     * ========================================================== */

    /** 站点签名密钥（config.php 的 secret；缺失时用固定前缀，保证「不崩」但不建议）。 */
    private static function secret()
    {
        $s = '';
        try {
            $s = (string) GF_Config::get('secret', '');
        } catch (Exception $e) {
            $s = '';
        }
        return $s !== '' ? $s : 'nawu-image-store-fallback-secret';
    }

    /** 计算签名（绑定 sha256 + 过期时间）。 */
    public static function sign($sha, $exp)
    {
        return substr(hash_hmac('sha256', $sha . '|' . (int) $exp, self::secret()), 0, 32);
    }

    /** 校验签名（时间恒定比较；过期即失效）。 */
    public static function verify($sha, $exp, $sig)
    {
        $exp = (int) $exp;
        if ($exp <= 0 || $exp < time()) {
            return false;
        }
        $want = self::sign($sha, $exp);
        return is_string($sig) && $sig !== '' && hash_equals($want, $sig);
    }

    /** 生成一个带签名的读取 URL（相对路径，跨端都能用：网页相对站点、App 由前端拼服务器地址）。 */
    public static function urlFor($sha, $ttl = self::SIGN_TTL)
    {
        $sha = self::validSha($sha);
        if ($sha === null) {
            return '';
        }
        $exp = time() + max(60, (int) $ttl);
        return '/api/user/images/' . $sha . '?t=' . $exp . '&s=' . self::sign($sha, $exp);
    }

    /**
     * 从任意「云端图片引用」里解析 sha256：
     *   `/api/user/images/<sha>?t=…`、`/api/user/images/<sha>`、裸 `<sha>`。
     * 解析不出返回 null（调用方据此走兜底，绝不抛异常）。
     */
    public static function shaFromRef($ref)
    {
        $s = trim((string) $ref);
        if ($s === '') {
            return null;
        }
        $direct = self::validSha($s);
        if ($direct !== null) {
            return $direct;
        }
        $path = (string) parse_url($s, PHP_URL_PATH);
        if (preg_match('#/api/user/images/([0-9a-fA-F]{64})#', $path !== '' ? $path : $s, $m)) {
            return strtolower($m[1]);
        }
        return null;
    }

    /* ==========================================================
     * 写：上传一张图
     * ========================================================== */

    /**
     * 上传（base64 或 dataURL 或原始二进制字符串均可）。
     *
     * @param array  $me     当前登录用户（GF_Auth::currentUser 的返回）
     * @param string $payload 图片内容
     * @return array array('ok'=>bool,'code'=>int,'error'=>string,'sha256'=>string,'size'=>int,'mime'=>string,'url'=>string,'deduped'=>bool,'ext'=>string)
     */
    public static function put($me, $payload)
    {
        $owner = $me['email'];
        $ownerHash = self::ownerHash($owner);

        $bytes = self::decodePayload($payload, $err);
        if ($bytes === false) {
            return array('ok' => false, 'code' => 400, 'error' => $err);
        }
        if ($bytes === '') {
            return array('ok' => false, 'code' => 400, 'error' => '图片内容为空');
        }
        if (strlen($bytes) > self::MAX_BYTES) {
            return array('ok' => false, 'code' => 413, 'error' => '图片过大（单张上限 2MB），请压缩后再上传');
        }
        $mime = self::sniff($bytes);
        if ($mime === null) {
            return array('ok' => false, 'code' => 400, 'error' => '不支持的图片格式（只接受 jpeg/png/webp/gif/bmp/ico）');
        }
        if ($mime === 'image/svg+xml') {
            return array('ok' => false, 'code' => 400, 'error' => '不接受 SVG（可能内嵌脚本）');
        }

        $sha = hash('sha256', $bytes);
        $hit = self::locate($ownerHash, $sha, $mime);
        if ($hit['path'] !== null) {
            // ★内容寻址：同样的图重复上传 → 秒返回已有 URL（一个字节都不再写）
            if (!self::referencedBy($ownerHash, $sha)) {
                self::refAdd($ownerHash, $sha);
            }
            self::indexPut($sha, $ownerHash);
            return self::result($sha, strlen($bytes), $mime, $hit['path'], true);
        }

        $target = $hit['write'];
        $dir = dirname($target);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
            return array('ok' => false, 'code' => 500, 'error' => '图片目录不可写（storage/images 权限，需 755 且属主为 PHP 运行用户）');
        }
        // 先写临时文件再原子重命名：并发同名上传也不会读到半截文件
        $tmp = $target . '.' . getmypid() . '.' . mt_rand(1000, 9999) . '.tmp';
        if (@file_put_contents($tmp, $bytes) === false || !@rename($tmp, $target)) {
            @unlink($tmp);
            return array('ok' => false, 'code' => 500, 'error' => '图片写入失败（磁盘不可写或空间不足）');
        }
        @chmod($target, 0644);
        self::refAdd($ownerHash, $sha);
        self::indexPut($sha, $ownerHash);
        return self::result($sha, strlen($bytes), $mime, $target, false);
    }

    /** 统一返回体。 */
    private static function result($sha, $size, $mime, $path, $deduped)
    {
        $ext = pathinfo($path, PATHINFO_EXTENSION);
        return array(
            'ok'      => true,
            'code'    => 200,
            'sha256'  => $sha,
            'size'    => (int) $size,
            'mime'    => $mime,
            'ext'     => $ext !== '' ? $ext : self::extOf($mime),
            'url'     => self::urlFor($sha),
            'deduped' => (bool) $deduped,
        );
    }

    /**
     * 解出图片原始字节。
     * 支持：`data:image/…;base64,xxxx`、裸 base64（含换行）、原始二进制。
     * @return string|false
     */
    private static function decodePayload($payload, &$err = null)
    {
        if (!is_string($payload)) {
            $err = '图片内容必须是字符串';
            return false;
        }
        $s = trim($payload);
        if ($s === '') {
            return '';
        }
        if (strlen($s) > self::MAX_B64_CHARS) {
            $err = '图片过大（单张上限 2MB）';
            return false;
        }
        // ① 二进制直传（POST /api/user/images?raw=1，body 就是图片字节）
        if (strpos($s, 'data:') !== 0 && self::sniff($s) !== null) {
            return $s;
        }
        // ② dataURL：去掉 `data:<mime>;base64,` 前缀
        if (preg_match('#^data:#i', $s)) {
            $comma = strpos($s, ',');
            if ($comma === false) {
                $err = '图片 dataURL 缺少数据段';
                return false;
            }
            $s = substr($s, $comma + 1);
        }
        $s = preg_replace('/\s+/', '', $s);
        $bin = base64_decode($s, true);
        if ($bin === false || $bin === '') {
            $err = '图片 base64 无法解码';
            return false;
        }
        return $bin;
    }

    /** 按魔数识别真实图片类型（不依赖 GD）。 */
    public static function sniff($bin)
    {
        if (!is_string($bin) || strlen($bin) < 4) {
            return null;
        }
        if (strncmp($bin, "\xFF\xD8\xFF", 3) === 0) {
            return 'image/jpeg';
        }
        if (strncmp($bin, "\x89PNG\r\n\x1A\n", 8) === 0) {
            return 'image/png';
        }
        if (strncmp($bin, 'GIF8', 4) === 0) {
            return 'image/gif';
        }
        if (strlen($bin) >= 12 && strncmp($bin, 'RIFF', 4) === 0 && substr($bin, 8, 4) === 'WEBP') {
            return 'image/webp';
        }
        if (strncmp($bin, 'BM', 2) === 0) {
            return 'image/bmp';
        }
        if (strncmp($bin, "\x00\x00\x01\x00", 4) === 0) {
            return 'image/x-icon';
        }
        $head = ltrim($bin);
        if (stripos($head, '<svg') === 0 || stripos($head, '<?xml') === 0) {
            return 'image/svg+xml';
        }
        return null;
    }

    /* ==========================================================
     * 读：输出一张图（<img src> 直接访问，无 Authorization 头）
     * ========================================================== */

    /**
     * GET /api/user/images/<sha> —— 输出二进制。
     *
     * 鉴权：先验 `?t=&s=` 签名；签名缺失/过期时再看同源 Cookie `nawu_img`；
     *       两者都没有 → 401（但**不带 HTML**，以免 <img> 拿到一坨网页）。
     * 缓存：内容寻址 → 字节永不变化，ETag/强缓存给足（304 命中即客户端零下载）。
     */
    public static function send($sha, $query = null)
    {
        $sha = self::validSha($sha);
        if ($sha === null) {
            self::failPlain('bad sha256', 400);
        }
        $q = is_array($query) ? $query : $_GET;
        $exp = isset($q['t']) ? (int) $q['t'] : 0;
        $sig = isset($q['s']) ? (string) $q['s'] : '';
        $authorized = self::verify($sha, $exp, $sig) || self::cookieOk($sha);
        if (!$authorized) {
            // 没签名也没 Cookie：不是正常客户端的 <img> 请求，直接拒绝（不回 HTML，避免 <img> 拿到网页）
            self::failPlain('unauthorized', 401);
        }

        // 定位文件：索引 → 各账号目录（不依赖请求方身份）
        $path = self::fileForSha($sha);
        if ($path === null) {
            self::failPlain('image not found', 404);
        }

        $mime = self::mimeOfExt(pathinfo($path, PATHINFO_EXTENSION));
        $size = (int) @filesize($path);
        $etag = '"' . $sha . '"';
        $inm = isset($_SERVER['HTTP_IF_NONE_MATCH']) ? trim((string) $_SERVER['HTTP_IF_NONE_MATCH']) : '';

        if (!headers_sent()) {
            header('Content-Type: ' . $mime);
            header('X-Content-Type-Options: nosniff');
            header("Content-Security-Policy: default-src 'none'");
            // 分享卡 canvas 要能跨域取图（App 内 window 源是 https://localhost，服务器是另一台主机）
            header('Access-Control-Allow-Origin: *');
            header('Cross-Origin-Resource-Policy: cross-origin');
            header('ETag: ' . $etag);
            header('Last-Modified: ' . gmdate('D, d M Y H:i:s', (int) @filemtime($path)) . ' GMT');
            // 内容寻址 = 字节永不改变 → 客户端可长期强缓存（URL 带签名，但内容是同一份字节）
            header('Cache-Control: public, max-age=31536000, immutable');
            if ($inm !== '' && strpos($inm, $sha) !== false) {
                http_response_code(304);
                exit;
            }
            header('Content-Length: ' . $size);
        } else {
            exit;
        }
        readfile($path);
        exit;
    }

    /** 找一张图的磁盘路径（索引优先，其次扫描各账号目录）。 */
    public static function fileForSha($sha)
    {
        $sha = self::validSha($sha);
        if ($sha === null) {
            return null;
        }
        $idx = self::readIndex();
        $cands = array();
        if (isset($idx[$sha])) {
            $cands[] = (string) $idx[$sha];
        }
        // 索引缺失/损坏时兜底：列一遍各账号目录（数量有限，且只在 miss 时走）
        $root = GF_ROOT . '/storage/images';
        if (is_dir($root)) {
            $dh = @opendir($root);
            if ($dh) {
                while (($n = readdir($dh)) !== false) {
                    if ($n === '.' || $n === '..' || !is_dir($root . '/' . $n)) {
                        continue;
                    }
                    if (!in_array($n, $cands, true)) {
                        $cands[] = $n;
                    }
                }
                closedir($dh);
            }
        }
        foreach ($cands as $oh) {
            $dir = $root . '/' . $oh . '/' . substr($sha, 0, 2);
            foreach (array('jpg', 'png', 'webp', 'gif', 'bmp', 'ico') as $e) {
                $p = $dir . '/' . $sha . '.' . $e;
                if (is_file($p)) {
                    return $p;
                }
            }
        }
        return null;
    }

    /** 纯文本失败响应（绝对不能回 JSON/HTML —— <img> 只认二进制）。 */
    private static function failPlain($msg, $code)
    {
        http_response_code($code);
        if (!headers_sent()) {
            header('Content-Type: text/plain; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
        }
        echo $msg;
        exit;
    }

    /* ==========================================================
     * Cookie 兜底（同源浏览器 / App WebView 的 <img> 请求）
     * ========================================================== */

    /** 文件名 → 掩码：Cookie 里不出现完整 sha256（避免 Cookie 体积与信息泄露）。 */
    private static function mask($sha)
    {
        return substr(hash('sha256', 'mask|' . self::secret() . '|' . $sha), 0, 16);
    }

    /** 下发/续期 Cookie（登录态下由上传、列表接口顺手调用）。 */
    public static function touchCookie($sha = '')
    {
        if (headers_sent()) {
            return;
        }
        $now = time();
        $list = array();
        foreach (self::cookieList() as $k => $v) {
            if ((int) $v > $now) {
                $list[$k] = (int) $v;
            }
        }
        $sha = self::validSha($sha);
        if ($sha !== null) {
            $m = self::mask($sha);
            unset($list[$m]);
            $list[$m] = $now + self::COOKIE_TTL;
        }
        // 控体积：超 100 条丢最旧的（同源浏览器渲染几十张图完全够用）
        if (count($list) > 100) {
            $list = array_slice($list, -100, 100, true);
        }
        $parts = array();
        foreach ($list as $k => $v) {
            if (preg_match('/^[0-9a-f]{16}$/', (string) $k)) {
                $parts[] = $k . '_' . (int) $v;
            }
        }
        $val = implode('.', $parts);
        $secure = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== '' && $_SERVER['HTTPS'] !== 'off')
            || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https');
        $cookie = self::COOKIE_NAME . '=' . $val
            . '; Max-Age=' . self::COOKIE_TTL
            . '; Path=/api/user/images'
            . '; SameSite=Lax'
            . '; HttpOnly';
        if ($secure) {
            $cookie .= '; Secure';
        }
        header('Set-Cookie: ' . $cookie, false);
    }

    /** 解析 Cookie 里的 { 掩码: 过期时间 }。 */
    private static function cookieList()
    {
        $out = array();
        $raw = isset($_COOKIE[self::COOKIE_NAME]) ? (string) $_COOKIE[self::COOKIE_NAME] : '';
        if ($raw === '') {
            return $out;
        }
        foreach (explode('.', $raw) as $pair) {
            $pos = strrpos($pair, '_');
            if ($pos === false) {
                continue;
            }
            $k = substr($pair, 0, $pos);
            $v = (int) substr($pair, $pos + 1);
            if (preg_match('/^[0-9a-f]{16}$/', $k) && $v > 0) {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    /** Cookie 是否授权访问这张图（未过期）。 */
    private static function cookieOk($sha)
    {
        $list = self::cookieList();
        $m = self::mask($sha);
        return isset($list[$m]) && (int) $list[$m] > time();
    }

    /* ==========================================================
     * 账号引用集合（谁上传过 / 谁的记录在引用哪张图）
     * ==========================================================
     * 为什么不直接按目录扫：跨账号去重后，文件可能落在「首个写入者」的目录里，
     * 本账号目录是空的 —— 那样 LIST 会漏报，客户端就会重复上传。
     * 引用集合让 LIST 精确，也让 GC 能判断「这张图还有没有人用」。
     * 存储：storage/images/<ownerHash>/refs.json = array('a'=>{sha:1}, 't'=>最后登记时间)
     */
    private static function refsFile($ownerHash)
    {
        return self::ownerDir($ownerHash) . '/refs.json';
    }

    private static function readRefs($ownerHash)
    {
        $file = self::refsFile($ownerHash);
        $raw = is_file($file) ? @file_get_contents($file) : false;
        $arr = is_string($raw) && $raw !== '' ? json_decode($raw, true) : array();
        $a = is_array($arr) && isset($arr['a']) && is_array($arr['a']) ? $arr['a'] : array();
        $t = is_array($arr) && isset($arr['t']) ? (int) $arr['t'] : 0;
        return array('a' => $a, 't' => $t);
    }

    private static function writeRefs($ownerHash, $refs)
    {
        $dir = self::ownerDir($ownerHash);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
            return false;
        }
        $file = self::refsFile($ownerHash);
        $tmp = $file . '.' . getmypid() . '.tmp';
        $json = json_encode($refs, JSON_UNESCAPED_SLASHES);
        if ($json === false || @file_put_contents($tmp, $json) === false) {
            @unlink($tmp);
            return false;
        }
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
            return false;
        }
        return true;
    }

    /** 该账号是否「用过」这张图（收图 / 登记过引用）。 */
    public static function referencedBy($ownerHash, $sha)
    {
        $s = self::validSha($sha);
        if ($s === null) {
            return false;
        }
        $refs = self::readRefs($ownerHash);
        return isset($refs['a'][$s]);
    }

    /** 登记一条引用（幂等）。 */
    public static function refAdd($ownerHash, $sha)
    {
        $s = self::validSha($sha);
        if ($s === null) {
            return false;
        }
        $refs = self::readRefs($ownerHash);
        if (isset($refs['a'][$s])) {
            return true;
        }
        $refs['a'][$s] = 1;
        $refs['t'] = time();
        return self::writeRefs($ownerHash, $refs);
    }

    /* ==========================================================
     * LIST / 回收
     * ========================================================== */

    /**
     * 列出本账号已托管的图片（供客户端做「本地有、云端没有」差异比对）。
     * 数据来源 = 引用集合 ∪ 目录扫描（两者互补：一份防漏报，一份防 refs.json 丢失）。
     *
     * @return array array('ok'=>bool,'hashes'=>array,'count'=>int)
     */
    public static function listHashes($me)
    {
        $ownerHash = self::ownerHash($me['email']);
        $out = array();

        $refs = self::readRefs($ownerHash);
        foreach ($refs['a'] as $sha => $one) {
            if (self::validSha($sha) !== null) {
                $out[$sha] = true;
            }
            if (count($out) >= self::LIST_LIMIT) {
                break;
            }
        }

        $root = self::ownerDir($ownerHash);
        if (is_dir($root) && count($out) < self::LIST_LIMIT) {
            $subs = @scandir($root);
            if (is_array($subs)) {
                foreach ($subs as $sub) {
                    if ($sub === '.' || $sub === '..' || !is_dir($root . '/' . $sub)) {
                        continue;
                    }
                    $files = @scandir($root . '/' . $sub);
                    if (!is_array($files)) {
                        continue;
                    }
                    foreach ($files as $f) {
                        if (preg_match('/^([0-9a-f]{64})\.[a-z0-9]+$/', $f, $m)) {
                            $out[$m[1]] = true;
                        }
                        if (count($out) >= self::LIST_LIMIT) {
                            break 2;
                        }
                    }
                }
            }
        }
        return array('ok' => true, 'hashes' => array_keys($out), 'count' => count($out));
    }

    /**
     * 回收：删除本账号「已不再被引用」的图（手动触发，界面上是「清理云端冗余图片」）。
     *
     * 判断一张图能不能删（三重保险，任一条不满足就不删）：
     *   ① 只处理**本账号**登记过的 sha256（别的账号的图绝不碰）；
     *   ② 调用方传来 `$referenced`（本机所有记录仍在引用的 sha256）命中 → 保留；
     *   ③ 全站索引里记着的「首个写入者」是别的账号 → 说明别的账号也在用这份字节 → 保留。
     * `$referenced` 必须是数组（哪怕是空数组 = 本机确实没有任何引用）——
     * 不传 / 传错类型一律拒绝执行，避免「没给清单的回收」误删。
     *
     * @return array array('ok'=>bool,'deleted'=>int,'kept'=>int,'skipped'=>int,'error'=>string)
     */
    public static function gc($me, $referenced)
    {
        if (!is_array($referenced)) {
            return array('ok' => false, 'error' => '必须传 referenced（本机在用图片的 sha256 列表）');
        }
        $keep = array();
        foreach ($referenced as $r) {
            $s = self::validSha($r);
            if ($s !== null) {
                $keep[$s] = true;
            }
        }
        $ownerHash = self::ownerHash($me['email']);
        $refs = self::readRefs($ownerHash);
        $idx = self::readIndex();
        $deleted = 0;
        $kept = 0;
        $skipped = 0;
        $touched = false;

        foreach (array_keys($refs['a']) as $sha) {
            $sha = (string) $sha;
            if (self::validSha($sha) === null) {
                unset($refs['a'][$sha]);
                $touched = true;
                continue;
            }
            if (isset($keep[$sha])) {
                $kept++;
                continue;
            }
            if (isset($idx[$sha]) && (string) $idx[$sha] !== (string) $ownerHash) {
                $skipped++; // 别的账号也在用这份字节：删了会砸别人的图
                continue;
            }
            $removedBytes = false;
            foreach (array('jpg', 'png', 'webp', 'gif', 'bmp', 'ico') as $e) {
                $p = self::ownerDir($ownerHash) . '/' . substr($sha, 0, 2) . '/' . $sha . '.' . $e;
                if (is_file($p) && @unlink($p)) {
                    $removedBytes = true;
                }
            }
            unset($refs['a'][$sha]);
            if (isset($idx[$sha])) {
                unset($idx[$sha]);
            }
            $touched = true;
            if ($removedBytes) {
                $deleted++;
            } else {
                $skipped++; // 文件已在别处（跨账号去重），不算删除
            }
        }
        if ($touched) {
            $refs['t'] = time();
            self::writeRefs($ownerHash, $refs);
            self::writeIndex($idx);
            // 清掉空的两级目录（只删空目录，绝不递归删有内容的）
            $root = self::ownerDir($ownerHash);
            foreach ((array) glob($root . '/*', GLOB_ONLYDIR) as $d) {
                @rmdir($d);
            }
        }
        return array('ok' => true, 'deleted' => $deleted, 'kept' => $kept, 'skipped' => $skipped);
    }
}