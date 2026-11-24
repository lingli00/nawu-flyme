<?php
/**
 * t_icon_slugs.php —— 交叉校验：服务端 GF_BrandIndex 给出的每个 `brand:<slug>`
 * 必须在**前端 simpleBrand.ts 的 GLYPH_GROUPS 里真的存在**，
 * 否则用户看到的订阅图标会是空白（服务端说「命中」，前端画不出来）。
 *
 * 否则再校验：服务端给出的每个 `/brand-icons/<file>` 都必须在 server/brand-icons/ 里真实存在。
 *
 * 跑法： php t_icon_slugs.php
 */
if (!defined('GF_ROOT')) {
    define('GF_ROOT', __DIR__);
}
require_once GF_ROOT . '/app/lib/BrandIndex.php';

$pass = 0;
$fail = 0;
function ok($n, $c, $d = '')
{
    global $pass, $fail;
    if ($c) { $pass++; echo "  [PASS] {$n}\n"; }
    else { $fail++; echo "  [FAIL] {$n}" . ($d !== '' ? "  → {$d}" : '') . "\n"; }
}

/* 前端字库路径（只读，不改） */
$tsPath = dirname(GF_ROOT) . '/app/src/lib/simpleBrand.ts';
ok('simpleBrand.ts 存在（只读引用）', is_file($tsPath), $tsPath);
if (!is_file($tsPath)) {
    echo "PASS={$pass}  FAIL={$fail}\n";
    exit(1);
}
$ts = (string) file_get_contents($tsPath);
preg_match_all('/"slug":\s*"([^"]+)"/', $ts, $m);
$frontSlugs = array_flip($m[1]);
ok('前端 slug 数量 > 150', count($frontSlugs) > 150, (string) count($frontSlugs));

/* 服务端给出的每个 brand: 值都要能在前端找到 */
$all = GF_BrandIndex::listAll('', 0);
$missing = array();
$checked = 0;
foreach ($all as $b) {
    $icon = (string) $b['icon'];
    if (strpos($icon, 'brand:') === 0) {
        $slug = substr($icon, 6);
        $checked++;
        if (!isset($frontSlugs[$slug])) {
            $missing[] = $b['name'] . ' → ' . $slug;
        }
    }
}
ok("服务端 brand: 引用共 {$checked} 条，全部能在前端字库找到", count($missing) === 0,
    implode(' | ', array_slice($missing, 0, 10)));

/* 服务端给出的每个 /brand-icons/<file> 都要真实存在 */
$missingFiles = array();
$checkedFiles = 0;
foreach ($all as $b) {
    $icon = (string) $b['icon'];
    if (strpos($icon, '/brand-icons/') === 0) {
        $checkedFiles++;
        $f = GF_ROOT . $icon;
        if (!is_file($f)) {
            $missingFiles[] = $icon;
        }
    }
}
ok("服务端 /brand-icons/ 引用共 {$checkedFiles} 条，文件全部存在", count($missingFiles) === 0,
    implode(' | ', array_slice($missingFiles, 0, 10)));

/* 反向：前端有字库但我们没收录的品牌（不是错误，只是覆盖率信息） */
$serverSlugs = array();
foreach ($all as $b) {
    if (!empty($b['slug'])) {
        $serverSlugs[$b['slug']] = true;
    }
}
$frontMissing = array();
foreach ($frontSlugs as $s => $_) {
    if (!isset($serverSlugs[$s])) {
        $frontMissing[] = $s;
    }
}
echo "  （信息）前端字库有、服务端品牌表未收录的 slug：" . count($frontMissing) . " 个\n";

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);