<?php
/**
 * t_icon_write_e2e.php —— 端到端：Agent 从 /api/ai/icons 拿到的 write 值
 * 原样写进 subscriptions.icon，能否通过 GF_AiSchema::normalizeRow 且不被改写。
 *
 * 这是「订阅配图标」整条链路的最后一段验证（检索 → 取值 → 落库）。
 *
 * 跑法： php t_icon_write_e2e.php
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

$pass = 0;
$fail = 0;
function ok($n, $c, $d = '')
{
    global $pass, $fail;
    if ($c) { $pass++; echo "  [PASS] {$n}\n"; }
    else { $fail++; echo "  [FAIL] {$n}" . ($d !== '' ? "  → {$d}" : '') . "\n"; }
}

/* 真实订阅名 → 走一遍完整链路 */
$names = array('Netflix', 'B站大会员', '阿里云', '腾讯视频VIP', '网易云音乐', '招商银行', 'Steam', '小米', 'Notion', '爱奇艺', '优酷', 'QQ音乐');
$cfg = array('judgementOptions' => array());
foreach ($names as $name) {
    $r = GF_BrandIndex::find($name);
    $write = $r['matched'] !== null ? $r['matched']['write'] : 'credit-card';
    $w = array();
    $row = GF_AiSchema::normalizeRow('subscriptions', array(
        'name'   => $name,
        'amount' => 25,
        'icon'   => $write,
    ), $cfg, $w);
    ok("{$name} 写入 icon='{$write}' 后原样保留", ($row['icon'] ?? '') === $write, json_encode($row['icon'] ?? null));
    ok("{$name} 写入无 warning", count($w) === 0, implode(' | ', $w));
}

/* 缺省仍补 credit-card */
$w = array();
$row = GF_AiSchema::normalizeRow('subscriptions', array('name' => '无图标订阅', 'amount' => 1), $cfg, $w);
ok('不传 icon → 补 credit-card', ($row['icon'] ?? '') === 'credit-card', json_encode($row['icon'] ?? null));

/* 非法 icon（含空格 / 过长 / 控制字符）也不该让整行失败 */
$w = array();
$row = GF_AiSchema::normalizeRow('subscriptions', array('name' => '怪图标', 'amount' => 1, 'icon' => "a b\tc"), $cfg, $w);
ok('怪 icon 不让整行归一失败', is_array($row) && $row['name'] === '怪图标');

/* 物品侧：image 三形态都要能过 */
$sha = str_repeat('d', 64);
$imgCases = array(
    'cloud 对象'   => array('source' => 'cloud', 'ref' => "/api/user/images/$sha"),
    'web 直链'      => array('source' => 'web', 'ref' => 'https://cdn.example.com/p.jpg'),
    '裸云端路径'    => "/api/user/images/$sha",
);
foreach ($imgCases as $label => $img) {
    $w = array();
    $row = GF_AiSchema::normalizeRow('goods', array('name' => '测试物品', 'price' => 100, 'image' => $img), $cfg, $w);
    $ok = is_array($row) && isset($row['image']['ref']) && $row['image']['ref'] !== '';
    ok("goods.image {$label} 归一成功", $ok, json_encode($row['image'] ?? null));
    $expectSrc = strpos((string) ($row['image']['ref'] ?? ''), '/api/user/images/') === 0 ? 'cloud' : 'web';
    ok("goods.image {$label} source={$expectSrc}", ($row['image']['source'] ?? '') === $expectSrc,
        (string) ($row['image']['source'] ?? ''));
}

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);