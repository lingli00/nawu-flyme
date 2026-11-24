<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * ★v1.7.0 多端增量同步（记录级）
 *
 * 背景：此前「同步」只有整份快照备份（flyme_backups，服务端只留 3 份），
 * 手机写完要手动备份、电脑再拉取恢复才能看到，且恢复会整体覆盖本机。
 * 本层提供**按条记录**的增量同步：登录设备把每条变更推上来，其他设备按
 * 游标增量拉取合并，实现「手机写、电脑自动看到」。
 *
 * 表 flyme_sync_docs（惰性建表，老库无 DDL 权限时接口降级 503，不影响其他功能）：
 *   id                 自增主键 —— 同时是**全局单调游标**（按 owner 过滤后依旧递增）
 *   owner_id           账号邮箱
 *   collection         集合名（12 集合白名单 + '__settings'）
 *   record_id          记录 id（客户端 newId() 生成）
 *   data               记录 JSON（delete 时为 null）
 *   client_updated_at  客户端打的变化时间戳（毫秒）—— LWW 依据
 *   deleted            删除墓碑（1 = 该记录已被某端删除）
 *
 * 合并规则（Last-Write-Wins）：
 *   - 推送： incoming.client_updated_at >= 已存值 才覆盖（相等也覆盖，幂等）
 *   - 拉取： 客户端拿 remote.updatedAt 与本地记录 updatedAt 比较，新者胜；
 *            本地尚有未推送的变更（outbox 在队列里）时本地优先，推完自然覆盖。
 *
 * 接口（挂在 /api/user/ 鉴权分区下，仅 Bearer token）：
 *   POST /api/user/sync/push    {changes:[{collection,recordId,op,data,updatedAt}]}
 *   GET  /api/user/sync/pull    ?since=<cursor>&limit<=500
 *   GET  /api/user/sync/cursor  新设备首拉锚点（该账号当前最大游标）
 */
class GF_Sync
{
    /** 允许同步的集合白名单（12 集合 + '__settings' 设置漫游专用键）。 */
    const COLLECTIONS = array(
        'goods', 'subscriptions', 'bills', 'valueRecords', 'moods', 'times',
        'wishlist', 'cooldowns', 'categories', 'usageRecords', 'reminders', 'walls',
        '__settings',
    );

    /** 单次 push 变更条数上限。 */
    const MAX_PUSH_CHANGES = 500;
    /** push 频控：1200 次/小时（正常节流推送远低于此，仅防滥用）。 */
    const PUSH_THROTTLE_MAX = 1200;
    const PUSH_THROTTLE_WINDOW = 3600;

    public static function ensureTables()
    {
        static $done = false;
        if ($done) {
            return true;
        }
        try {
            // ★兼容老 MySQL（5.5）：
            // - 一个表只允许一个 TIMESTAMP 列带 CURRENT_TIMESTAMP（只用 updated_at）；
            // - utf8mb4 组合索引总宽 ≤767 字节 → 唯一键用 ukey=md5(owner|collection|record_id)，
            //   owner 索引走前缀。
            GF_Db::q(
                'CREATE TABLE IF NOT EXISTS `flyme_sync_docs` (
                    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    `ukey` CHAR(32) NOT NULL,
                    `owner_id` VARCHAR(190) NOT NULL,
                    `collection` VARCHAR(64) NOT NULL,
                    `record_id` VARCHAR(190) NOT NULL,
                    `data` LONGTEXT NULL,
                    `client_updated_at` BIGINT NOT NULL DEFAULT 0,
                    `deleted` TINYINT NOT NULL DEFAULT 0,
                    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (`id`),
                    UNIQUE KEY `uniq_doc` (`ukey`),
                    KEY `idx_owner_id` (`owner_id`(64), `id`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
                array()
            );
            $done = true;
            return true;
        } catch (Exception $e) {
            error_log('[nawu-sync] ensureTables: ' . $e->getMessage());
            return false;
        }
    }

    /** 行唯一键（规避老 MySQL utf8mb4 组合索引宽度限制）。 */
    private static function ukey($owner, $collection, $recordId)
    {
        return md5($owner . '|' . $collection . '|' . $recordId);
    }

    /** 入口（Api.php user 分区调用）。$me 已通过 GF_Auth::currentUser() 校验。 */
    public static function handle($path, $method, $me)
    {
        if (!self::ensureTables()) {
            flyme_fail('服务器暂不支持多端同步（缺少数据表权限）', 503);
        }

        if ($path === '/api/user/sync/push' && $method === 'POST') {
            self::push($me);
        }
        if ($path === '/api/user/sync/pull' && $method === 'GET') {
            self::pull($me);
        }
        if ($path === '/api/user/sync/cursor' && $method === 'GET') {
            $cursor = (int) GF_Db::val(
                'SELECT COALESCE(MAX(`id`), 0) FROM `flyme_sync_docs` WHERE `owner_id` = ?',
                array($me['email']),
                0
            );
            flyme_ok(array('cursor' => $cursor, 'serverTime' => self::nowMs()));
        }

        flyme_fail('not found', 404);
    }

    private static function nowMs()
    {
        return (int) round(microtime(true) * 1000);
    }

    /** 归一化一条变更；非法返回 null。 */
    private static function normalizeChange($raw)
    {
        if (!is_array($raw)) {
            return null;
        }
        $collection = isset($raw['collection']) ? (string) $raw['collection'] : '';
        $recordId   = isset($raw['recordId']) ? (string) $raw['recordId'] : '';
        $op         = isset($raw['op']) ? (string) $raw['op'] : 'upsert';
        if (!in_array($collection, self::COLLECTIONS, true)) {
            return null;
        }
        if ($recordId === '' || strlen($recordId) > 190) {
            return null;
        }
        if ($op !== 'upsert' && $op !== 'delete') {
            return null;
        }
        $updatedAt = isset($raw['updatedAt']) ? (int) $raw['updatedAt'] : 0;
        if ($updatedAt <= 0 || $updatedAt > self::nowMs() + 86400000) {
            return null; // 时间戳必须有效（允许 1 天时钟偏差）
        }
        $data = null;
        if ($op === 'upsert') {
            if (!isset($raw['data']) || !is_array($raw['data'])) {
                return null;
            }
            $data = json_encode($raw['data'], JSON_UNESCAPED_UNICODE);
            if ($data === false || strlen($data) > 2097152) {
                return null; // 单条记录上限 2MB（图片走压缩，正常远小于此）
            }
        }
        return array(
            'collection' => $collection,
            'recordId'   => $recordId,
            'op'         => $op,
            'updatedAt'  => $updatedAt,
            'data'       => $data,
        );
    }

    private static function push($me)
    {
        list($allow, $wait) = flyme_throttle_check('syncpush', $me['email'], self::PUSH_THROTTLE_MAX, self::PUSH_THROTTLE_WINDOW);
        if (!$allow) {
            flyme_fail('同步太频繁，请 ' . $wait . ' 秒后再试', 429);
        }
        flyme_throttle_fail('syncpush', $me['email'], self::PUSH_THROTTLE_MAX, self::PUSH_THROTTLE_WINDOW);

        $changes = flyme_param('changes');
        if (!is_array($changes)) {
            flyme_fail('缺少 changes 数组', 400);
        }
        if (count($changes) > self::MAX_PUSH_CHANGES) {
            flyme_fail('单次最多推送 ' . self::MAX_PUSH_CHANGES . ' 条变更', 400);
        }

        $applied  = 0;
        $ignored  = 0;
        foreach ($changes as $raw) {
            $c = self::normalizeChange($raw);
            if ($c === null) {
                $ignored++;
                continue;
            }
            $existing = GF_Db::one(
                'SELECT `client_updated_at`, `deleted` FROM `flyme_sync_docs`
                 WHERE `ukey` = ? LIMIT 1',
                array(self::ukey($me['email'], $c['collection'], $c['recordId']))
            );
            if ($existing && (int) $existing['client_updated_at'] > $c['updatedAt']) {
                // 云端已有一条更新的版本（另一台设备后写的）：丢弃旧变更
                $ignored++;
                continue;
            }
            if ($existing) {
                // ★v1.7.1 修复：LWW 更新改为「删旧行 + 插新行」。
                // 原来走 UPDATE 时行 id 不变，其他设备游标若已越过该 id，
                // 就永远拉不到这次修改/删除墓碑（表现为「一端删了另一端还在」）。
                // 删旧插新后新行 id 单调递增 = 新游标，所有设备都能增量拉到。
                GF_Db::q('DELETE FROM `flyme_sync_docs` WHERE `ukey` = ?', array(self::ukey($me['email'], $c['collection'], $c['recordId'])));
            }
            GF_Db::q(
                'INSERT INTO `flyme_sync_docs`
                    (`ukey`, `owner_id`, `collection`, `record_id`, `data`, `client_updated_at`, `deleted`)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                array(
                    self::ukey($me['email'], $c['collection'], $c['recordId']),
                    $me['email'],
                    $c['collection'],
                    $c['recordId'],
                    $c['data'],
                    $c['updatedAt'],
                    $c['op'] === 'delete' ? 1 : 0,
                )
            );
            $applied++;
        }

        flyme_ok(array(
            'applied'    => $applied,
            'ignored'    => $ignored,
            'serverTime' => self::nowMs(),
        ));
    }

    private static function pull($me)
    {
        $since = isset($_GET['since']) ? (int) $_GET['since'] : 0;
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 500;
        if ($since < 0) {
            $since = 0;
        }
        if ($limit <= 0 || $limit > 500) {
            $limit = 500;
        }
        $rows = GF_Db::rows(
            'SELECT `id`, `collection`, `record_id`, `data`, `client_updated_at`, `deleted`
             FROM `flyme_sync_docs`
             WHERE `owner_id` = ? AND `id` > ?
             ORDER BY `id` ASC
             LIMIT ' . (int) $limit,
            array($me['email'], $since)
        );

        $changes = array();
        $cursor  = $since;
        foreach ($rows as $r) {
            $cursor = (int) $r['id'];
            $data = null;
            if ((int) $r['deleted'] === 0 && $r['data'] !== null) {
                $data = json_decode($r['data'], true);
                if (!is_array($data)) {
                    continue; // 坏数据跳过（不推进 hasMore 判断由条数控制）
                }
            }
            $changes[] = array(
                'cursor'     => $cursor,
                'collection' => (string) $r['collection'],
                'recordId'   => (string) $r['record_id'],
                'op'         => ((int) $r['deleted'] === 1) ? 'delete' : 'upsert',
                'data'       => $data,
                'updatedAt'  => (int) $r['client_updated_at'],
            );
        }

        flyme_ok(array(
            'changes' => $changes,
            'cursor'  => $cursor,
            'hasMore' => count($rows) >= $limit,
            'serverTime' => self::nowMs(),
        ));
    }
}
