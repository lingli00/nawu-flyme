<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * v1.0.36 · 服务端在线更新核心。
 *
 * 设计要点（对应《实施计划》§3.4）：
 *  - 更新源 = 官方频道目录（默认 http://127.0.0.1:2233/nawu-update/，
 *    管理后台可改），拉 manifest.json（含全量 files 清单 + 包 sha256）；
 *  - 协作式分片任务：每次 /api/admin/server/status 轮询推进 ≤ SLICE_MS 毫秒，
 *    状态全部落盘（jobs/<id>.json），断点续跑——不依赖单请求跑完，
 *    兼容 Windows 宝塔 CGI 的 max_execution_time；
 *  - 安全链：下载分片 + Range 续传 → 整包 sha256 校验 → 备份待改文件 →
 *    解包（ZipArchive，zip-slip 防护）→ 逐文件 sha256 复核 + 原子 rename →
 *    按规则清理废弃文件 → 写 applied.json → opcache_reset → 健康自检
 *    （连续失败自动回滚）；
 *  - applying 完成后主动结束本片：后续阶段由「新代码」在下一片执行
 *    （此时 index.php/Api.php/Update.php 已被替换，运行中的请求持旧代码是安全的，
 *     但 finalizing 要调的可能是未来版本才有的能力）。路由名
 *     /api/admin/server/* 必须跨版本保持稳定。
 *  - 并发：全局锁只保护「建任务」；单任务推进用每任务独占锁（非阻塞，
 *     拿不到就直接返回当前状态——说明另有请求在推进）。
 *
 * 目录（全部在 storage/server-release/ 下，兼容 .user.ini 的 open_basedir）：
 *   jobs/<id>.json / jobs/<id>.lock / jobs/<id>/package.zip.part
 *   （兜底重下时临时文件叫 package.zip.alt.part，避免与主包残留拼接）
 *   / jobs/<id>/stage/
 *   backups/<id>/{job.json,changed/<relpath>}
 *   applied.json  history.json  scan-cache.json
 */

class GF_Update
{
    const DIR              = '/storage/server-release';
    const DEFAULT_SOURCE   = 'http://127.0.0.1:2233/nawu-update/';
    // 单片工作预算（毫秒）。**必须显著小于客户端默认超时 15s**：
    // 这个接口是「轮询即推进」，一次响应要等这一片干完才返回。
    // 曾设 18000 → 任何一次有活可干的轮询都会超过前端 15s 被 AbortController 掐断，
    // 前端永远收不到 jobId 与进度，表现为「连接超时（15s）」→「已有更新任务正在进行」死循环。
    // 本机更新（更新源就是自己，下载秒完）不会暴露这个问题，公网跨机更新必炸。
    const SLICE_MS         = 5000;
    const CHUNK            = 262144;  // 256KB
    const BACKUP_KEEP      = 3;
    const BACKUP_MAX_BYTES = 536870912; // 512MB
    const MAX_FILES        = 6000;
    const MAX_MANIFEST     = 2097152;   // manifest.json 上限 2MB
    const HEALTH_TRIES     = 2;
    // 多久没有任何进展就判定为「停滞」（上次请求被掐断 / 进程崩了）。
    // 每片 ≤5s 且每次都会写 updatedAt，正常任务不可能 120s 不动。
    const STALLED_SECONDS  = 120;

    /* ==================== 路径 ==================== */

    public static function baseDir()       { return GF_ROOT . self::DIR; }
    public static function jobsDir()       { return self::baseDir() . '/jobs'; }
    public static function backupsDir()    { return self::baseDir() . '/backups'; }
    public static function appliedFile()   { return self::baseDir() . '/applied.json'; }
    public static function historyFile()   { return self::baseDir() . '/history.json'; }
    public static function scanCacheFile() { return self::baseDir() . '/scan-cache.json'; }
    public static function lockFile()      { return self::baseDir() . '/update.lock'; }

    private static function ensureDir($dir)
    {
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        return is_dir($dir);
    }

    /* ==================== 小工具 ==================== */

    private static function readJson($file, $default)
    {
        $raw = @file_get_contents($file);
        if (!is_string($raw) || $raw === '') {
            return $default;
        }
        $d = json_decode($raw, true);
        return is_array($d) ? $d : $default;
    }

    /** 原子写 JSON（tmp + rename，范式同 GF_Config::write）。 */
    private static function writeJson($file, $data)
    {
        if (!self::ensureDir(dirname($file))) {
            return false;
        }
        $flags = JSON_UNESCAPED_UNICODE;
        if (defined('JSON_UNESCAPED_SLASHES')) {
            $flags |= JSON_UNESCAPED_SLASHES;
        }
        $json = json_encode($data, $flags);
        if ($json === false) {
            return false;
        }
        $tmp = $file . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $json) === false) {
            return false;
        }
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
            return false;
        }
        @chmod($file, 0644);
        return true;
    }

    /** 与 App 端 compareVersions 同语义：按 . 分段取整比较。 */
    public static function compare($a, $b)
    {
        $pa  = array_map('intval', explode('.', (string) $a));
        $pb  = array_map('intval', explode('.', (string) $b));
        $len = max(count($pa), count($pb));
        for ($i = 0; $i < $len; $i++) {
            $na = isset($pa[$i]) ? (int) $pa[$i] : 0;
            $nb = isset($pb[$i]) ? (int) $pb[$i] : 0;
            if ($na !== $nb) {
                return $na > $nb ? 1 : -1;
            }
        }
        return 0;
    }

    /** 相对路径安全性：拒绝绝对路径、..、非法字符（manifest 与 zip 条目共用）。 */
    public static function safeRelPath($p)
    {
        return is_string($p)
            && $p !== ''
            && strlen($p) <= 300
            && preg_match('#^[A-Za-z0-9._/-]+$#', $p)
            && strpos($p, '..') === false
            && $p[0] !== '/'
            && strpos($p, '//') === false;
    }

    /** 本地服务端版本（app/VERSION，缺失/非法 → '0.0.0'）。 */
    public static function localVersion()
    {
        $file = GF_ROOT . '/app/VERSION';
        $raw  = is_file($file) ? trim((string) @file_get_contents($file)) : '';
        return preg_match('/^[0-9A-Za-z._-]{1,32}$/', $raw) ? $raw : '0.0.0';
    }

    private static function now()
    {
        return date('Y-m-d H:i:s');
    }

    /* ==================== 更新源与 manifest ==================== */

    /** 生效的更新源（配置为空 → 官方默认源），统一带尾斜杠。 */
    public static function sourceUrl()
    {
        $u    = GF_Config::updateSource();
        $url  = isset($u['url']) ? trim((string) $u['url']) : '';
        if ($url === '') {
            $url = self::DEFAULT_SOURCE;
        }
        return rtrim($url, '/') . '/';
    }

    /** 校验管理员填的更新源 URL（协议 + SSRF，端口按 URL 实际端口放行）。 */
    public static function validSourceUrl($url)
    {
        if (!is_string($url) || strlen($url) > 500) {
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
            return false;
        }
        $port = isset($p['port']) ? (int) $p['port'] : (strtolower($p['scheme']) === 'https' ? 443 : 80);
        return flyme_ssrf_check_url($url, array($port));
    }

    /** 拉取并校验 manifest。$base 为空用当前生效源。失败抛 GF_UserError（400）。 */
    public static function fetchManifest($base = null, $timeout = 10)
    {
        if ($base === null || $base === '') {
            $base = self::sourceUrl();
        }
        $base = rtrim((string) $base, '/') . '/';
        $mUrl = $base . 'manifest.json';
        $p    = parse_url($mUrl);
        $port = isset($p['port']) ? (int) $p['port'] : (strtolower($p['scheme']) === 'https' ? 443 : 80);

        $r = flyme_http_get($mUrl, $timeout, self::MAX_MANIFEST, '', array($port));
        if ($r === null || !isset($r['body'])) {
            throw new GF_UserError('连不上更新源（' . $mUrl . '），请检查网络或更新源地址');
        }
        $m = json_decode((string) $r['body'], true);
        if (!is_array($m)) {
            throw new GF_UserError('更新源返回的不是合法 manifest（可能被伪静态拦截成了网页），请检查 ' . $mUrl);
        }
        return self::normalizeManifest($m, $base);
    }

    private static function normalizeManifest($m, $base)
    {
        $version = isset($m['version']) ? (string) $m['version'] : '';
        if (!preg_match('/^[0-9A-Za-z._-]{1,32}$/', $version)) {
            throw new GF_UserError('manifest 缺少有效的 version 字段');
        }
        $raw = (isset($m['files']) && is_array($m['files'])) ? $m['files'] : array();
        if (count($raw) === 0 || count($raw) > self::MAX_FILES) {
            throw new GF_UserError('manifest 的 files 清单为空或超出上限（' . self::MAX_FILES . '）');
        }
        $files = array();
        foreach ($raw as $f) {
            if (!is_array($f)) {
                throw new GF_UserError('manifest 的 files 含非法条目');
            }
            $path = isset($f['path']) ? (string) $f['path'] : '';
            $sha  = isset($f['sha256']) ? strtolower((string) $f['sha256']) : '';
            $size = isset($f['size']) ? (int) $f['size'] : -1;
            if (!self::safeRelPath($path)) {
                throw new GF_UserError('manifest 含非法文件路径：' . $path);
            }
            if (!preg_match('/^[0-9a-f]{64}$/', $sha)) {
                throw new GF_UserError('manifest 中 ' . $path . ' 的 sha256 不合法');
            }
            if ($size < 0) {
                throw new GF_UserError('manifest 中 ' . $path . ' 的 size 不合法');
            }
            $files[$path] = array('sha256' => $sha, 'size' => $size);
        }
        $pkgSha  = isset($m['packageSha256']) ? strtolower((string) $m['packageSha256']) : '';
        $pkgSize = isset($m['packageSize']) ? (int) $m['packageSize'] : 0;
        if (!preg_match('/^[0-9a-f]{64}$/', $pkgSha) || $pkgSize <= 0) {
            throw new GF_UserError('manifest 缺少有效的 packageSha256 / packageSize');
        }
        $pkgUrl = isset($m['packageUrl']) ? (string) $m['packageUrl'] : '';
        if ($pkgUrl === '') {
            throw new GF_UserError('manifest 缺少 packageUrl');
        }
        if (!preg_match('#^https?://#i', $pkgUrl)) {
            $pkgUrl = $base . ltrim($pkgUrl, '/');
        }
        if (!self::validSourceUrl($pkgUrl)) {
            throw new GF_UserError('manifest 的 packageUrl 未通过安全校验：' . $pkgUrl);
        }
        $minVersion = isset($m['minVersion']) ? (string) $m['minVersion'] : '';
        if ($minVersion !== '' && !preg_match('/^[0-9A-Za-z._-]{1,32}$/', $minVersion)) {
            $minVersion = '';
        }
        /* ★v1.3.3 全量兜底包：增量包下载/校验失败时自动改下这个。
           老 manifest 没有这一段 → fallback 为 null，行为与旧版完全一致。 */
        $fallback = null;
        if (isset($m['fallback']) && is_array($m['fallback'])) {
            $f = $m['fallback'];
            $fSha  = isset($f['sha256']) ? strtolower((string) $f['sha256']) : '';
            $fSize = isset($f['size']) ? (int) $f['size'] : 0;
            $fUrl  = isset($f['url']) ? (string) $f['url'] : '';
            if ($fUrl !== '' && !preg_match('#^https?://#i', $fUrl)) {
                $fUrl = $base . ltrim($fUrl, '/');
            }
            if (preg_match('/^[0-9a-f]{64}$/', $fSha) && $fSize > 0 && $fUrl !== '' && self::validSourceUrl($fUrl)) {
                $fallback = array('url' => $fUrl, 'size' => $fSize, 'sha256' => $fSha);
            }
        }
        return array(
            'version'        => $version,
            'publishedAt'    => isset($m['publishedAt']) ? substr((string) $m['publishedAt'], 0, 40) : '',
            'notes'          => isset($m['notes']) ? (string) $m['notes'] : '',
            'minVersion'     => $minVersion,
            'packageUrl'     => $pkgUrl,
            'packageSize'    => $pkgSize,
            'packageSha256'  => $pkgSha,
            'fallback'       => $fallback,
            'files'          => $files,
        );
    }

    /* ==================== 本地扫描与 diff ==================== */

    private static function skipDir($rel)
    {
        return $rel === 'storage' || strpos($rel, 'storage/') === 0
            || $rel === '.git' || strpos($rel, '.git/') === 0
            || $rel === 'node_modules' || strpos($rel, 'node_modules/') === 0;
    }

    private static function skipFile($rel)
    {
        $base = basename($rel);
        if ($base === '.user.ini' || $base === 'error_log') {
            return true;
        }
        return (bool) preg_match('/\.(zip|part|log|bak|old|tmp)$/i', $base);
    }

    /**
     * 扫描站点根（排除 storage/ 等），带 mtime+size 缓存，仅变化文件重算 sha256。
     * @return array(path => array('sha256','size','mtime'))
     */
    public static function scanLocal()
    {
        $cache = self::readJson(self::scanCacheFile(), array());
        $cache = (isset($cache['files']) && is_array($cache['files'])) ? $cache['files'] : array();
        $root  = GF_ROOT;
        $out   = array();
        $stack = array('');
        while ($stack) {
            $rel = array_pop($stack);
            $dir = ($rel === '') ? $root : $root . '/' . $rel;
            $dh  = @opendir($dir);
            if (!$dh) {
                continue;
            }
            while (($name = readdir($dh)) !== false) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                $childRel = ($rel === '') ? $name : $rel . '/' . $name;
                $full     = $dir . '/' . $name;
                if (is_dir($full)) {
                    if (!self::skipDir($childRel)) {
                        $stack[] = $childRel;
                    }
                    continue;
                }
                if (self::skipFile($childRel)) {
                    continue;
                }
                $st = @stat($full);
                if (!$st) {
                    continue;
                }
                $c = isset($cache[$childRel]) ? $cache[$childRel] : null;
                if (is_array($c) && isset($c['size'], $c['mtime'], $c['sha256'])
                    && (int) $c['size'] === (int) $st['size']
                    && (int) $c['mtime'] === (int) $st['mtime']
                    && preg_match('/^[0-9a-f]{64}$/', (string) $c['sha256'])
                ) {
                    $out[$childRel] = array(
                        'sha256' => (string) $c['sha256'],
                        'size'   => (int) $st['size'],
                        'mtime'  => (int) $st['mtime'],
                    );
                    continue;
                }
                $sha = @hash_file('sha256', $full);
                if ($sha === false) {
                    continue;
                }
                $out[$childRel] = array('sha256' => $sha, 'size' => (int) $st['size'], 'mtime' => (int) $st['mtime']);
            }
            closedir($dh);
        }
        self::writeJson(self::scanCacheFile(), array('updatedAt' => gmdate('c'), 'files' => $out));
        return $out;
    }

    /** 永久保护名单：任何规则都不得删除。 */
    public static function isProtectedPath($p)
    {
        if (!self::safeRelPath($p)) {
            return true;
        }
        if ($p === 'install.php' || $p === '.user.ini') {
            return true;
        }
        foreach (array('storage', 'brand-icons', 'tess', 'tessdata') as $d) {
            if ($p === $d || strpos($p, $d . '/') === 0) {
                return true;
            }
        }
        return false;
    }

    /** 构建产物（assets/ 下的静态文件）——不在新 manifest 即可删。 */
    private static function isBuildAsset($p)
    {
        if (!preg_match('#^assets/[-A-Za-z0-9._]+$#', $p)) {
            return false;
        }
        $ext = strtolower(pathinfo($p, PATHINFO_EXTENSION));
        $ok  = array('js', 'css', 'map', 'woff', 'woff2', 'ttf', 'png', 'svg', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'txt');
        return in_array($ext, $ok, true);
    }

    /**
     * diff：本地 vs 新 manifest。
     * 删除候选过滤：保护名单 → kept；assets 构建产物 → deleted；
     * app/ 且被 applied.json 托管 → deleted；其余 → kept。
     * @return array(added, updated, deleted, kept) —— 均为路径数组
     */
    public static function planDiff($local, $remoteFiles, $appliedFiles)
    {
        $added = array();
        $updated = array();
        $deleted = array();
        $kept = array();
        foreach ($remoteFiles as $path => $info) {
            if (!isset($local[$path])) {
                $added[] = $path;
            } elseif ($local[$path]['sha256'] !== $info['sha256']) {
                $updated[] = $path;
            }
        }
        foreach ($local as $path => $info) {
            if (isset($remoteFiles[$path])) {
                continue;
            }
            if (self::isProtectedPath($path)) {
                $kept[] = $path;
            } elseif (self::isBuildAsset($path)) {
                $deleted[] = $path;
            } elseif (strpos($path, 'app/') === 0 && is_array($appliedFiles) && isset($appliedFiles[$path])) {
                $deleted[] = $path;
            } else {
                $kept[] = $path;
            }
        }
        sort($added);
        sort($updated);
        sort($deleted);
        sort($kept);
        return array('added' => $added, 'updated' => $updated, 'deleted' => $deleted, 'kept' => $kept);
    }

    /* ==================== 检查更新 ==================== */

    public static function check($force = false)
    {
        $started = microtime(true);
        $base    = self::sourceUrl();
        $m       = self::fetchManifest($base);
        $local   = self::scanLocal();
        $lv      = self::localVersion();
        $applied = self::readJson(self::appliedFile(), null);
        $af      = (is_array($applied) && isset($applied['files']) && is_array($applied['files'])) ? $applied['files'] : array();
        $diff    = self::planDiff($local, $m['files'], $af);

        $cmp        = self::compare($m['version'], $lv);
        $comparison = $cmp > 0 ? 'newer' : ($cmp === 0 ? 'same' : 'older');
        $canUpdate  = $force ? true : ($cmp > 0);
        $reason     = '';
        if (!$canUpdate) {
            $reason = $cmp === 0
                ? '已是最新版本 v' . $lv . '（修复安装可勾选「强制重装」）'
                : '更新源版本 v' . $m['version'] . ' 低于本地 v' . $lv . '（降级需勾选「强制重装」）';
        }
        if ($m['minVersion'] !== '' && self::compare($lv, $m['minVersion']) < 0) {
            $canUpdate = false;
            $reason    = '本地版本过低，请先手动部署 ≥ v' . $m['minVersion'] . ' 的版本';
        }

        return array(
            'comparison' => $comparison,
            'canUpdate'  => $canUpdate,
            'reason'     => $reason,
            'local'      => array('version' => $lv),
            'remote'     => array(
                'version'       => $m['version'],
                'publishedAt'   => $m['publishedAt'],
                'notes'         => $m['notes'],
                'packageSize'   => $m['packageSize'],
                'packageSha256' => $m['packageSha256'],
                'minVersion'    => $m['minVersion'],
            ),
            'diff'       => array(
                'added'             => count($diff['added']),
                'updated'           => count($diff['updated']),
                'deleted'           => count($diff['deleted']),
                'kept'              => count($diff['kept']),
                'totalRemote'       => count($m['files']),
                'deletedList'       => array_slice($diff['deleted'], 0, 200),
                'deletedListCapped' => count($diff['deleted']) > 200,
            ),
            'elapsedMs'  => (int) round((microtime(true) - $started) * 1000),
        );
    }

    /* ==================== 任务：创建 / 查询 / 推进 ==================== */

    private static function jobFile($id)
    {
        return self::jobsDir() . '/' . $id . '.json';
    }

    public static function readJob($id)
    {
        if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', (string) $id)) {
            return null;
        }
        $j = self::readJson(self::jobFile($id), null);
        return is_array($j) ? $j : null;
    }

    /** 最近一个未完结任务（running / stalled）。 */
    public static function activeJob()
    {
        $dir  = self::jobsDir();
        $best = null;
        if (!is_dir($dir)) {
            return null;
        }
        foreach (glob($dir . '/*.json') as $f) {
            $j = self::readJson($f, null);
            if (!is_array($j) || !isset($j['status'], $j['startedAt'])) {
                continue;
            }
            if ($j['status'] === 'running' || $j['status'] === 'stalled') {
                if ($best === null || $j['startedAt'] > $best['startedAt']) {
                    $best = $j;
                }
            }
        }
        if ($best !== null && $best['status'] === 'running') {
            // 长时间无进展且推进锁可拿到 → 判定为停滞（上次请求崩了）
            $age = time() - strtotime($best['updatedAt'] . ' UTC');
            if ($age > self::STALLED_SECONDS) {
                $lp = @fopen($dir . '/' . $best['id'] . '.lock', 'c');
                if ($lp) {
                    if (flock($lp, LOCK_EX | LOCK_NB)) {
                        $best['status'] = 'stalled';
                        self::writeJob($best);
                        flock($lp, LOCK_UN);
                    }
                    fclose($lp);
                }
            }
        }
        return $best;
    }

    private static function writeJob($job)
    {
        $job['updatedAt'] = gmdate('c');
        return self::writeJson(self::jobFile($job['id']), $job);
    }

    private static function jobLog($job, $msg)
    {
        $job['log'][] = array('t' => self::now(), 'msg' => $msg);
        if (count($job['log']) > 200) {
            $job['log'] = array_slice($job['log'], -100);
        }
        return $job;
    }

    private static function setPhase($job, $phase, $message = '')
    {
        $job['phase']   = $phase;
        $job['message'] = $message !== '' ? $message : self::phaseLabel($phase);
        return self::writeJob($job);
    }

    public static function phaseLabel($phase)
    {
        $map = array(
            'queued'      => '排队中',
            'downloading' => '下载安装包',
            'verifying'   => '校验安装包完整性',
            'backing_up'  => '备份当前文件',
            'extracting'  => '解包',
            'applying'    => '应用新文件',
            'pruning'     => '清理废弃文件',
            'finalizing'  => '写入更新记录',
            'health_check'=> '更新后自检',
            'done'        => '已完成',
        );
        return isset($map[$phase]) ? $map[$phase] : $phase;
    }

    /** 全局锁（仅保护建任务，非阻塞）。 */
    private static function acquireGlobalLock()
    {
        if (!self::ensureDir(self::baseDir())) {
            return null;
        }
        $fp = @fopen(self::lockFile(), 'c');
        if (!$fp) {
            return null;
        }
        if (!flock($fp, LOCK_EX | LOCK_NB)) {
            fclose($fp);
            return null;
        }
        return $fp;
    }

    /**
     * 任务推进锁当前是否空闲（空闲 = 没有任何请求正在推进这个任务）。
     * 只探不持有：拿到立即释放，用于判断 running 任务是活的还是残骸。
     */
    private static function probeJobLock($id)
    {
        if (!self::ensureDir(self::jobsDir())) {
            return true;
        }
        $lp = @fopen(self::jobsDir() . '/' . $id . '.lock', 'c');
        if (!$lp) {
            return false;
        }
        $free = flock($lp, LOCK_EX | LOCK_NB);
        if ($free) {
            flock($lp, LOCK_UN);
        }
        fclose($lp);
        return (bool) $free;
    }

    /**
     * 启动（或续跑）更新任务。
     * @return array('jobId' => string, 'resumed' => bool)
     * @throws GF_UserError 409 已有任务 / 400 无需更新、版本过低、磁盘不足等
     */
    public static function startUpdate($force = false, $siteUrl = '')
    {
        $lock = self::acquireGlobalLock();
        if ($lock === null) {
            throw new GF_UserError('已有更新任务正在进行', 409);
        }
        try {
            $base = self::sourceUrl();
            $m    = self::fetchManifest($base);

            $active = self::activeJob();
            if ($active !== null) {
                // 更新源可能被「热修重打」过：包还是那个版本号，但字节变了。
                // 这时旧任务下载到一半的 .part 属于旧包，续传必然 sha256 校验失败，
                // 直接作废重建，别浪费用户一次失败。
                $rehash = !isset($active['remote']['packageSha256'])
                    || $active['remote']['packageSha256'] !== $m['packageSha256'];
                $early  = in_array($active['phase'], array('queued', 'downloading', 'verifying'), true);
                if ($rehash && $early) {
                    self::cancel($active['id']);
                    $active = null;
                }
            }

            if ($active !== null) {
                if ($active['status'] === 'running') {
                    // running 也可能是「上一次请求被客户端掐断」留下的残骸：
                    // 探一次推进锁，能拿到就说明当前没有任何请求在推进它 → 直接接管续跑。
                    // 否则才是真的有任务在跑，返回 409（此时前端保持轮询即可，不必重开）。
                    if (!self::probeJobLock($active['id'])) {
                        throw new GF_UserError('已有更新任务正在进行', 409);
                    }
                    $active = self::jobLog($active, '接管了此前中断的更新任务');
                }
                // stalled / 接管：原地续跑
                $active['status'] = 'running';
                self::writeJob($active);
                return array('jobId' => $active['id'], 'resumed' => true);
            }

            $lv   = self::localVersion();
            $cmp  = self::compare($m['version'], $lv);

            if (!$force && $cmp <= 0) {
                throw new GF_UserError(
                    $cmp === 0 ? '已是最新版本 v' . $lv . '（修复安装可勾选强制重装）'
                               : '更新源版本 v' . $m['version'] . ' 低于本地 v' . $lv,
                    409
                );
            }
            if ($m['minVersion'] !== '' && self::compare($lv, $m['minVersion']) < 0) {
                throw new GF_UserError('本地版本过低，请先手动部署 ≥ v' . $m['minVersion'] . ' 的版本');
            }
            $free = @disk_free_space(self::baseDir());
            if ($free !== false && $free < $m['packageSize'] * 2 + 134217728) {
                throw new GF_UserError('磁盘空间不足：需 ≥ ' . self::mb($m['packageSize'] * 2 + 134217728) . '，当前可用 ' . self::mb($free));
            }

            $local   = self::scanLocal();
            $applied = self::readJson(self::appliedFile(), null);
            $af      = (is_array($applied) && isset($applied['files']) && is_array($applied['files'])) ? $applied['files'] : array();
            $diff    = self::planDiff($local, $m['files'], $af);

            $jobId = date('YmdHis') . substr((string) mt_rand(1000, 9999), 0, 4);
            $job   = array(
                'id'       => $jobId,
                'status'   => 'running',
                'phase'    => 'queued',
                'percent'  => 0,
                'message'  => '已创建更新任务',
                'log'      => array(),
                'progress' => array(
                    'bytes'     => 0,
                    'totalBytes'=> $m['packageSize'],
                    'fileIndex' => 0,
                    'fileTotal' => count($m['files']),
                ),
                'force'     => (bool) $force,
                'siteUrl'   => (string) $siteUrl,
                'source'    => $base,
                'remote'    => array(
                    'version'       => $m['version'],
                    'publishedAt'   => $m['publishedAt'],
                    'packageUrl'    => $m['packageUrl'],
                    'packageSize'   => $m['packageSize'],
                    'packageSha256' => $m['packageSha256'],
                    /* ★v1.3.3：兜底包信息必须随任务一起持久化 —— 少了这一行，
                       switchToFallback() 永远读到 null，降级链路等于没接（实测抓到的 bug）。 */
                    'fallback'      => $m['fallback'],
                    'files'         => $m['files'],
                ),
                'plan'      => $diff,
                'backupId'  => $jobId,
                'healthFails' => 0,
                'startedAt' => gmdate('c'),
                'updatedAt' => gmdate('c'),
            );
            self::writeJob($job);
            return array('jobId' => $jobId, 'resumed' => false);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private static function mb($bytes)
    {
        return round(((int) $bytes) / 1048576, 1) . ' MB';
    }

    /**
     * 推进任务 ≤ SLICE_MS。status 接口每次轮询都会调用它——
     * 关掉页面任务暂停，重新打开自动续跑。
     * @return array|null 任务快照（无此任务返回 null）
     */
    public static function advanceJob($id)
    {
        $job = self::readJob($id);
        if ($job === null || ($job['status'] !== 'running' && $job['status'] !== 'stalled')) {
            return $job;
        }
        if (!self::ensureDir(self::jobsDir())) {
            return $job;
        }
        $lp = @fopen(self::jobsDir() . '/' . $id . '.lock', 'c');
        if (!$lp) {
            return $job;
        }
        if (!flock($lp, LOCK_EX | LOCK_NB)) {
            fclose($lp); // 另有请求正在推进
            return $job;
        }
        if ($job['status'] === 'stalled') {
            // 进入这里的请求已经拿到推进锁，说明此前确实没人管它了 —— 直接续跑，
            // 不必等用户再点一次「立即更新」。
            $job = self::jobLog($job, '检测到停滞，自动续跑');
            $job['status'] = 'running';
            self::writeJob($job);
        }
        try {
            $deadline = microtime(true) + self::SLICE_MS / 1000;
            while (microtime(true) < $deadline) {
                $job = self::readJob($id);
                if ($job === null || $job['status'] !== 'running') {
                    break;
                }
                $phase = $job['phase'];
                if ($phase === 'queued') {
                    self::setPhase($job, 'downloading');
                    continue;
                }
                if ($phase === 'downloading') {
                    self::phaseDownload($job, $deadline);
                } elseif ($phase === 'verifying') {
                    self::phaseVerify($job);
                } elseif ($phase === 'backing_up') {
                    self::phaseBackup($job, $deadline);
                } elseif ($phase === 'extracting') {
                    self::phaseExtract($job, $deadline);
                } elseif ($phase === 'applying') {
                    self::phaseApply($job, $deadline);
                } elseif ($phase === 'pruning') {
                    self::phasePrune($job, $deadline);
                } elseif ($phase === 'finalizing') {
                    self::phaseFinalize($job);
                } elseif ($phase === 'health_check') {
                    self::phaseHealth($job);
                } else {
                    break;
                }
                if ($job === null) {
                    break;
                }
            }
        } catch (Exception $e) {
            $job = self::readJob($id);
            if ($job !== null) {
                self::failJob($job, $e->getMessage());
            }
        } finally {
            flock($lp, LOCK_UN);
            fclose($lp);
        }
        return self::readJob($id);
    }

    /** 任务快照（供 status 接口返回；附阶段中文名与百分比）。 */
    public static function jobSnapshot($job)
    {
        if ($job === null) {
            return null;
        }
        $log = isset($job['log']) && is_array($job['log']) ? array_slice($job['log'], -50) : array();
        $pct = isset($job['percent']) ? (int) $job['percent'] : 0;
        if ($job['phase'] === 'downloading' && !empty($job['progress']['totalBytes'])) {
            $pct = (int) floor($job['progress']['bytes'] / $job['progress']['totalBytes'] * 60);
        } elseif (($job['phase'] === 'extracting' || $job['phase'] === 'applying') && !empty($job['progress']['fileTotal'])) {
            $pct = 60 + (int) floor($job['progress']['fileIndex'] / $job['progress']['fileTotal'] * 35);
        }
        $result = null;
        if ($job['status'] === 'done' || $job['status'] === 'rolled_back') {
            $result = array(
                'added'   => isset($job['result']['added']) ? $job['result']['added'] : 0,
                'updated' => isset($job['result']['updated']) ? $job['result']['updated'] : 0,
                'deleted' => isset($job['result']['deleted']) ? $job['result']['deleted'] : 0,
            );
        }
        return array(
            'id'        => $job['id'],
            'status'    => $job['status'],
            'phase'     => $job['phase'],
            'phaseLabel'=> self::phaseLabel($job['phase']),
            'percent'   => $pct,
            'message'   => isset($job['message']) ? $job['message'] : '',
            'log'       => $log,
            'error'     => isset($job['error']) ? $job['error'] : null,
            'progress'  => isset($job['progress']) ? $job['progress'] : null,
            'backupId'  => isset($job['backupId']) ? $job['backupId'] : null,
            'result'    => $result,
            'migration' => isset($job['migration']) ? $job['migration'] : null,
            'startedAt' => isset($job['startedAt']) ? $job['startedAt'] : null,
            'finishedAt'=> isset($job['finishedAt']) ? $job['finishedAt'] : null,
        );
    }

    /* ==================== 各阶段实现 ==================== */

    private static function jobDir($id)
    {
        return self::jobsDir() . '/' . $id;
    }

    private static function phaseDownload($job, $deadline)
    {
        $dir   = self::jobDir($job['id']);
        if (!self::ensureDir($dir)) {
            throw new Exception('无法创建任务目录：' . $dir);
        }
        $part  = self::partFile($job);
        $have  = is_file($part) ? (int) @filesize($part) : 0;
        $total = (int) $job['remote']['packageSize'];
        if ($have > $total) {
            @unlink($part);
            $have = 0;
        }
        if ($have >= $total && $total > 0) {
            $job['progress']['bytes'] = $have;
            self::writeJob($job);
            self::setPhase($job, 'verifying');
            return;
        }

        $url  = $job['remote']['packageUrl'];
        $port = self::urlPort($url);
        if (!flyme_ssrf_check_url($url, array($port))) {
            throw new Exception('安装包地址未通过安全校验：' . $url);
        }

        $written = 0;
        $aborted = false; // 到达单片预算，主动中断等待下片续传
        if (function_exists('curl_init')) {
            $fp = @fopen($part, $have > 0 ? 'ab' : 'wb');
            if (!$fp) {
                throw new Exception('无法写入下载临时文件');
            }
            $ch = curl_init($url);
            $hdrs = array('User-Agent: nawu-updater/1.0');
            if ($have > 0) {
                $hdrs[] = 'Range: bytes=' . $have . '-';
            }
            curl_setopt_array($ch, array(
                CURLOPT_FILE            => null,
                CURLOPT_RETURNTRANSFER  => false,
                CURLOPT_FOLLOWLOCATION  => false,
                CURLOPT_CONNECTTIMEOUT  => 8,
                CURLOPT_NOPROGRESS      => true,
                CURLOPT_SSL_VERIFYPEER  => true,
                CURLOPT_HTTPHEADER      => $hdrs,
            ));
            $self = $job['id'];
            curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$fp, &$written, &$aborted, $deadline) {
                if (microtime(true) >= $deadline) {
                    $aborted = true;
                    return 0; // 中断传输，保留 .part 下片续传
                }
                $n = fwrite($fp, $data);
                if ($n === false) {
                    return 0;
                }
                $written += $n;
                return $n;
            });
            curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $err    = curl_error($ch);
            curl_close($ch);
            fclose($fp);
            if ($have > 0 && $status === 200) {
                // 上游忽略 Range：截断重下（本片从头开始）
                @unlink($part);
                $job['progress']['bytes'] = 0;
                self::writeJob($job);
                self::phaseDownload($job, $deadline);
                return;
            }
            if ($status >= 400) {
                throw new Exception('下载失败：更新源返回 HTTP ' . $status . ($err ? '（' . $err . '）' : ''));
            }
            if (!$aborted && $err !== '') {
                throw new Exception('下载中断：' . $err . '（已保留断点，下次轮询自动续传）');
            }
        } else {
            // 无 curl：stream 兜底（Range 头续传）
            $ctx = stream_context_create(array('http' => array(
                'method'        => 'GET',
                'header'        => ($have > 0 ? 'Range: bytes=' . $have . "-\r\n" : '') . "User-Agent: nawu-updater/1.0\r\n",
                'timeout'       => 6,
                'ignore_errors' => true,
            )));
            $remote = @fopen($url, 'rb', false, $ctx);
            if (!$remote) {
                throw new Exception('打不开安装包地址：' . $url);
            }
            $status = 0;
            if (isset($http_response_header) && is_array($http_response_header)) {
                foreach ($http_response_header as $h) {
                    if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $mm)) {
                        $status = (int) $mm[1];
                    }
                }
            }
            if ($status >= 400) {
                fclose($remote);
                throw new Exception('下载失败：更新源返回 HTTP ' . $status);
            }
            if ($have > 0 && $status !== 206) {
                fclose($remote);
                @unlink($part);
                $job['progress']['bytes'] = 0;
                self::writeJob($job);
                self::phaseDownload($job, $deadline);
                return;
            }
            $fp = @fopen($part, $have > 0 ? 'ab' : 'wb');
            if (!$fp) {
                fclose($remote);
                throw new Exception('无法写入下载临时文件');
            }
            while (!feof($remote) && microtime(true) < $deadline) {
                $buf = fread($remote, self::CHUNK);
                if ($buf === '' || $buf === false) {
                    break;
                }
                fwrite($fp, $buf);
                $written += strlen($buf);
            }
            fclose($remote);
            fclose($fp);
        }

        $nowHave = $have + $written;
        $job['progress']['bytes'] = $nowHave;
        if ($nowHave >= $total) {
            self::writeJob($job);
            self::setPhase($job, 'verifying');
            return;
        }
        self::writeJob($job); // 保持 running，下片继续
    }

    private static function urlPort($url)
    {
        $p = parse_url($url);
        if (isset($p['port'])) {
            return (int) $p['port'];
        }
        return (strtolower(isset($p['scheme']) ? $p['scheme'] : 'http') === 'https') ? 443 : 80;
    }

    /**
     * ★v1.3.3 下载临时文件的绝对路径。
     * 文件名随尝试次数变（`package.zip.part` → `package.zip.alt.part`）：
     * Windows 上旧 .part 偶尔会因句柄未及时释放而删不掉，若继续用同名文件，
     * 续传会拿「主包的前半段 + 全量包的后半段」拼出一个大小刚好对、内容全错的包
     * （实测踩到：14.6MB + 7.2MB = 21.8MB，size 校验通过、sha256 必挂）。
     * 换名 = 新文件从 0 开始，物理上不可能拼接。
     */
    private static function partFile($job)
    {
        $name = isset($job['remote']['partName']) ? (string) $job['remote']['partName'] : 'package.zip.part';
        if (!preg_match('/^package\.zip(\.[a-z0-9]+)?\.part$/', $name)) {
            $name = 'package.zip.part';
        }
        return self::jobDir($job['id']) . '/' . $name;
    }

    /**
     * ★v1.3.3 增量包坏了 → 自动改下全量包（一次为限），失败才真正终止。
     * 返回 true 表示已经切到兜底包、调用方应直接 return（下一拍从下载阶段继续）。
     */
    private static function switchToFallback(&$job, $reason)
    {
        $fb = isset($job['remote']['fallback']) ? $job['remote']['fallback'] : null;
        if (!is_array($fb) || empty($fb['url'])) {
            return false;
        }
        if (!empty($job['remote']['usedFallback'])) {
            return false;
        }
        /* 主包那次用的 .part 尽力删掉（删不掉也不影响：下面会换成新文件名，
           绝不会续传到旧内容上）；同时清掉可能残留的上一次兜底临时文件。 */
        foreach (array('package.zip.part', 'package.zip.alt.part') as $sub) {
            $p = self::jobDir($job['id']) . '/' . $sub;
            if (is_file($p)) {
                @unlink($p);
            }
        }
        $job['remote']['partName']      = 'package.zip.alt.part';
        $job['remote']['packageUrl']    = $fb['url'];
        $job['remote']['packageSize']   = (int) $fb['size'];
        $job['remote']['packageSha256'] = (string) $fb['sha256'];
        $job['remote']['usedFallback']  = true;
        $job['progress']['bytes']       = 0;
        $job['progress']['percent']     = 0;
        /* 总字节数也要换成兜底包的：前端进度条按 totalBytes 算百分比，
           不改的话会一直卡在「超过 100%」或者算成未知大小。 */
        $job['progress']['totalBytes']  = (int) $fb['size'];
        $job['plan']                    = null;
        $job['backupIndex']             = 0;
        $job['backupBytes']             = 0;
        $job['progress']['fileIndex']   = 0;
        $job = self::jobLog($job, '增量包不可用（' . $reason . '），已自动改用全量包重下');
        self::writeJob($job);
        self::setPhase($job, 'downloading');
        return true;
    }

    private static function phaseVerify($job)
    {
        $part = self::partFile($job);
        if (!is_file($part)) {
            if (self::switchToFallback($job, '临时文件丢失')) {
                return;
            }
            throw new Exception('安装包文件丢失，请重新开始更新');
        }
        if ((int) @filesize($part) !== (int) $job['remote']['packageSize']) {
            if (self::switchToFallback($job, '大小不符')) {
                return;
            }
            throw new Exception('安装包大小与 manifest 不一致，请重新开始更新');
        }
        $sha = @hash_file('sha256', $part);
        if ($sha === false || $sha !== $job['remote']['packageSha256']) {
            if (self::switchToFallback($job, 'sha256 校验不通过')) {
                return;
            }
            @unlink($part);
            throw new Exception('安装包 sha256 校验不通过，已终止（站点未做任何改动）');
        }
        $job = self::jobLog($job, '安装包完整性校验通过');
        self::writeJob($job);
        self::setPhase($job, 'backing_up');
    }

    private static function phaseBackup($job, $deadline)
    {
        $bid  = $job['backupId'];
        $bdir = self::backupsDir() . '/' . $bid;
        if (!self::ensureDir($bdir . '/changed')) {
            throw new Exception('无法创建备份目录：' . $bdir);
        }
        // 待备份 = 将被覆盖的（updated）+ 将被删除的（deleted）
        $targets = array_merge(
            isset($job['plan']['updated']) ? $job['plan']['updated'] : array(),
            isset($job['plan']['deleted']) ? $job['plan']['deleted'] : array()
        );
        $idx = isset($job['progress']['fileIndex']) ? (int) $job['progress']['fileIndex'] : 0;
        // fileIndex 在 applying 阶段复用；backing_up 用自己的游标
        $bkIdx = isset($job['backupIndex']) ? (int) $job['backupIndex'] : 0;
        $bytes = isset($job['backupBytes']) ? (int) $job['backupBytes'] : 0;
        for ($i = $bkIdx; $i < count($targets); $i++) {
            if (microtime(true) >= $deadline) {
                $job['backupIndex'] = $i;
                $job['backupBytes'] = $bytes;
                self::writeJob($job);
                return;
            }
            $path = $targets[$i];
            $src  = GF_ROOT . '/' . $path;
            if (!is_file($src)) {
                continue;
            }
            $dst = $bdir . '/changed/' . $path;
            if (!self::ensureDir(dirname($dst))) {
                throw new Exception('无法创建备份子目录：' . $path);
            }
            if (!@copy($src, $dst)) {
                throw new Exception('备份文件失败：' . $path);
            }
            $bytes += (int) @filesize($src);
            if ($bytes > self::BACKUP_MAX_BYTES) {
                throw new Exception('备份体积超过上限（' . self::mb(self::BACKUP_MAX_BYTES) . '），已终止');
            }
        }
        $meta = array(
            'id'         => $bid,
            'version'    => self::localVersion(),
            'createdAt'  => self::now(),
            'files'      => array_values(array_filter($targets, function ($p) {
                return is_file(GF_ROOT . '/' . $p);
            })),
            'addedFiles' => isset($job['plan']['added']) ? $job['plan']['added'] : array(),
        );
        self::writeJson($bdir . '/job.json', $meta);
        $job = self::jobLog($job, '已备份 ' . count($meta['files']) . ' 个待改文件');
        self::writeJob($job);
        self::setPhase($job, 'extracting');
    }

    private static function phaseExtract($job, $deadline)
    {
        if (!class_exists('ZipArchive')) {
            throw new Exception('当前 PHP 未启用 zip 扩展：请在 php.ini 开启 extension=zip 后重试');
        }
        $part  = self::partFile($job);
        $stage = self::jobDir($job['id']) . '/stage';
        if (!is_file($part)) {
            throw new Exception('安装包文件丢失，请重新开始更新');
        }
        if (!self::ensureDir($stage)) {
            throw new Exception('无法创建解包目录');
        }
        $zip = new ZipArchive();
        if ($zip->open($part) !== true) {
            throw new Exception('安装包损坏或不是有效的 zip');
        }
        $stageReal = realpath($stage);
        $idx = isset($job['progress']['fileIndex']) ? (int) $job['progress']['fileIndex'] : 0;
        for ($i = $idx; $i < $zip->numFiles; $i++) {
            if (microtime(true) >= $deadline) {
                $job['progress']['fileIndex'] = $i;
                self::writeJob($job);
                $zip->close();
                return;
            }
            $name = $zip->getNameIndex($i);
            if ($name === false || !self::safeRelPath($name) || substr($name, -1) === '/') {
                $zip->close();
                throw new Exception('安装包含非法条目：' . (string) $name);
            }
            $dest = $stage . '/' . $name;
            // ⚠ 必须先建目录再做 realpath 校验：realpath 对不存在的路径返回 false，
            //   而 zip 条目顺序不保证父目录先出现（如 app/.htaccess 是 app/ 下第一个
            //   条目时，dirnam 还没建 → 被误判成「越界路径」整包更新失败）。
            //   目录建出来后 realpath 才有意义，与 safeRelPath 构成双保险。
            if (!self::ensureDir(dirname($dest))) {
                $zip->close();
                throw new Exception('无法创建解包子目录：' . $name);
            }
            $destDirReal = realpath(dirname($dest));
            if ($destDirReal === false || strpos($destDirReal, $stageReal) !== 0) {
                $zip->close();
                throw new Exception('安装包含越界路径：' . $name);
            }
            $content = $zip->getFromIndex($i);
            if ($content === false) {
                $zip->close();
                throw new Exception('读取安装包条目失败：' . $name);
            }
            if (@file_put_contents($dest, $content) === false) {
                $zip->close();
                throw new Exception('写入解包文件失败：' . $name);
            }
        }
        $zip->close();
        $job['progress']['fileIndex'] = $zip->numFiles;
        $job = self::jobLog($job, '解包完成，共 ' . $zip->numFiles . ' 个条目');
        self::writeJob($job);
        self::setPhase($job, 'applying');
    }

    private static function phaseApply($job, $deadline)
    {
        $stage = self::jobDir($job['id']) . '/stage';
        $files = $job['remote']['files'];
        $paths = array_keys($files);
        $idx   = isset($job['progress']['fileIndex']) ? (int) $job['progress']['fileIndex'] : 0;
        if ($idx === 0) {
            $job['appliedFiles'] = array();
        }
        for ($i = $idx; $i < count($paths); $i++) {
            if (microtime(true) >= $deadline) {
                $job['progress']['fileIndex'] = $i;
                self::writeJob($job);
                return;
            }
            $path = $paths[$i];
            $src  = $stage . '/' . $path;
            if (!is_file($src)) {
                throw new Exception('安装包内缺少文件：' . $path);
            }
            $sha = @hash_file('sha256', $src);
            if ($sha === false || $sha !== $files[$path]['sha256']) {
                throw new Exception('安装包内文件校验失败：' . $path);
            }
            $dst = GF_ROOT . '/' . $path;
            $isNew = !is_file($dst);
            if (!self::ensureDir(dirname($dst))) {
                throw new Exception('无法创建目标目录：' . dirname($path));
            }
            $tmp = $dst . '.' . getmypid() . '.tmp';
            if (!@copy($src, $tmp)) {
                throw new Exception('写入临时文件失败：' . $path);
            }
            $ok = @rename($tmp, $dst);
            if (!$ok) {
                // Windows：文件可能被其它进程占用，重试几次
                for ($t = 0; $t < 3 && !$ok; $t++) {
                    usleep(300000);
                    $ok = @rename($tmp, $dst);
                }
            }
            if (!$ok) {
                @unlink($tmp);
                throw new Exception('无法替换文件：' . $path . '（可能被占用，请稍后重试）');
            }
            @chmod($dst, 0644);
            if ($isNew) {
                $job['appliedFiles'][] = $path;
            }
            if (($i % 20) === 0) {
                $job['progress']['fileIndex'] = $i;
                self::writeJob($job);
            }
        }
        $job['progress']['fileIndex'] = count($paths);
        $job = self::jobLog($job, '新文件已应用（' . count($paths) . ' 个）');
        self::writeJob($job);
        // 关键：应用完成后结束本片——pruning/finalizing 由下一片的新代码执行
        self::setPhase($job, 'pruning');
    }

    private static function phasePrune($job, $deadline)
    {
        $deleted = isset($job['plan']['deleted']) ? $job['plan']['deleted'] : array();
        /* ★v1.1.5 修复：删除游标必须独立，不能复用应用阶段的 fileIndex。
         * 旧实现直接拿 progress.fileIndex 当删除循环起点，而应用阶段结束时
         * fileIndex 已被置为「已应用文件数」（例如 36）——删除清单若不足 36 条，
         * 循环起点就 >= 终点，整段清理被静默跳过：后台明明提示「将删除 36 个文件」，
         * 实际一个都没删，旧 chunk 越积越多（1.1.4→1.1.5 更新后站点仍有旧 bundle
         * 就是这个原因）。改用 pruneIndex（从 0 起）并单独持久化，续跑也安全。 */
        $idx   = isset($job['progress']['pruneIndex']) ? (int) $job['progress']['pruneIndex'] : 0;
        $total = count($deleted);
        $count = isset($job['prunedCount']) ? (int) $job['prunedCount'] : 0;
        for ($i = $idx; $i < $total; $i++) {
            if (microtime(true) >= $deadline) {
                $job['progress']['pruneIndex'] = $i;
                $job['prunedCount'] = $count;
                self::writeJob($job);
                return;
            }
            $dst = GF_ROOT . '/' . $deleted[$i];
            if (is_file($dst)) {
                @unlink($dst);
                $count++;
            }
            if (($i % 50) === 0) {
                $job['progress']['pruneIndex'] = $i;
                self::writeJob($job);
            }
        }
        $job['progress']['pruneIndex'] = $total;
        // 清理 assets/ 与 app/ 下的空子目录（根目录本身保留）
        self::pruneEmptyDirs(GF_ROOT . '/assets');
        self::pruneEmptyDirs(GF_ROOT . '/app');
        $job['prunedCount'] = $count;
        $job = self::jobLog($job, '已清理废弃文件 ' . $count . ' 个');
        self::writeJob($job);
        self::setPhase($job, 'finalizing');
    }

    /** 自底向上删除空子目录（不动 $root 自身）。 */
    private static function pruneEmptyDirs($root)
    {
        if (!is_dir($root)) {
            return;
        }
        $stack = array($root);
        $dirs  = array();
        while ($stack) {
            $dir = array_pop($stack);
            $dh  = @opendir($dir);
            if (!$dh) {
                continue;
            }
            $hasFile = false;
            while (($name = readdir($dh)) !== false) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                $full = $dir . '/' . $name;
                if (is_dir($full)) {
                    $stack[] = $full;
                    $dirs[] = $full;
                } else {
                    $hasFile = true;
                }
            }
            closedir($dh);
            if (!$hasFile && $dir !== $root) {
                @rmdir($dir);
            }
        }
        // 嵌套空目录：再扫一轮（简单起见循环两遍）
        $stack = array($root);
        while ($stack) {
            $dir = array_pop($stack);
            $dh  = @opendir($dir);
            if (!$dh) {
                continue;
            }
            $hasFile = false;
            $subs    = array();
            while (($name = readdir($dh)) !== false) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                $full = $dir . '/' . $name;
                if (is_dir($full)) {
                    $subs[] = $full;
                } else {
                    $hasFile = true;
                }
            }
            closedir($dh);
            if (!$hasFile && $dir !== $root) {
                @rmdir($dir);
            } else {
                foreach ($subs as $s) {
                    $stack[] = $s;
                }
            }
        }
    }

    private static function phaseFinalize($job)
    {
        $applied = array(
            'app'            => 'nawu-server',
            'version'        => $job['remote']['version'],
            'publishedAt'    => $job['remote']['publishedAt'],
            'appliedAt'      => self::now(),
            'source'         => $job['source'],
            'packageSha256'  => $job['remote']['packageSha256'],
            'files'          => $job['remote']['files'],
        );
        self::writeJson(self::appliedFile(), $applied);

        $hist = self::readJson(self::historyFile(), array());
        if (!is_array($hist)) {
            $hist = array();
        }
        $hist[] = array(
            'id'      => $job['id'],
            'version' => $job['remote']['version'],
            'result'  => 'done',
            'at'      => self::now(),
            'added'   => isset($job['plan']['added']) ? count($job['plan']['added']) : 0,
            'updated' => isset($job['plan']['updated']) ? count($job['plan']['updated']) : 0,
            'deleted' => isset($job['prunedCount']) ? (int) $job['prunedCount'] : 0,
        );
        if (count($hist) > 20) {
            $hist = array_slice($hist, -20);
        }
        self::writeJson(self::historyFile(), $hist);

        clearstatcache(true);
        if (function_exists('opcache_reset')) {
            @opcache_reset();
        }
        if (class_exists('GF_Migrate')) {
            try {
                $job['migration'] = GF_Migrate::run();
            } catch (Exception $e) {
                $job['migrationError'] = $e->getMessage();
            }
        }
        $job = self::jobLog($job, '更新记录已写入（v' . $job['remote']['version'] . '）');
        self::writeJob($job);
        self::setPhase($job, 'health_check');
    }

    private static function guessBaseUrl()
    {
        $https = !empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off';
        $host  = isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : 'localhost';
        $dir   = isset($_SERVER['SCRIPT_NAME']) ? dirname((string) $_SERVER['SCRIPT_NAME']) : '';
        if ($dir === '/' || $dir === '\\' || $dir === '.') {
            $dir = '';
        }
        return ($https ? 'https://' : 'http://') . $host . $dir;
    }

    /**
     * 健康自检：请求自身 /api/health，期望 ok===true。
     * 这是「自己请求自己」，host 来自 $_SERVER 或管理员输入，无注入面，
     * 因此不过 SSRF 校验（代码注释说明）。
     * @return array('ok' => bool, 'reachable' => bool, 'detail' => string)
     */
    public static function selfCheck($siteUrl = '')
    {
        $base = ($siteUrl !== '') ? rtrim((string) $siteUrl, '/') : self::guessBaseUrl();
        $url  = $base . '/api/health';
        $body = null;
        $err  = '';
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, array(
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 5,
                CURLOPT_CONNECTTIMEOUT => 3,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_SSL_VERIFYHOST => 0,
                CURLOPT_USERAGENT      => 'nawu-selfcheck/1.0',
            ));
            $body = curl_exec($ch);
            if ($body === false) {
                $err = curl_error($ch);
            }
            curl_close($ch);
        } else {
            $ctx = stream_context_create(array(
                'http' => array('timeout' => 5, 'ignore_errors' => true),
                'ssl'  => array('verify_peer' => false, 'verify_peer_name' => false),
            ));
            $body = @file_get_contents($url, false, $ctx);
            if ($body === false) {
                $err = '无法连接';
            }
        }
        $reachable = ($body !== false && $body !== null);
        $d = is_string($body) ? json_decode($body, true) : null;
        $ok = is_array($d) && isset($d['ok']) && $d['ok'] === true;
        return array(
            'ok'        => $ok,
            'reachable' => $reachable,
            'detail'    => $ok ? '' : ($reachable ? '响应不是预期的健康检查 JSON' : ('连接失败：' . $err)),
        );
    }

    private static function phaseHealth($job)
    {
        $r = self::selfCheck(isset($job['siteUrl']) ? $job['siteUrl'] : '');
        if ($r['ok']) {
            self::finishJob($job, 'done', '更新完成');
            self::pruneBackups();
            self::cleanupJobFiles($job['id']);
            return;
        }
        // 连不上（如 HTTP_HOST 推导错误）不判定失败，避免回滚一个好更新
        if (!$r['reachable']) {
            $job['healthNote'] = $r['detail'];
            self::finishJob($job, 'done', '更新完成（自检地址不可达，已跳过：' . $r['detail'] . '）');
            self::pruneBackups();
            self::cleanupJobFiles($job['id']);
            return;
        }
        $job['healthFails'] = (isset($job['healthFails']) ? (int) $job['healthFails'] : 0) + 1;
        if ($job['healthFails'] >= self::HEALTH_TRIES) {
            throw new Exception('更新后健康自检未通过（' . $r['detail'] . '），已自动回滚到更新前状态');
        }
        $job = self::jobLog($job, '自检未通过，将重试：' . $r['detail']);
        self::writeJob($job);
    }

    private static function finishJob($job, $status, $message)
    {
        $job['status']    = $status;
        $job['phase']     = $status === 'done' ? 'done' : $job['phase'];
        $job['percent']   = 100;
        $job['message']   = $message;
        $job['finishedAt']= gmdate('c');
        $job['result']    = array(
            'added'   => isset($job['plan']['added']) ? count($job['plan']['added']) : 0,
            'updated' => isset($job['plan']['updated']) ? count($job['plan']['updated']) : 0,
            'deleted' => isset($job['prunedCount']) ? (int) $job['prunedCount'] : 0,
        );
        self::writeJob($job);
    }

    /** 失败：必要时自动回滚，然后标记终态。 */
    private static function failJob($job, $message)
    {
        $phase = $job['phase'];
        $touched = in_array($phase, array('backing_up', 'extracting', 'applying', 'pruning', 'finalizing', 'health_check'), true);
        if ($touched && !empty($job['backupId'])) {
            try {
                $rb = self::rollback($job['backupId']);
                $job['status']     = 'rolled_back';
                $job['phase']      = 'rolled_back';
                $job['percent']    = 100;
                $job['message']    = '更新失败，已自动回滚（恢复 ' . $rb['restored'] . ' 个文件）';
                $job['error']      = $message;
                $job['finishedAt'] = gmdate('c');
                $hist = self::readJson(self::historyFile(), array());
                if (is_array($hist)) {
                    $hist[] = array(
                        'id' => $job['id'], 'version' => $job['remote']['version'], 'result' => 'rolled_back',
                        'at' => self::now(), 'error' => $message,
                    );
                    if (count($hist) > 20) {
                        $hist = array_slice($hist, -20);
                    }
                    self::writeJson(self::historyFile(), $hist);
                }
                self::writeJob($job);
                self::cleanupJobFiles($job['id']);
                return;
            } catch (Exception $e) {
                $message = $message . '；自动回滚也失败：' . $e->getMessage() . '（请用后台「历史与回滚」手动恢复）';
            }
        }
        $job['status']     = 'failed';
        $job['percent']    = 100;
        $job['error']      = $message;
        $job['message']    = '更新失败：' . $message;
        $job['finishedAt'] = gmdate('c');
        self::writeJob($job);
        self::cleanupJobFiles($job['id']);
    }

    /** 清理任务的 .part / stage（备份保留）。 */
    private static function cleanupJobFiles($id)
    {
        $dir = self::jobDir($id);
        if (!is_dir($dir)) {
            return;
        }
        foreach (array('package.zip.part', 'package.zip.alt.part', 'stage') as $sub) {
            $p = $dir . '/' . $sub;
            if (is_file($p)) {
                @unlink($p);
            } elseif (is_dir($p)) {
                self::rmdirRecursive($p);
            }
        }
    }

    private static function rmdirRecursive($dir)
    {
        if (!is_dir($dir)) {
            return;
        }
        $dh = @opendir($dir);
        if ($dh) {
            while (($name = readdir($dh)) !== false) {
                if ($name === '.' || $name === '..') {
                    continue;
                }
                $full = $dir . '/' . $name;
                if (is_dir($full)) {
                    self::rmdirRecursive($full);
                } else {
                    @unlink($full);
                }
            }
            closedir($dh);
        }
        @rmdir($dir);
    }

    /* ==================== 回滚 ==================== */

    /**
     * 用指定备份恢复站点：删掉更新新增的文件，把 changed/ 里的旧文件写回。
     * @return array('restored' => int, 'version' => string)
     */
    public static function rollback($backupId)
    {
        if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', (string) $backupId)) {
            throw new GF_UserError('备份 ID 不合法');
        }
        $bdir = self::backupsDir() . '/' . $backupId;
        $meta = self::readJson($bdir . '/job.json', null);
        if (!is_array($meta)) {
            throw new GF_UserError('备份不存在：' . $backupId, 404);
        }
        $restored = 0;
        // 1) 更新新增的文件 → 删除
        foreach ((isset($meta['addedFiles']) && is_array($meta['addedFiles'])) ? $meta['addedFiles'] : array() as $path) {
            if (self::safeRelPath($path) && is_file(GF_ROOT . '/' . $path)) {
                @unlink(GF_ROOT . '/' . $path);
            }
        }
        // 2) 备份里的旧文件 → 写回
        foreach ((isset($meta['files']) && is_array($meta['files'])) ? $meta['files'] : array() as $path) {
            if (!self::safeRelPath($path)) {
                continue;
            }
            $src = $bdir . '/changed/' . $path;
            $dst = GF_ROOT . '/' . $path;
            if (is_file($src)) {
                if (self::ensureDir(dirname($dst))) {
                    if (@copy($src, $dst)) {
                        $restored++;
                    }
                }
            }
        }
        clearstatcache(true);
        if (function_exists('opcache_reset')) {
            @opcache_reset();
        }
        $hist = self::readJson(self::historyFile(), array());
        if (is_array($hist)) {
            $hist[] = array('id' => 'rollback-' . $backupId, 'version' => $meta['version'], 'result' => 'rolled_back_manual', 'at' => self::now());
            if (count($hist) > 20) {
                $hist = array_slice($hist, -20);
            }
            self::writeJson(self::historyFile(), $hist);
        }
        return array('restored' => $restored, 'version' => isset($meta['version']) ? $meta['version'] : '');
    }

    /* ==================== 备份管理 ==================== */

    /** 备份列表（新的在前）。 */
    public static function backups()
    {
        $dir  = self::backupsDir();
        $out  = array();
        if (!is_dir($dir)) {
            return $out;
        }
        foreach (glob($dir . '/*/job.json') as $f) {
            $m = self::readJson($f, null);
            if (!is_array($m) || !isset($m['id'])) {
                continue;
            }
            $size = 0;
            $cdir = dirname($f) . '/changed';
            if (is_dir($cdir)) {
                $stack = array($cdir);
                while ($stack) {
                    $d = array_pop($stack);
                    $dh = @opendir($d);
                    if (!$dh) {
                        continue;
                    }
                    while (($name = readdir($dh)) !== false) {
                        if ($name === '.' || $name === '..') {
                            continue;
                        }
                        $full = $d . '/' . $name;
                        if (is_dir($full)) {
                            $stack[] = $full;
                        } else {
                            $size += (int) @filesize($full);
                        }
                    }
                    closedir($dh);
                }
            }
            $out[] = array(
                'id'        => $m['id'],
                'version'   => isset($m['version']) ? $m['version'] : '',
                'createdAt' => isset($m['createdAt']) ? $m['createdAt'] : '',
                'sizeMb'    => round($size / 1048576, 2),
                'fileCount' => (isset($m['files']) && is_array($m['files'])) ? count($m['files']) : 0,
            );
        }
        usort($out, function ($a, $b) {
            return strcmp($b['createdAt'], $a['createdAt']);
        });
        return $out;
    }

    /** 只保留最近 BACKUP_KEEP 个备份。 */
    private static function pruneBackups()
    {
        $list = self::backups();
        if (count($list) <= self::BACKUP_KEEP) {
            return;
        }
        $old = array_slice($list, self::BACKUP_KEEP);
        foreach ($old as $b) {
            self::rmdirRecursive(self::backupsDir() . '/' . $b['id']);
        }
    }

    /* ==================== 取消 ==================== */

    /** 取消任务（仅 applying 之前有效）。 */
    public static function cancel($id)
    {
        $job = self::readJob($id);
        if ($job === null) {
            throw new GF_UserError('任务不存在', 404);
        }
        if (!in_array($job['phase'], array('queued', 'downloading', 'verifying', 'backing_up', 'extracting'), true)) {
            throw new GF_UserError('已进入文件应用阶段，无法取消（可等待完成后回滚）', 409);
        }
        $job['status']     = 'cancelled';
        $job['message']    = '已取消';
        $job['finishedAt'] = gmdate('c');
        self::writeJob($job);
        self::cleanupJobFiles($id);
        // 取消时若已产生备份，一并清掉
        if (!empty($job['backupId'])) {
            self::rmdirRecursive(self::backupsDir() . '/' . $job['backupId']);
        }
        return true;
    }

    /* ==================== info ==================== */

    public static function info()
    {
        $active = self::activeJob();
        $source = GF_Config::updateSource();
        $free   = @disk_free_space(self::baseDir());
        $applied = self::readJson(self::appliedFile(), null);
        return array(
            'version'    => self::localVersion(),
            'php'        => PHP_VERSION,
            'os'         => PHP_OS,
            'diskFreeMb' => $free === false ? null : round($free / 1048576, 1),
            'source'     => array(
                'url'       => isset($source['url']) ? (string) $source['url'] : '',
                'effective' => self::sourceUrl(),
                'autoCheck' => (isset($source['autoCheck']) ? (string) $source['autoCheck'] : 'true') === 'true',
            ),
            'applied'    => $applied === null ? null : array(
                'version'   => isset($applied['version']) ? $applied['version'] : '',
                'appliedAt' => isset($applied['appliedAt']) ? $applied['appliedAt'] : '',
                'source'    => isset($applied['source']) ? $applied['source'] : '',
                'fileCount' => (isset($applied['files']) && is_array($applied['files'])) ? count($applied['files']) : 0,
            ),
            'backups'    => self::backups(),
            'activeJob'  => $active === null ? null : array(
                'id'     => $active['id'],
                'status' => $active['status'],
                'phase'  => $active['phase'],
            ),
            'schema'     => array(
                'current' => class_exists('GF_Migrate') ? GF_Migrate::current() : 0,
                'target'  => class_exists('GF_Migrate') ? GF_Migrate::LATEST : 0,
            ),
        );
    }
}
