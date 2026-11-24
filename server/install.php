<?php
/**
 * 纳物 · 安装向导
 *
 * 五步走：环境检测 → 数据库 → 管理员 → 站点与邮件 → 完成
 * 中间状态落在 storage/.install.tmp（服务端），结束后写入 storage/config.php。
 * 安装完成后本文件自动锁定，如需重跑安装，删掉 storage/config.php 即可。
 */

if (!defined('GF_ROOT')) {
    define('GF_ROOT', dirname(__FILE__));
}
error_reporting(E_ALL);
ini_set('display_errors', '0');

date_default_timezone_set('Asia/Shanghai');

require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/Config.php';
require_once GF_ROOT . '/app/lib/Db.php';
require_once GF_ROOT . '/app/lib/Schema.php';

/* ---------------- CSRF 防护（v1.0.33 安全修复） ----------------
 * 安装向导的每一步都是「改配置 / 建表 / 建管理员」的高危写操作，
 * 旧版没有任何 CSRF 令牌：攻击者只要诱导已打开过向导的管理员访问一个
 * 恶意页面，就能跨站替他把站点「安装」到自己的数据库/管理员账号上。
 * 现在每个表单都带一次性会话令牌，POST 时必须匹配。 */
if (session_status() !== PHP_SESSION_ACTIVE) {
    @session_start();
}
if (empty($_SESSION['nawu_install_csrf'])) {
    $_SESSION['nawu_install_csrf'] = flyme_random_hex(16);
}

function install_csrf_ok()
{
    if (!install_session_ok()) {
        return true; // 会话不可用的极端环境不额外阻拦（POST 校验同样依赖会话）
    }
    $token = isset($_POST['csrf']) ? (string) $_POST['csrf'] : '';
    return $token !== '' && hash_equals((string) $_SESSION['nawu_install_csrf'], $token);
}

/** 第 5 步由 GET 触发，令牌从 URL 带（redirect_self 自动附加） */
function install_csrf_ok_get()
{
    if (!install_session_ok()) {
        return true;
    }
    $token = isset($_GET['csrf']) ? (string) $_GET['csrf'] : '';
    return $token !== '' && hash_equals((string) $_SESSION['nawu_install_csrf'], $token);
}

function install_session_ok()
{
    return session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['nawu_install_csrf']);
}

function install_csrf_field()
{
    return '<input type="hidden" name="csrf" value="' . h(isset($_SESSION['nawu_install_csrf']) ? $_SESSION['nawu_install_csrf'] : '') . '">';
}

$scriptDir = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : ''));
if ($scriptDir === '/' || $scriptDir === '.') {
    $scriptDir = '';
}

$baseUrl = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https://' : 'http://')
    . (isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : 'localhost')
    . $scriptDir;

$step  = isset($_POST['step']) ? (int) $_POST['step'] : (isset($_GET['step']) ? (int) $_GET['step'] : 1);
$state = GF_Config::loadTmp();

/* v1.0.33 安全修复：所有 POST 必须携带会话内的 CSRF 令牌 */
if (!empty($_POST) && !install_csrf_ok()) {
    redirect_self($step, '表单已过期或提交来源不合法，请返回重新操作');
}

/* 已完成安装时的锁定页 */
function render_locked_page($baseUrl)
{
    render_head('已安装');
    echo '<div class="done-card">
        <div class="done-icon">✓</div>
        <h2>纳物已经安装过了</h2>
        <p class="muted">站点配置已存在，为防止被陌生人重置，安装向导已锁定。</p>
        <div class="btns">
            <a class="btn primary" href="' . h($baseUrl . '/index.php') . '">进入纳物</a>
        </div>
        <details class="reinstall">
            <summary>我需要重新安装 / 重置后台账号</summary>
            <ol>
                <li>通过宝塔文件管理或 FTP 删除站点根目录下的 <code>storage/config.php</code></li>
                <li>刷新本页面即可重新进入安装向导</li>
                <li>忘记密码时，在第 3 步重新设置管理员账号即可覆盖</li>
            </ol>
            <p class="muted tiny">注意：重装不会删除数据库中已有的用户账号与表结构；同一个管理员账号会直接被新密码覆盖。</p>
        </details>
    </div>';
    render_foot();
}

if (GF_Config::installed()) {
    render_locked_page($baseUrl);
    exit;
}

/* ---------------- 步骤 1：环境检测 ---------------- */
if ($step === 1) {
    $checks = array();
    $fatal  = false;

    $phpVer = PHP_VERSION;
    $phpOk  = version_compare($phpVer, '7.2.0', '>=');
    $checks[] = array('PHP 版本', $phpVer, $phpOk, $phpOk ? 'ok' : 'bad', $phpOk ? '满足 7.2 ~ 8.0 要求' : '需要 PHP 7.2 及以上');

    $pdoOk = class_exists('PDO') && in_array('mysql', PDO::getAvailableDrivers(), true);
    $checks[] = array('PDO MySQL 扩展', $pdoOk ? '已加载' : '缺失', $pdoOk, $pdoOk ? 'ok' : 'bad', $pdoOk ? '数据库连接依赖' : '请在宝塔 PHP 管理中安装 pdo_mysql');

    $jsonOk = function_exists('json_encode');
    $checks[] = array('JSON 扩展', $jsonOk ? '已加载' : '缺失', $jsonOk, $jsonOk ? 'ok' : 'bad', '接口依赖');

    $mbOk = function_exists('mb_strlen') || function_exists('iconv');
    $checks[] = array('字符串编码处理', $mbOk ? '可用' : '缺失', true, $mbOk ? 'ok' : 'warn', '缺少 mbstring 时仍可运行，仅邮件编码略有妥协');

    $sslOk = function_exists('openssl_encrypt') || extension_loaded('openssl');
    $checks[] = array('OpenSSL（SMTP SSL 用）', $sslOk ? '已启用' : '未启用', true, $sslOk ? 'ok' : 'warn', '不启用将无法用 465 SSL 端口发信');

    // 目录可写
    $storageDir = GF_ROOT . '/storage';
    if (!is_dir($storageDir)) {
        @mkdir($storageDir, 0755, true);
    }
    $writable = is_dir($storageDir) && is_writable($storageDir);
    $checks[] = array('storage 目录可写', $writable ? '可写' : '不可写', $writable, $writable ? 'ok' : 'bad',
        $writable ? '配置文件将写入此处' : '请把 storage 目录权限设为 755（或改成 PHP 运行用户属主）');

    $memLimit = ini_get('memory_limit');
    $memBytes = return_bytes($memLimit);
    $memOk    = $memBytes <= 0 || $memBytes >= 64 * 1024 * 1024;
    $checks[] = array('内存限制', $memLimit, true, $memOk ? 'ok' : 'warn', $memOk ? '充足' : '建议 ≥ 64M');

    foreach ($checks as $c) {
        if ($c[3] === 'bad') {
            $fatal = true;
        }
    }

    if (isset($_POST['next'])) {
        if ($fatal) {
            $state['env_passed'] = false;
            GF_Config::saveTmp($state);
            redirect_self(1, '存在未通过的环境检查项，请处理后再继续');
        }
        $state['env_passed'] = true;
        $state['runtime']    = $phpVer;
        GF_Config::saveTmp($state);
        redirect_self(2);
    }

    render_head('第 1 步 · 环境检测');
    echo '<h2>第 1 步 · 环境检测</h2><p class="muted">先确认这台服务器能不能跑。目标环境：Nginx 1.21 / PHP 7.2 ~ 8.0 / MySQL 5.5。</p>';
    echo '<ul class="checklist">';
    foreach ($checks as $c) {
        echo '<li class="' . $c[3] . '"><span class="ci">' . ($c[3] === 'ok' ? '✓' : ($c[3] === 'warn' ? '!' : '✕')) . '</span>'
            . '<div><b>' . h($c[0]) . '</b><span class="cv">' . h((string) $c[1]) . '</span>'
            . '<p>' . h($c[4]) . '</p></div></li>';
    }
    echo '</ul>';
    echo '<form method="post"><input type="hidden" name="step" value="1"><input type="hidden" name="next" value="1">' . install_csrf_field() . '
          <div class="btns"><button class="btn primary"' . ($fatal ? ' disabled' : '') . '>下一步：配置数据库</button></div></form>';
    render_foot();
    exit;
}

/* ---------------- 步骤 2：数据库 ---------------- */
if ($step === 2) {
    $err   = '';
    $okMsg = '';
    $hint  = '';
    $hintHtml = '';
    if (isset($_POST['test']) || isset($_POST['next'])) {
        $host = flyme_str($_POST['db_host']);
        $port = (int) (isset($_POST['db_port']) ? $_POST['db_port'] : 3306);
        $name = flyme_str($_POST['db_name']);
        $user = flyme_str($_POST['db_user']);
        $pass = isset($_POST['db_pass']) ? (string) $_POST['db_pass'] : '';

        if ($host === '' || $name === '' || $user === '') {
            $err = '主机地址、数据库名、用户名都不能为空';
        } else {
            $conf = array('host' => $host, 'port' => $port ? $port : 3306, 'name' => $name, 'user' => $user, 'pass' => $pass, 'charset' => 'utf8mb4');
            $state['db'] = $conf;
            GF_Config::saveTmp($state);

            if (isset($_POST['test'])) {
                list($ok, $msg) = GF_Db::test($conf);
                // 库不存在时尝试给个更明确的提示
                if (!$ok && stripos($msg, 'Unknown database') !== false) {
                    list($ok2) = GF_Db::test(array_merge($conf, array('name' => '')));
                    if ($ok2) {
                        $msg = '服务器连得上，但找不到数据库「' . $name . '」。请确认库名，或先在数据库里建好这个库。';
                    }
                }
                if (!$ok && $hint === '' ) {
                    $hint = flyme_db_hint($msg);
                }
                if ($hint !== '') {
                    $hintHtml = '<div class="hint-box"><b>提示：</b>' . h($hint) . '</div>';
                }
                $okMsg = $ok ? '连接成功 ✓' : '';
                $err = $ok ? '' : $msg;
            } else {
                // next：测试 + 建表
                list($ok, $msg) = GF_Db::test($conf);
                if (!$ok) {
                    $err = '数据库连接失败，无法继续：' . $msg;
                } else {
                    // 先用这组参数直接建表（不落 config.php，避免中途失败留下残缺配置）
                    $res = run_install_ddl($conf);
                    if ($res[0] !== true) {
                        $err = '建表失败：' . $res[1];
                    } else {
                        $state['db_ok']  = true;
                        $state['db']     = $conf;
                        $state['tables'] = $res[1];
                        GF_Config::saveTmp($state);
                        redirect_self(3);
                    }
                }
            }
        }
    }

    $db = isset($state['db']) ? $state['db'] : array(
        'host' => '', 'port' => 3306, 'name' => '', 'user' => '', 'pass' => '',
    );

    render_head('第 2 步 · 数据库');
    if ($err !== '') {
        echo alert('error', $err);
        echo $hintHtml;
    } elseif ($okMsg !== '') {
        echo alert('ok', $okMsg);
    }
    echo '<h2>第 2 步 · 连接数据库</h2>
        <p class="muted">请填写你自己的数据库连接信息，<b>所有字段均为空白，需要你手工填写</b>。数据库可以是服务器上任意一台 MySQL：部署在本机就填 <b>127.0.0.1</b>，远程库填对应 IP 或域名，端口默认 <b>3306</b>。库名与用户名需事先在 MySQL 中创建好并授权。</p>
        <form method="post" class="form">
        <input type="hidden" name="step" value="2">' . install_csrf_field() . '
        <label>主机地址<div class="hint">IP 或域名；本机数据库填 127.0.0.1</div>
            <input type="text" name="db_host" value="' . h($db['host']) . '" placeholder="127.0.0.1" required></label>
        <div class="row2">
            <label>端口<input type="number" name="db_port" value="' . h((string) $db['port']) . '" min="1" max="65535"></label>
            <label>数据库名<input type="text" name="db_name" value="' . h($db['name']) . '" placeholder="数据库名" required></label>
        </div>
        <div class="row2">
            <label>用户名<input type="text" name="db_user" value="' . h($db['user']) . '" placeholder="数据库用户名" required autocomplete="off"></label>
            <label>密码<input type="password" name="db_pass" value="' . h($db['pass']) . '" placeholder="留空表示无密码" autocomplete="new-password"></label>
        </div>
        <div class="btns">
            <button class="btn" name="test" value="1">测试连接</button>
            <button class="btn primary" name="next" value="1">下一步：设置管理员</button>
        </div>
        <p class="tiny muted">点「下一步」会先测试连接，成功后自动创建 11 张表（已有表不会被覆盖）。</p>
        </form>';
    render_foot();
    exit;
}

/* ---------------- 步骤 3：管理员账号 ---------------- */
if ($step === 3) {
    if (empty($state['db_ok'])) {
        redirect_self(2, '请先完成数据库配置');
    }
    $err = '';
    if (isset($_POST['next'])) {
        $username = flyme_str($_POST['admin_user']);
        $pw1      = (string) $_POST['admin_pass'];
        $pw2      = (string) $_POST['admin_pass2'];
        $dispName = flyme_str($_POST['admin_display']);

        if ($username === '') {
            $err = '管理员账号不能为空';
        } elseif (!preg_match('/^[A-Za-z0-9_.-]{3,32}$/', $username)) {
            $err = '管理员账号只能是 3~32 位字母、数字、下划线、点或短横线';
        } elseif (strlen($pw1) < 6) {
            $err = '密码至少 6 位';
        } elseif ($pw1 !== $pw2) {
            $err = '两次输入的密码不一致';
        } else {
            $state['admin'] = array('username' => $username, 'password' => $pw1, 'display_name' => $dispName !== '' ? $dispName : '系统管理员');
            GF_Config::saveTmp($state);
            redirect_self(4);
        }
    }
    if (isset($_POST['back'])) {
        redirect_self(2);
    }

    render_head('第 3 步 · 管理员账号');
    if ($err !== '') {
        echo alert('error', $err);
    }
    echo '<h2>第 3 步 · 设置后台管理员</h2>
        <p class="muted">这个账号用来登录 <b>/#/admin</b> 管理后台：控制注册开关、功能开关、用户封禁、SMTP 发信等。<b>请不要使用过于简单的密码</b>。</p>
        <form method="post" class="form">
        <input type="hidden" name="step" value="3">' . install_csrf_field() . '
        <div class="row2">
            <label>管理员账号<input type="text" name="admin_user" value="' . h(isset($_POST['admin_user']) ? $_POST['admin_user'] : 'admin') . '" placeholder="admin" required autocomplete="off"></label>
            <label>显示名称<input type="text" name="admin_display" value="' . h(isset($_POST['admin_display']) ? $_POST['admin_display'] : '系统管理员') . '" placeholder="系统管理员"></label>
        </div>
        <div class="row2">
            <label>登录密码<div class="hint">至少 6 位</div><input type="password" name="admin_pass" autocomplete="new-password" required></label>
            <label>确认密码<input type="password" name="admin_pass2" autocomplete="new-password" required></label>
        </div>
        <div class="btns">
            <button class="btn" name="back" value="1">上一步</button>
            <button class="btn primary" name="next" value="1">下一步：站点设置</button>
        </div>
        </form>';
    render_foot();
    exit;
}

/* ---------------- 步骤 4：站点与邮件 ---------------- */
if ($step === 4) {
    if (empty($state['admin'])) {
        redirect_self(3, '请先设置管理员账号');
    }
    $err = '';
    $smtpMsg = '';

    $smtp = isset($state['smtp']) ? $state['smtp'] : array(
        'enable' => false, 'host' => '', 'port' => 465, 'secure' => true, 'user' => '', 'pass' => '', 'from' => '',
    );

    if (isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $smtp['enable'] = !empty($_POST['smtp_enable']);
        $smtp['host']   = flyme_str($_POST['smtp_host']);
        $smtp['port']   = (int) $_POST['smtp_port'];
        $smtp['secure'] = !empty($_POST['smtp_secure']);
        $smtp['user']   = flyme_str($_POST['smtp_user']);
        $smtp['pass']   = isset($_POST['smtp_pass']) ? (string) $_POST['smtp_pass'] : '';
        $smtp['from']   = flyme_str($_POST['smtp_from']);
        if ($smtp['from'] === '') {
            $smtp['from'] = $smtp['user'];
        }

        $site = array(
            'siteName'        => flyme_str($_POST['site_name']),
            'allowRegister'   => !empty($_POST['allow_register']) ? 'true' : 'false',
            'allowLogin'      => !empty($_POST['allow_login']) ? 'true' : 'false',
            'requireVerified' => !empty($_POST['require_verified']) ? 'true' : 'false',
            'featAi'          => !empty($_POST['feat_ai']) ? 'true' : 'false',
            'featOcr'         => !empty($_POST['feat_ocr']) ? 'true' : 'false',
            'featShare'       => !empty($_POST['feat_share']) ? 'true' : 'false',
            'featWall'        => !empty($_POST['feat_wall']) ? 'true' : 'false',
            'featSync'        => !empty($_POST['feat_sync']) ? 'true' : 'false',
        );
        $state['site'] = $site;
        $state['smtp'] = $smtp;
        GF_Config::saveTmp($state);

        if (isset($_POST['test_smtp'])) {
            if ($smtp['host'] === '' || $smtp['user'] === '' || $smtp['pass'] === '') {
                $err = '请先填好 SMTP 服务器、账号与授权码';
            } else {
                require_once GF_ROOT . '/app/lib/Mail.php';
                $to = flyme_str($_POST['smtp_test_to']);
                if (!flyme_valid_email($to)) {
                    $err = '请输入正确的测试收件邮箱';
                } else {
                    list($ok, $msg) = GF_Mail::buildTransport($smtp)->send($to, '纳物 · SMTP 测试邮件', "这是一封测试邮件：收到它说明发件邮箱配置成功。\n\n发送时间：" . date('Y-m-d H:i:s'));
                    if ($ok) {
                        $smtpMsg = '测试邮件已发出，请去收件箱确认';
                    } else {
                        $err = '发信失败：' . $msg;
                    }
                }
            }
        } elseif (isset($_POST['finish'])) {
            if ($smtp['enable'] && ($smtp['host'] === '' || $smtp['user'] === '' || $smtp['pass'] === '')) {
                $err = '已勾选启用邮件服务，请完整填写 SMTP 信息（或取消勾选）';
            } else {
                redirect_self(5);
            }
        } elseif (isset($_POST['back'])) {
            redirect_self(3);
        }
    }

    $site = isset($state['site']) ? $state['site'] : array(
        'siteName' => '纳物', 'allowRegister' => 'true', 'allowLogin' => 'true', 'requireVerified' => 'true',
        'featAi' => 'true', 'featOcr' => 'true', 'featShare' => 'true', 'featWall' => 'true', 'featSync' => 'true',
    );
    $v = function ($k) use ($site) {
        return !empty($site[$k]) && $site[$k] !== 'false';
    };

    render_head('第 4 步 · 站点与邮件');
    if ($err !== '') {
        echo alert('error', $err);
    } elseif ($smtpMsg !== '') {
        echo alert('ok', $smtpMsg);
    }
    echo '<h2>第 4 步 · 站点设置</h2>
        <p class="muted">这些都能在后台随时改，先按你想要的来。<b>注册是否需要邮箱验证</b>取决于 SMTP 是否配好：不配 SMTP 就建议关掉「注册需邮箱验证」，否则用户无法自助注册。</p>
        <form method="post" class="form">
        <input type="hidden" name="step" value="4">' . install_csrf_field() . '
        <label>站点名称<input type="text" name="site_name" value="' . h($site['siteName']) . '" placeholder="纳物"></label>

        <div class="fieldset">
            <div class="fs-title">账号策略</div>
            ' . toggle('allow_register', '开放注册', '关闭后访客无法自助注册，只能由你去后台开通', $v('allowRegister')) . '
            ' . toggle('allow_login', '允许登录', '关闭后所有人都登不上（维护时可用）', $v('allowLogin')) . '
            ' . toggle('require_verified', '注册需邮箱验证', '开启后注册必须收验证码，需要第 4 步的 SMTP 配好', $v('requireVerified')) . '
        </div>

        <div class="fieldset">
            <div class="fs-title">功能开关</div>
            ' . toggle('feat_ai', 'AI 助手', '口语化录入与消费复盘', $v('featAi')) . '
            ' . toggle('feat_ocr', '识图添加', '上传订单截图自动识别', $v('featOcr')) . '
            ' . toggle('feat_share', '分享卡片', '生成物品分享图', $v('featShare')) . '
            ' . toggle('feat_wall', '置物墙', '把物品摆到墙上', $v('featWall')) . '
            ' . toggle('feat_sync', '云同步备份', '按账号隔离的手动云备份', $v('featSync')) . '
        </div>

        <div class="fieldset">
            <div class="fs-title">邮件服务（SMTP，可跳过）</div>
            <label class="switch-line">' . '<input type="checkbox" name="smtp_enable" value="1"' . (!empty($smtp['enable']) ? ' checked' : '') . '><span>现在就配置发件邮箱</span></label>
            <div class="row2">
                <label>SMTP 服务器<input type="text" name="smtp_host" value="' . h($smtp['host']) . '" placeholder="smtp.qq.com"></label>
                <label>端口<input type="number" name="smtp_port" value="' . h((string) $smtp['port']) . '"></label>
            </div>
            <div class="row2">
                <label>发件账号<input type="text" name="smtp_user" value="' . h($smtp['user']) . '" placeholder="you@qq.com" autocomplete="off"></label>
                <label>授权码<div class="hint">邮箱服务商生成的「授权码」，不是登录密码</div><input type="password" name="smtp_pass" value="' . h($smtp['pass']) . '" autocomplete="new-password"></label>
            </div>
            <label>发件人显示名（选填）<input type="text" name="smtp_from" value="' . h($smtp['from']) . '" placeholder="' . h($smtp['user']) . '"></label>
            <label>SSL 加密 ' . '<input type="checkbox" name="smtp_secure" value="1"' . (!empty($smtp['secure']) ? ' checked' : '') . '><span class="hint inline">465 端口必须开启</span></label>
            <div class="smtp-test">
                <input type="email" name="smtp_test_to" placeholder="测试收件邮箱" value="' . h(isset($_POST['smtp_test_to']) ? flyme_str($_POST['smtp_test_to']) : '') . '">
                <button class="btn sm" name="test_smtp" value="1">发送测试邮件</button>
            </div>
            <p class="tiny muted">常见组合：QQ 邮箱 smtp.qq.com / 465 / SSL；163 邮箱 smtp.163.com / 465 / SSL；企业微信邮箱 smtp.exmail.qq.com / 465 / SSL。</p>
        </div>

        <div class="btns">
            <button class="btn" name="back" value="1">上一步</button>
            <button class="btn primary" name="finish" value="1">下一步：完成安装</button>
        </div>
        </form>';
    render_foot();
    exit;
}

/* ---------------- 步骤 5：完成 ---------------- */
if ($step === 5) {
    if (empty($state['db']) || empty($state['admin'])) {
        redirect_self(1, '安装信息已失效，请从第 1 步重新开始');
    }
    /* v1.0.33 安全修复：第 5 步由 GET 触发、且 storage/.install.tmp 是全局共享的
     * （不区分会话）。只防 POST 不够——跨站诱导管理员访问 install.php?step=5
     * 就能用攻击者写进 tmp 的数据库/管理员配置完成「安装」。
     * 这里要求 URL 里的令牌必须与「当前浏览器会话」内的令牌一致：
     * 正常流程跳转自带令牌；攻击者知道的是他自己会话的令牌，与受害者会话不匹配。 */
    if (!install_csrf_ok_get()) {
        redirect_self(1, '安装会话校验失败，请从第 1 步重新开始');
    }

    /* v1.0.33 安全修复：排他锁 + 锁内复查 installed()。
     * 两个浏览器同时走到第 5 步时，旧代码会各自写一遍 config.php、各自跑
     * 一遍建表/建管理员，后写的覆盖先写的（安装接管竞态窗口）。 */
    $lockFile = GF_ROOT . '/storage/.install.lock';
    @mkdir(dirname($lockFile), 0755, true);
    $lockFp = @fopen($lockFile, 'c');
    if ($lockFp && !flock($lockFp, LOCK_EX)) {
        render_head('安装繁忙');
        echo alert('error', '另一个安装进程正在进行中，请稍候刷新页面重试');
        render_foot();
        exit;
    }
    try {
        if (GF_Config::installed()) {
            render_locked_page($baseUrl);
            exit;
        }

        // 1) 写入配置
        $res = GF_Config::write(array(
        'installed'    => true,
        'installed_at' => date('Y-m-d H:i:s'),
        'secret'       => flyme_random_hex(16),
        'db'           => $state['db'],
    ));
    if ($res !== true) {
        render_head('安装失败');
        echo alert('error', (string) $res);
        render_foot();
        exit;
    }

    // 2) 用正式配置建表 + 写管理员 + 写开关
    $res2 = GF_Schema::install($state['admin'], true);
    if ($res2[0] !== true) {
        render_head('安装失败');
        echo alert('error', '建表失败：' . $res2[1]);
        echo '<p class="tiny muted">已生成的 storage/config.php 保留着，修好后重新访问 install.php 会自动跳过第 1~2 步直接进入第 3 步设置管理员。</p>';
        render_foot();
        exit;
    }

    if (!empty($state['site'])) {
        foreach ($state['site'] as $k => $val) {
            try {
                GF_Db::q('INSERT INTO `flyme_admin_settings` (`k`, `v`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)', array($k, (string) $val));
            } catch (Exception $e) {
                /* 忽略 */
            }
        }
    }
    if (!empty($state['smtp']['enable'])) {
        $conf = array(
            'host'   => $state['smtp']['host'],
            'port'   => (int) $state['smtp']['port'],
            'secure' => !empty($state['smtp']['secure']) || (int) $state['smtp']['port'] === 465,
            'user'   => $state['smtp']['user'],
            'pass'   => $state['smtp']['pass'],
            'from'   => $state['smtp']['from'] !== '' ? $state['smtp']['from'] : $state['smtp']['user'],
        );
        try {
            GF_Db::q('INSERT INTO `flyme_admin_settings` (`k`, `v`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)', array('smtpJson', json_encode($conf, JSON_UNESCAPED_UNICODE)));
        } catch (Exception $e) {
            /* 忽略 */
        }
    }

    $state['done'] = true;
    GF_Config::clearTmp();

    render_head('安装完成');
    echo '<div class="done-card">
        <div class="done-icon">✓</div>
        <h2>安装完成</h2>
        <p class="muted">数据库表已就绪，管理员账号已创建。下面是接下来要做的事：</p>
        <div class="summary">
            <div><span>数据库</span><b>' . h($state['db']['host'] . ':' . $state['db']['port']) . ' / ' . h($state['db']['name']) . '</b></div>
            <div><span>管理员账号</span><b>' . h($state['admin']['username']) . '</b></div>
            <div><span>数据表</span><b>' . h(implode('、', isset($state['tables']) ? $state['tables'] : array())) . '</b></div>
        </div>
        <div class="btns">
            <a class="btn primary" href="' . h($baseUrl . '/index.php') . '">进入纳物</a>
            <a class="btn" href="' . h($baseUrl . '/index.php#/admin') . '">打开管理后台</a>
        </div>
        <div class="tips">
            <b>安全提醒</b>
            <ol>
                <li>安装向导已锁定。若需重装，删除 <code>storage/config.php</code> 后刷新 <code>install.php</code>。</li>
                <li>确认 <code>storage/</code> 与 <code>app/</code> 无法被浏览器直接访问（配套的 nginx.conf 已加 deny 规则）。</li>
                <li>用户数据存在各自的浏览器里（IndexedDB），服务器端只存账号与云备份——换设备请在应用内手动做一次云端备份。</li>
            </ol>
        </div>
    </div>';
        render_foot();
        exit;
    } finally {
        if ($lockFp) {
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
        }
    }
}

/* 兜底 */
redirect_self(1);

/* =================== 辅助函数 =================== */

function run_install_ddl($conf)
{
    // 不走 GF_Db 的全局单例：那依赖已经落盘的 storage/config.php。
    // 这里拿本次表单里的参数开一条一次性连接，把表建好再关掉。
    $names = array();
    try {
        $pdo = GF_Db::connectPdo($conf);
    } catch (Exception $e) {
        return array(false, '无法连接数据库：' . $e->getMessage());
    }
    try {
        foreach (GF_Schema::ddl() as $sql) {
            $pdo->exec($sql);
            if (preg_match('/`([^`]+)`/i', substr($sql, 0, 140), $m)) {
                $names[] = $m[1];
            }
        }
        $pdo->exec("INSERT INTO `app_meta` (`k`, `v`) VALUES ('schema_version', '2')
                    ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)");
        foreach (GF_Schema::defaultSettings() as $k => $v) {
            $st = $pdo->prepare('INSERT IGNORE INTO `flyme_admin_settings` (`k`, `v`) VALUES (?, ?)');
            $st->execute(array($k, $v));
        }
        unset($pdo);
        return array(true, $names);
    } catch (Exception $e) {
        unset($pdo);
        return array(false, $e->getMessage());
    }
}

function h($s)
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

function return_bytes($v)
{
    $v = trim((string) $v);
    if ($v === '' || $v === '-1') {
        return PHP_INT_MAX;
    }
    $unit = strtolower(substr($v, -1));
    $num  = (float) $v;
    if ($unit === 'g') {
        $num = $num * 1024 * 1024 * 1024;
    } elseif ($unit === 'm') {
        $num = $num * 1024 * 1024;
    } elseif ($unit === 'k') {
        $num = $num * 1024;
    }
    return (int) $num;
}

function alert($type, $msg)
{
    return '<div class="alert ' . $type . '">' . h($msg) . '</div>';
}

function toggle($name, $title, $desc, $checked)
{
    return '<label class="toggle-item"><input type="checkbox" name="' . $name . '" value="1"' . ($checked ? ' checked' : '') . '>'
        . '<span class="tg-body"><b>' . h($title) . '</b><i>' . h($desc) . '</i></span></label>';
}

function redirect_self($toStep, $msg = '')
{
    $url = $_SERVER['PHP_SELF'] . '?step=' . (int) $toStep;
    // v1.0.33 安全修复：跳转链接自带会话令牌，第 5 步（GET 落盘）据此校验来源
    if (install_session_ok()) {
        $url .= '&csrf=' . rawurlencode((string) $_SESSION['nawu_install_csrf']);
    }
    if ($msg !== '') {
        $url .= '&msg=' . rawurlencode($msg);
    }
    header('Location: ' . $url, true, 302);
    exit;
}

function render_head($title)
{
    $msg = isset($_GET['msg']) ? trim($_GET['msg']) : '';
    echo '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>安装向导 · 纳物</title>
<style>' . install_css() . '</style></head><body>
<div class="wrap">
<div class="brand"><span class="logo">纳</span><div><h1>纳物 · 安装向导</h1><p>物品与消费复盘 · PHP 版</p></div></div>
<div class="steps">' . install_steps_bar() . '</div>
<div class="card">';
    if ($msg !== '') {
        echo alert('error', $msg);
    }
}

function install_steps_bar()
{
    $names = array(1 => '环境检测', 2 => '数据库', 3 => '管理员', 4 => '站点与邮件', 5 => '完成');
    $cur   = isset($_GET['step']) ? (int) $_GET['step'] : 1;
    $html  = '';
    foreach ($names as $i => $n) {
        $cls = $i < $cur ? ' done' : ($i === $cur ? ' cur' : '');
        $html .= '<span class="step' . $cls . '"><i>' . $i . '</i>' . h($n) . '</span>';
    }
    return $html;
}

function render_foot()
{
    echo '</div><p class="foot">纳物 NaWu · PHP/Nginx/MySQL 自建版 · 数据保存在本机浏览器与服务端数据库</p></div></body></html>';
}

function install_css()
{
    return <<<'CSS'
*{box-sizing:border-box}
body{margin:0;background:#f4f5f3;color:#22252a;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:34px 18px 60px}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.logo{width:46px;height:46px;border-radius:13px;background:#2f6b4f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600}
.brand h1{margin:0;font-size:20px;letter-spacing:.5px}
.brand p{margin:0;color:#8a9098;font-size:13px}
.steps{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.step{display:flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:#e6e8e4;color:#7a8288;font-size:12.5px}
.step i{width:18px;height:18px;border-radius:50%;background:#fff;color:#8a9098;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:11px}
.step.done{background:#d8ebdf;color:#2f6b4f}
.step.done i{background:#2f6b4f;color:#fff}
.step.cur{background:#2f6b4f;color:#fff}
.step.cur i{background:#fff;color:#2f6b4f}
.card{background:#fff;border:1px solid #e3e6e1;border-radius:16px;padding:26px 26px 22px}
h2{margin:0 0 6px;font-size:19px}
p.muted{color:#8a9098;margin:0 0 18px;font-size:13.5px}
.alert{padding:11px 14px;border-radius:10px;margin-bottom:16px;font-size:13.5px}
.alert.error{background:#fdeceb;color:#a8382c;border:1px solid #f7c9c4}
.hint-box{background:#fff8e8;border:1px solid #f2dfae;color:#8a6a1f;border-radius:10px;padding:11px 14px;margin-bottom:16px;font-size:13.5px}
.alert.ok{background:#e8f4ec;color:#2f6b4f;border:1px solid #c6e3d1}
.checklist{list-style:none;margin:0 0 20px;padding:0}
.checklist li{display:flex;gap:11px;padding:11px 0;border-bottom:1px dashed #ebebe8}
.checklist li .ci{flex:none;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff}
.checklist li.ok .ci{background:#2f6b4f}
.checklist li.warn .ci{background:#d99b2b}
.checklist li.bad .ci{background:#c1443a}
.checklist b{font-weight:600}
.cv{color:#2f6b4f;margin-left:8px;font-size:13px}
.checklist p{margin:0;color:#8a9098;font-size:12.5px}
.form{display:block}
.form label{display:block;margin-bottom:14px;font-size:13px;color:#5d646b}
.form input[type=text],.form input[type=password],.form input[type=number],.form input[type=email]{width:100%;margin-top:5px;padding:10px 12px;border:1px solid #dde0da;border-radius:10px;font-size:14px;background:#fbfbf9;outline:none}
.form input:focus{border-color:#2f6b4f;background:#fff}
.row2{display:flex;gap:12px}.row2>label{flex:1}
.hint{color:#a2a8ad;font-size:12px}
.hint.inline{margin-left:6px}
.fieldset{border:1px solid #e9ebe7;border-radius:12px;padding:8px 16px 4px;margin-bottom:16px}
.fs-title{font-size:12px;color:#a2a8ad;letter-spacing:1px;padding:6px 0 4px}
.toggle-item{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid #f1f2ef}
.toggle-item input{margin-top:5px;width:16px;height:16px}
.tg-body b{display:block;font-weight:600;color:#22252a}
.tg-body i{font-style:normal;color:#9aa0a5;font-size:12.5px}
.switch-line{display:flex;align-items:center;gap:8px}
.switch-line input{width:16px;height:16px}
.smtp-test{display:flex;gap:8px;margin:6px 0 4px}
.smtp-test input{flex:1;padding:9px 12px;border:1px solid #dde0da;border-radius:10px;font-size:13px;background:#fbfbf9}
.btns{display:flex;gap:10px;margin-top:20px}
.btn{flex:1;text-align:center;padding:11px 16px;border-radius:11px;border:1px solid #dde0da;background:#fff;color:#3d4348;font-size:14px;cursor:pointer;text-decoration:none}
.btn.primary{background:#2f6b4f;border-color:#2f6b4f;color:#fff}
.btn.sm{flex:none;padding:9px 14px;font-size:13px}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.tiny{font-size:12px}
.tips{background:#f7f8f5;border:1px solid #e9ebe7;border-radius:12px;padding:14px 16px;margin-top:18px;font-size:13px;color:#5d646b}
.tips ol{margin:8px 0 0;padding-left:20px}
.summary{border:1px solid #e9ebe7;border-radius:12px;overflow:hidden;margin-bottom:4px}
.summary div{display:flex;border-bottom:1px solid #f1f2ef}
.summary div:last-child{border-bottom:0}
.summary span{width:110px;background:#f7f8f5;padding:11px 14px;color:#8a9098;font-size:13px}
.summary b{padding:11px 14px;font-weight:600;word-break:break-all}
.done-card{text-align:center}
.done-icon{width:56px;height:56px;margin:6px auto 14px;border-radius:50%;background:#2f6b4f;color:#fff;font-size:28px;display:flex;align-items:center;justify-content:center}
.summary{text-align:left;margin:16px 0 20px}
.tips{text-align:left}
.reinstall{margin-top:18px;text-align:left;background:#f7f8f5;border:1px solid #e9ebe7;border-radius:12px;padding:12px 16px;font-size:13px;color:#5d646b}
.reinstall summary{cursor:pointer;color:#2f6b4f}
code{background:#eceee9;padding:1px 5px;border-radius:4px;font-size:12px}
.foot{text-align:center;color:#a2a8ad;font-size:12px;margin-top:16px}
@media(max-width:560px){.row2{flex-direction:column}.card{padding:20px 18px}}
CSS;
}
