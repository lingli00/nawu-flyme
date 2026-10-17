<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * 极简 SMTP 发信客户端（零依赖，纯 PHP socket 实现）
 *
 * 为什么不直接用 PHPMailer：宝塔环境下不一定方便装 Composer 包，
 * 而注册验证码只需要「能发出去一封纯文本邮件」，因此自己实现：
 *   - 支持 465 SSL（ssl:// 直连）与 587 STARTTLS
 *   - 支持 AUTH LOGIN / AUTH PLAIN
 *   - 中文标题自动 base64 编码，正文用 quoted-printable
 */

require_once dirname(__FILE__) . '/Support.php';

class GF_Mail
{
    private $socket   = null;
    private $host     = '';
    private $log      = array();
    private $port     = 0;
    private $lastCode = 0;

    /**
     * @param array $conf array(host, port, secure, user, pass, from)
     */
    public function __construct($conf)
    {
        $this->conf = array_merge(array(
            'host'   => '',
            'port'   => 25,
            'secure' => false,
            'user'   => '',
            'pass'   => '',
            'from'   => '',
        ), $conf);
    }

    private $conf = array();

    public function lastLog()
    {
        return implode(' | ', array_slice($this->log, -6));
    }

    public static function buildTransport($conf)
    {
        return new GF_Mail($conf);
    }

    /**
     * 发信
     * @param string $to
     * @param string $subject
     * @param string $text
     * @return array array(true) | array(false, 错误)
     */
    public function send($to, $subject, $text)
    {
        $plans    = $this->planAttempts();
        $lastAuth = '';   // 最后一次「认证/加密」类失败的原因
        $fatal    = '';   // 非认证类失败（MAIL FROM / RCPT / DATA），再试也没用

        foreach ($plans as $plan) {
            $this->resetSession();
            try {
                $this->connectServer($plan['port'], $plan['secure']);
                $this->hello();
                $this->auth();
                // 认证通过：之后的失败属于配置/地址问题，没必要换端口重试
                try {
                    $this->mailFrom();
                    $this->rcptTo($to);
                    $this->data($to, $subject, $text);
                    $this->quit();
                } catch (Exception $e2) {
                    $this->close();
                    return array(false, $e2->getMessage());
                }
                $this->close();
                return array(true, '');
            } catch (Exception $e) {
                $this->close();
                if ($this->authStage) {
                    // 登录被拒：换一种连接方式再试（多为「服务器要求加密」或端口不当）
                    $lastAuth = $e->getMessage();
                    continue;
                }
                // 连接/握手阶段失败：也换下一种方式继续试
                $lastAuth = $e->getMessage();
            }
        }
        if ($fatal !== '') {
            return array(false, $fatal);
        }
        return array(false, $lastAuth !== '' ? $lastAuth : 'SMTP 发信失败（未知原因）');
    }

    /** 当前是否处在「认证阶段」（用于判断失败后要不要换方式重试） */
    private $authStage = false;

    private function resetSession()
    {
        $this->close();
        $this->log        = array();
        $this->extensions = '';
        $this->authStage  = false;
        $this->lastCode   = 0;
    }

    /**
     * 连接方案：先用用户填的，再依次补上常见的加密端口组合。
     * 这样即使端口/加密勾选填错，也能自动找到发得出去的那一种。
     */
    private function planAttempts()
    {
        $host = $this->conf['host'];
        $port = (int) $this->conf['port'];
        if ($port <= 0) {
            $port = 25;
        }
        $secure = ($port === 465) ? true : !empty($this->conf['secure']);

        $plans   = array();
        $plans[] = array('host' => $host, 'port' => $port, 'secure' => $secure);

        // 常见兜底顺序：465 隐式 SSL → 587 STARTTLS → 25 STARTTLS
        $fallback = array(
            array('port' => 465, 'secure' => true),
            array('port' => 587, 'secure' => true),
            array('port' => 25,  'secure' => true),
        );
        foreach ($fallback as $f) {
            $dup = false;
            foreach ($plans as $p) {
                if ($p['port'] === $f['port'] && $p['secure'] === $f['secure']) {
                    $dup = true;
                    break;
                }
            }
            if (!$dup) {
                $plans[] = array('host' => $host, 'port' => $f['port'], 'secure' => $f['secure']);
            }
        }
        return $plans;
    }

    /* ---------------- 连接 ---------------- */

    /**
     * SSL 上下文（v1.0.33 安全修复）。
     * $verify=false 仅作为「服务器 CA 根证书库不全」时的兼容降级，
     * 每次降级都会写 error_log，提醒运维修复 openssl.cafile。
     */
    private static function sslContext($verify)
    {
        $opts = array(
            'verify_peer'       => $verify,
            'verify_peer_name'  => $verify,
            'allow_self_signed' => !$verify,
        );
        $cafile = ini_get('openssl.cafile');
        $capath = ini_get('openssl.capath');
        if (is_string($cafile) && $cafile !== '' && @is_file($cafile)) {
            $opts['cafile'] = $cafile;
        } elseif (is_string($capath) && $capath !== '' && @is_dir($capath)) {
            $opts['capath'] = $capath;
        }
        return stream_context_create(array('ssl' => $opts));
    }

    private function connectServer($port = null, $secure = null)
    {
        $host         = $this->conf['host'];
        $this->host   = $host;
        if ($port === null) {
            $port = (int) $this->conf['port'];
        }
        $port = (int) $port;
        if ($port <= 0) {
            $port = 25;
        }
        // 端口 465 一律按 SSL 处理（与 Node 版一致，避免「465 + 关 SSL」这种发不出信的组合）
        if ($secure === null) {
            $secure = ($port === 465) ? true : !empty($this->conf['secure']);
        }
        $secure = (bool) $secure;
        $this->port = $port;

        $remote = ($secure ? 'ssl://' : 'tcp://') . $host . ':' . $port;
        $errno  = 0;
        $errstr = '';
        $ctx    = self::sslContext(true);
        $fp = @stream_socket_client($remote, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp && $secure && $port !== 465) {
            // SSL 连不上时兜底再试一次明文（465 是隐式 SSL，明文连上去必然无法通信，不兜底）
            $fp = @stream_socket_client('tcp://' . $host . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
        }
        if (!$fp) {
            // 兼容降级：少数虚拟主机 CA 根证书库不全，校验必然失败。
            // 降级前先确认「不校验也能连上」，避免把真正的网络故障也吞掉。
            $fpLoose = @stream_socket_client($remote, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, self::sslContext(false));
            if ($fpLoose) {
                error_log('[nawu-mail] SMTP ' . $host . ':' . $port
                    . ' 证书校验失败，已降级为不验证证书重连。请修复服务器的 CA 根证书配置（php.ini openssl.cafile / capath）。');
                $fp = $fpLoose;
            }
        }
        if (!$fp) {
            throw new Exception('无法连接 SMTP 服务器 ' . $host . ':' . $port . '（' . $errstr . '，错误码 ' . $errno . '）');
        }
        stream_set_timeout($fp, 20);
        $this->socket = $fp;
        $this->readLine();
    }

    private function hello()
    {
        // EHLO 主机名只信白名单字符：HTTP_HOST 可被客户端构造，
        // 不过滤掉 CR/LF/空格就等于给了 SMTP 命令注入的口子（v1.0.33 安全修复）
        $host = isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : 'localhost';
        $host = preg_replace('/:\d+$/', '', $host);            // 去端口
        $host = preg_replace('/[^A-Za-z0-9.\-_]/', '', $host); // 只留安全字符
        $host = trim($host, '.-');
        if ($host === '' || strlen($host) > 253 || !preg_match('/[A-Za-z0-9]/', $host)) {
            $host = 'localhost';
        }
        $code = $this->command('EHLO ' . $host);
        if ($code !== 250) {
            // 老式服务器不认 EHLO
            $code = $this->command('HELO ' . $host);
            if ($code !== 250) {
                throw new Exception('SMTP 握手失败（EHLO 返回 ' . $code . '）');
            }
            $this->extensions = '';
            return;
        }
        // 只要服务器宣告了 STARTTLS 且当前还是明文，就先升级加密再登录。
        // 不能依赖用户是否勾选「加密」：QQ / 163 / Gmail 等主流服务商在明文下
        // 一律拒绝 AUTH（返回 530 Must issue a STARTTLS command first），
        // 勾选漏了就会被误报成「账号或授权码不正确」。
        if (!$this->isSslSocket() && stripos($this->extensions, 'STARTTLS') !== false) {
            $code = $this->command('STARTTLS');
            if ($code === 220) {
                $ok = @stream_socket_enable_crypto($this->socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
                if (!$ok) {
                    $ok = @stream_socket_enable_crypto($this->socket, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT);
                }
                if (!$ok) {
                    $ok = @stream_socket_enable_crypto($this->socket, true, STREAM_CRYPTO_METHOD_TLSv1_1_CLIENT);
                }
                if ($ok) {
                    $this->extensions = ''; // TLS 后的 EHLO 会重新宣告，避免混入旧扩展
                    $code = $this->command('EHLO ' . $host);
                    if ($code !== 250) {
                        throw new Exception('STARTTLS 后握手失败（返回 ' . $code . '）');
                    }
                }
            }
        }
    }

    private $extensions = '';

    private function isSslSocket()
    {
        $meta = @stream_get_meta_data($this->socket);
        return isset($meta['crypto']);
    }

    private function auth()
    {
        if ($this->conf['user'] === '') {
            return; // 无需认证
        }
        $this->authStage = true;

        $user = base64_encode($this->conf['user']);
        $pass = base64_encode($this->conf['pass']);
        $declared = stripos($this->extensions, 'AUTH') !== false;

        if ($declared) {
            if (stripos($this->extensions, 'LOGIN') !== false) {
                $code = $this->command('AUTH LOGIN');
                if ($code === 334) {
                    $code = $this->command($user);
                    if ($code === 334) {
                        $code = $this->command($pass);
                        if ($code === 235) {
                            $this->authStage = false;
                            return;
                        }
                        throw new Exception($this->authError($code));
                    }
                }
            }
            if (stripos($this->extensions, 'PLAIN') !== false) {
                $code = $this->command('AUTH PLAIN ' . base64_encode("\0" . $this->conf['user'] . "\0" . $this->conf['pass']));
                if ($code === 235) {
                    $this->authStage = false;
                    return;
                }
            }
        }

        // 少数内网中继不宣告 AUTH 但仍要求 AUTH LOGIN，盲发一次
        if (!$declared) {
            try {
                $code = $this->command('AUTH LOGIN');
                if ($code === 334) {
                    $this->command($user);
                    $code = $this->command($pass);
                    if ($code === 235) {
                        $this->authStage = false;
                        return;
                    }
                    throw new Exception($this->authError($code));
                }
            } catch (Exception $e) {
                throw $e;
            }
        }
        throw new Exception($this->authError($this->lastCode));
    }

    /** 把 SMTP 认证返回码翻译成人能看懂的原因 */
    private function authError($code)
    {
        $code = (int) $code;
        if ($code === 530 || $code === 538) {
            return 'SMTP ' . $code . '：服务器要求先建立加密连接（SSL / STARTTLS）才允许登录——'
                . '这不是授权码有问题。已自动改用 465(SSL) / 587(STARTTLS) 重试；'
                . '若仍失败，请把端口改为 465 或 587。';
        }
        if ($code === 535 || $code === 534) {
            return 'SMTP ' . $code . '：账号或授权码不正确。请确认填的是邮箱服务商生成的「授权码」，'
                . '不是网页登录密码；并确认发件邮箱与登录账号是同一个。';
        }
        if ($code === 504 || $code === 502) {
            return 'SMTP ' . $code . '：服务器不支持这种登录方式（AUTH LOGIN），请更换端口或联系邮箱服务商。';
        }
        return 'SMTP 认证失败（返回 ' . $code . '），服务器拒绝了账号或授权码。';
    }

    private function mailFrom()
    {
        $from = $this->conf['from'] !== '' ? $this->conf['from'] : $this->conf['user'];
        $addr = $this->extractEmail($from);
        if (!$addr) {
            throw new Exception('发件邮箱地址不合法：' . $from);
        }
        $code = $this->command('MAIL FROM: <' . $addr . '>');
        if ($code !== 250) {
            $userAddr = $this->extractEmail($this->conf['user']);
            if ($userAddr && strcasecmp($userAddr, $addr) !== 0) {
                throw new Exception('MAIL FROM 被拒（返回 ' . $code . '）：发件邮箱 ' . $addr
                    . ' 与登录账号 ' . $userAddr . ' 不一致。QQ / 163 等要求两者必须是同一个邮箱，'
                    . '请把「发件邮箱」改成 ' . $userAddr);
            }
            throw new Exception('MAIL FROM 被拒（返回 ' . $code . '），请检查发件账号是否开通了 SMTP 权限');
        }
        $this->mailFromAddr = $addr;
        $this->mailFromRaw  = $from;
    }

    private $mailFromAddr = '';
    private $mailFromRaw  = '';

    private function rcptTo($to)
    {
        $to = $this->extractEmail($to);
        if (!$to) {
            throw new Exception('收件邮箱地址不合法');
        }
        $code = $this->command('RCPT TO: <' . $to . '>');
        if ($code !== 250 && $code !== 251) {
            throw new Exception('RCPT TO 被拒（返回 ' . $code . '），请确认收件地址');
        }
        $this->rcptToAddr = $to;
    }

    private $rcptToAddr = '';

    private function data($to, $subject, $text)
    {
        $code = $this->command('DATA');
        if ($code !== 354) {
            throw new Exception('服务端不接受邮件内容（返回 ' . $code . '）');
        }
        $msg = $this->buildMessage($this->mailFromRaw, $this->rcptToAddr, $subject, $text);
        $this->writeLine($msg . "\r\n.");
        $this->readLine();
    }

    private function quit()
    {
        try {
            $this->command('QUIT', true);
        } catch (Exception $e) {
            /* 忽略 */
        }
    }

    private function close()
    {
        if ($this->socket) {
            @fclose($this->socket);
            $this->socket = null;
        }
    }

    /* ---------------- 报文组装 ---------------- */

    private function buildMessage($from, $to, $subject, $text)
    {
        $boundary = false; // 纯文本，无需 multipart
        $headers  = array();
        $fromName = $this->displayPart($from);
        $headers[] = 'From: ' . $this->encodeHeader($fromName) . ' <' . $this->extractEmail($from) . '>';
        $headers[] = 'To: <' . $to . '>';
        $headers[] = 'Subject: ' . $this->encodeHeader($subject);
        $headers[] = 'Date: ' . date('r');
        $headers[] = 'Message-ID: <' . gmdate('YmdHis') . '.' . flyme_random_hex(6) . '@flyme>';
        $headers[] = 'MIME-Version: 1.0';
        $headers[] = 'Content-Type: text/plain; charset=UTF-8';
        $headers[] = 'Content-Transfer-Encoding: quoted-printable';
        $headers[] = 'X-Mailer: NaWu/PHP';

        $body = quoted_printable_encode(str_replace(array("\r\n", "\r"), "\n", $text));
        // 换行统一用 CRLF
        $body = str_replace("\n", "\r\n", $body);

        return implode("\r\n", $headers) . "\r\n\r\n" . $body;
    }

    private function displayPart($addr)
    {
        if (preg_match('/^(.*?)\s*<.+>$/', trim($addr), $m) && trim($m[1]) !== '') {
            return trim($m[1], " \t\"'");
        }
        return '';
    }

    private function encodeHeader($str)
    {
        if ($str === '') {
            return '';
        }
        if (!preg_match('/[^\x20-\x7E]/', $str)) {
            return $str; // 纯 ASCII 直接原样
        }
        return '=?UTF-8?B?' . base64_encode($str) . '?=';
    }

    private function extractEmail($s)
    {
        if (preg_match('/<([^<>@\s]+@[^<>@\s]+)>/', $s, $m)) {
            return $m[1];
        }
        $s = trim($s);
        if (preg_match('/^([^\s@]+@[^\s@]+)$/', $s)) {
            return $s;
        }
        return null;
    }

    /* ---------------- socket 读写 ---------------- */

    private function command($cmd, $noThrow = false)
    {
        $this->writeLine($cmd);
        return $this->readLine($noThrow);
    }

    private function writeLine($line)
    {
        if (!$this->socket) {
            throw new Exception('SMTP 连接已断开');
        }
        if (@fwrite($this->socket, $line . "\r\n") === false) {
            throw new Exception('SMTP 写入失败：连接被服务端关闭');
        }
    }

    /** 读取 SMTP 响应（支持多行），返回最后一行状态码 */
    private function readLine($noThrow = false)
    {
        if (!$this->socket) {
            throw new Exception('SMTP 连接已断开');
        }
        $code  = 0;
        $whole = '';
        while (!feof($this->socket)) {
            $line = @fgets($this->socket, 1024);
            if ($line === false) {
                break;
            }
            $whole .= trim($line) . ' ';
            $this->log[] = trim($line);
            if (preg_match('/^(\d{3})(?:[ \-]|$)/', $line, $m)) {
                $code = (int) $m[1];
                if (isset($line[3]) && $line[3] === '-') {
                    continue; // 多行响应，继续读
                }
                break;
            }
        }
        // 记录 EHLO 返回的扩展列表
        if (stripos($whole, '250-') !== false || stripos($whole, 'EHLO') !== false) {
            /* 仅在握手阶段需要 */
        }
        if (strpos($whole, 'AUTH') !== false || strpos($whole, 'STARTTLS') !== false) {
            $this->extensions .= ' ' . $whole;
        }
        if ($whole === '') {
            if ($noThrow) {
                return 0;
            }
            throw new Exception('SMTP 服务器无响应（' . $this->host . ':' . $this->port . '，可能是被防火墙拦截或端口不通）');
        }
        $this->lastCode = $code;
        return $code;
    }
}
