<?php
/**
 * t_icon_writes.php —— 校验 `/api/ai/icons` 会吐出的**每一种 write 值**都真的可用：
 *   ① brand:<slug>      → 前端 simpleBrand.ts 里存在该 slug（t_icon_slugs 已覆盖，这里再验一遍）
 *   ② /brand-icons/x.png → server/brand-icons/ 里真实存在该文件
 *   ③ /api/icon/img?d=   → 域名合法（可被 /api/icon/img 接住）
 *   ④ 裸 lucide id       → 来自合法字符集
 *
 * 跑法： php t_icon_writes.php
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

/* 前端 slug 集合 */
$ts = (string) file_get_contents(dirname(GF_ROOT) . '/app/src/lib/simpleBrand.ts');
preg_match_all('/"slug":\s*"([^"]+)"/', $ts, $m);
$frontSlugs = array_flip($m[1]);

/* 用一批真实订阅名逐条查，收集所有 write 值 */
$names = array(
    'Netflix', 'B站大会员', '阿里云', '腾讯云', '华为云', 'AWS', 'Azure', '谷歌云',
    '腾讯视频', '爱奇艺', '优酷', 'QQ音乐', '网易云音乐', 'Spotify', 'Apple Music',
    '淘宝', '天猫', '京东', '拼多多', '美团', '招商银行', '支付宝', 'Steam', '小米',
    'Notion', 'Figma', 'Adobe', 'ChatGPT Plus', 'DeepSeek', 'iCloud', 'OneDrive',
    '12306', '中国联通', '中国移动', '顺丰速运', '高德地图', '喜马拉雅', '芒果TV',
    '知乎', '微博', 'QQ', '哔哩哔哩', 'Disney+', 'YouTube', 'Kindle',
);
$kinds = array('brand' => 0, 'local' => 0, 'proxy' => 0, 'lucide' => 0);
$bad = array();
foreach ($names as $q) {
    $r = GF_BrandIndex::find($q);
    if ($r['matched'] === null) {
        continue;
    }
    $w = (string) $r['matched']['write'];
    if (strpos($w, 'brand:') === 0) {
        $kinds['brand']++;
        $slug = substr($w, 6);
        if (!isset($frontSlugs[$slug])) {
            $bad[] = "{$q}: brand:{$slug} 不在前端字库";
        }
    } elseif (strpos($w, '/brand-icons/') === 0) {
        $kinds['local']++;
        if (!is_file(GF_ROOT . $w)) {
            $bad[] = "{$q}: {$w} 文件不存在";
        }
    } elseif (strpos($w, '/api/icon/img?d=') === 0) {
        $kinds['proxy']++;
        $d = rawurldecode(substr($w, strlen('/api/icon/img?d=')));
        if (!preg_match('/^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+$/', $d)) {
            $bad[] = "{$q}: 域名不合法 {$d}";
        }
    } elseif (preg_match('/^[a-z][a-z0-9\-]{0,59}$/i', $w)) {
        $kinds['lucide']++;
    } else {
        $bad[] = "{$q}: 无法识别的 write 值 {$w}";
    }
}
echo '  （分布）brand=' . $kinds['brand'] . ' local=' . $kinds['local']
    . ' proxy=' . $kinds['proxy'] . ' lucide=' . $kinds['lucide'] . "\n";
ok('所有 write 值都合法且可用', count($bad) === 0, implode(' | ', array_slice($bad, 0, 8)));
ok('brand: 形态是主流（≥20 条）', $kinds['brand'] >= 20, (string) $kinds['brand']);

/* 站内品牌图文件总量 */
$dir = GF_ROOT . '/brand-icons';
$files = is_dir($dir) ? glob($dir . '/*') : array();
ok('server/brand-icons 有 ≥170 个文件', count($files) >= 170, (string) count($files));

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);