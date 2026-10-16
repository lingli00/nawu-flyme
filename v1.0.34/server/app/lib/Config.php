<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * 站点配置读写
 *
 * 安装向导把配置落盘到 storage/config.php（PHP 数组格式，不可通过 URL 直接读出内容）。
 * 管理后台「数据库」页可在线修改数据库参数，改动会即时写回同一个文件。
 */

class GF_Config
{
    const FILE = '/storage/config.php';
    const TMP  = '/storage/.install.tmp';

    private static $data = null;

    /** 已安装 => 配置数组；未安装 => null */
    public static function load()
    {
        if (self::$data !== null) {
            return self::$data;
        }
        $file = GF_ROOT . self::FILE;
        if (!is_file($file)) {
            self::$data = false;
            return false;
        }
        $arr = @include $file;
        if (!is_array($arr) || empty($arr['installed'])) {
            self::$data = false;
            return false;
        }
        self::$data = $arr;
        return $arr;
    }

    public static function installed()
    {
        return self::load() !== false;
    }

    public static function get($key, $default = null)
    {
        $c = self::load();
        if (!is_array($c)) {
            return $default;
        }
        return isset($c[$key]) ? $c[$key] : $default;
    }

    /** 数据库连接参数 */
    public static function db()
    {
        $c = self::load();
        $db = (is_array($c) && isset($c['db']) && is_array($c['db'])) ? $c['db'] : array();
        return array_merge(array(
            'host'    => '127.0.0.1',
            'port'    => 3306,
            'user'    => '',
            'pass'    => '',
            'name'    => '',
            'charset' => 'utf8mb4',
        ), $db);
    }

    /** SPA 首页 HTML */
    public static function spaHtml()
    {
        $file = GF_ROOT . '/app/spa-index.html';
        $html = @file_get_contents($file);
        if ($html === false) {
            $html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>纳物</title></head>'
                . '<body><div id="root"></div><p style="font:14px/1.8 sans-serif;padding:24px">'
                . '前端资源缺失：请确认 app/spa-index.html 与 assets/ 目录已完整上传。</p></body></html>';
        }
        return $html;
    }

    /** 格式化写出配置文件 */
    public static function write($arr)
    {
        $file = GF_ROOT . self::FILE;
        $dir  = dirname($file);
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        $export = self::exportArray($arr);
        // 顶部加一道闸门：万一 Nginx 的 deny 规则没配上，直接访问这个文件也只会得到 403
        $php = "<?php\n"
            . "if (!defined('GF_ROOT')) {\n    http_response_code(403);\n    exit;\n}\n\n"
            . "/**\n * 纳物 · 运行配置（由安装向导自动生成，请勿手工修改格式）\n"
            . " * 生成时间：" . date('Y-m-d H:i:s') . "\n */\n\n"
            . "return " . $export . ";\n";

        $tmp = $file . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $php) === false) {
            return '配置文件写入失败：storage 目录不可写，请把目录权限设为 755（或属主设为 PHP 运行用户）';
        }
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
            return '配置文件替换失败：请检查 storage 目录权限';
        }
        // v1.0.33 安全修复：600 → 仅属主可读写（库里躺着 DB 口令与 SMTP 授权码）
        @chmod($file, 0600);
        self::$data = null;
        return true;
    }

    /** 在线更新数据库参数（管理后台用），口令留空表示沿用旧值 */
    public static function saveDb($new)
    {
        $c = self::load();
        if (!is_array($c)) {
            $c = array('installed' => true, 'installed_at' => date('Y-m-d H:i:s'), 'secret' => flyme_random_hex(16));
        }
        $db = self::db();
        foreach (array('host', 'port', 'user', 'name', 'charset') as $k) {
            if (isset($new[$k]) && (string) $new[$k] !== '') {
                $db[$k] = $new[$k];
            }
        }
        $db['port'] = (int) $db['port'];
        if (!empty($new['pass'])) {
            $db['pass'] = $new['pass'];
        }
        $c['db'] = $db;
        return self::write($c);
    }

    public static function remove()
    {
        $file = GF_ROOT . self::FILE;
        if (is_file($file)) {
            @unlink($file);
        }
        self::$data = null;
    }

    /* ---------------- 安装过程中的临时状态 ---------------- */

    public static function saveTmp($arr)
    {
        $file = GF_ROOT . self::TMP;
        @mkdir(dirname($file), 0755, true);
        // JSON_INVALID_UTF8_SUBSTITUTE：请求里混入非 UTF-8 字节时不要让整个状态文件写空
        $flags = JSON_UNESCAPED_UNICODE;
        if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
            $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
        }
        $json = json_encode($arr, $flags);
        if ($json === false) {
            $json = json_encode($arr); // 退化为 \uXXXX 转义
        }
        if ($json === false) {
            return false;
        }
        // v1.0.33 安全修复：排他锁串行化写入，防止两个浏览器同时安装时状态文件被写花
        $fp = @fopen($file, 'c');
        if (!$fp) {
            return @file_put_contents($file, $json);
        }
        $ok = false;
        if (flock($fp, LOCK_EX)) {
            ftruncate($fp, 0);
            fwrite($fp, $json);
            fflush($fp);
            flock($fp, LOCK_UN);
            $ok = true;
        }
        fclose($fp);
        @chmod($file, 0600);
        return $ok;
    }

    public static function loadTmp()
    {
        $file = GF_ROOT . self::TMP;
        if (!is_file($file)) {
            return array();
        }
        $raw = false;
        $fp  = @fopen($file, 'r');
        if ($fp) {
            if (flock($fp, LOCK_SH)) {
                $raw = stream_get_contents($fp);
                flock($fp, LOCK_UN);
            } else {
                $raw = stream_get_contents($fp);
            }
            fclose($fp);
        }
        if ($raw === false || $raw === '') {
            $raw = @file_get_contents($file);
        }
        $d = json_decode((string) $raw, true);
        return is_array($d) ? $d : array();
    }

    public static function clearTmp()
    {
        $file = GF_ROOT . self::TMP;
        if (is_file($file)) {
            @unlink($file);
        }
    }

    /** 数组 → 可读的 PHP 字面量（便于人工检查） */
    private static function exportArray($arr, $indent = 0)
    {
        $pad1 = str_repeat('    ', $indent + 1);
        $pad0 = str_repeat('    ', $indent);
        $lines = array();
        $isList = true;
        $i = 0;
        foreach ($arr as $k => $v) {
            if ($k !== $i) {
                $isList = false;
                break;
            }
            $i++;
        }
        foreach ($arr as $k => $v) {
            $key = $isList ? '' : self::exportKey($k) . ' => ';
            if (is_array($v)) {
                $lines[] = $pad1 . $key . self::exportArray($v, $indent + 1);
            } elseif (is_bool($v)) {
                $lines[] = $pad1 . $key . ($v ? 'true' : 'false');
            } elseif (is_int($v) || is_float($v)) {
                $lines[] = $pad1 . $key . $v;
            } elseif ($v === null) {
                $lines[] = $pad1 . $key . 'null';
            } else {
                $lines[] = $pad1 . $key . "'" . self::escape((string) $v) . "'";
            }
        }
        if (count($lines) === 0) {
            return 'array()';
        }
        return "array(\n" . implode(",\n", $lines) . "\n" . $pad0 . ')';
    }

    private static function exportKey($k)
    {
        // 一律加引号：PHP 8 会把裸字符串键当成「未定义常量」直接抛 Error，
        // PHP 7 虽然能降级成字符串但会报 Notice，两种都不该出现。
        return "'" . self::escape((string) $k) . "'";
    }

    private static function escape($s)
    {
        return str_replace(array('\\', "'"), array('\\\\', "\\'"), $s);
    }
}
