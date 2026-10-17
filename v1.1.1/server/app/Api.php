<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * 纳物 · REST 后端（与 Node 版 server.cjs 接口完全对齐）
 */

require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/Config.php';
require_once GF_ROOT . '/app/lib/Db.php';
require_once GF_ROOT . '/app/lib/Schema.php';
require_once GF_ROOT . '/app/lib/Auth.php';
require_once GF_ROOT . '/app/lib/Mail.php';
// v1.0.36：服务端在线更新 + 版本化迁移
require_once GF_ROOT . '/app/lib/Update.php';
require_once GF_ROOT . '/app/lib/Migrate.php';
// v1.1：.flyme 备份容器（加密导出 / 解密导入，与前端二进制互通）
require_once GF_ROOT . '/app/lib/FlymeFile.php';

/**
 * v1.0.33.1：可安全回显给客户端的业务异常。
 *
 * 背景：v1.0.33 把 handle() 的兜底 catch 改成「一律不回显异常消息」（用于防止 SQL 错误、
 * 绝对路径泄露），但副作用是把 checkCode() 这类**本该提示用户**的校验失败也一起吞成了
 * “服务器内部错误”。此处用独立异常类型把两者分开：
 *   - GF_UserError  → 消息经人工确认可对外展示，按 400 返回（如“验证码不正确”）
 *   - 其它 Exception → 只写日志，对外统一“服务器内部错误”
 */
class GF_UserError extends Exception
{
}

class GF_Api
{
    /** 云备份单包上限 16MB（v1.0.33 安全修复：原来无限制，可被用来撑爆 DB/磁盘） */
    const BACKUP_MAX_BYTES = 16777216;

    public static function handle($path)
    {
        $method = flyme_method();

        try {
            if (strpos($path, '/api/admin/') === 0) {
                self::admin($path, $method);
            } elseif (strpos($path, '/api/auth/') === 0) {
                self::auth($path, $method);
            } elseif (strpos($path, '/api/user/') === 0) {
                self::user($path, $method);
            } elseif (strpos($path, '/api/sync/') === 0) {
                // 兼容「个人中心 → 自建服务器」那套旧协议：直接读写本账号的云备份
                self::sync($path, $method);
            } elseif ($path === '/api/settings') {
                self::legacySettings($method);
            } elseif ($path === '/api/health') {
                self::health();
            } elseif ($path === '/api/app/version' && $method === 'GET') {
                // 免鉴权：App 启动 / 设置页检查更新用
                self::appVersion();
            } elseif ($path === '/api/app/download' && $method === 'GET') {
                // 免鉴权：系统浏览器直接下载 APK（无需登录态）
                self::appDownload();
            } else {
                flyme_fail('not found', 404);
            }
        } catch (GF_UserError $e) {
            // v1.0.33.1：业务校验异常，消息可安全回显（如“验证码不正确 / 请先获取验证码”）
            flyme_fail($e->getMessage(), 400);
        } catch (Exception $e) {
            // v1.0.33 安全修复：异常详情只进服务端日志，不再回显给客户端
            // （原来会把 SQL 错误、绝对路径直接暴露给访客）
            error_log('[nawu-api] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            if (defined('GF_DEBUG') && GF_DEBUG) {
                flyme_fail('服务器错误：' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(), 500);
            }
            flyme_fail('服务器内部错误，请稍后再试', 500);
        }
        flyme_fail('not found', 404);
    }

    /* =================== 健康检查 =================== */

    private static function health()
    {
        GF_Db::conn();
        $ok  = GF_Db::connected();
        $out = array(
            'ok'      => true,
            'db'      => $ok,
            'time'    => gmdate('c'),
            'runtime' => 'PHP ' . PHP_VERSION,
            // v1.0.36：服务端版本（app/VERSION，供在线更新比对与健康自检）
            'version' => self::serverVersion(),
        );
        // v1.0.33 安全修复：dbError / 连接信息只对管理员可见，避免泄露数据库错误细节
        $admin = self::adminOrNull();
        if (!$ok) {
            $out['dbError'] = $admin ? (GF_Db::error() ? GF_Db::error() : '未连接') : null;
        }
        if ($admin && $ok) {
            $c = GF_Config::db();
            $out['host']     = $c['host'] . ':' . $c['port'];
            $out['database'] = $c['name'];
        }
        flyme_json($out);
    }

    /* =================== 用户认证 =================== */

    private static function auth($path, $method)
    {
        if ($path === '/api/auth/login' && $method === 'POST') {
            self::requireDb();
            // 兼容旧「自建服务器」客户端用 username 传账号的情况
            $rawEmail = flyme_param('email');
            if ($rawEmail === null || trim((string) $rawEmail) === '') {
                $rawEmail = flyme_param('username');
            }
            $email = strtolower(flyme_str($rawEmail));
            $pass  = (string) flyme_param('password', '');

            if (GF_Auth::get('allowLogin', 'true') !== 'true') {
                flyme_fail('管理员已暂停登录，请稍后再试', 403);
            }
            // v1.0.33 安全修复：登录限速 —— 同账号 5 次失败锁 15 分钟，同 IP 30 次失败锁 15 分钟
            $ip = flyme_client_ip();
            list($allowAcct, $waitAcct) = flyme_throttle_check('login', $email, 5, 900);
            if (!$allowAcct) {
                flyme_fail('失败次数过多，该账号已被暂时锁定，请 ' . $waitAcct . ' 秒后再试', 429);
            }
            list($allowIp, $waitIp) = flyme_throttle_check('loginip', $ip, 30, 900);
            if (!$allowIp) {
                flyme_fail('当前网络失败次数过多，请 ' . $waitIp . ' 秒后再试', 429);
            }
            $u = GF_Db::one('SELECT * FROM `flyme_users` WHERE `email` = ? LIMIT 1', array($email));
            if (!$u) {
                flyme_throttle_fail('login', $email, 5, 900);
                flyme_throttle_fail('loginip', $ip, 30, 900);
                // v1.0.33 安全修复：与「密码不正确」统一文案，避免枚举已注册用户
                flyme_fail('邮箱或密码不正确', 401);
            }
            if (!flyme_pw_verify($pass, $u['pass_hash'], $u['salt'])) {
                flyme_throttle_fail('login', $email, 5, 900);
                flyme_throttle_fail('loginip', $ip, 30, 900);
                flyme_fail('邮箱或密码不正确', 401);
            }
            // 旧 SHA-256 哈希：校验通过后透明升级为 bcrypt
            if (flyme_pw_needs_upgrade($u['pass_hash'])) {
                GF_Db::q(
                    'UPDATE `flyme_users` SET `pass_hash` = ?, `salt` = ? WHERE `email` = ?',
                    array(flyme_pw_hash($pass), '', $email)
                );
            }
            if (intval($u['disabled'])) {
                flyme_fail('该账号已被管理员停用，如有疑问请联系管理员', 403);
            }
            if (GF_Auth::get('requireVerified', 'true') === 'true' && !intval($u['verified'])) {
                flyme_fail('邮箱尚未验证，请先完成注册验证', 403);
            }
            flyme_throttle_clear('login', $email);
            flyme_throttle_clear('loginip', $ip);
            GF_Db::q('UPDATE `flyme_users` SET `last_login_at` = NOW() WHERE `email` = ?', array($email));
            /* ★v1.1：昵称以 flyme_profiles 为单一事实源（用户端「账号编辑」只写它）。
               登录时优先取 profiles 的 display_name，回落 users 表历史值，
               再回落邮箱——保证「我的」页、名册、管理后台三处显示一致。 */
            $dirName = $u['display_name'] ? $u['display_name'] : $email;
            try {
                $profRow = GF_Db::one('SELECT `display_name` FROM `flyme_profiles` WHERE `owner_id` = ? LIMIT 1', array($email));
                if ($profRow && $profRow['display_name'] !== null && $profRow['display_name'] !== '') {
                    $dirName = $profRow['display_name'];
                }
            } catch (Exception $profErr) {
                /* 老库没有 profiles 表时不影响登录 */
            }
            self::touchDirectoryDb($email, $dirName);
            $token = GF_Auth::issueUserToken($email);
            flyme_ok(array(
                'token' => $token,
                'user'  => array(
                    'id'           => $email,
                    'email'        => $email,
                    'display_name' => $dirName,
                    'verified'     => (bool) intval($u['verified']),
                ),
            ));
        }

        if ($path === '/api/auth/send-code' && $method === 'POST') {
            self::requireDb();
            $email   = strtolower(flyme_str(flyme_param('email')));
            $purpose = flyme_str(flyme_param('purpose')) === 'reset' ? 'reset' : 'register';
            if (!flyme_valid_email($email)) {
                flyme_fail('请输入正确的邮箱地址', 400);
            }
            $exist = GF_Db::one('SELECT `email`, `verified` FROM `flyme_users` WHERE `email` = ? LIMIT 1', array($email));
            if ($purpose === 'register') {
                if (GF_Auth::get('allowRegister', 'true') !== 'true') {
                    flyme_fail('管理员已关闭注册', 403);
                }
                if ($exist && intval($exist['verified'])) {
                    flyme_fail('该邮箱已注册，请直接登录', 400);
                }
                if (GF_Auth::get('requireVerified', 'true') !== 'true') {
                    flyme_fail('当前注册无需邮箱验证，直接设置密码即可', 400);
                }
            } else {
                if (!$exist) {
                    flyme_fail('该邮箱尚未注册', 404);
                }
            }
            // v1.0.33 安全修复：同 IP 每小时最多 20 封验证邮件，防「邮件轰炸」
            $ip = flyme_client_ip();
            list($allowIp, $waitIp) = flyme_throttle_check('sendcodeip', $ip, 20, 3600);
            if (!$allowIp) {
                flyme_fail('发送太频繁，请 ' . $waitIp . ' 秒后再试', 429);
            }
            flyme_throttle_fail('sendcodeip', $ip, 20, 3600);
            self::issueAndSendCode($email, $purpose);
            flyme_ok(array('verificationId' => $email . ':' . $purpose));
        }

        if ($path === '/api/auth/register' && $method === 'POST') {
            self::requireDb();
            $rawEmail = flyme_param('email');
            if ($rawEmail === null || trim((string) $rawEmail) === '') {
                $rawEmail = flyme_param('username');
            }
            $email = strtolower(flyme_str($rawEmail));
            $pass  = (string) flyme_param('password', '');
            $code  = flyme_str(flyme_param('code'));

            if (GF_Auth::get('allowRegister', 'true') !== 'true') {
                flyme_fail('管理员已关闭注册', 403);
            }
            if (!flyme_valid_email($email)) {
                flyme_fail('请输入正确的邮箱地址', 400);
            }
            if (strlen($pass) < 6) {
                flyme_fail('密码至少 6 位', 400);
            }

            $requireVerify = GF_Auth::get('requireVerified', 'true') === 'true';
            if ($requireVerify) {
                self::checkCode($email, 'register', $code);
            }

            $exist = GF_Db::one('SELECT `email`, `verified` FROM `flyme_users` WHERE `email` = ? LIMIT 1', array($email));
            if ($exist && intval($exist['verified'])) {
                flyme_fail('该邮箱已注册，请直接登录', 400);
            }

            // v1.0.33 安全修复：bcrypt 哈希（salt 字段留空，bcrypt 自带盐）
            $newHash = flyme_pw_hash($pass);
            if ($exist) {
                GF_Db::q(
                    'UPDATE `flyme_users` SET `pass_hash` = ?, `salt` = ?, `verified` = ?, `last_login_at` = NOW() WHERE `email` = ?',
                    array($newHash, '', 1, $email)
                );
            } else {
                GF_Db::q(
                    'INSERT INTO `flyme_users` (`email`, `pass_hash`, `salt`, `verified`, `last_login_at`) VALUES (?, ?, ?, ?, NOW())',
                    array($email, $newHash, '', 1)
                );
            }
            self::touchDirectoryDb($email, $email);
            $token = GF_Auth::issueUserToken($email);
            flyme_ok(array(
                'token' => $token,
                'user'  => array('id' => $email, 'email' => $email, 'display_name' => null, 'verified' => true),
            ));
        }

        if ($path === '/api/auth/reset' && $method === 'POST') {
            self::requireDb();
            $email = strtolower(flyme_str(flyme_param('email')));
            $newPw = (string) flyme_param('newPassword', '');
            if (strlen($newPw) < 6) {
                flyme_fail('密码至少 6 位', 400);
            }
            $exist = GF_Db::one('SELECT `email` FROM `flyme_users` WHERE `email` = ? LIMIT 1', array($email));
            if (!$exist) {
                flyme_fail('该邮箱尚未注册', 404);
            }
            // v1.0.33 安全修复：同邮箱 5 次失败锁 30 分钟（checkCode 内部还有 5 次验证码尝试锁定）
            list($allow, $wait) = flyme_throttle_check('reset', $email, 5, 1800);
            if (!$allow) {
                flyme_fail('操作过于频繁，请 ' . $wait . ' 秒后再试', 429);
            }
            if (GF_Auth::get('requireVerified', 'true') === 'true') {
                try {
                    self::checkCode($email, 'reset', flyme_str(flyme_param('code')));
                } catch (Exception $ce) {
                    flyme_throttle_fail('reset', $email, 5, 1800, 1800);
                    throw $ce;
                }
            }
            flyme_throttle_clear('reset', $email);
            GF_Db::q(
                'UPDATE `flyme_users` SET `pass_hash` = ?, `salt` = ?, `verified` = 1 WHERE `email` = ?',
                array(flyme_pw_hash($newPw), '', $email)
            );
            GF_Auth::killUserSessions($email);
            flyme_ok();
        }

        if ($path === '/api/auth/me' && $method === 'GET') {
            $me = GF_Auth::currentUser();
            if (!$me) {
                flyme_fail('登录状态已失效', 401);
            }
            flyme_ok(array('user' => array(
                'id'           => $me['email'],
                'email'        => $me['email'],
                'display_name' => $me['display_name'],
                'verified'     => $me['verified'],
            )));
        }

        if ($path === '/api/auth/logout' && $method === 'POST') {
            $token = flyme_bearer();
            if ($token) {
                GF_Db::q('DELETE FROM `flyme_sessions` WHERE `token` = ?', array($token));
            }
            flyme_ok();
        }

        if ($path === '/api/auth/password' && $method === 'POST') {
            // 旧「自建服务器」协议里的改密入口，行为等同于 changepassword
            $me = GF_Auth::currentUser();
            if (!$me) {
                flyme_fail('登录状态已失效', 401);
            }
            $u = GF_Db::one('SELECT * FROM `flyme_users` WHERE `email` = ? LIMIT 1', array($me['email']));
            $old = (string) flyme_param('oldPassword', '');
            $new = (string) flyme_param('newPassword', '');
            if (!$u || !flyme_pw_verify($old, $u['pass_hash'], $u['salt'])) {
                flyme_fail('当前密码不正确', 400);
            }
            if (strlen($new) < 6) {
                flyme_fail('新密码至少 6 位', 400);
            }
            GF_Db::q('UPDATE `flyme_users` SET `pass_hash` = ?, `salt` = ? WHERE `email` = ?', array(flyme_pw_hash($new), '', $me['email']));
            GF_Auth::killUserSessions($me['email']);
            flyme_ok();
        }

        if ($path === '/api/auth/changepassword' && $method === 'POST') {
            $me = GF_Auth::currentUser();
            if (!$me) {
                flyme_fail('登录状态已失效', 401);
            }
            $u = GF_Db::one('SELECT * FROM `flyme_users` WHERE `email` = ? LIMIT 1', array($me['email']));
            $old = (string) flyme_param('oldPassword', '');
            $new = (string) flyme_param('newPassword', '');
            if (!$u || !flyme_pw_verify($old, $u['pass_hash'], $u['salt'])) {
                flyme_fail('当前密码不正确', 400);
            }
            if (strlen($new) < 6) {
                flyme_fail('新密码至少 6 位', 400);
            }
            GF_Db::q(
                'UPDATE `flyme_users` SET `pass_hash` = ?, `salt` = ? WHERE `email` = ?',
                array(flyme_pw_hash($new), '', $me['email'])
            );
            GF_Auth::killUserSessions($me['email']);
            flyme_ok();
        }

        flyme_fail('not found', 404);
    }

    /* =================== 用户数据（云备份 / 资料） =================== */

    private static function user($path, $method)
    {
        $me = GF_Auth::currentUser();
        if (!$me) {
            flyme_fail('登录状态已失效，请重新登录', 401);
        }

        if ($path === '/api/user/backups' && $method === 'GET') {
            $rows = GF_Db::rows(
                'SELECT `id`, `label`, `item_count`, `bytes`, `device`, `created_at` FROM `flyme_backups` WHERE `owner_id` = ? ORDER BY `id` DESC LIMIT 50',
                array($me['email'])
            );
            $out = array();
            foreach ($rows as $r) {
                $out[] = array(
                    'id'         => (int) $r['id'],
                    'label'      => $r['label'],
                    'item_count' => (int) $r['item_count'],
                    'bytes'      => (int) $r['bytes'],
                    'device'     => $r['device'],
                    'created_at' => flyme_iso($r['created_at']) !== null ? flyme_iso($r['created_at']) : gmdate('c'),
                );
            }
            flyme_ok(array('rows' => $out));
        }

        if ($path === '/api/user/backups' && $method === 'POST') {
            // v1.0.33 安全修复：备份频率限制 60 次/小时（配合 16MB 单包上限，
            // 堵死「无限上传撑爆 DB/磁盘」）
            list($allow, $wait) = flyme_throttle_check('backup', $me['email'], 60, 3600);
            if (!$allow) {
                flyme_fail('备份操作太频繁，请 ' . $wait . ' 秒后再试', 429);
            }
            flyme_throttle_fail('backup', $me['email'], 60, 3600);
            $payloadRaw = flyme_param('payload');
            $payload    = is_string($payloadRaw) ? $payloadRaw : json_encode($payloadRaw, JSON_UNESCAPED_UNICODE);
            if (!is_string($payload)) {
                $payload = '';
            }
            // 入库前归一化：保证将来「覆盖恢复」时结构一定可用
            // （缺失的集合补空数组、非数组值剔除，避免恢复后前端因读到 undefined/null 崩溃白屏）
            $payload = self::normalizeBackupPayload($payload);
            $bytes    = strlen($payload);
            if ($bytes > self::BACKUP_MAX_BYTES) {
                flyme_fail('备份内容过大（上限 16MB），请清理历史数据后再试', 400);
            }
            $label    = flyme_str(flyme_param('label', '手动备份'), 120);
            $itemCount = flyme_int(flyme_param('item_count', 0));
            $device   = flyme_str(flyme_param('device', ''), 110);

            GF_Db::q(
                'INSERT INTO `flyme_backups` (`owner_id`, `label`, `payload`, `item_count`, `bytes`, `device`) VALUES (?, ?, ?, ?, ?, ?)',
                array($me['email'], $label, $payload, $itemCount, $bytes, $device)
            );
            $id = (int) GF_Db::insertId();
            // 每个账号只保留最近 3 份
            self::trimBackups($me['email'], 3);
            flyme_ok(array('id' => $id));
        }

        if (preg_match('#^/api/user/backups/(\d+)$#', $path, $m)) {
            $id = (int) $m[1];
            if ($method === 'GET') {
                $r = GF_Db::one('SELECT `payload`, `label` FROM `flyme_backups` WHERE `id` = ? AND `owner_id` = ?', array($id, $me['email']));
                if (!$r) {
                    flyme_fail('备份不存在', 404);
                }
                $payload = $r['payload'];
                $decoded = json_decode($payload, true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    $payload = $decoded;
                }
                flyme_ok(array('payload' => $payload, 'label' => $r['label']));
            }
            if ($method === 'DELETE') {
                $st = GF_Db::q('DELETE FROM `flyme_backups` WHERE `id` = ? AND `owner_id` = ?', array($id, $me['email']));
                if (!$st || !$st->rowCount()) {
                    flyme_fail('备份不存在', 404);
                }
                flyme_ok();
            }
            flyme_fail('method not allowed', 405);
        }

        if ($path === '/api/user/profile' && $method === 'GET') {
            $row = GF_Db::one('SELECT `owner_id`, `display_name`, `avatar_url`, `plan` FROM `flyme_profiles` WHERE `owner_id` = ? LIMIT 1', array($me['email']));
            flyme_ok(array('profile' => $row ? array(
                'owner_id'     => $row['owner_id'],
                'display_name' => $row['display_name'],
                'avatar_url'   => $row['avatar_url'],
                'plan'         => $row['plan'],
                'created_at'   => null,
            ) : null));
        }

        if ($path === '/api/user/profile' && $method === 'POST') {
            // ★v0.7.0 兼容两种形状：顶层扁平 {display_name,...}（App 新版）与
            // 嵌套 {profile:{display_name,...}}（旧客户端/网页版）。顶层优先，嵌套兜底。
            $body    = flyme_body();
            $nested  = (isset($body['profile']) && is_array($body['profile'])) ? $body['profile'] : array();
            $pick    = static function ($key) use ($body, $nested) {
                if (array_key_exists($key, $body)) {
                    return $body[$key];
                }
                return array_key_exists($key, $nested) ? $nested[$key] : null;
            };
            $dn    = $pick('display_name');
            $dn    = $dn === null || $dn === '' ? null : flyme_str($dn, 64);
            $avUrl = flyme_str($pick('avatar_url') ?? '', 2000);
            $plan  = flyme_str($pick('plan') ?? 'free', 16);
            GF_Db::q(
                'INSERT INTO `flyme_profiles` (`owner_id`, `display_name`, `avatar_url`, `plan`) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`), `avatar_url` = VALUES(`avatar_url`), `plan` = VALUES(`plan`)',
                array($me['email'], $dn, $avUrl !== '' ? $avUrl : null, $plan !== '' ? $plan : 'free')
            );
            /* ★v1.1：广播同步昵称到 flyme_users / flyme_directory——
               管理后台「用户管理」与「名册」此前读这两张表，用户端改的昵称
               （只写 profiles）它们看不到，显示「未设昵称」。现在保存即同步。 */
            try {
                GF_Db::q('UPDATE `flyme_users` SET `display_name` = ? WHERE `email` = ?', array($dn, $me['email']));
                GF_Db::q('UPDATE `flyme_directory` SET `display_name` = ? WHERE `owner_id` = ?', array($dn, $me['email']));
            } catch (Exception $syncErr) {
                /* 老库缺列时不影响 profiles 主写入 */
            }
            flyme_ok();
        }

        /* ---- 识别规则：AI 助手自定义词库，跟随账号同步 ---- */

        if ($path === '/api/user/rules' && $method === 'GET') {
            GF_Schema::ensureRulesTable();
            $row = GF_Db::one(
                'SELECT `payload`, `updated_at` FROM `flyme_user_rules` WHERE `owner_id` = ? LIMIT 1',
                array($me['email'])
            );
            $rules = null;
            if ($row && $row['payload'] !== null && $row['payload'] !== '') {
                $decoded = json_decode($row['payload'], true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    $rules = $decoded;
                }
            }
            flyme_ok(array(
                'rules'      => $rules,
                'updated_at' => $row ? flyme_iso($row['updated_at']) : null,
            ));
        }

        if ($path === '/api/user/rules' && $method === 'POST') {
            GF_Schema::ensureRulesTable();
            $rules = flyme_param('rules');
            if ($rules !== null && !is_array($rules)) {
                flyme_fail('规则格式不正确', 400);
            }
            $json = $rules === null ? '' : json_encode($rules, JSON_UNESCAPED_UNICODE);
            if (strlen($json) > 200000) {
                flyme_fail('规则太多了（上限 200KB），精简后再保存', 400);
            }
            GF_Db::q(
                'INSERT INTO `flyme_user_rules` (`owner_id`, `payload`) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE `payload` = VALUES(`payload`)',
                array($me['email'], $json)
            );
            flyme_ok(array('bytes' => strlen($json)));
        }

        flyme_fail('not found', 404);
    }

    /* =================== 管理后台 =================== */

    private static function adminOrNull()
    {
        GF_Db::conn();
        if (!GF_Db::connected()) {
            return null;
        }
        return GF_Auth::currentAdmin();
    }

    private static function admin($path, $method)
    {
        /* ---- 公开：登录 ---- */
        if ($path === '/api/admin/login' && $method === 'POST') {
            self::requireDb();
            $username = flyme_str(flyme_param('username'));
            $password = (string) flyme_param('password', '');
            // v1.0.33 安全修复：管理员登录限速 —— 同账号 5 次失败锁 30 分钟，同 IP 30 次锁 30 分钟
            $ip = flyme_client_ip();
            list($allowAcct, $waitAcct) = flyme_throttle_check('adminlogin', $username !== '' ? $username : '-', 5, 1800);
            if (!$allowAcct) {
                flyme_fail('失败次数过多，该账号已被暂时锁定，请 ' . $waitAcct . ' 秒后再试', 429);
            }
            list($allowIp, $waitIp) = flyme_throttle_check('adminloginip', $ip, 30, 1800);
            if (!$allowIp) {
                flyme_fail('当前网络失败次数过多，请 ' . $waitIp . ' 秒后再试', 429);
            }
            $row = GF_Db::one('SELECT * FROM `flyme_admins` WHERE `username` = ? LIMIT 1', array($username));
            if (!$row || !flyme_pw_verify($password, $row['pass_hash'], $row['salt'])) {
                flyme_throttle_fail('adminlogin', $username !== '' ? $username : '-', 5, 1800, 1800);
                flyme_throttle_fail('adminloginip', $ip, 30, 1800, 1800);
                flyme_fail('用户名或密码不正确', 401);
            }
            if (flyme_pw_needs_upgrade($row['pass_hash'])) {
                GF_Db::q(
                    'UPDATE `flyme_admins` SET `pass_hash` = ?, `salt` = ? WHERE `username` = ?',
                    array(flyme_pw_hash($password), '', $row['username'])
                );
            }
            flyme_throttle_clear('adminlogin', $username);
            flyme_throttle_clear('adminloginip', $ip);
            $token = GF_Auth::issueAdminToken($row['username']);
            flyme_ok(array(
                'token' => $token,
                'admin' => array(
                    'username'     => $row['username'],
                    'display_name' => $row['display_name'],
                    'created_at'   => isset($row['created_at']) ? flyme_iso($row['created_at']) : null,
                ),
            ));
        }

        /* ---- 公开：退出 ---- */
        if ($path === '/api/admin/logout' && $method === 'POST') {
            $me = self::adminOrNull();
            if ($me) {
                GF_Auth::killAdminTokens($me['username']);
            }
            flyme_ok();
        }

        /* ---- 公开：全局开关（登录页 / 品牌 / 维护模式需要） ---- */
        if ($path === '/api/admin/settings' && $method === 'GET') {
            self::requireDb();
            $s = GF_Auth::settings();
            $configured = !empty($s['smtpJson']);
            unset($s['smtpJson']);
            $s['smtpConfigured'] = $configured ? 'true' : 'false';
            flyme_ok(array('settings' => $s));
        }

        /* ---- 登录登记（v1.0.33 安全修复：由匿名可写改为「登录且只能写自己」） ---- */
        if ($path === '/api/admin/directory/touch' && $method === 'POST') {
            self::requireDb();
            $me = GF_Auth::currentUser();
            if (!$me) {
                flyme_fail('登录状态已失效', 401);
            }
            $owner = flyme_str(flyme_param('owner_id'));
            if ($owner === '') {
                $owner = $me['email'];
            } elseif ($owner !== $me['email']) {
                // 防止匿名/恶意用户往名册里塞别人的条目
                flyme_fail('无权登记其他用户', 403);
            }
            self::touchDirectoryDb($owner, flyme_param('display_name'));
            flyme_ok();
        }

        /* ---- 以下需要管理员身份 ---- */
        $me = self::adminOrNull();
        if (!$me) {
            flyme_fail('未登录管理后台或会话已过期', 401);
        }
        self::requireDb();

        /* =================== v1.0.36：服务端在线更新 =================== */

        if ($path === '/api/admin/server/info' && $method === 'GET') {
            flyme_ok(array('info' => GF_Update::info()));
        }

        if ($path === '/api/admin/server/source' && $method === 'GET') {
            $s = GF_Config::updateSource();
            flyme_ok(array(
                'url'       => (string) $s['url'],
                'autoCheck' => ((string) $s['autoCheck']) === 'true',
                'effective' => GF_Update::sourceUrl(),
            ));
        }

        if ($path === '/api/admin/server/source' && $method === 'POST') {
            $url  = trim((string) flyme_param('url', ''));
            $auto = filter_var(flyme_param('autoCheck', true), FILTER_VALIDATE_BOOLEAN);
            if ($url !== '' && !GF_Update::validSourceUrl($url)) {
                flyme_fail('更新源地址不合法（仅支持 http/https，且不能是内网地址）', 400);
            }
            $r = GF_Config::saveUpdate($url, $auto);
            if ($r !== true) {
                flyme_fail((string) $r, 500);
            }
            flyme_ok();
        }

        if ($path === '/api/admin/server/source/test' && $method === 'POST') {
            $url = trim((string) flyme_param('url', ''));
            if ($url === '') {
                $url = null;
            } elseif (!GF_Update::validSourceUrl($url)) {
                flyme_fail('更新源地址不合法（仅支持 http/https，且不能是内网地址）', 400);
            }
            $m = GF_Update::fetchManifest($url);
            flyme_ok(array(
                'remoteVersion' => $m['version'],
                'publishedAt'   => $m['publishedAt'],
                'packageSize'   => $m['packageSize'],
            ));
        }

        if ($path === '/api/admin/server/check' && $method === 'POST') {
            $force = filter_var(flyme_param('force', false), FILTER_VALIDATE_BOOLEAN);
            flyme_ok(GF_Update::check($force));
        }

        if ($path === '/api/admin/server/update' && $method === 'POST') {
            $force   = filter_var(flyme_param('force', false), FILTER_VALIDATE_BOOLEAN);
            $siteUrl = trim((string) flyme_param('siteUrl', ''));
            if ($siteUrl !== '' && !preg_match('#^https?://#i', $siteUrl)) {
                flyme_fail('站点地址不合法（需以 http:// 或 https:// 开头）', 400);
            }
            flyme_ok(GF_Update::startUpdate($force, $siteUrl));
        }

        if ($path === '/api/admin/server/status' && $method === 'GET') {
            $id = isset($_GET['jobId']) ? preg_replace('/[^A-Za-z0-9._-]/', '', (string) $_GET['jobId']) : '';
            if ($id !== '') {
                $job = GF_Update::advanceJob($id);
            } else {
                $active = GF_Update::activeJob();
                $job    = $active === null ? null : GF_Update::advanceJob($active['id']);
            }
            flyme_ok(array('job' => GF_Update::jobSnapshot($job)));
        }

        if ($path === '/api/admin/server/cancel' && $method === 'POST') {
            GF_Update::cancel((string) flyme_param('jobId', ''));
            flyme_ok();
        }

        if ($path === '/api/admin/server/rollback' && $method === 'POST') {
            flyme_ok(GF_Update::rollback((string) flyme_param('backupId', '')));
        }

        if ($path === '/api/admin/server/migrate' && $method === 'POST') {
            flyme_ok(GF_Migrate::run());
        }

        /* =================== v1.0.36：App 安装包发布（后台） =================== */

        if ($path === '/api/admin/app-release' && $method === 'GET') {
            $file = self::appReleaseDir() . '/manifest.json';
            $m    = array();
            if (is_file($file)) {
                $d = json_decode((string) @file_get_contents($file), true);
                if (is_array($d)) {
                    $m = $d;
                }
            }
            $exists = false;
            if (!empty($m['file'])) {
                $name = (string) $m['file'];
                $exists = strpos($name, '/') === false && strpos($name, '\\') === false
                    && strpos($name, '..') === false && is_file(self::appReleaseDir() . '/' . $name);
            }
            flyme_ok(array(
                'manifest'   => array(
                    'version'     => isset($m['version']) ? (string) $m['version'] : '',
                    'notes'       => isset($m['notes']) ? (string) $m['notes'] : '',
                    'file'        => isset($m['file']) ? (string) $m['file'] : '',
                    'fileSize'    => isset($m['fileSize']) ? (int) $m['fileSize'] : 0,
                    'publishedAt' => isset($m['publishedAt']) ? (string) $m['publishedAt'] : '',
                    'history'     => (isset($m['history']) && is_array($m['history'])) ? array_slice($m['history'], -10) : array(),
                ),
                'fileExists' => $exists,
            ));
        }

        if ($path === '/api/admin/app-release' && $method === 'POST') {
            self::publishAppRelease();
        }

        if ($path === '/api/admin/me' && $method === 'GET') {
            $row = GF_Db::one('SELECT * FROM `flyme_admins` WHERE `username` = ? LIMIT 1', array($me['username']));
            $admins = array();
            foreach (GF_Db::rows('SELECT `username`, `display_name`, `created_at` FROM `flyme_admins`') as $r) {
                $admins[] = array(
                    'username'     => $r['username'],
                    'display_name' => $r['display_name'],
                    'created_at'   => flyme_iso($r['created_at']),
                );
            }
            flyme_ok(array(
                'admin'  => array(
                    'username'     => $me['username'],
                    'display_name' => $row ? $row['display_name'] : null,
                    'created_at'   => $row && isset($row['created_at']) ? flyme_iso($row['created_at']) : null,
                ),
                'admins' => $admins,
            ));
        }

        if ($path === '/api/admin/password' && $method === 'POST') {
            $row = GF_Db::one('SELECT * FROM `flyme_admins` WHERE `username` = ? LIMIT 1', array($me['username']));
            if (!$row) {
                flyme_fail('管理员不存在', 404);
            }
            if (!flyme_pw_verify((string) flyme_param('oldPassword', ''), $row['pass_hash'], $row['salt'])) {
                flyme_fail('当前密码不正确', 400);
            }
            $np = (string) flyme_param('newPassword', '');
            if (strlen($np) < 6) {
                flyme_fail('新密码至少 6 位', 400);
            }
            GF_Db::q('UPDATE `flyme_admins` SET `pass_hash` = ?, `salt` = ? WHERE `username` = ?', array(flyme_pw_hash($np), '', $me['username']));
            flyme_ok();
        }

        /* ---- 修改管理员登录名（v1.0.9） ---- */
        if ($path === '/api/admin/username' && $method === 'POST') {
            $username = trim((string) flyme_param('username'));
            if ($username === '' || strlen($username) < 3 || strlen($username) > 40) {
                flyme_fail('用户名需 3-40 个字符', 400);
            }
            if (!preg_match('/^[\x{4e00}-\x{9fa5}A-Za-z0-9_@.\-]+$/u', $username)) {
                flyme_fail('用户名含不支持的字符', 400);
            }
            $dup = GF_Db::one('SELECT `username` FROM `flyme_admins` WHERE `username` = ? LIMIT 1', array($username));
            if ($dup && $dup['username'] !== $me['username']) {
                flyme_fail('该用户名已被占用', 400);
            }
            GF_Db::q('UPDATE `flyme_admins` SET `username` = ? WHERE `username` = ?', array($username, $me['username']));
            flyme_ok();
        }

        /* ---- 数据备份导出（v1.1：.flyme 加密容器，与用户端导出格式一致）----
         * scope=all 全站；scope=site 站点数据（用户/云备份/名册）。
         * password 必填（≥4 位）：FLYME1 加密（PBKDF2 20 万次 + AES-256-GCM，
         * 见 app/lib/FlymeFile.php，与前端 src/lib/flymeFile.ts 二进制互通）——
         * 文件落到本地即使被拷走也读不出内容，导入时需同一密码。
         * 响应为二进制文件下载；张数/行数统计走 X-Nawu-Backup-Summary 响应头。 */
        if ($path === '/api/admin/backup' && $method === 'GET') {
            $scope = isset($_GET['scope']) ? (string) $_GET['scope'] : 'all';
            $pwd   = isset($_GET['password']) ? (string) $_GET['password'] : '';
            if ($scope !== 'site') {
                $scope = 'all';
            }
            if (strlen(trim($pwd)) < 4) {
                flyme_fail('请设置备份密码（至少 4 位）——导出的 .flyme 文件将用它加密', 400);
            }
            $tables = array();
            foreach (GF_Db::rows('SHOW TABLES') as $r) {
                $tables[] = (string) reset($r);
            }
            if ($scope === 'site') {
                $keep = array('flyme_users', 'flyme_backups', 'flyme_directory');
                $tables = array_values(array_intersect($tables, $keep));
            }
            $dump = array(
                'app'        => 'nawu',
                'scope'      => $scope,
                'exportedAt' => gmdate('c'),
                'tables'     => array(),
            );
            $rowTotal = 0;
            foreach ($tables as $t) {
                $rows = GF_Db::rows('SELECT * FROM `' . str_replace('`', '', $t) . '`');
                $rows = is_array($rows) ? $rows : array();
                $dump['tables'][$t] = $rows;
                $rowTotal += count($rows);
            }
            $bytes = GF_FlymeFile::encode($dump, $pwd);
            $fname = 'nawu-backup-' . $scope . '-' . gmdate('Ymd') . '.flyme';
            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="' . $fname . '"');
            header('Content-Length: ' . strlen($bytes));
            header('X-Nawu-Backup-Summary: ' . json_encode(array(
                'tables' => count($dump['tables']),
                'rows'   => $rowTotal,
                'file'   => $fname,
            ), JSON_UNESCAPED_UNICODE));
            echo $bytes;
            exit;
        }

        /* ---- 数据备份导入（v1.1：.flyme 文件字节直传，服务端解密）----
         * 协议：raw body = .flyme 文件字节（application/octet-stream），
         *   mode / includeAdmins / password 走 query string
         *   （flyme_param() 只读 JSON body，见 Support.php L77）。
         * 兼容：body 以 '{' 开头时按旧协议（v1.0.34~1.0.36 的 JSON：
         *   {scope,mode,includeAdmins,tables}）解析，老客户端/老备份不废。
         *
         * 安全约束（缺一不可，与 v1.0.34 起一致）：
         *  ① 表名必须命中前缀/名单白名单，且**当前库里真实存在**（杜绝任意表写入）；
         *  ② 列名以 `SHOW COLUMNS` 的真实列为准，备份里多出来的列一律忽略；
         *  ③ 全部写入包在一个事务里，任一行失败整体回滚（不会留下半截数据）；
         *  ④ 默认**不动管理员账号表**（flyme_admins / flyme_admin_sessions），
         *     否则拿别人的备份一导入就把自己的后台登录顶掉了；需要时显式勾选。 */
        if ($path === '/api/admin/backup/import' && $method === 'POST') {
            self::requireDb();
            $raw = file_get_contents('php://input');
            if (!is_string($raw) || $raw === '') {
                flyme_fail('请求体为空（应为 .flyme 文件字节）', 400);
            }
            if (strlen($raw) > GF_FlymeFile::MAX_BYTES) {
                flyme_fail('备份文件过大（上限 256MB）', 400);
            }
            $mode          = isset($_GET['mode']) ? (string) $_GET['mode'] : 'merge';
            $includeAdmins = isset($_GET['includeAdmins']) && $_GET['includeAdmins'] !== '' && $_GET['includeAdmins'] !== '0' && $_GET['includeAdmins'] !== 'false';
            $password      = isset($_GET['password']) ? (string) $_GET['password'] : '';

            $dump = null;
            if (ltrim($raw) !== '' && ltrim($raw)[0] === '{') {
                // 旧协议：JSON body（tables 内嵌其中）
                $dump = json_decode($raw, true);
                if (!is_array($dump)) {
                    flyme_fail('备份文件不是合法的 JSON', 400);
                }
            } else {
                try {
                    $dump = GF_FlymeFile::decode($raw, $password);
                } catch (Exception $fe) {
                    flyme_fail($fe->getMessage(), 400);
                }
            }

            $scope      = (isset($dump['scope']) && $dump['scope'] === 'site') ? 'site' : 'all';
            $dumpTables = isset($dump['tables']) ? $dump['tables'] : null;
            if ($mode !== 'replace') {
                $mode = 'merge'; // 默认合并：只覆盖同名主键，不动备份里没有的行
            }
            if (!is_array($dumpTables) || count($dumpTables) === 0) {
                flyme_fail('备份文件里没有任何数据表', 400);
            }

            $existing = array();
            foreach (GF_Db::rows('SHOW TABLES') as $r) {
                $existing[] = (string) reset($r);
            }
            $exclude = $includeAdmins ? array() : array('flyme_admins', 'flyme_admin_sessions');

            // 先整体校验出「计划」，确认有东西可导再开事务
            $plan    = array();
            $skipped = array();
            foreach ($dumpTables as $t => $rows) {
                $t = (string) $t;
                if (!self::importTableAllowed($t, $scope)) {
                    $skipped[] = array('table' => $t, 'reason' => '不在允许导入的表名单内，已跳过');
                    continue;
                }
                if (in_array($t, $exclude, true)) {
                    $skipped[] = array('table' => $t, 'reason' => '管理员账号表，需勾选「同时导入管理员表」才会导入');
                    continue;
                }
                if (!in_array($t, $existing, true)) {
                    $skipped[] = array('table' => $t, 'reason' => '当前数据库里没有这张表');
                    continue;
                }
                if (!is_array($rows)) {
                    $skipped[] = array('table' => $t, 'reason' => '数据格式不正确');
                    continue;
                }
                $cols = array();
                foreach (GF_Db::rows('SHOW COLUMNS FROM `' . $t . '`') as $c) {
                    $cols[] = (string) $c['Field'];
                }
                if (!$cols) {
                    $skipped[] = array('table' => $t, 'reason' => '读不到表结构');
                    continue;
                }
                $plan[$t] = array('columns' => $cols, 'rows' => $rows);
            }
            if (!$plan) {
                $first = isset($skipped[0]['reason']) ? $skipped[0]['reason'] : '没有可导入的数据';
                flyme_fail('没有可导入的数据表：' . $first, 400);
            }

            @set_time_limit(300); // 大表导入可能超过默认 30s
            $report   = array();
            $totalRow = 0;
            GF_Db::q('START TRANSACTION');
            try {
                foreach ($plan as $t => $p) {
                    if ($mode === 'replace') {
                        GF_Db::q('DELETE FROM `' . $t . '`'); // 事务内可回滚，比 TRUNCATE 安全
                    }
                    $n = 0;
                    foreach ($p['rows'] as $row) {
                        if (!is_array($row)) {
                            continue;
                        }
                        $use  = array();
                        $vals = array();
                        foreach ($p['columns'] as $c) {
                            if (array_key_exists($c, $row)) {
                                $use[]  = $c;
                                $v      = $row[$c];
                                if (is_bool($v)) {
                                    $v = $v ? 1 : 0;
                                } elseif (is_array($v)) {
                                    $v = json_encode($v, JSON_UNESCAPED_UNICODE);
                                }
                                $vals[] = $v;
                            }
                        }
                        if (!$use) {
                            continue;
                        }
                        $colList = '`' . implode('`,`', $use) . '`';
                        $ph      = implode(',', array_fill(0, count($use), '?'));
                        $upd     = array();
                        foreach ($use as $c) {
                            $upd[] = '`' . $c . '` = VALUES(`' . $c . '`)';
                        }
                        GF_Db::q(
                            'INSERT INTO `' . $t . '` (' . $colList . ') VALUES (' . $ph . ')'
                            . ' ON DUPLICATE KEY UPDATE ' . implode(', ', $upd),
                            $vals
                        );
                        $n++;
                    }
                    $report[$t] = array('imported' => $n, 'total' => count($p['rows']), 'mode' => $mode);
                    $totalRow  += $n;
                }
                GF_Db::q('COMMIT');
            } catch (Exception $e) {
                try {
                    GF_Db::q('ROLLBACK');
                } catch (Exception $e2) {
                    /* 回滚失败也只能继续抛原始错误 */
                }
                error_log('[nawu-api] backup import failed: ' . $e->getMessage());
                flyme_fail('导入失败，已回滚，数据库未改动', 500);
            }

            flyme_ok(array(
                'scope'     => $scope,
                'mode'      => $mode,
                'tables'    => $report,
                'skipped'   => $skipped,
                'tableCount' => count($report),
                'rowCount'  => $totalRow,
            ));
        }

        if ($path === '/api/admin/settings' && $method === 'POST') {
            $key = flyme_str(flyme_param('key'));
            $map = GF_Schema::defaultSettings();
            if ($key === '' || !isset($map[$key])) {
                flyme_fail('未知设置项：' . $key, 400);
            }
            $val = flyme_param('value');
            GF_Auth::set($key, $val === null ? '' : (string) $val);
            flyme_ok();
        }

        /* ---- 用户管理 ---- */
        if ($path === '/api/admin/users' && $method === 'GET') {
            /* ★v1.1：display_name 以 flyme_profiles 为准（用户端「账号编辑」写的是它），
               users 表同名列只是登录期的历史值——LEFT JOIN + COALESCE 两者都取到，
               兼容 v1.1 之前改过昵称但没同步进 users 表的老数据。 */
            $rows = GF_Db::rows(
                'SELECT u.`email`, COALESCE(p.`display_name`, u.`display_name`) AS `display_name`,
                        u.`verified`, u.`disabled`, u.`created_at`, u.`last_login_at`
                 FROM `flyme_users` u
                 LEFT JOIN `flyme_profiles` p ON p.`owner_id` = u.`email`
                 ORDER BY u.`created_at` DESC LIMIT 500'
            );
            $out = array();
            foreach ($rows as $r) {
                $out[] = array(
                    'email'         => $r['email'],
                    'display_name'  => $r['display_name'],
                    'verified'      => (bool) intval($r['verified']),
                    'disabled'      => (bool) intval($r['disabled']),
                    'created_at'    => flyme_iso($r['created_at']),
                    'last_login_at' => flyme_iso($r['last_login_at']),
                );
            }
            flyme_ok(array('rows' => $out));
        }

        if ($path === '/api/admin/users/password' && $method === 'POST') {
            $email = strtolower(flyme_str(flyme_param('email')));
            $np    = (string) flyme_param('newPassword', '');
            if (strlen($np) < 6) {
                flyme_fail('新密码至少 6 位', 400);
            }
            $st = GF_Db::q('UPDATE `flyme_users` SET `pass_hash` = ?, `salt` = ? WHERE `email` = ?', array(flyme_pw_hash($np), '', $email));
            if (!$st || !$st->rowCount()) {
                flyme_fail('用户不存在', 404);
            }
            GF_Auth::killUserSessions($email);
            flyme_ok();
        }

        if ($path === '/api/admin/users/verify' && $method === 'POST') {
            $email = strtolower(flyme_str(flyme_param('email')));
            $st = GF_Db::q('UPDATE `flyme_users` SET `verified` = ? WHERE `email` = ?', array(flyme_param('verified') ? 1 : 0, $email));
            if (!$st || !$st->rowCount()) {
                flyme_fail('用户不存在', 404);
            }
            flyme_ok();
        }

        if ($path === '/api/admin/users/disable' && $method === 'POST') {
            $email   = strtolower(flyme_str(flyme_param('email')));
            $disable = flyme_param('disabled') ? 1 : 0;
            $st = GF_Db::q('UPDATE `flyme_users` SET `disabled` = ? WHERE `email` = ?', array($disable, $email));
            if (!$st || !$st->rowCount()) {
                flyme_fail('用户不存在', 404);
            }
            GF_Db::q('UPDATE `flyme_directory` SET `disabled` = ? WHERE `owner_id` = ?', array($disable, $email));
            if ($disable) {
                GF_Auth::killUserSessions($email);
            }
            flyme_ok();
        }

        if ($path === '/api/admin/users/delete' && $method === 'POST') {
            $email = strtolower(flyme_str(flyme_param('email')));
            $st = GF_Db::q('DELETE FROM `flyme_users` WHERE `email` = ?', array($email));
            if (!$st || !$st->rowCount()) {
                flyme_fail('用户不存在', 404);
            }
            GF_Db::q('DELETE FROM `flyme_sessions` WHERE `email` = ?', array($email));
            GF_Db::q('DELETE FROM `flyme_backups` WHERE `owner_id` = ?', array($email));
            GF_Db::q('DELETE FROM `flyme_profiles` WHERE `owner_id` = ?', array($email));
            flyme_ok();
        }

        /* ---- 数据库连接在线配置 ---- */
        if ($path === '/api/admin/dbconf' && $method === 'GET') {
            $connected = false;
            try {
                GF_Db::q('SELECT 1');
                $connected = true;
            } catch (Exception $e) {
                $connected = false;
            }
            $c = GF_Config::db();
            flyme_ok(array(
                'host'       => $c['host'],
                'port'       => (int) $c['port'],
                'user'       => $c['user'],
                'database'   => $c['name'],
                'passMasked' => flyme_mask_secret($c['pass']),
                'connected'  => $connected,
                'dbError'    => $connected ? '' : (GF_Db::error() ? GF_Db::error() : '未连接'),
                'fileActive' => true,
            ));
        }

        if ($path === '/api/admin/dbconf/test' && $method === 'POST') {
            $target = self::mergeDbConf(flyme_body());
            list($okT, $errT) = GF_Db::test($target);
            if (!$okT) {
                $hintT = flyme_db_hint($errT);
                flyme_fail($errT . ($hintT !== '' ? "\n\n" . $hintT : ''), 400);
            }
            flyme_ok();
        }

        if ($path === '/api/admin/dbconf' && $method === 'POST') {
            $target = self::mergeDbConf(flyme_body());
            list($ok, $err) = GF_Db::test($target);
            if (!$ok) {
                flyme_fail('连接失败，配置未保存：' . $err, 400);
            }
            $res = GF_Config::saveDb(array(
                'host' => $target['host'],
                'port' => $target['port'],
                'user' => $target['user'],
                'pass' => $target['pass'],
                'name' => $target['name'],
            ));
            if ($res !== true) {
                flyme_fail($res, 500);
            }
            GF_Db::reconnect();
            if (!GF_Db::connected()) {
                flyme_fail('配置已保存，但重连失败：' . GF_Db::error(), 500);
            }
            flyme_ok();
        }

        /* ---- SMTP ---- */
        if ($path === '/api/admin/smtp' && $method === 'GET') {
            $conf = self::loadSmtp();
            if (!$conf) {
                flyme_ok(array('configured' => false));
            }
            flyme_ok(array(
                'configured' => true,
                'host'       => $conf['host'],
                'port'       => (int) $conf['port'],
                'secure'     => !empty($conf['secure']),
                'user'       => $conf['user'],
                'from'       => $conf['from'],
                'passMasked' => flyme_mask_secret($conf['pass']),
            ));
        }

        if ($path === '/api/admin/smtp' && $method === 'POST') {
            $old  = self::loadSmtp();
            $pass = (string) flyme_param('pass', '');
            $port = flyme_int(flyme_param('port', 0), 0);
            $normSecure = ($port === 465) ? true : !empty(flyme_param('secure'));

            if ($pass === '' && $old) {
                $conf = array(
                    'host'   => flyme_str(flyme_param('host', $old['host'])),
                    'port'   => $port > 0 ? $port : (int) $old['port'],
                    'secure' => flyme_param('secure') === null ? !empty($old['secure']) : $normSecure,
                    'user'   => flyme_str(flyme_param('user', $old['user'])),
                    'pass'   => $old['pass'],
                    'from'   => flyme_str(flyme_param('from') === null ? $old['from'] : flyme_param('from')),
                );
            } else {
                $conf = array(
                    'host'   => flyme_str(flyme_param('host', '')),
                    'port'   => $port > 0 ? $port : 25,
                    'secure' => $normSecure,
                    'user'   => flyme_str(flyme_param('user', '')),
                    'pass'   => $pass,
                    'from'   => flyme_str(flyme_param('from', '')),
                );
                if ($conf['host'] === '' || $conf['user'] === '' || $conf['pass'] === '') {
                    flyme_fail('SMTP 服务器、账号、密码/授权码均必填', 400);
                }
            }
            if ($conf['port'] === 0) {
                $conf['port'] = !empty($conf['secure']) ? 465 : 25;
            }
            if ($conf['from'] === '') {
                $conf['from'] = $conf['user'];
            }
            // 发件邮箱必须与登录账号一致：QQ / 163 / Gmail 会直接拒绝不一致的 MAIL FROM（501）
            if ($conf['user'] !== '' && strcasecmp($conf['from'], $conf['user']) !== 0) {
                $conf['from'] = $conf['user'];
            }
            GF_Auth::set('smtpJson', json_encode($conf, JSON_UNESCAPED_UNICODE));
            flyme_ok();
        }

        if ($path === '/api/admin/smtp/clear' && $method === 'POST') {
            GF_Auth::set('smtpJson', '');
            flyme_ok();
        }

        if ($path === '/api/admin/smtp/test' && $method === 'POST') {
            $to = flyme_str(flyme_param('to'));
            if (!flyme_valid_email($to)) {
                flyme_fail('请输入正确的测试收件邮箱', 400);
            }
            $conf = self::loadSmtp();
            if (!$conf) {
                flyme_fail('尚未配置发件邮箱（SMTP），无法发送测试邮件', 400);
            }
            list($ok, $err) = GF_Mail::buildTransport($conf)->send($to, '纳物 · SMTP 测试邮件', "这是一封测试邮件：收到它说明发件邮箱配置成功，用户注册验证码可以正常送达。\n\n发送时间：" . date('Y-m-d H:i:s'));
            if (!$ok) {
                flyme_fail($err, 400);
            }
            flyme_ok();
        }

        /* ---- 用户名册 ---- */
        if ($path === '/api/admin/directory' && $method === 'GET') {
            $rows = GF_Db::rows(
                'SELECT `owner_id`, `display_name`, `last_login_at`, `disabled`, `note`, `created_at` FROM `flyme_directory` ORDER BY `created_at` DESC LIMIT 500'
            );
            $out = array();
            foreach ($rows as $r) {
                $out[] = array(
                    'owner_id'      => $r['owner_id'],
                    'display_name'  => $r['display_name'],
                    'last_login_at' => flyme_iso($r['last_login_at']),
                    'disabled'      => (bool) intval($r['disabled']),
                    'note'          => $r['note'],
                    'created_at'    => flyme_iso($r['created_at']) !== null ? flyme_iso($r['created_at']) : gmdate('c'),
                );
            }
            flyme_ok(array('rows' => $out));
        }

        if ($path === '/api/admin/directory/disable' && $method === 'POST') {
            $owner = flyme_str(flyme_param('owner_id'));
            if ($owner === '') {
                flyme_fail('owner_id required', 400);
            }
            $note = flyme_param('note');
            $st = GF_Db::q(
                'UPDATE `flyme_directory` SET `disabled` = ?, `note` = ? WHERE `owner_id` = ?',
                array(flyme_param('disabled') ? 1 : 0, is_string($note) ? $note : null, $owner)
            );
            if (!$st || !$st->rowCount()) {
                flyme_fail('该用户尚未登录过本应用', 404);
            }
            flyme_ok();
        }

        if ($path === '/api/admin/directory/remove' && $method === 'POST') {
            $st = GF_Db::q('DELETE FROM `flyme_directory` WHERE `owner_id` = ?', array(flyme_str(flyme_param('owner_id'))));
            if (!$st || !$st->rowCount()) {
                flyme_fail('没有可移除的记录', 404);
            }
            flyme_ok();
        }

        /* ---- 数据库信息（仅管理员） ---- */
        if ($path === '/api/admin/dbinfo' && $method === 'GET') {
            $t0 = microtime(true);
            $tables = array();
            try {
                GF_Db::q('SELECT 1');
                $latencyMs = (int) round((microtime(true) - $t0) * 1000);
                foreach (GF_Db::rows('SHOW TABLES') as $r) {
                    $tables[] = (string) reset($r);
                }
            } catch (Exception $e) {
                flyme_ok(array('ok' => true, 'connected' => false, 'error' => $e->getMessage()));
            }
            $cnt = (int) GF_Db::val('SELECT COUNT(*) AS n FROM `app_rows`', array(), 0);
            $c   = GF_Config::db();
            flyme_ok(array(
                'connected' => true,
                'host'      => $c['host'] . ':' . $c['port'],
                'database'  => $c['name'],
                'user'      => flyme_mask_secret($c['user']),
                'latencyMs' => $latencyMs,
                'tables'    => $tables,
                'rowCount'  => $cnt,
                'driver'    => 'pdo_mysql',
            ));
        }

        flyme_fail('not found', 404);
    }

    /* =================== 旧「自建服务器」协议兼容 =================== */

    private static function sync($path, $method)
    {
        $me = GF_Auth::currentUser();
        if (!$me) {
            flyme_fail('登录状态已失效，请重新登录', 401);
        }

        if ($path === '/api/sync/list' && $method === 'GET') {
            $rows = GF_Db::rows(
                'SELECT `id`, `label`, `item_count`, `bytes`, `device`, `created_at` FROM `flyme_backups` WHERE `owner_id` = ? ORDER BY `id` DESC LIMIT 50',
                array($me['email'])
            );
            $out = array();
            foreach ($rows as $r) {
                $out[] = array(
                    'id'         => (int) $r['id'],
                    'label'      => $r['label'],
                    'item_count' => (int) $r['item_count'],
                    'bytes'      => (int) $r['bytes'],
                    'created_at' => flyme_iso($r['created_at']),
                );
            }
            flyme_ok(array('rows' => $out));
        }

        if ($path === '/api/sync/push' && $method === 'POST') {
            // v1.0.33 安全修复：备份频率限制 60 次/小时
            list($allow, $wait) = flyme_throttle_check('backup', $me['email'], 60, 3600);
            if (!$allow) {
                flyme_fail('备份操作太频繁，请 ' . $wait . ' 秒后再试', 429);
            }
            flyme_throttle_fail('backup', $me['email'], 60, 3600);
            $payloadRaw = flyme_param('payload');
            $payload    = is_string($payloadRaw) ? $payloadRaw : json_encode($payloadRaw, JSON_UNESCAPED_UNICODE);
            if (!is_string($payload)) {
                $payload = '';
            }
            // 入库前归一化：保证将来「覆盖恢复」时结构一定可用
            // （缺失的集合补空数组、非数组值剔除，避免恢复后前端因读到 undefined/null 崩溃白屏）
            $payload = self::normalizeBackupPayload($payload);
            if (strlen($payload) > self::BACKUP_MAX_BYTES) {
                flyme_fail('备份内容过大（上限 16MB），请清理历史数据后再试', 400);
            }
            GF_Db::q(
                'INSERT INTO `flyme_backups` (`owner_id`, `label`, `payload`, `item_count`, `bytes`, `device`) VALUES (?, ?, ?, ?, ?, ?)',
                array(
                    $me['email'],
                    flyme_str(flyme_param('label', '手动备份'), 120),
                    $payload,
                    flyme_int(flyme_param('item_count', 0)),
                    strlen($payload),
                    flyme_str(flyme_param('device', ''), 110),
                )
            );
            self::trimBackups($me['email'], 3);
            flyme_ok(array('id' => (int) GF_Db::insertId()));
        }

        if ($path === '/api/sync/pull' && $method === 'GET') {
            $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
            if ($id <= 0) {
                flyme_fail('缺少 id', 400);
            }
            self::requireDb();
            $r = GF_Db::one('SELECT `payload` FROM `flyme_backups` WHERE `id` = ? AND `owner_id` = ?', array($id, $me['email']));
            if (!$r) {
                flyme_fail('备份不存在', 404);
            }
            $payload = json_decode($r['payload'], true);
            flyme_ok(array('payload' => json_last_error() === JSON_ERROR_NONE ? $payload : $r['payload']));
        }

        if ($path === '/api/sync/delete' && $method === 'POST') {
            $id = (int) flyme_param('id', 0);
            $st = GF_Db::q('DELETE FROM `flyme_backups` WHERE `id` = ? AND `owner_id` = ?', array($id, $me['email']));
            if (!$st || !$st->rowCount()) {
                flyme_fail('备份不存在', 404);
            }
            flyme_ok();
        }

        flyme_fail('not found', 404);
    }

    /** 保留最近 N 份备份，其余删掉 */
    /**
     * 备份 payload 归一化（防御性）。
     *
     * 目标：任何来源（网页版 / App / 旧版本 / 手工构造）上传的备份，在将来被「覆盖恢复」时
     * 都不会因为结构缺失而让前端读到 undefined / null 导致启动崩溃（白屏）。
     *
     * 规则（只补全、绝不丢弃用户数据）：
     *   1. 期望结构：{ collections: {12 个集合均为数组}, settings: object, count, app, version, exportedAt }
     *   2. collections 缺失时，兼容旧「扁平」结构（集合直接挂在顶层）
     *   3. 缺失的集合补 []；值不是数组的按 [] 处理（坏数据宁可为空也不要崩）
     *   4. settings 必须为对象
     *   5. 无法解析为数组的 payload 原样返回（不应由这层负责报错）
     */
    /**
     * 「导入备份」允许写入的表名单（v1.0.34）。
     *
     * - 表名必须是纯标识符（`[A-Za-z0-9_]`），杜绝反引号/SQL 片段注入；
     * - scope=site 只认站点数据三张表（与导出端 `scope=site` 一一对应）；
     * - scope=all 只认 `flyme_` / `app_` 前缀的业务表，绝不放行库里的任何其他表。
     */
    private static function importTableAllowed($table, $scope)
    {
        if (!is_string($table) || !preg_match('/^[A-Za-z0-9_]{1,64}$/', $table)) {
            return false;
        }
        if ($scope === 'site') {
            return in_array($table, array('flyme_users', 'flyme_backups', 'flyme_directory'), true);
        }
        return strpos($table, 'flyme_') === 0 || strpos($table, 'app_') === 0;
    }

    private static function normalizeBackupPayload($payload)
    {
        $names = array(
            'goods', 'subscriptions', 'bills', 'valueRecords', 'moods', 'times',
            'wishlist', 'cooldowns', 'categories', 'usageRecords', 'reminders', 'walls',
        );
        $data = json_decode($payload, true);
        if (!is_array($data)) {
            return $payload;
        }

        $collections = null;
        if (isset($data['collections']) && is_array($data['collections'])) {
            $collections = $data['collections'];
        } else {
            // 旧结构兼容：集合直接挂在顶层
            $collections = array();
            $found = false;
            foreach ($names as $n) {
                if (array_key_exists($n, $data)) {
                    $found = true;
                    $collections[$n] = $data[$n];
                }
            }
            if (!$found) {
                $collections = null;
            }
        }

        if (is_array($collections)) {
            $clean = array();
            foreach ($names as $n) {
                $v = isset($collections[$n]) ? $collections[$n] : array();
                $clean[$n] = is_array($v) ? $v : array();
            }
            // 保留客户端可能扩展的其它集合（同样校验为数组）
            foreach ($collections as $k => $v) {
                if (!isset($clean[$k]) && is_string($k)) {
                    $clean[$k] = is_array($v) ? $v : array();
                }
            }
            $data['collections'] = $clean;

            if (!isset($data['count']) || !is_int($data['count'])) {
                $data['count'] = 0;
            }
            if (!isset($data['app'])) {
                $data['app'] = 'flyme-web';
            }
            if (!isset($data['version'])) {
                $data['version'] = 1;
            }
            if (isset($data['settings']) && !is_array($data['settings'])) {
                $data['settings'] = array();
            }

            // 实体级加固：物品缺少 image 字段时前端渲染会直接崩溃（Cannot read properties of undefined）
            if (is_array($clean['goods'])) {
                foreach ($clean['goods'] as $i => $g) {
                    if (!is_array($g)) {
                        unset($clean['goods'][$i]);
                        continue;
                    }
                    if (!isset($g['image']) || !is_array($g['image'])) {
                        $g['image'] = array('source' => 'system', 'ref' => '📦');
                    }
                    if (!isset($g['extraFees']) || !is_array($g['extraFees'])) {
                        $g['extraFees'] = array();
                    }
                    if (!isset($g['incomes']) || !is_array($g['incomes'])) {
                        $g['incomes'] = array();
                    }
                    $clean['goods'][$i] = $g;
                }
                $clean['goods'] = array_values($clean['goods']);
            }
            $data['collections'] = $clean;
        }

        $encoded = json_encode($data, JSON_UNESCAPED_UNICODE);
        return $encoded === false ? $payload : $encoded;
    }

    private static function trimBackups($ownerId, $keep = 3)
    {
        $keepRows = GF_Db::rows(
            'SELECT `id` FROM `flyme_backups` WHERE `owner_id` = ? ORDER BY `id` DESC LIMIT ' . (int) $keep,
            array($ownerId)
        );
        $ids = array();
        foreach ($keepRows as $r) {
            $ids[] = (int) $r['id'];
        }
        if (count($ids)) {
            GF_Db::q(
                'DELETE FROM `flyme_backups` WHERE `owner_id` = ? AND `id` NOT IN (' . implode(',', $ids) . ')',
                array($ownerId)
            );
        }
    }

    /** 全局设置：登录即可读，改需要管理员 */
    private static function legacySettings($method)
    {
        if (!GF_Auth::currentUser() && !GF_Auth::currentAdmin()) {
            flyme_fail('登录状态已失效', 401);
        }
        self::requireDb();
        if ($method === 'GET') {
            $s = GF_Auth::settings();
            $configured = !empty($s['smtpJson']);
            unset($s['smtpJson']);
            $s['smtpConfigured'] = $configured ? 'true' : 'false';
            flyme_ok(array('settings' => $s));
        }
        if ($method === 'POST') {
            if (!GF_Auth::currentAdmin()) {
                flyme_fail('只有管理员可以修改全局设置', 403);
            }
            $key = flyme_str(flyme_param('key'));
            $map = GF_Schema::defaultSettings();
            if ($key === '' || !isset($map[$key])) {
                flyme_fail('未知设置项：' . $key, 400);
            }
            GF_Auth::set($key, (string) flyme_param('value', ''));
            flyme_ok();
        }
        flyme_fail('method not allowed', 405);
    }

    /* =================== App 版本 / 安装包下发（免鉴权） =================== */

    /** 应用发布目录（manifest.json + apk 都放这里，由维护者手动上传）。 */
    private static function appReleaseDir()
    {
        return GF_ROOT . '/storage/app-release';
    }

    /**
     * 读取 manifest.json；文件缺失或损坏时返回全空的默认结构
     * （version 为空 → 客户端视为「无更新」）。
     */
    private static function readAppManifest()
    {
        $empty = array('version' => '', 'notes' => '', 'fileSize' => 0, 'publishedAt' => '', 'file' => '');
        $file  = self::appReleaseDir() . '/manifest.json';
        if (!is_file($file)) {
            return $empty;
        }
        $raw = file_get_contents($file);
        $m   = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($m)) {
            return $empty;
        }
        return array(
            'version'     => isset($m['version']) ? (string) $m['version'] : '',
            'notes'       => isset($m['notes']) ? (string) $m['notes'] : '',
            'fileSize'    => isset($m['fileSize']) ? (int) $m['fileSize'] : 0,
            'publishedAt' => isset($m['publishedAt']) ? (string) $m['publishedAt'] : '',
            'file'        => isset($m['file']) ? (string) $m['file'] : '',
        );
    }

    /** GET /api/app/version → 当前发布的版本信息。 */
    private static function appVersion()
    {
        $m = self::readAppManifest();
        flyme_json(array(
            'ok'          => true,
            'version'     => $m['version'],
            'notes'       => $m['notes'],
            'fileSize'    => $m['fileSize'],
            'publishedAt' => $m['publishedAt'],
        ));
    }

    /**
     * GET /api/app/download → 流式下发安装包。
     *
     * - 文件名只从 manifest 的 `file` 取，且拒绝路径穿越（/ \ ..）；
     * - filename 统一用 ASCII（app.apk），避免 header 里的中文编码问题；
     * - Content-Length 用真实文件大小，不信任 manifest 里的 fileSize。
     */
    private static function appDownload()
    {
        $m    = self::readAppManifest();
        $name = $m['file'];
        if ($name === '' || strpos($name, '/') !== false || strpos($name, '\\') !== false || strpos($name, '..') !== false) {
            flyme_fail('暂无安装包', 404);
        }
        $path = self::appReleaseDir() . '/' . $name;
        if (!is_file($path)) {
            flyme_fail('暂无安装包', 404);
        }
        $size = filesize($path);
        if ($size === false) {
            flyme_fail('暂无安装包', 404);
        }
        header('Content-Type: application/vnd.android.package-archive');
        header('Content-Length: ' . $size);
        header('Content-Disposition: attachment; filename="app.apk"');
        header('Cache-Control: no-store');
        readfile($path);
        exit;
    }

    /**
     * POST /api/admin/app-release（v1.0.36）：后台发布 App 安装包。
     *
     * - raw body = APK 字节：不走 $_FILES，绕开 upload_max_filesize / post_max_size；
     * - version / notes 走 query string（flyme_param() 只读 body，见 Support.php L77）；
     * - 校验链：大小（1MB~300MB）→ PK zip 头 → 含 AndroidManifest.xml / classes.dex；
     * - 落盘 storage/app-release/nawu-v<version>.apk + 原子写 manifest.json
     *   （旧条目压入 history，cap 10；清理上一版 apk 避免堆积）。
     */
    private static function publishAppRelease()
    {
        $version = isset($_GET['version']) ? trim((string) $_GET['version']) : '';
        $notes   = isset($_GET['notes']) ? (string) $_GET['notes'] : '';
        if (!preg_match('/^[0-9A-Za-z._-]{1,32}$/', $version)) {
            flyme_fail('版本号不合法（仅限字母/数字/点/中划线/下划线，≤32 位）', 400);
        }
        $notes = flyme_str($notes, 4000);

        $dir = self::appReleaseDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        if (!is_dir($dir)) {
            flyme_fail('安装包目录不可写：storage/app-release', 500);
        }

        // 流式读入临时文件（php://input 不受 post_max_size 限制）
        $tmp = $dir . '/.upload-' . getmypid() . '.apk';
        $in  = @fopen('php://input', 'rb');
        if (!$in) {
            flyme_fail('无法读取上传数据', 500);
        }
        $out = @fopen($tmp, 'wb');
        if (!$out) {
            fclose($in);
            flyme_fail('无法写入临时文件（storage 目录权限？）', 500);
        }
        $size    = 0;
        $tooBig  = false;
        while (!feof($in)) {
            $buf = fread($in, 262144);
            if ($buf === '' || $buf === false) {
                break;
            }
            $size += strlen($buf);
            if ($size > 314572800) { // 300MB
                $tooBig = true;
                break;
            }
            fwrite($out, $buf);
        }
        fclose($in);
        fclose($out);
        if ($tooBig) {
            @unlink($tmp);
            flyme_fail('安装包超过 300MB 上限', 413);
        }
        if ($size < 1048576) {
            @unlink($tmp);
            flyme_fail('文件太小（<1MB），不是有效的安装包', 400);
        }

        // 体检 1：PK zip 头
        $fh = @fopen($tmp, 'rb');
        if (!$fh) {
            @unlink($tmp);
            flyme_fail('无法读取上传文件', 500);
        }
        $head = fread($fh, 4);
        fclose($fh);
        if ($head !== "PK\x03\x04") {
            @unlink($tmp);
            flyme_fail('不是有效的 APK（文件头不是 PK zip）', 400);
        }

        // 体检 2：分块检索关键条目名（条目名在 zip 中央目录中是明文）
        $needles = array('AndroidManifest.xml' => false, 'classes.dex' => false);
        $fh = @fopen($tmp, 'rb');
        if ($fh) {
            $prev = '';
            while (!feof($fh)) {
                $buf = fread($fh, 1048576);
                if ($buf === '' || $buf === false) {
                    break;
                }
                $win = $prev . $buf;
                foreach (array_keys($needles) as $n) {
                    if (!$needles[$n] && strpos($win, $n) !== false) {
                        $needles[$n] = true;
                    }
                }
                $prev = substr($buf, -64);
            }
            fclose($fh);
        }
        if (!$needles['AndroidManifest.xml'] || !$needles['classes.dex']) {
            @unlink($tmp);
            flyme_fail('不是有效的 APK（缺少 AndroidManifest.xml / classes.dex）', 400);
        }

        // 落盘（rename 优先，失败退回 copy）
        $name = 'nawu-v' . $version . '.apk';
        $dest = $dir . '/' . $name;
        if (!@rename($tmp, $dest)) {
            @copy($tmp, $dest);
            @unlink($tmp);
            if (!is_file($dest)) {
                flyme_fail('保存安装包失败（storage 目录权限？）', 500);
            }
        }
        @chmod($dest, 0644);

        // manifest：旧条目进 history（cap 10）→ 原子写
        $mfile = $dir . '/manifest.json';
        $old   = array();
        if (is_file($mfile)) {
            $d = json_decode((string) @file_get_contents($mfile), true);
            if (is_array($d)) {
                $old = $d;
            }
        }
        $history = (isset($old['history']) && is_array($old['history'])) ? $old['history'] : array();
        $replaced = !empty($old['version']) && (string) $old['version'] !== $version;
        if ($replaced) {
            $history[] = array(
                'version'     => (string) $old['version'],
                'file'        => isset($old['file']) ? (string) $old['file'] : '',
                'fileSize'    => isset($old['fileSize']) ? (int) $old['fileSize'] : 0,
                'publishedAt' => isset($old['publishedAt']) ? (string) $old['publishedAt'] : '',
                'notes'       => isset($old['notes']) ? (string) $old['notes'] : '',
            );
            if (count($history) > 10) {
                $history = array_slice($history, -10);
            }
        }
        $manifest = array(
            'app'         => 'nawu',
            'version'     => $version,
            'notes'       => $notes,
            'file'        => $name,
            'fileSize'    => $size,
            'publishedAt' => date('Y-m-d H:i'),
            'history'     => $history,
        );
        $json = json_encode($manifest, JSON_UNESCAPED_UNICODE);
        $mtmp = $mfile . '.' . getmypid() . '.tmp';
        if ($json === false || @file_put_contents($mtmp, $json) === false || !@rename($mtmp, $mfile)) {
            @unlink($mtmp);
            flyme_fail('写入 manifest 失败', 500);
        }
        @chmod($mfile, 0644);

        // 清理上一版 apk（当前 manifest 只认最新文件，旧包留着纯占地方）
        foreach (glob($dir . '/nawu-v*.apk') as $f) {
            if (basename($f) !== $name) {
                @unlink($f);
            }
        }

        flyme_ok(array(
            'manifest'     => array(
                'version'     => $version,
                'file'        => $name,
                'fileSize'    => $size,
                'publishedAt' => $manifest['publishedAt'],
            ),
            'historyCount' => count($history),
            'replaced'     => $replaced,
        ));
    }

    /* =================== 公共小工具 =================== */

    private static function requireDb()
    {
        GF_Db::conn();
        if (!GF_Db::connected()) {
            // v1.0.33 安全修复：数据库错误细节只进日志，不回显给客户端
            error_log('[nawu-api] db unavailable: ' . (GF_Db::error() ? GF_Db::error() : 'uninitialized'));
            flyme_fail('服务暂时不可用，请稍后再试', 503);
        }
    }

    /**
     * 服务端版本号（v1.0.36 新增）：读 app/VERSION。
     * 文件缺失/内容非法时回落 '0.0.0'（在线更新会视为「需全量对齐」）。
     */
    private static function serverVersion()
    {
        static $v = null;
        if ($v !== null) {
            return $v;
        }
        $file = GF_ROOT . '/app/VERSION';
        $raw  = is_file($file) ? trim((string) @file_get_contents($file)) : '';
        $v    = preg_match('/^[0-9A-Za-z._-]{1,32}$/', $raw) ? $raw : '0.0.0';
        return $v;
    }

    private static function touchDirectoryDb($ownerId, $displayName)
    {
        try {
            if ($displayName === null || $displayName === '') {
                $displayName = null;
            } else {
                $displayName = flyme_str($displayName, 128);
            }
            GF_Db::q(
                'INSERT INTO `flyme_directory` (`owner_id`, `display_name`, `last_login_at`) VALUES (?, ?, NOW())
                 ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`), `last_login_at` = VALUES(`last_login_at`)',
                array($ownerId, $displayName)
            );
        } catch (Exception $e) {
            /* 名册失败不影响主流程 */
        }
    }

    private static function loadSmtp()
    {
        $s = GF_Auth::settings();
        $raw = isset($s['smtpJson']) ? $s['smtpJson'] : '';
        if ($raw === '') {
            return null;
        }
        $c = json_decode($raw, true);
        if (!is_array($c) || empty($c['host']) || empty($c['user']) || !isset($c['pass'])) {
            return null;
        }
        return array(
            'host'   => (string) $c['host'],
            'port'   => (int) (isset($c['port']) ? $c['port'] : 25),
            'secure' => !empty($c['secure']),
            'user'   => (string) $c['user'],
            'pass'   => (string) $c['pass'],
            'from'   => isset($c['from']) ? (string) $c['from'] : (string) $c['user'],
        );
    }

    private static function sendMail($to, $subject, $text)
    {
        $conf = self::loadSmtp();
        if (!$conf) {
            throw new GF_UserError('管理员尚未配置发件邮箱（SMTP），暂时无法发送验证邮件');
        }
        if ($conf['port'] === 0) {
            $conf['port'] = !empty($conf['secure']) ? 465 : 25;
        }
        if ($conf['port'] === 465) {
            $conf['secure'] = true;
        }
        list($ok, $err) = GF_Mail::buildTransport($conf)->send($to, $subject, $text);
        if (!$ok) {
            throw new Exception($err);
        }
        return true;
    }

    private static function issueAndSendCode($email, $purpose)
    {
        $row = GF_Db::one(
            'SELECT `expires_at` FROM `flyme_verify_codes` WHERE `email` = ? AND `purpose` = ?',
            array($email, $purpose)
        );
        if ($row) {
            $created = (int) $row['expires_at'] - GF_Auth::CODE_TTL_MS;
            if ($created > (flyme_now_ms() - GF_Auth::CODE_RESEND_MS)) {
                throw new GF_UserError('验证码发送太频繁，请 1 分钟后再试');
            }
        }
        // v1.0.33 安全修复：random_int（CSPRNG）替代 mt_rand，
        // 6 位验证码不再可被预测/枚举
        $code     = (string) random_int(100000, 999999);
        $codeHash = flyme_sha256($code . ':' . $purpose . ':' . $email);
        GF_Db::q(
            'INSERT INTO `flyme_verify_codes` (`email`, `purpose`, `code_hash`, `expires_at`) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE `code_hash` = VALUES(`code_hash`), `expires_at` = VALUES(`expires_at`)',
            array($email, $purpose, $codeHash, flyme_now_ms() + GF_Auth::CODE_TTL_MS)
        );
        $siteName = GF_Auth::get('siteName', '');
        if ($siteName === '') {
            $siteName = '纳物';
        }
        $zh = $purpose === 'reset' ? '重置密码' : '注册验证';
        self::sendMail(
            $email,
            $siteName . ' · ' . $zh . '验证码',
            '你的' . $zh . '验证码是：' . $code . "\n\n10 分钟内有效。如果不是你本人的操作，请忽略这封邮件。"
        );
        return true;
    }

    private static function checkCode($email, $purpose, $code)
    {
        // v1.0.33 安全修复：同一邮箱+用途的验证码，5 次校验失败即锁定 30 分钟。
        // 修复前可无限次重试 6 位验证码（10 万空间），足以在线爆破任意账号的
        // 注册/重置码，直接导致账号接管。
        $scope = 'code:' . $purpose;
        list($allow, $wait) = flyme_throttle_check($scope, $email, 5, 1800);
        if (!$allow) {
            throw new GF_UserError('验证码错误次数过多，已暂时锁定，请 ' . $wait . ' 秒后再试');
        }
        $row = GF_Db::one(
            'SELECT `code_hash`, `expires_at` FROM `flyme_verify_codes` WHERE `email` = ? AND `purpose` = ?',
            array($email, $purpose)
        );
        if (!$row) {
            throw new GF_UserError('请先获取验证码');
        }
        if ((int) $row['expires_at'] < flyme_now_ms()) {
            throw new GF_UserError('验证码已过期，请重新获取');
        }
        if (flyme_sha256(flyme_str($code) . ':' . $purpose . ':' . $email) !== $row['code_hash']) {
            flyme_throttle_fail($scope, $email, 5, 1800, 1800);
            throw new GF_UserError('验证码不正确');
        }
        flyme_throttle_clear($scope, $email);
        GF_Db::q('DELETE FROM `flyme_verify_codes` WHERE `email` = ? AND `purpose` = ?', array($email, $purpose));
        return true;
    }

    private static function mergeDbConf($body)
    {
        $cur = GF_Config::db();
        $pick = function ($k, $default) use ($body, $cur) {
            $v = isset($body[$k]) ? $body[$k] : null;
            if ($v !== null && trim((string) $v) !== '') {
                return trim((string) $v);
            }
            return $default;
        };
        return array(
            'host' => $pick('host', $cur['host']),
            'port' => (int) $pick('port', $cur['port']),
            'user' => $pick('user', $cur['user']),
            'pass' => isset($body['password']) && (string) $body['password'] !== '' ? (string) $body['password'] : $cur['pass'],
            'name' => $pick('database', $cur['name']),
            'charset' => $cur['charset'],
        );
    }
}
