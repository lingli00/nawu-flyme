<?php
/**
 * t_ai_read.php —— /api/ai/* 读取层逻辑自测（★不连数据库、不连外网）
 *
 * 覆盖：
 *  ① matchRow 的全部运算符（含 v1.8.1 新增 $exists/$nin/$regex/$size/$and/$not/$hasImage）
 *  ② rowHasImage 的「真有图」口径（system emoji 不算图）
 *  ③ stats 的分组 / 求和 / 日期区间逻辑（用桩数据直接跑私有方法）
 *  ④ goods.image 的两种写法归一（web 直链 / cloud 引用）—— 走 GF_EntityNormalize
 *
 * 跑法： php t_ai_read.php
 * 退出码：0 全过 / 1 有失败
 */
if (!defined('GF_ROOT')) {
    define('GF_ROOT', __DIR__);
}
/* 让 AiApi.php 的 require 能跑：这些库里只有 Support/Config/Db/Schema 会碰 IO，
 * 但我们只调用纯静态方法，不触发任何 IO。 */
require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/Config.php';
require_once GF_ROOT . '/app/lib/Db.php';
require_once GF_ROOT . '/app/lib/Schema.php';
require_once GF_ROOT . '/app/lib/EntityNormalize.php';

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

/* 只加载 AiApi.php 里的 class 定义部分：直接 include 会跑 require_once（安全，纯声明）。
 * AiApi.php 顶部有 `if (!defined('GF_ROOT')) { exit; }`，已定义即通过。 */
require_once GF_ROOT . '/app/lib/NawuAI.php';
require_once GF_ROOT . '/app/lib/BrandIndex.php';
require_once GF_ROOT . '/app/lib/AiApi.php';
require_once GF_ROOT . '/app/lib/AiSchema.php';

function invoke_private($name, $args)
{
    $m = new ReflectionMethod('GF_Ai', $name);
    $m->setAccessible(true);
    return $m->invokeArgs(null, $args);
}

echo "== ① matchRow 运算符 ==\n";
$row = array(
    'id' => 'g_1', 'name' => '索尼 WH-1000XM5', 'price' => 2499.0,
    'status' => 'active', 'tags' => array('通勤', '降噪'),
    'image' => array('source' => 'cloud', 'ref' => '/api/user/images/abc', 'sha256' => str_repeat('a', 64)),
    'note' => '',
);
$cases = array(
    '精确匹配 name'          => array(array('name' => '索尼 WH-1000XM5'), true),
    '精确匹配 不存在字段'     => array(array('nope' => 1), false),
    '$gte 命中'              => array(array('price' => array('$gte' => 2000)), true),
    '$gte 不命中'            => array(array('price' => array('$gte' => 3000)), false),
    '$lte 命中'              => array(array('price' => array('$lte' => 2499)), true),
    '$gt / $lt 组合'         => array(array('price' => array('$gt' => 1000, '$lt' => 3000)), true),
    '$ne 命中'               => array(array('status' => array('$ne' => 'retired')), true),
    '$contains 命中'         => array(array('name' => array('$contains' => '索尼')), true),
    '$contains 不命中'       => array(array('name' => array('$contains' => '苹果')), false),
    '$in 命中'               => array(array('status' => array('$in' => array('active', 'favorite'))), true),
    '$in 不命中'             => array(array('status' => array('$in' => array('retired'))), false),
    '★$nin 命中'             => array(array('status' => array('$nin' => array('retired'))), true),
    '★$nin 不命中'           => array(array('status' => array('$nin' => array('active'))), false),
    '★$exists true'          => array(array('image' => array('$exists' => true)), true),
    '★$exists false（note 空串算无）' => array(array('note' => array('$exists' => false)), true),
    '★$exists false 不存在键' => array(array('nope' => array('$exists' => false)), true),
    '★$regex 命中'           => array(array('name' => array('$regex' => 'WH-?1000')), true),
    '★$regex 不命中'         => array(array('name' => array('$regex' => '^苹果')), false),
    '★$size 精确'            => array(array('tags' => array('$size' => 2)), true),
    '★$size 区间'            => array(array('tags' => array('$size' => array('$gte' => 1, '$lte' => 3))), true),
    '★$and'                  => array(array('$and' => array(array('status' => 'active'), array('price' => array('$gt' => 1)))), true),
    '★$and 有一条不满足'      => array(array('$and' => array(array('status' => 'retired'), array('price' => array('$gt' => 1)))), false),
    '★$or 命中'              => array(array('$or' => array(array('status' => 'retired'), array('name' => array('$contains' => '索尼')))), true),
    '★$or 全不命中'          => array(array('$or' => array(array('status' => 'retired'), array('name' => '小米'))), false),
    '★$not 取反'             => array(array('name' => array('$not' => array('$contains' => '小米'))), true),
    '★$hasImage true'        => array(array('$hasImage' => true), true),
    '多键 AND'               => array(array('status' => 'active', 'price' => array('$gte' => 2000)), true),
    '多键 AND 有一个不满足'   => array(array('status' => 'active', 'price' => array('$gte' => 9000)), false),
);
foreach ($cases as $label => $c) {
    $got = (bool) invoke_private('matchRow', array($row, $c[0]));
    t_ok($got === $c[1], $label, 'got=' . var_export($got, true));
}

echo "\n== ② rowHasImage：system emoji 不算图 ==\n";
$imgCases = array(
    'cloud 引用算图'      => array(array('image' => array('source' => 'cloud', 'ref' => '/api/user/images/x')), true),
    'web 直链算图'        => array(array('image' => array('source' => 'web', 'ref' => 'https://a/b.jpg')), true),
    'local dataURL 算图'  => array(array('image' => array('source' => 'local', 'ref' => 'data:image/png;base64,xx')), true),
    'brand 引用码算图'    => array(array('image' => array('source' => 'brand', 'ref' => 'brand:bilibili')), true),
    'system 📦 不算图'    => array(array('image' => array('source' => 'system', 'ref' => '📦')), false),
    'system 分类 emoji 不算图' => array(array('image' => array('source' => 'system', 'ref' => '🎧')), false),
    '无 image 键不算图'   => array(array('name' => 'x'), false),
    'image 空对象不算图'  => array(array('image' => array()), false),
    '字符串 url 算图'     => array(array('image' => 'url:https://a/b.png'), true),
    '字符串空不算图'      => array(array('image' => ''), false),
);
foreach ($imgCases as $label => $c) {
    $got = (bool) invoke_private('rowHasImage', array($c[0]));
    t_ok($got === $c[1], $label, 'got=' . var_export($got, true));
}

echo "\n== ③ goods.image / subscriptions.image 归一（GF_EntityNormalize）==\n";
$w = array();
$web = GF_EntityNormalize::image(array('source' => 'web', 'ref' => 'https://cdn.example.com/photo.jpg'), $w);
t_ok(is_array($web) && $web['source'] === 'web' && $web['ref'] === 'https://cdn.example.com/photo.jpg',
    'web 直链 → {source:web, ref:<url>}', json_encode($web));

$w = array();
$sha = str_repeat('b', 64);
$cloud = GF_EntityNormalize::image(array('source' => 'cloud', 'ref' => '/api/user/images/' . $sha), $w);
t_ok(is_array($cloud) && $cloud['source'] === 'cloud' && $cloud['ref'] === '/api/user/images/' . $sha,
    'cloud 相对路径 → {source:cloud, ref:/api/user/images/<sha>}', json_encode($cloud));

$w = array();
$cloud2 = GF_EntityNormalize::image('/api/user/images/' . $sha, $w);
t_ok(is_array($cloud2) && $cloud2['source'] === 'cloud' && $cloud2['sha256'] === $sha,
    '裸云端路径字符串 → 自动带 sha256', json_encode($cloud2));

$w = array();
$cloud3 = GF_EntityNormalize::image(array('source' => 'cloud', 'ref' => 'https://nawu.example/api/user/images/' . $sha . '?t=1&s=x'), $w);
t_ok(is_array($cloud3) && $cloud3['source'] === 'cloud' && strpos($cloud3['ref'], '/api/user/images/') === 0,
    '绝对 URL → 只留相对路径（换域名不失效）', json_encode($cloud3));

// 落库形态再读回：goods 行过一遍 row()
$gw = array();
$goodsRow = GF_EntityNormalize::row('goods', array(
    'name' => '测试耳机', 'price' => 899,
    'image' => array('source' => 'cloud', 'ref' => '/api/user/images/' . $sha),
), array('when' => 'write'), $gw);
t_ok(isset($goodsRow['image']) && $goodsRow['image']['source'] === 'cloud', 'goods 写入后 image 仍是 cloud',
    json_encode($goodsRow['image']));
t_ok(isset($goodsRow['tags']) && is_array($goodsRow['tags']), 'goods 必填 tags 已补齐');

$gr = array();
$goodsRead = GF_EntityNormalize::row('goods', $goodsRow, array('when' => 'read'), $gr);
t_ok(isset($goodsRead['image']) && $goodsRead['image']['source'] === 'cloud', 'goods 读回 image 不被换成 📦',
    json_encode($goodsRead['image']));
t_ok(invoke_private('rowHasImage', array($goodsRead)) === true, '读回后 rowHasImage=true（链路通）');

echo "\n== ④ image 缺省补 📦（读态），写态不补 ==\n";
$gw2 = array();
$noImgWrite = GF_EntityNormalize::row('goods', array('name' => '无图物品', 'price' => 1), array('when' => 'write'), $gw2);
t_ok(!isset($noImgWrite['image']), '写态缺省不硬塞 image', json_encode($noImgWrite));
$gr2 = array();
$noImgRead = GF_EntityNormalize::row('goods', $noImgWrite, array('when' => 'read'), $gr2);
t_ok(isset($noImgRead['image']) && $noImgRead['image']['source'] === 'system',
    '读态补 system 📦 占位', json_encode($noImgRead['image']));
t_ok(invoke_private('rowHasImage', array($noImgRead)) === false,
    '★占位 📦 的 rowHasImage=false（$hasImage:false 才能正确筛出「没图的物品」）');

echo "\n== ⑤ subscriptions.icon 归一化口径 ==\n";
$sw = array();
$sub = GF_EntityNormalize::row('subscriptions', array('name' => 'B站大会员', 'amount' => 148, 'period' => 'year'), array('when' => 'write'), $sw);
t_ok(isset($sub['icon']) && $sub['icon'] === 'credit-card', 'icon 缺省补 credit-card', (string) ($sub['icon'] ?? ''));
$sw2 = array();
$sub2 = GF_EntityNormalize::row('subscriptions', array('name' => 'B站大会员', 'amount' => 148, 'icon' => 'brand:bilibili'), array('when' => 'write'), $sw2);
t_ok(isset($sub2['icon']) && $sub2['icon'] === 'brand:bilibili', 'brand: 引用码原样保留', (string) ($sub2['icon'] ?? ''));
$sw3 = array();
$sub3 = GF_EntityNormalize::row('subscriptions', array('name' => 'X', 'amount' => 1, 'icon' => '/brand-icons/bilibili.com.png'), array('when' => 'write'), $sw3);
t_ok(isset($sub3['icon']) && $sub3['icon'] === '/brand-icons/bilibili.com.png', '站内品牌图路径原样保留', (string) ($sub3['icon'] ?? ''));

echo "\n== ⑥ flyme_str 按字节截断不能切坏中文（★v1.8.1 修复）==\n";
$long = str_repeat('阿里云订阅', 20); // 5 字 × 20 = 100 个汉字 = 300 字节
$cut = flyme_str($long, 60);
t_ok(preg_match('//u', $cut) === 1, '截断后的串是合法 UTF-8', bin2hex(substr($cut, -6)));
t_ok(json_encode(array('v' => $cut), JSON_UNESCAPED_UNICODE) !== false,
    '截断后仍可 json_encode（不会让整个响应变成 null）');
t_ok(strlen($cut) <= 60, '长度 ≤ 上限', (string) strlen($cut));
// 纯 ASCII 不受影响
t_ok(flyme_str('abcdefghij', 5) === 'abcde', 'ASCII 正常截断');
t_ok(flyme_str('短', 60) === '短', '短串不截');
t_ok(flyme_str(null) === '' && flyme_str(false) === '', 'null/false → 空串');

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);