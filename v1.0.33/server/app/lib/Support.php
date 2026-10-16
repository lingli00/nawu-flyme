<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * 通用工具函数（PHP 7.2 ~ 8.0 通用，无任何第三方依赖）
 */

if (!function_exists('flyme_json')) {

    // MySQL 的 DATETIME 是按「服务端时区」读出来的（Node 版 mysql2 也是这么解析的）。
    // 这里保证 PHP 有明确的时区，避免 strtotime 把时间按 UTC 解释后差 8 小时。
    if (!ini_get('date.timezone')) {
        date_default_timezone_set('Asia/Shanghai');
    }

    /** 输出 JSON 并结束请求 */
    function flyme_json($data, $code = 200)
    {
        if (!headers_sent()) {
            http_response_code($code);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    function flyme_ok($extra = null)
    {
        $out = array('ok' => true);
        if (is_array($extra)) {
            $out = array_merge($out, $extra);
        }
        flyme_json($out);
    }

    function flyme_fail($msg, $code = 400)
    {
        flyme_json(array('ok' => false, 'error' => $msg), $code);
    }

    /** 读取并解析 JSON 请求体 */
    function flyme_body()
    {
        static $cache = null;
        if ($cache !== null) {
            return $cache;
        }
        $raw = '';
        $fh  = fopen('php://input', 'rb');
        if ($fh) {
            while (!feof($fh)) {
                $chunk = fread($fh, 262144);
                if ($chunk === false) {
                    break;
                }
                $raw .= $chunk;
                if (strlen($raw) > 32 * 1024 * 1024) {
                    break; // 32MB 上限
                }
            }
            fclose($fh);
        }
        $raw = trim($raw);
        if ($raw === '') {
            $cache = array();
            return $cache;
        }
        $data = json_decode($raw, true);
        $cache = is_array($data) ? $data : array();
        return $cache;
    }

    function flyme_param($key, $default = null)
    {
        $body = flyme_body();
        return array_key_exists($key, $body) ? $body[$key] : $default;
    }

    function flyme_str($v, $limit = 0)
    {
        if ($v === null || $v === true || $v === false) {
            return '';
        }
        if (is_array($v)) {
            $v = json_encode($v, JSON_UNESCAPED_UNICODE);
        }
        $s = trim((string) $v);
        if ($limit > 0) {
            $s = substr($s, 0, $limit);
        }
        return $s;
    }

    function flyme_int($v, $default = 0)
    {
        return (int) (is_numeric($v) ? $v : $default);
    }

    function flyme_sha256($text)
    {
        return hash('sha256', (string) $text);
    }

    /** 与 Node 版 server.cjs 完全一致的口令哈希，保证已有账号可直接迁移。
     *  ⚠️ 仅保留用于「旧哈希校验 + 透明迁移」，新口令一律走 flyme_pw_hash()（bcrypt）。 */
    function flyme_hash_password($password, $salt)
    {
        return hash('sha256', $salt . $password . $salt);
    }

    /* ---------------- 口令哈希（v1.0.33 安全修复：SHA-256 → bcrypt） ----------------
     * 新哈希以 "$2y$" 开头可直接被 password_verify 识别；
     * 旧库里的 64 位十六进制 SHA-256 哈希仍可校验，校验通过后由调用方
     * 透明升级为 bcrypt（见 flyme_pw_needs_upgrade）。 */

    function flyme_pw_hash($password)
    {
        return password_hash((string) $password, PASSWORD_BCRYPT);
    }

    function flyme_pw_is_bcrypt($hash)
    {
        return is_string($hash) && isset($hash[0]) && $hash[0] === '$' && strlen($hash) >= 50;
    }

    /** 校验口令：自动识别 bcrypt 新哈希与旧 SHA-256 哈希 */
    function flyme_pw_verify($password, $hash, $salt = '')
    {
        if (flyme_pw_is_bcrypt($hash)) {
            return password_verify((string) $password, $hash);
        }
        if (is_string($hash) && is_string($salt) && $salt !== '') {
            return hash_equals($hash, flyme_hash_password($password, $salt));
        }
        return false;
    }

    /** 旧格式（或成本值变化）返回 true，提示调用方重新哈希并落库 */
    function flyme_pw_needs_upgrade($hash)
    {
        return !flyme_pw_is_bcrypt($hash);
    }

    function flyme_random_hex($bytes = 24)
    {
        if (function_exists('random_bytes')) {
            try {
                return bin2hex(random_bytes($bytes));
            } catch (Exception $e) {
                /* 落到下面的兜底实现 */
            }
        }
        $s = '';
        for ($i = 0; $i < $bytes * 2; $i++) {
            $s .= dechex(mt_rand(0, 15));
        }
        return $s;
    }

    function flyme_valid_email($email)
    {
        return (bool) preg_match('/^[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}$/', (string) $email);
    }

    /** 取 Bearer / X-Admin-Token */
    function flyme_bearer()
    {
        // 优先 X-Admin-Token（管理后台专用），再回落 Bearer —— 与 Node 版一致
        if (isset($_SERVER['HTTP_X_ADMIN_TOKEN'])) {
            $v = trim($_SERVER['HTTP_X_ADMIN_TOKEN']);
            if ($v !== '') {
                return $v;
            }
        }
        if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
            $v = trim(preg_replace('/^Bearer\s+/i', '', $_SERVER['HTTP_AUTHORIZATION']));
            if ($v !== '') {
                return $v;
            }
        }
        if (isset($_SERVER['HTTP_X_ADMIN_TOKEN'])) {
            $v = trim($_SERVER['HTTP_X_ADMIN_TOKEN']);
            if ($v !== '') {
                return $v;
            }
        }
        // 部分环境会把 REDIRECT_ 前缀加进来
        if (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
            $v = trim(preg_replace('/^Bearer\s+/i', '', $_SERVER['REDIRECT_HTTP_AUTHORIZATION']));
            if ($v !== '') {
                return $v;
            }
        }
        return null;
    }

    function flyme_method()
    {
        return strtoupper(isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET');
    }

    /** ISO8601 时间字符串（兼容老写法，不使用 PHP 8 新增的常量） */
    function flyme_iso($v)
    {
        if ($v === null || $v === '') {
            return null;
        }
        $t = is_numeric($v) ? (int) $v : strtotime((string) $v);
        if (!$t) {
            return null;
        }
        return gmdate('Y-m-d\TH:i:s.v\Z', $t);
    }

    /** 毫秒级 JS Date.now() */
    function flyme_now_ms()
    {
        return (int) round(microtime(true) * 1000);
    }

    /**
     * 把 PDO 抛出的英文错误翻译成人话提示（MySQL/SQLSTATE 常见码）
     * @return string 附加中文提示；识别不出时返回空串
     */
    function flyme_db_hint($msg)
    {
        $m = (string) $msg;
        if (strpos($m, '2002') !== false || stripos($m, 'timed out') !== false || strpos($m, '2003') !== false) {
            return '连不上数据库主机：请确认地址与端口正确、服务器防火墙放行了该端口、MySQL 侧允许当前来源 IP 访问。';
        }
        if (strpos($m, '1045') !== false || stripos($m, 'Access denied') !== false) {
            return '用户名或密码错误，或者该账号不允许从这个地址登录（需要在 MySQL 里给账号授权对应来源 IP）。';
        }
        if (strpos($m, '1049') !== false || stripos($m, 'Unknown database') !== false) {
            return '找不到这个数据库：请确认库名拼写，或先在 MySQL 里把库建好再来安装。';
        }
        if (strpos($m, '1044') !== false || strpos($m, '1142') !== false) {
            return '当前账号没有操作该数据库的权限。';
        }
        if (stripos($m, 'could not find driver') !== false) {
            return 'PHP 缺少 pdo_mysql 扩展，请在宝塔的 PHP 设置里安装它。';
        }
        return '';
    }

    function flyme_mask_secret($s, $keep = 2)
    {
        $s = (string) $s;
        if ($s === '') {
            return '';
        }
        return substr($s, 0, $keep) . '***';
    }

    function flyme_mime($ext)
    {
        static $map = array(
            'html'  => 'text/html; charset=utf-8',
            'htm'   => 'text/html; charset=utf-8',
            'js'    => 'application/javascript; charset=utf-8',
            'mjs'   => 'application/javascript; charset=utf-8',
            'css'   => 'text/css; charset=utf-8',
            'json'  => 'application/json; charset=utf-8',
            'map'   => 'application/json; charset=utf-8',
            'svg'   => 'image/svg+xml',
            'png'   => 'image/png',
            'jpg'   => 'image/jpeg',
            'jpeg'  => 'image/jpeg',
            'gif'   => 'image/gif',
            'webp'  => 'image/webp',
            'ico'   => 'image/x-icon',
            'woff'  => 'font/woff',
            'woff2' => 'font/woff2',
            'ttf'   => 'font/ttf',
            'txt'   => 'text/plain; charset=utf-8',
        );
        return isset($map[$ext]) ? $map[$ext] : null;
    }

    /* ---------------- 暴力破解防护（v1.0.33 安全修复） ----------------
     * 计数落在 flyme_throttle 表（GF_Schema::ensureThrottleTable() 惰性建表）。
     * 表不可用（如无 DDL 权限）时放行并记错误日志 —— 可用性优先，安装向导
     * 正常走完后表一定存在。 */

    /** 取客户端 IP（不信任 X-Forwarded-For，避免伪造绕过限速） */
    function flyme_client_ip()
    {
        $ip = isset($_SERVER['REMOTE_ADDR']) ? trim((string) $_SERVER['REMOTE_ADDR']) : '';
        if (!filter_var($ip, FILTER_VALIDATE_IP)) {
            $ip = '0.0.0.0';
        }
        return $ip;
    }

    /**
     * 检查某 scope+ident 当前是否被允许继续尝试。
     * @return array array(true) 放行 | array(false, 需等待秒数)
     */
    function flyme_throttle_check($scope, $ident, $maxHits, $windowSec)
    {
        try {
            GF_Schema::ensureThrottleTable();
            $row = GF_Db::one(
                'SELECT `hits`, `window_start`, `locked_until` FROM `flyme_throttle` WHERE `scope` = ? AND `ident` = ? LIMIT 1',
                array($scope, (string) $ident)
            );
        } catch (Exception $e) {
            error_log('[nawu-throttle] check failed: ' . $e->getMessage());
            return array(true);
        }
        $now = flyme_now_ms();
        if (!$row) {
            return array(true);
        }
        if ((int) $row['locked_until'] > $now) {
            return array(false, (int) ceil(((int) $row['locked_until'] - $now) / 1000));
        }
        if ((int) $row['window_start'] < $now - (int) $windowSec * 1000) {
            return array(true); // 窗口已过期，视为干净
        }
        if ((int) $row['hits'] >= (int) $maxHits) {
            return array(false, (int) ceil(((int) $row['window_start'] + (int) $windowSec * 1000 - $now) / 1000));
        }
        return array(true);
    }

    /** 记录一次失败；达到上限则锁定 $lockSec 秒 */
    function flyme_throttle_fail($scope, $ident, $maxHits, $windowSec, $lockSec = 900)
    {
        $now = flyme_now_ms();
        try {
            GF_Schema::ensureThrottleTable();
            GF_Db::q(
                'INSERT INTO `flyme_throttle` (`scope`, `ident`, `hits`, `window_start`, `locked_until`)
                 VALUES (?, ?, 1, ?, 0)
                 ON DUPLICATE KEY UPDATE
                    `hits` = IF(`window_start` < ? - ?, 1, `hits` + 1),
                    `window_start` = IF(`window_start` < ? - ?, ?, `window_start`),
                    `locked_until` = IF(`hits` >= ?, ? + ?, 0)',
                array(
                    $scope, (string) $ident, $now,
                    $now, (int) $windowSec * 1000,
                    $now, (int) $windowSec * 1000, $now,
                    (int) $maxHits,
                    $now, (int) $lockSec * 1000,
                )
            );
        } catch (Exception $e) {
            error_log('[nawu-throttle] fail record failed: ' . $e->getMessage());
        }
    }

    /** 成功登录 / 验证码通过后清零计数 */
    function flyme_throttle_clear($scope, $ident)
    {
        try {
            GF_Schema::ensureThrottleTable();
            GF_Db::q('DELETE FROM `flyme_throttle` WHERE `scope` = ? AND `ident` = ?', array($scope, (string) $ident));
        } catch (Exception $e) {
            /* 忽略：清理失败不影响主流程 */
        }
    }

    /* ---------------- SSRF 防护（v1.0.33 安全修复） ----------------
     * 判定「IP 是否为可放行的公网地址」：私有段 / 保留段 / 链路本地 /
     * CGNAT（含 100.100.100.200 云元数据）/ IPv6 ULA·链路本地·映射地址
     * 一律拒绝。十进制 / 十六进制 / 八进制 / inet_aton 简写等伪装形式
     * 先归一化成点分十进制再判定。 */

    /** 把各种 IPv4 写法（2130706433 / 0x7f000001 / 017700000001 / 127.1）归一化 */
    function flyme_normalize_ipv4($host)
    {
        $host = trim((string) $host);
        if ($host === '') {
            return null;
        }
        if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return $host;
        }
        $val = null;
        if (preg_match('/^\d+$/', $host)) {                       // 2130706433
            $val = (float) $host;
        } elseif (preg_match('/^0[xX][0-9a-fA-F]+$/', $host)) {   // 0x7f000001
            $val = (float) hexdec(substr($host, 2));
        } elseif (preg_match('/^0[0-7]+$/', $host)) {             // 017700000001
            $val = (float) octdec($host);
        } elseif (preg_match('/^(\d{1,3})(?:\.(\d{1,3})){0,3}$/', $host, $m)) {
            $parts = array();
            for ($i = 1; $i <= 4; $i++) {
                if (!isset($m[$i]) || $m[$i] === '') {
                    break;
                }
                $p = (int) $m[$i];
                if ($p > 255) {
                    return null;
                }
                $parts[] = $p;
            }
            $n = count($parts);
            if ($n === 1) {
                $val = $parts[0];
            } elseif ($n === 2) {
                $val = $parts[0] * 16777216 + $parts[1];
            } elseif ($n === 3) {
                $val = $parts[0] * 16777216 + $parts[1] * 65536 + $parts[2];
            } else {
                $val = $parts[0] * 16777216 + $parts[1] * 65536 + $parts[2] * 256 + $parts[3];
            }
        }
        if ($val === null || $val < 0 || $val > 4294967295) {
            return null;
        }
        return sprintf('%d.%d.%d.%d', ((int) $val >> 24) & 255, ((int) $val >> 16) & 255, ((int) $val >> 8) & 255, (int) $val & 255);
    }

    function flyme_ipv4_in_cidr($long, $cidr)
    {
        $parts = explode('/', $cidr);
        if (count($parts) !== 2) {
            return false;
        }
        $subLong = ip2long(trim($parts[0]));
        $bits    = (int) trim($parts[1]);
        if ($subLong === false || $bits < 0 || $bits > 32) {
            return false;
        }
        $long    = (int) $long;
        $subLong = (int) $subLong;
        if ($long < 0) {
            $long += 4294967296;
        }
        if ($subLong < 0) {
            $subLong += 4294967296;
        }
        $mask = $bits === 0 ? 0 : ((0xFFFFFFFF << (32 - $bits)) & 0xFFFFFFFF);
        return (($long & $mask) === ($subLong & $mask));
    }

    function flyme_ipv6_in_cidr($ip, $cidr)
    {
        $parts = explode('/', $cidr);
        if (count($parts) !== 2) {
            return false;
        }
        $bits  = (int) trim($parts[1]);
        $bin1  = @inet_pton($ip);
        $bin2  = @inet_pton(trim($parts[0]));
        if ($bits < 0 || $bits > 128 || $bin1 === false || $bin2 === false
            || strlen($bin1) !== 16 || strlen($bin2) !== 16) {
            return false;
        }
        $fullBytes = (int) ($bits / 8);
        $remBits   = $bits % 8;
        if ($fullBytes > 0 && strncmp(substr($bin1, 0, $fullBytes), substr($bin2, 0, $fullBytes), $fullBytes) !== 0) {
            return false;
        }
        if ($remBits > 0) {
            $mask = (0xFF << (8 - $remBits)) & 0xFF;
            if ((ord($bin1[$fullBytes]) & $mask) !== (ord($bin2[$fullBytes]) & $mask)) {
                return false;
            }
        }
        return true;
    }

    /** 公网 IP 才返回 true */
    function flyme_ip_is_public($ip)
    {
        $ip = strtolower(trim((string) $ip));
        if ($ip === '') {
            return false;
        }
        $ip = trim($ip, '[]');

        if (strpos($ip, ':') !== false) {
            // IPv4-mapped（::ffff:127.0.0.1 / ::ffff:7f00:1）→ 解包后按 IPv4 判
            if (preg_match('/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/', $ip, $m)) {
                return flyme_ip_is_public($m[1]);
            }
            if (preg_match('/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/', $ip, $m)) {
                $long = (hexdec($m[1]) << 16) | hexdec($m[2]);
                return flyme_ip_is_public(sprintf('%d.%d.%d.%d', ($long >> 24) & 255, ($long >> 16) & 255, ($long >> 8) & 255, $long & 255));
            }
            $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
            if (!filter_var($ip, FILTER_VALIDATE_IP, $flags)) {
                return false;
            }
            $bad6 = array(
                '::', '::1', 'ff00::/8', 'fe80::/10', 'fc00::/7', '::ffff:0:0/96',
                '64:ff9b::/96', '100::/64', '2001:db8::/32', '2002::/16',
            );
            foreach ($bad6 as $net) {
                if (strpos($net, '/') !== false) {
                    if (flyme_ipv6_in_cidr($ip, $net)) {
                        return false;
                    }
                } elseif ($ip === $net) {
                    return false;
                }
            }
            return true;
        }

        $norm = flyme_normalize_ipv4($ip);
        if ($norm === null) {
            return false;
        }
        $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
        if (!filter_var($norm, FILTER_VALIDATE_IP, $flags)) {
            return false;
        }
        $long = ip2long($norm);
        if ($long === false) {
            return false;
        }
        $bad4 = array(
            '100.64.0.0/10',    // CGNAT（含阿里云元数据 100.100.100.200）
            '168.254.0.0/16',   // 部分云环境元数据别名
            '192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15',
            '198.51.100.0/24', '203.0.113.0/24',
        );
        foreach ($bad4 as $net) {
            if (flyme_ipv4_in_cidr($long, $net)) {
                return false;
            }
        }
        return true;
    }

    /** 出站 URL 的 SSRF 体检：协议/端口/内嵌凭据/IP 段/DNS 解析全部通过才放行 */
    function flyme_ssrf_check_url($url)
    {
        if (!is_string($url) || $url === '' || strlen($url) > 2048) {
            return false;
        }
        $p = parse_url($url);
        if (!is_array($p) || empty($p['scheme']) || empty($p['host'])) {
            return false;
        }
        if (!preg_match('#^https?$#i', $p['scheme'])) {
            return false;
        }
        if (isset($p['user']) || isset($p['pass'])) {
            return false; // 拒绝 http://user:pass@host 形式
        }
        $port = isset($p['port']) ? (int) $p['port'] : (strtolower($p['scheme']) === 'https' ? 443 : 80);
        if ($port <= 0 || $port > 65535) {
            return false;
        }
        // 只放行常见 Web 端口，挡掉探内网 Redis/MySQL/SSH 等旁路
        $allowedPorts = array(80, 443, 8080, 8443, 3030, 2222);
        if (!in_array($port, $allowedPorts, true)) {
            return false;
        }
        $host = strtolower(trim((string) $p['host'], '[]'));

        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return flyme_ip_is_public($host);
        }
        if (strpos($host, ':') !== false) {
            return flyme_ip_is_public($host); // IPv6 字面量
        }
        $norm = flyme_normalize_ipv4($host);
        if ($norm !== null) {
            return flyme_ip_is_public($norm); // 十进制/十六进制 IP 伪装成「域名」
        }

        // 域名：A / AAAA 全部解析结果都必须落在公网段
        $ips = array();
        if (function_exists('dns_get_record')) {
            $types = DNS_A;
            if (defined('DNS_AAAA')) {
                $types += DNS_AAAA;
            }
            $recs = @dns_get_record($host, $types);
            if (is_array($recs)) {
                foreach ($recs as $r) {
                    if (isset($r['ip']) && filter_var($r['ip'], FILTER_VALIDATE_IP)) {
                        $ips[] = $r['ip'];
                    }
                    if (isset($r['ipv6']) && filter_var($r['ipv6'], FILTER_VALIDATE_IP)) {
                        $ips[] = $r['ipv6'];
                    }
                }
            }
        }
        if (!$ips) {
            $ip = gethostbyname($host);
            if ($ip !== $host && filter_var($ip, FILTER_VALIDATE_IP)) {
                $ips[] = $ip;
            }
        }
        if (!$ips) {
            return false; // 解析失败 → 不放行
        }
        foreach ($ips as $ip) {
            if (!flyme_ip_is_public($ip)) {
                return false;
            }
        }
        return true;
    }
}
