<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * 站点全局开关 + 用户/管理员会话
 */

require_once dirname(__FILE__) . '/Support.php';
require_once dirname(__FILE__) . '/Db.php';
require_once dirname(__FILE__) . '/Schema.php';

class GF_Auth
{
    const ADMIN_TTL_MS   = 28800000; // 8 小时
    const USER_TOKEN_TTL = 2592000;  // 30 天（滑动续期：每次使用都顺延）
    const CODE_TTL_MS    = 600000;   // 10 分钟
    const CODE_RESEND_MS = 60000;    // 60 秒重发间隔

    /* ---------------- 全局设置（60 秒进程内缓存 + 文件缓存） ---------------- */

    public static function settings($force = false)
    {
        static $cache = null;
        static $cacheAt = 0;
        if (!$force && $cache !== null && (time() - $cacheAt) < 60) {
            return $cache;
        }
        try {
            $rows = GF_Db::rows('SELECT `k`, `v` FROM `flyme_admin_settings`');
            $map  = GF_Schema::defaultSettings();
            foreach ($rows as $r) {
                $map[$r['k']] = $r['v'] === null ? '' : (string) $r['v'];
            }
        } catch (Exception $e) {
            $map = GF_Schema::defaultSettings();
        }
        $cache   = $map;
        $cacheAt = time();
        return $map;
    }

    public static function get($key, $default = '')
    {
        $s = self::settings();
        return isset($s[$key]) ? $s[$key] : $default;
    }

    public static function set($key, $value)
    {
        $map = GF_Schema::defaultSettings();
        if (!isset($map[$key])) {
            return false;
        }
        GF_Db::q(
            'INSERT INTO `flyme_admin_settings` (`k`, `v`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)',
            array($key, (string) $value)
        );
        self::settings(true);
        return true;
    }

    /* ---------------- 用户会话 ---------------- */

    public static function currentUser()
    {
        $token = flyme_bearer();
        if (!$token) {
            return null;
        }
        try {
            GF_Schema::ensureSessionsExpires();
            GF_Schema::gcSessions();
            // expires_at = 0 是升级前的历史行：先放行本次请求，同时补写有效期
            try {
                $sess = GF_Db::one(
                    'SELECT `email`, `expires_at` FROM `flyme_sessions` WHERE `token` = ? LIMIT 1',
                    array($token)
                );
            } catch (Exception $e2) {
                // 极老库且无 DDL 权限（加列失败）：按旧逻辑放行，只是没有过期机制
                $sess = GF_Db::one('SELECT `email` FROM `flyme_sessions` WHERE `token` = ? LIMIT 1', array($token));
                if (is_array($sess)) {
                    $sess['expires_at'] = 0;
                }
            }
            if (!$sess) {
                return null;
            }
            $now = flyme_now_ms();
            $exp = (int) $sess['expires_at'];
            if ($exp > 0 && $exp < $now) {
                GF_Db::q('DELETE FROM `flyme_sessions` WHERE `token` = ?', array($token));
                return null;
            }
            // 滑动续期：活跃用户永不过期，30 天不登录才失效
            if ($exp !== $now + self::USER_TOKEN_TTL * 1000) {
                try {
                    GF_Db::q(
                        'UPDATE `flyme_sessions` SET `expires_at` = ? WHERE `token` = ?',
                        array($now + self::USER_TOKEN_TTL * 1000, $token)
                    );
                } catch (Exception $e3) {
                    /* 老库无该列：跳过续期，不影响本次登录 */
                }
            }
            $u = GF_Db::one(
                'SELECT `email`, `display_name`, `verified`, `disabled` FROM `flyme_users` WHERE `email` = ? LIMIT 1',
                array($sess['email'])
            );
            if (!$u || intval($u['disabled'])) {
                return null;
            }
            return array(
                'email'        => $u['email'],
                'display_name' => $u['display_name'],
                'verified'     => intval($u['verified']) ? true : false,
                'token'        => $token,
            );
        } catch (Exception $e) {
            return null;
        }
    }

    public static function issueUserToken($email)
    {
        $token = flyme_random_hex(24);
        try {
            GF_Db::q(
                'INSERT INTO `flyme_sessions` (`token`, `email`, `expires_at`) VALUES (?, ?, ?)',
                array($token, $email, flyme_now_ms() + self::USER_TOKEN_TTL * 1000)
            );
        } catch (Exception $e) {
            // 老库还没有 expires_at 列（DDL 权限缺失）：退化按旧结构签发
            GF_Db::q('INSERT INTO `flyme_sessions` (`token`, `email`) VALUES (?, ?)', array($token, $email));
        }
        return $token;
    }

    public static function killUserSessions($email)
    {
        GF_Db::q('DELETE FROM `flyme_sessions` WHERE `email` = ?', array($email));
    }

    /* ---------------- 管理员会话 ---------------- */

    public static function currentAdmin()
    {
        $token = flyme_bearer();
        if (!$token) {
            return null;
        }
        try {
            GF_Schema::gcSessions();
            $row = GF_Db::one(
                'SELECT `username`, `expires_at` FROM `flyme_admin_sessions` WHERE `token` = ? LIMIT 1',
                array($token)
            );
            if (!$row) {
                return null;
            }
            $exp = flyme_now_ms() + self::ADMIN_TTL_MS;
            GF_Db::q('UPDATE `flyme_admin_sessions` SET `expires_at` = ? WHERE `token` = ?', array($exp, $token));
            return array('username' => $row['username'], 'token' => $token);
        } catch (Exception $e) {
            return null;
        }
    }

    public static function issueAdminToken($username)
    {
        $token = flyme_random_hex(24);
        GF_Db::q(
            'INSERT INTO `flyme_admin_sessions` (`token`, `username`, `expires_at`) VALUES (?, ?, ?)',
            array($token, $username, flyme_now_ms() + self::ADMIN_TTL_MS)
        );
        return $token;
    }

    public static function killAdminTokens($username)
    {
        GF_Db::q('DELETE FROM `flyme_admin_sessions` WHERE `username` = ?', array($username));
    }
}
