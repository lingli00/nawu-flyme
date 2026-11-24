<?php
/**
 * t_ai_payload.php —— 检查 /api/ai/schema 与 /api/ai/context 返回体里的「图片规则」与「读取入口」
 * 是否都给到位（这两个端点要 DB，所以这里只验**纯内存构造的那几段**，不连库）。
 *
 * 跑法： php t_ai_payload.php
 */
if (!defined('GF_ROOT')) {
    define('GF_ROOT', __DIR__);
}
require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/Config.php';
require_once GF_ROOT . '/app/lib/Db.php';
require_once GF_ROOT . '/app/lib/Schema.php';
require_once GF_ROOT . '/app/lib/EntityNormalize.php';
require_once GF_ROOT . '/app/lib/NawuAI.php';
require_once GF_ROOT . '/app/lib/BrandIndex.php';
require_once GF_ROOT . '/app/lib/AiSchema.php';
require_once GF_ROOT . '/app/lib/AiApi.php';

$pass = 0;
$fail = 0;
function ok($n, $c, $d = '')
{
    global $pass, $fail;
    if ($c) { $pass++; echo "  [PASS] {$n}\n"; }
    else { $fail++; echo "  [FAIL] {$n}" . ($d !== '' ? "  → {$d}" : '') . "\n"; }
}

echo "== schema 字典里的图片口径 ==\n";
$dict = GF_AiSchema::collections(array());
$goodsImg = $dict['goods']['fields']['image']['note'];
ok('goods.image 说明含「实物图」', strpos($goodsImg, '实物图') !== false);
ok('goods.image 说明含 /api/user/images', strpos($goodsImg, '/api/user/images') !== false);
ok('goods.image 说明含不拿订单图代替', strpos($goodsImg, '订单图') !== false);
ok('goods.image 示例是 cloud 形态', strpos((string) json_encode($dict['goods']['fields']['image']['example']), 'cloud') !== false);

$subIcon = $dict['subscriptions']['fields']['icon']['note'];
ok('subscriptions.icon 说明含 /api/ai/icons', strpos($subIcon, '/api/ai/icons') !== false);
ok('subscriptions.icon 说明含 brand:', strpos($subIcon, 'brand:') !== false);
ok('subscriptions.icon 说明含站内品牌图', strpos($subIcon, '/brand-icons/') !== false);
ok('subscriptions.icon 说明含缺省 credit-card', strpos($subIcon, 'credit-card') !== false);

$subImg = $dict['subscriptions']['fields']['image']['note'];
ok('subscriptions.image 说明「别向用户索要」', strpos($subImg, '不需要用户传图') !== false || strpos($subImg, '别向用户索要') !== false);

$vrImg = $dict['valueRecords']['fields']['image']['note'];
ok('valueRecords.image 说明「一般不需要图」', strpos($vrImg, '不需要图') !== false);

echo "\n== OpenAPI schema 里 icon 的 description 同步到位 ==\n";
$oa = GF_AiSchema::openapiSchemas(array());
$desc = (string) ($oa['Subscriptions']['properties']['icon']['description'] ?? '');
ok('OpenAPI Subscriptions.icon 指向 /api/ai/icons', strpos($desc, '/api/ai/icons') !== false, substr($desc, 0, 100));
$gdesc = (string) ($oa['Goods']['properties']['image']['description'] ?? '');
ok('OpenAPI Goods.image 提到实物图', strpos($gdesc, '实物图') !== false, substr($gdesc, 0, 100));

echo "\n== 新端点在路由表里 ==\n";
$src = (string) file_get_contents(GF_ROOT . '/app/lib/AiApi.php');
foreach (array("case 'icons'", "case 'stats'", "case 'entity'") as $needle) {
    ok("路由含 {$needle}", strpos($src, $needle) !== false);
}
foreach (array('/api/ai/icons', '/api/ai/stats', '/api/ai/entity') as $p) {
    ok("OpenAPI 路径 {$p}", strpos($src, "'" . $p . "'") !== false);
}
// 三个新端点必须在 owner() 之后（即要 Bearer 鉴权）：检查 '$email = self::owner();' 的位置
$ownerPos = strpos($src, '$email = self::owner();');
$casePos  = strpos($src, "case 'icons':");
ok('icons 在 owner() 之后（走 Bearer 鉴权）', $ownerPos !== false && $casePos !== false && $casePos > $ownerPos);
$statPos = strpos($src, "case 'stats':");
ok('stats 在 owner() 之后', $statPos !== false && $statPos > $ownerPos);
$entPos = strpos($src, "case 'entity':");
ok('entity 在 owner() 之后', $entPos !== false && $entPos > $ownerPos);

echo "\n== 所有 PHP 文件不得带 UTF-8 BOM（★BOM 会让 header() 失败 → 线上接口 500）==\n";
$files = array();
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(GF_ROOT, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if (!$f->isFile() || strtolower($f->getExtension()) !== 'php') {
        continue;
    }
    if (preg_match('#[\\\\/](storage|assets)[\\\\/]#', $f->getPathname())) {
        continue;
    }
    $files[] = $f->getPathname();
}
$bomFiles = array();
foreach ($files as $p) {
    $bytes = file_get_contents($p, false, null, 0, 3);
    if ($bytes === "\xEF\xBB\xBF") {
        $bomFiles[] = basename($p);
    }
}
ok('扫描 ' . count($files) . ' 个 PHP 文件均无 BOM', count($bomFiles) === 0, implode(', ', $bomFiles));

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);