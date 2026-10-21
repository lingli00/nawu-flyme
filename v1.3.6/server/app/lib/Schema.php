<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * 表结构定义与初始化
 *
 * 与 Node 版 server.cjs 的 DDL 一一对应，另外为了适配 PHP-FPM 多进程模型，
 * 新增一张 flyme_admin_sessions 存管理员会话（Node 版是放在进程内存里的，
 * PHP-FPM 下每个请求是独立进程，不能沿用）。
 *
 * MySQL 5.5 约束：每张表最多只能有 1 个「自动初始化/更新」的 TIMESTAMP 列。
 */

require_once dirname(__FILE__) . '/Support.php';
require_once dirname(__FILE__) . '/Db.php';

class GF_Schema
{
    /** 全部默认开关项 */
    public static function defaultSettings()
    {
        return array(
            'siteClosed'      => 'false',
            'allowRegister'   => 'true',
            'allowLogin'      => 'true',
            'requireVerified' => 'true',
            // ★v1.3.3：featAi / featOcr 已删除（旧版「AI 记一笔 / 识图添加」独立入口下线），
            // 已有的旧库行留着无害，但不再作为默认项下发，也不再被任何界面读取。
            'featShare'       => 'true',
            'featWall'        => 'true',
            'featSync'        => 'true',
            'notice'          => '',
            'siteName'        => '',
            'siteIcon'        => '',
            'smtpJson'        => '',
        );
    }

    public static function ddl()
    {
        return array(
            // ---- 历史遗留表（保留结构，v3.7 起不再读写，方便旧备份核对）----
            "CREATE TABLE IF NOT EXISTS `app_rows` (
                `id` VARCHAR(64) NOT NULL,
                `collection` VARCHAR(64) NOT NULL,
                `data` LONGTEXT NOT NULL,
                `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (`id`, `collection`),
                KEY `idx_collection` (`collection`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `app_kv` (
                `k` VARCHAR(128) NOT NULL,
                `v` LONGTEXT,
                `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (`k`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `app_meta` (
                `k` VARCHAR(64) NOT NULL,
                `v` VARCHAR(255) DEFAULT NULL,
                PRIMARY KEY (`k`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

            // ---- 管理后台 ----
            "CREATE TABLE IF NOT EXISTS `flyme_admins` (
                `username` VARCHAR(64) NOT NULL,
                `pass_hash` VARCHAR(128) NOT NULL,
                `salt` VARCHAR(64) NOT NULL,
                `display_name` VARCHAR(64) DEFAULT NULL,
                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (`username`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_admin_sessions` (
                `token` VARCHAR(64) NOT NULL,
                `username` VARCHAR(64) NOT NULL,
                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                `expires_at` BIGINT NOT NULL,
                PRIMARY KEY (`token`),
                KEY `idx_adm_sess_user` (`username`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_directory` (
                `owner_id` VARCHAR(96) NOT NULL,
                `display_name` VARCHAR(128) DEFAULT NULL,
                `last_login_at` DATETIME DEFAULT NULL,
                `disabled` TINYINT(1) NOT NULL DEFAULT 0,
                `note` VARCHAR(255) DEFAULT NULL,
                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (`owner_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_admin_settings` (
                `k` VARCHAR(64) NOT NULL,
                `v` LONGTEXT,
                `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (`k`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

            // ---- 用户账号体系 ----
            "CREATE TABLE IF NOT EXISTS `flyme_users` (
                `email` VARCHAR(128) NOT NULL,
                `pass_hash` VARCHAR(128) NOT NULL,
                `salt` VARCHAR(64) NOT NULL,
                `display_name` VARCHAR(64) DEFAULT NULL,
                `verified` TINYINT(1) NOT NULL DEFAULT 0,
                `disabled` TINYINT(1) NOT NULL DEFAULT 0,
                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                `last_login_at` DATETIME DEFAULT NULL,
                PRIMARY KEY (`email`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_sessions` (
                `token` VARCHAR(64) NOT NULL,
                `email` VARCHAR(128) NOT NULL,
                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                `expires_at` BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (`token`),
                KEY `idx_sess_email` (`email`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            // ---- 防暴力破解计数（v1.0.33 安全修复新增）----
            "CREATE TABLE IF NOT EXISTS `flyme_throttle` (
                `scope` VARCHAR(32) NOT NULL,
                `ident` VARCHAR(128) NOT NULL,
                `hits` INT NOT NULL DEFAULT 0,
                `window_start` BIGINT NOT NULL DEFAULT 0,
                `locked_until` BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (`scope`, `ident`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_verify_codes` (
                `email` VARCHAR(128) NOT NULL,
                `purpose` VARCHAR(16) NOT NULL,
                `code_hash` VARCHAR(128) NOT NULL,
                `expires_at` BIGINT NOT NULL,
                PRIMARY KEY (`email`, `purpose`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_backups` (
                `id` INT NOT NULL AUTO_INCREMENT,
                `owner_id` VARCHAR(128) NOT NULL,
                `label` VARCHAR(128) DEFAULT NULL,
                `payload` LONGTEXT,
                `item_count` INT NOT NULL DEFAULT 0,
                `bytes` INT NOT NULL DEFAULT 0,
                `device` VARCHAR(120) DEFAULT NULL,
                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (`id`),
                KEY `idx_bk_owner` (`owner_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_profiles` (
                `owner_id` VARCHAR(128) NOT NULL,
                `display_name` VARCHAR(64) DEFAULT NULL,
                `avatar_url` VARCHAR(2048) DEFAULT NULL,
                `plan` VARCHAR(16) NOT NULL DEFAULT 'free',
                `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (`owner_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS `flyme_user_rules` (
                `owner_id` VARCHAR(128) NOT NULL,
                `payload` MEDIUMTEXT,
                `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (`owner_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        );
    }

    /**
     * 惰性迁移：确保「识别规则」表存在（幂等，可重复执行）
     *
     * 全新安装时由 install() -> ddl() 一并创建；已经装好的站点访问
     * /api/user/rules 时会调用这里补建，无需重装。
     *
     * @return bool
     */
    public static function ensureRulesTable()
    {
        try {
            $pdo = GF_Db::conn();
            if (!$pdo) {
                return false;
            }
            $pdo->exec(
                "CREATE TABLE IF NOT EXISTS `flyme_user_rules` (
                    `owner_id` VARCHAR(128) NOT NULL,
                    `payload` MEDIUMTEXT,
                    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (`owner_id`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
            return true;
        } catch (Exception $e) {
            return false;
        }
    }

    /**
     * 惰性迁移（v1.0.33 安全修复）：确保防爆破计数表存在。
     * 全新安装由 ddl() 创建；老站点在第一次触发限流逻辑时自动补建。
     */
    public static function ensureThrottleTable()
    {
        static $done = false;
        if ($done) {
            return true;
        }
        try {
            $pdo = GF_Db::conn();
            if (!$pdo) {
                return false;
            }
            $pdo->exec(
                "CREATE TABLE IF NOT EXISTS `flyme_throttle` (
                    `scope` VARCHAR(32) NOT NULL,
                    `ident` VARCHAR(128) NOT NULL,
                    `hits` INT NOT NULL DEFAULT 0,
                    `window_start` BIGINT NOT NULL DEFAULT 0,
                    `locked_until` BIGINT NOT NULL DEFAULT 0,
                    PRIMARY KEY (`scope`, `ident`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
            $done = true;
            return true;
        } catch (Exception $e) {
            error_log('[nawu-schema] ensureThrottleTable failed: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * 惰性迁移（v1.0.33 安全修复）：给 flyme_sessions 补 expires_at 列。
     * 老站点升级后第一次读取会话时自动 ALTER；历史行 expires_at=0 表示
     * 「无过期时间」，首次被访问时会补写 30 天有效期。
     */
    public static function ensureSessionsExpires()
    {
        static $done = false;
        if ($done) {
            return true;
        }
        try {
            $pdo = GF_Db::conn();
            if (!$pdo) {
                return false;
            }
            $has = GF_Db::val(
                "SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                 WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'flyme_sessions' AND `COLUMN_NAME` = 'expires_at'",
                array(),
                0
            );
            if (intval($has) === 0) {
                $pdo->exec('ALTER TABLE `flyme_sessions` ADD COLUMN `expires_at` BIGINT NOT NULL DEFAULT 0');
            }
            $done = true;
            return true;
        } catch (Exception $e) {
            error_log('[nawu-schema] ensureSessionsExpires failed: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * 建表 + 写入默认管理员 / 默认开关
     *
     * @param array $admin array('username'=>, 'password'=>, 'display_name'=>)
     * @param bool  $forceCreateAdmin 管理员表为空时是否写入 $admin（false 时不建，留给调用方）
     * @return array array(true, array(日志)) | array(false, 错误)
     */
    public static function install($admin = null, $overwriteAdmin = false)
    {
        GF_Db::reconnect();
        $pdo = GF_Db::conn();
        if (!$pdo) {
            return array(false, GF_Db::error());
        }

        $log = array();
        try {
            foreach (self::ddl() as $sql) {
                $pdo->exec($sql);
                if (preg_match('/^CREATE TABLE IF NOT EXISTS `([^`]+)`/i', $sql, $m)) {
                    $log[] = $m[1];
                }
            }

            $pdo->exec("INSERT INTO `app_meta` (`k`, `v`) VALUES ('schema_version', '2')
                        ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)");

            foreach (self::defaultSettings() as $k => $v) {
                GF_Db::q('INSERT IGNORE INTO `flyme_admin_settings` (`k`, `v`) VALUES (?, ?)', array($k, $v));
            }

            if (is_array($admin) && !empty($admin['username']) && !empty($admin['password'])) {
                $exists = GF_Db::val('SELECT COUNT(*) FROM `flyme_admins`');
                $hasThis = GF_Db::val('SELECT COUNT(*) FROM `flyme_admins` WHERE `username` = ?', array($admin['username']));
                if ($overwriteAdmin) {
                    self::upsertAdmin($admin['username'], $admin['password'], isset($admin['display_name']) ? $admin['display_name'] : '');
                    $log[] = '已写入/更新管理员：' . $admin['username'];
                } elseif (intval($exists) === 0) {
                    self::upsertAdmin($admin['username'], $admin['password'], isset($admin['display_name']) ? $admin['display_name'] : '');
                    $log[] = '已创建管理员：' . $admin['username'];
                } elseif (intval($hasThis) === 0) {
                    $log[] = '管理员表已存在其他账号，未重复创建（可直接用原有账号登录）';
                } else {
                    $log[] = '同名管理员已存在，未改动其密码';
                }
            }

            return array(true, $log);
        } catch (Exception $e) {
            return array(false, $e->getMessage());
        }
    }

    public static function upsertAdmin($username, $password, $displayName = '')
    {
        // v1.0.33 安全修复：新建/重置管理员直接用 bcrypt（salt 列留空，
        // bcrypt 哈希自带盐；旧 SHA-256 行由登录接口透明升级）
        GF_Db::q(
            'INSERT INTO `flyme_admins` (`username`, `pass_hash`, `salt`, `display_name`) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE `pass_hash` = VALUES(`pass_hash`), `salt` = VALUES(`salt`), `display_name` = VALUES(`display_name`)',
            array($username, flyme_pw_hash($password), '', $displayName)
        );
        return true;
    }

    /** 清理过期会话（管理员会话 + 用户会话）与过期的限流计数 */
    public static function gcSessions()
    {
        $now = flyme_now_ms();
        try {
            GF_Db::q('DELETE FROM `flyme_admin_sessions` WHERE `expires_at` < ?', array($now));
        } catch (Exception $e) {
            /* 忽略 */
        }
        try {
            self::ensureSessionsExpires();
            GF_Db::q('DELETE FROM `flyme_sessions` WHERE `expires_at` > 0 AND `expires_at` < ?', array($now));
        } catch (Exception $e) {
            /* 忽略 */
        }
        try {
            GF_Db::q('DELETE FROM `flyme_throttle` WHERE `locked_until` > 0 AND `locked_until` < ? - 86400000', array($now));
        } catch (Exception $e) {
            /* 忽略 */
        }
    }
}
