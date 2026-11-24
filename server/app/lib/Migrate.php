<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * v1.0.36 · 轻量版本化数据库迁移。
 *
 * 背景：此前 Schema.php 只有「惰性 ensure*」（建表/补列，幂等但无版本概念），
 * app_meta.schema_version 写死为 '2' 且从不读取——无法表达「v1.0.40 需要
 * 把某列数据搬到新列」这类真正的迁移。
 *
 * 约定：
 *  - 迁移表 migrations() 是有序数组：键 = 目标版本号（int），值 = 说明 + run；
 *  - current() 读 app_meta.schema_version（缺省 0，视为「安装时即最新」对齐到 2）；
 *  - run() 从 current+1 逐条执行，每条一个事务，成功后立刻把版本号写回
 *    app_meta——中途失败即抛异常，已执行的条目不回滚（各自事务已提交），
 *    下次 run() 从断点继续；
 *  - 服务端「在线更新」的 finalizing 阶段会自动调用 run()；
 *    管理后台也可手动 POST /api/admin/server/migrate 触发。
 *
 * ★怎么加一条迁移（未来版本）：
 *   1) 在本文件 migrations() 里加 `3 => array('note' => '…', 'run' => function () { … })`；
 *   2) 把 const LATEST 改成 3；
 *   3) run 闭包里用 GF_Db::q() 写 SQL（自动走连接重试），不要自己开 PDO。
 */

class GF_Migrate
{
    /** 当前代码的最新 schema 版本（v1.0.36 无真实迁移，与安装时写入值一致） */
    const LATEST = 2;

    /** 当前数据库 schema 版本；读不到 / 库没连上时返回 0。 */
    public static function current()
    {
        try {
            GF_Db::conn();
            if (!GF_Db::connected()) {
                return 0;
            }
            $v = GF_Db::val("SELECT `v` FROM `app_meta` WHERE `k` = 'schema_version' LIMIT 1", array(), null);
            return $v === null ? 0 : (int) $v;
        } catch (Exception $e) {
            return 0;
        }
    }

    /** 待执行的迁移：[版本号 => 说明] */
    public static function pending()
    {
        $cur = self::current();
        $out = array();
        foreach (array_keys(self::migrations()) as $v) {
            if ((int) $v > $cur) {
                $out[(int) $v] = self::migrations()[$v]['note'];
            }
        }
        return $out;
    }

    /** 有序迁移表。新增迁移只改这里 + LATEST。 */
    public static function migrations()
    {
        return array(
            // 示例（不要真实执行，仅示范写法）：
            // 3 => array(
            //     'note' => '示例：给 flyme_users 加一列',
            //     'run'  => function () {
            //         GF_Db::q('ALTER TABLE `flyme_users` ADD COLUMN `x` VARCHAR(64) NULL');
            //     },
            // ),
        );
    }

    /**
     * 执行所有待迁移。
     * @return array('from' => int, 'to' => int, 'log' => array)
     * @throws Exception 数据库不可用或某条迁移失败
     */
    public static function run()
    {
        $from = self::current();
        $to   = self::LATEST;
        $log  = array();
        if ($from >= $to) {
            return array('from' => $from, 'to' => $to, 'log' => $log);
        }
        GF_Db::conn();
        if (!GF_Db::connected()) {
            throw new Exception('数据库未连接，无法执行迁移');
        }
        foreach (self::migrations() as $v => $m) {
            $v = (int) $v;
            if ($v <= $from) {
                continue;
            }
            GF_Db::q('START TRANSACTION');
            try {
                if (isset($m['run']) && is_callable($m['run'])) {
                    call_user_func($m['run']);
                }
                GF_Db::q(
                    "INSERT INTO `app_meta` (`k`, `v`) VALUES ('schema_version', ?)
                     ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)",
                    array((string) $v)
                );
                GF_Db::q('COMMIT');
            } catch (Exception $e) {
                GF_Db::q('ROLLBACK');
                throw new Exception('迁移到 v' . $v . ' 失败：' . $e->getMessage());
            }
            $log[] = 'v' . $v . '：' . (isset($m['note']) ? $m['note'] : '');
        }
        return array('from' => $from, 'to' => self::current(), 'log' => $log);
    }
}
