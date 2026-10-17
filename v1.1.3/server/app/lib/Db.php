<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * PDO 数据访问层
 *
 * 专门为 MySQL 5.5 做过取舍：
 *   - 不使用 JSON 字段，行数据一律 LONGTEXT 存序列化字符串
 *   - 不使用 MySQL 5.6+ 才支持的多 TIMESTAMP 自动初始化列
 *   - 不在 SQL 里写不允许的组合，连接后主动把 sql_mode 降到宽松，避免 STRICT 模式下的报错
 */

require_once dirname(__FILE__) . '/Support.php';

class GF_Db
{
    /** @var PDO|null */
    private static $pdo = null;
    /** @var string|null */
    private static $error = null;

    public static function error()
    {
        return self::$error === null ? null : trim(self::$error);
    }

    public static function connected()
    {
        return self::$pdo instanceof PDO;
    }

    /**
     * 用一组参数建立连接（不写全局状态），用于安装向导测试连接
     * @return array array(true) 或 array(false, 错误信息)
     */
    public static function test($conf)
    {
        try {
            $pdo = self::connectPdo($conf);
            $pdo->query('SELECT 1');
            unset($pdo);
            return array(true, '');
        } catch (Exception $e) {
            return array(false, $e->getMessage());
        }
    }

    /** 按站点配置连接（带缓存） */
    public static function conn()
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }
        try {
            self::$pdo = self::connectPdo(GF_Config::db());
            self::$error = null;
        } catch (Exception $e) {
            self::$pdo = null;
            self::$error = $e->getMessage();
            return null;
        }
        return self::$pdo;
    }

    public static function connectPdo($conf)
    {
        $host    = isset($conf['host']) ? $conf['host'] : '127.0.0.1';
        $port    = (int) (isset($conf['port']) ? $conf['port'] : 3306);
        $name    = isset($conf['name']) ? $conf['name'] : '';
        $charset = isset($conf['charset']) ? $conf['charset'] : 'utf8mb4';
        $user    = isset($conf['user']) ? $conf['user'] : '';
        $pass    = isset($conf['pass']) ? $conf['pass'] : '';

        $dsn = 'mysql:host=' . $host . ';port=' . $port . ';charset=' . $charset;
        if ($name !== '') {
            $dsn .= ';dbname=' . $name;
        }

        $opts = array(
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => true, // MySQL 5.5 上更稳，也方便 LIMIT 绑定
            PDO::ATTR_TIMEOUT            => 10,
        );
        $pdo = new PDO($dsn, $user, $pass, $opts);

        // 降低 sql_mode：MySQL 5.5 常见 ONLY_FULL_GROUP_BY / STRICT_TRANS_TABLES，
        // 在写入 LONGTEXT 超长内容或缺省字段时容易直接报错，这里统一放宽
        try {
            $pdo->exec("SET SESSION sql_mode = ''");
        } catch (Exception $e) {
            /* 忽略：部分托管环境禁止修改 sql_mode */
        }
        try {
            $pdo->exec('SET NAMES ' . $charset);
        } catch (Exception $e) {
            /* 忽略 */
        }

        return $pdo;
    }

    /** 强制重连（改完数据库配置后调用） */
    public static function reconnect()
    {
        self::$pdo = null;
        self::$error = null;
        return self::conn();
    }

    public static function close()
    {
        self::$pdo = null;
    }

    /* ---------------- 查询封装 ---------------- */

    /**
     * @return PDOStatement|null
     */
    public static function q($sql, $args = array())
    {
        try {
            return self::execute($sql, $args);
        } catch (PDOException $e) {
            // 连接被服务端断开（MySQL server has gone away / Lost connection）时重连一次再试
            $msg = $e->getMessage();
            if (strpos($msg, '2006') !== false || strpos($msg, '2013') !== false || stripos($msg, 'gone away') !== false) {
                self::$pdo = null;
                self::conn();
                return self::execute($sql, $args);
            }
            throw $e;
        }
    }

    private static function execute($sql, $args = array())
    {
        $pdo = self::conn();
        if (!$pdo) {
            throw new Exception('数据库不可用：' . (self::$error ? self::$error : '未初始化'));
        }
        $stmt = $pdo->prepare($sql);
        if (!$stmt) {
            throw new Exception('SQL 预编译失败');
        }
        if (!is_array($args)) {
            $args = array($args);
        }
        foreach ($args as $k => $v) {
            $idx = is_int($k) ? $k + 1 : $k;
            if ($v === null) {
                $stmt->bindValue($idx, null, PDO::PARAM_NULL);
            } elseif (is_bool($v)) {
                $stmt->bindValue($idx, $v ? 1 : 0, PDO::PARAM_INT);
            } elseif (is_int($v)) {
                $stmt->bindValue($idx, $v, PDO::PARAM_INT);
            } else {
                // 浮点数也按字符串绑，避免 PDO::PARAM_INT 把 19.90 截成 19
                $stmt->bindValue($idx, (string) $v, PDO::PARAM_STR);
            }
        }
        $stmt->execute();
        // lastInsertId 必须在执行后立刻取：这条连接上再跑任何别的 SQL（包括探活）
        // 都可能把它清零
        self::$lastInsertId = $pdo->lastInsertId();
        return $stmt;
    }

    private static $lastInsertId = '0';

    public static function insertId()
    {
        return self::$lastInsertId;
    }

    public static function rows($sql, $args = array())
    {
        $st = self::q($sql, $args);
        return $st->fetchAll();
    }

    public static function one($sql, $args = array())
    {
        $st = self::q($sql, $args);
        $r  = $st->fetch();
        return $r === false ? null : $r;
    }

    public static function val($sql, $args = array(), $default = null)
    {
        $r = self::one($sql, $args);
        if ($r === null) {
            return $default;
        }
        $v = reset($r);
        return $v === null ? $default : $v;
    }

    public static function affected($st)
    {
        return $st ? $st->rowCount() : 0;
    }
}
