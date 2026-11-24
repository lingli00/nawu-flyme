<?php
/**
 * t_ai_http_child.php —— 子进程：真正调用 GF_Ai::handle() 并输出 JSON。
 * （父进程 t_ai_http.php 用它跑，因为 flyme_json() 会 exit，主进程没法接着断言。）
 *
 * 用法： php t_ai_http_child.php <mode> <jsonGET>
 *   mode = icons | list
 */
if (!defined('GF_ROOT')) {
    define('GF_ROOT', __DIR__);
}
require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/Config.php';
require_once GF_ROOT . '/app/lib/Db.php';
require_once GF_ROOT . '/app/lib/Schema.php';
require_once GF_ROOT . '/app/lib/EntityNormalize.php';
require_once GF_ROOT . '/app/lib/Auth.php';
require_once GF_ROOT . '/app/lib/Mail.php';
require_once GF_ROOT . '/app/lib/Update.php';
require_once GF_ROOT . '/app/lib/Migrate.php';
require_once GF_ROOT . '/app/lib/FlymeFile.php';
require_once GF_ROOT . '/app/lib/IpLoc.php';
require_once GF_ROOT . '/app/lib/NawuAI.php';
require_once GF_ROOT . '/app/lib/BrandIndex.php';
require_once GF_ROOT . '/app/lib/AiApi.php';
require_once GF_ROOT . '/app/lib/Sync.php';
require_once GF_ROOT . '/app/lib/ImageStore.php';

$mode = isset($argv[1]) ? $argv[1] : 'icons';
/* 参数从**文件**读，不走 argv —— Windows 命令行的引号/中文转义会把 JSON 弄坏。 */
$get = array();
$argFile = isset($argv[2]) ? (string) $argv[2] : '';
if ($argFile !== '' && is_file($argFile)) {
    $decoded = json_decode((string) file_get_contents($argFile), true);
    $get = is_array($decoded) ? $decoded : array();
}
$_GET = $get;
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['HTTPS'] = 'on';
$_SERVER['HTTP_HOST'] = 'nawu.test';
header_remove();

/* ★关键：icons() 不读数据库，但 handle() 会先调 owner() → ensureTables() → MySQL。
 * 为了让子进程在**没有 MySQL** 的环境也能跑通真实路由，这里直接调 private icons()，
 * 路由分派本身由父进程的 openapi 断言覆盖（openapi.json 也不需要 DB）。 */
if ($mode === 'icons' || $mode === 'list') {
    $m = new ReflectionMethod('GF_Ai', 'icons');
    $m->setAccessible(true);
    $m->invoke(null);   // icons() 内部 flyme_ok/flyme_fail → exit，输出即 JSON
    exit(1);
}

if ($mode === 'openapi') {
    /* openapi() 会调 apiVersion()（读文件，不碰库）+ GF_AiSchema::openapiSchemas()（纯内存），
     * 但 handle() 里 openapi 分支在 owner() 之前 → 不碰数据库。这里直接调它。 */
    $m = new ReflectionMethod('GF_Ai', 'openapi');
    $m->setAccessible(true);
    $m->invoke(null);
    exit(1);
}

echo json_encode(array('ok' => false, 'error' => 'unknown mode'));
exit(1);