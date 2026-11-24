<?php
/**
 * t_ai_http.php —— /api/ai/icons 的真实处理链路自测（★不需要 MySQL）
 *
 * 原理：flyme_json() 会 exit，所以把「真调用 GF_Ai::icons()」放到**子进程**
 * （t_ai_http_child.php），父进程只负责起进程 + 断言 JSON。
 * 参数走临时文件（不走 argv）—— Windows 命令行对引号/中文的转义不可靠。
 *
 * 另含：stats / entity / query 的核心**算法口径**断言（桩数据直喂，不连库）。
 *
 * 跑法： php t_ai_http.php
 * 退出码：0 全过 / 1 有失败
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

$fail = 0;
$pass = 0;
function t_ok($cond, $label, $detail = '')
{
    global $fail, $pass;
    if ($cond) {
        $pass++;
        echo "  [PASS] {$label}\n";
    } else {
        $fail++;
        echo "  [FAIL] {$label}" . ($detail !== '' ? "  → {$detail}" : '') . "\n";
    }
}

/** 起子进程跑 t_ai_http_child.php，返回解析后的 JSON（失败返回 null）。 */
function api_call($mode, $get)
{
    $dir = sys_get_temp_dir();
    $argFile = $dir . '/nawu_test_' . getmypid() . '_' . mt_rand(1000, 9999) . '.json';
    file_put_contents($argFile, json_encode($get, JSON_UNESCAPED_UNICODE));
    $cmd = escapeshellarg(PHP_BINARY)
        . ' ' . escapeshellarg(__DIR__ . '/t_ai_http_child.php')
        . ' ' . escapeshellarg($mode)
        . ' ' . escapeshellarg($argFile)
        . ' 2>&1';
    $raw = shell_exec($cmd);
    @unlink($argFile);
    $j = json_decode((string) $raw, true);
    if (!is_array($j)) {
        echo "    (子进程原始输出：" . substr((string) $raw, 0, 400) . ")\n";
    }
    return is_array($j) ? $j : null;
}

echo "== ① GET /api/ai/icons?q=Netflix,B站大会员,阿里云,某个没收录的小众服务,netflx ==\n";
$j = api_call('icons', array(
    'q' => 'Netflix,B站大会员,阿里云,某个没收录的小众服务,netflx',
    'limit' => '3',
));
t_ok($j !== null, '子进程返回合法 JSON');
if ($j === null) {
    echo "PASS={$pass}  FAIL={$fail}\n";
    exit(1);
}
t_ok(isset($j['ok']) && $j['ok'] === true, 'ok=true');
t_ok(isset($j['mode']) && $j['mode'] === 'search', 'mode=search', (string) ($j['mode'] ?? ''));
t_ok(isset($j['queryCount']) && $j['queryCount'] === 5, 'queryCount=5', (string) ($j['queryCount'] ?? ''));
t_ok(isset($j['hitCount']) && $j['hitCount'] >= 4, '至少 4 个命中（含 netflx 容错）', (string) ($j['hitCount'] ?? ''));

$byQ = array();
foreach ((array) ($j['results'] ?? array()) as $r) {
    $byQ[$r['query']] = $r;
}
$expect = array(
    'Netflix'              => 'brand:netflix',
    'B站大会员'             => 'brand:bilibili',
    '阿里云'                => 'brand:alibabacloud',
    'netflx'               => 'brand:netflix',
);
foreach ($expect as $q => $want) {
    $got = isset($byQ[$q]['matched']['write']) ? $byQ[$q]['matched']['write'] : null;
    t_ok($got === $want, "{$q} → {$want}", var_export($got, true));
}
t_ok(isset($byQ['某个没收录的小众服务']) && $byQ['某个没收录的小众服务']['matched'] === null,
    '未收录品牌 matched=null');
t_ok(isset($byQ['某个没收录的小众服务']['suggestion']['steps'])
    && count((array) $byQ['某个没收录的小众服务']['suggestion']['steps']) >= 3, '未收录时给出 ≥3 步兜底');
t_ok(isset($j['usage']['write']) && strpos((string) $j['usage']['write'], 'subscriptions.icon') !== false,
    'usage.write 指向 subscriptions.icon');
t_ok(isset($j['stats']['brands']) && $j['stats']['brands'] >= 150, 'stats.brands ≥150', (string) ($j['stats']['brands'] ?? ''));

$allAbs = true;
$allWrite = true;
foreach ((array) ($j['results'] ?? array()) as $r) {
    if ($r['matched'] === null) {
        continue;
    }
    if (empty($r['matched']['icon']['absolute'])) {
        $allAbs = false;
    }
    $w = (string) ($r['matched']['write'] ?? '');
    if ($w === '' || !(strpos($w, 'brand:') === 0 || strpos($w, '/brand-icons/') === 0 || strpos($w, '/api/icon/img') === 0 || preg_match('#^[a-z][a-z0-9\-]+$#i', $w))) {
        $allWrite = false;
    }
}
t_ok($allAbs, '所有命中项的 icon.absolute 非空');
t_ok($allWrite, '所有命中项的 write 都是合法 icon 值（brand:/站内路径/回源代理/lucide）');

echo "\n== ② GET /api/ai/icons?list=1&keyword=云（品牌清单）==\n";
$j = api_call('list', array('list' => '1', 'keyword' => '云'));
t_ok($j !== null && !empty($j['ok']), 'list 模式 ok=true');
t_ok($j !== null && isset($j['brands']) && count((array) $j['brands']) > 3, 'keyword=云 返回 >3 个品牌',
    (string) ($j !== null ? count((array) ($j['brands'] ?? array())) : 'n/a'));
$hasYun = false;
foreach ((array) ($j['brands'] ?? array()) as $b) {
    if (($b['domain'] ?? '') === 'aliyun.com') {
        $hasYun = true;
    }
}
t_ok($hasYun, '清单里含阿里云（domain=aliyun.com）');

echo "\n== ③ 缺参 / 边界 ==\n";
$j = api_call('icons', array());
t_ok($j !== null && empty($j['ok']) && isset($j['error']), 'q 为空且无 list → 400 + 可用提示',
    (string) ($j['error'] ?? ''));

$j = api_call('icons', array('q' => '   '));
t_ok($j !== null && empty($j['ok']), 'q 全是空格 → 400');

$long = str_repeat('a', 600);
$j = api_call('icons', array('q' => $long));
t_ok($j !== null && empty($j['ok']) && strpos((string) ($j['error'] ?? ''), '过长') !== false, 'q>500 字符 → 400 过长');

echo "\n== ④ stats 算法口径（桩数据）==\n";
$goods = array(
    array('id' => 'g_1', 'name' => '索尼 WH-1000XM5', 'price' => 2499, 'status' => 'active',
        'image' => array('source' => 'cloud', 'ref' => '/api/user/images/' . str_repeat('a', 64))),
    array('id' => 'g_2', 'name' => '罗技 MX Master 3S', 'price' => 699, 'status' => 'active',
        'image' => array('source' => 'system', 'ref' => '📦')),
    array('id' => 'g_3', 'name' => 'Kindle', 'price' => 999, 'status' => 'retired',
        'image' => array('source' => 'web', 'ref' => 'https://cdn/x.jpg')),
);
$vr = array(
    array('type' => 'expense', 'amount' => 35, 'date' => '2026-11-02', 'categoryId' => 'cl0'),
    array('type' => 'expense', 'amount' => 120, 'date' => '2026-11-05', 'categoryId' => 'cl1'),
    array('type' => 'income', 'amount' => 5000, 'date' => '2026-10-01', 'categoryId' => 'cl2'),
    array('type' => 'expense', 'amount' => 65, 'date' => '2026-10-20', 'categoryId' => 'cl0'),
    array('type' => 'expense', 'amount' => 18, 'date' => '2026-09-09', 'categoryId' => 'cl0'),
);
$rowHasImage = new ReflectionMethod('GF_Ai', 'rowHasImage');
$rowHasImage->setAccessible(true);
$noImg = array_values(array_filter($goods, function ($r) use ($rowHasImage) {
    return !$rowHasImage->invoke(null, $r);
}));
t_ok(count($noImg) === 1 && $noImg[0]['id'] === 'g_2', '3 件物品里只有 1 件「没图」（system 📦 不算图）',
    json_encode(array_map(function ($r) { return $r['id']; }, $noImg)));

$sumExp = 0;
foreach ($vr as $r) { if ($r['type'] === 'expense') { $sumExp += $r['amount']; } }
t_ok($sumExp === 238, '支出求和 = 238', (string) $sumExp);

$byMonth = array();
foreach ($vr as $r) {
    if ($r['type'] !== 'expense') { continue; }
    $k = substr($r['date'], 0, 7);
    $byMonth[$k] = (isset($byMonth[$k]) ? $byMonth[$k] : 0) + $r['amount'];
}
ksort($byMonth);
t_ok($byMonth === array('2026-09' => 18, '2026-10' => 65, '2026-11' => 155), '按月的支出 09:18 / 10:65 / 11:155',
    json_encode($byMonth));

$byCat = array();
foreach ($vr as $r) {
    $k = $r['categoryId'];
    $byCat[$k] = (isset($byCat[$k]) ? $byCat[$k] : 0) + $r['amount'];
}
t_ok($byCat['cl0'] === 118, '分类 cl0 合计 118', (string) $byCat['cl0']);

echo "\n== ⑤ 组合筛选：找「活跃且没图」的物品 ==\n";
$mr = new ReflectionMethod('GF_Ai', 'matchRow');
$mr->setAccessible(true);
$hit = array_values(array_filter($goods, function ($r) use ($mr) {
    return $mr->invoke(null, $r, array('status' => 'active', '$hasImage' => false));
}));
t_ok(count($hit) === 1 && $hit[0]['id'] === 'g_2', 'status=active 且 $hasImage:false → 只有 g_2',
    json_encode(array_map(function ($r) { return $r['id']; }, $hit)));

echo "\n== ⑥ OpenAPI 规范含新端点 ==\n";
$j = api_call('openapi', array());
t_ok($j !== null && isset($j['openapi']) && strpos((string) $j['openapi'], '3.1') === 0, 'openapi 3.1');
foreach (array('/api/ai/icons', '/api/ai/stats', '/api/ai/entity') as $p) {
    t_ok($j !== null && isset($j['paths'][$p]), "paths 含 {$p}");
}
t_ok($j !== null && isset($j['paths']['/api/ai/icons']['get']['operationId'])
    && $j['paths']['/api/ai/icons']['get']['operationId'] === 'nawu_icons', 'icons operationId=nawu_icons');
t_ok($j !== null && isset($j['components']['schemas']['Subscriptions']), 'schema 含 Subscriptions');
$iconDesc = '';
if ($j !== null && isset($j['components']['schemas']['Subscriptions']['properties']['icon']['description'])) {
    $iconDesc = (string) $j['components']['schemas']['Subscriptions']['properties']['icon']['description'];
}
t_ok(strpos($iconDesc, '/api/ai/icons') !== false, 'subscriptions.icon 描述里指向 /api/ai/icons',
    substr($iconDesc, 0, 120));
t_ok(strpos($iconDesc, 'brand:') !== false, 'subscriptions.icon 描述里说明了 brand: 引用码');

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);