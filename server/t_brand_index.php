<?php
/**
 * t_brand_index.php —— GF_BrandIndex 自测（纯 CLI，不连库、不连外网）
 *
 * 跑法： php t_brand_index.php
 * 退出码：0 全部通过 / 1 有失败
 */
if (!defined('GF_ROOT')) {
    define('GF_ROOT', __DIR__);
}
require_once GF_ROOT . '/app/lib/BrandIndex.php';

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

function t_show($q, $r)
{
    $m = $r['matched'];
    $cand = array();
    foreach (array_slice($r['candidates'], 0, 3) as $c) {
        $cand[] = $c['name'] . '(' . $c['score'] . '/' . $c['match'] . ')';
    }
    printf("  %-22s norm=%-16s matched=%-12s cand=[%s]\n",
        $q,
        $r['normalized'],
        $m === null ? '-' : $m['name'] . '|' . $m['write'],
        implode(', ', $cand)
    );
}

echo "== stats ==\n";
$st = GF_BrandIndex::stats();
print_r($st);
t_ok($st['brands'] >= 150, '品牌表 ≥150 条', (string) $st['brands']);
t_ok($st['withGlyph'] >= 60, '有字形 slug 的品牌 ≥60', (string) $st['withGlyph']);
t_ok($st['withBundledIcon'] >= 60, '有随包图标的品牌 ≥60', (string) $st['withBundledIcon']);

echo "\n== 用户点名的三个（需求原文） ==\n";
$cases = array(
    // 查询 => 期望命中的品牌名（null = 期望「不命中」）
    'Netflix'            => 'Netflix',
    'netflix'            => 'Netflix',
    'Netflix 家庭版'      => 'Netflix',
    '奈飞会上'            => null,       // 中文俗名没录，允许不命中
    'B站'                => '哔哩哔哩',
    'b站大会员'           => '哔哩哔哩',
    '哔哩哔哩'            => '哔哩哔哩',
    'bilibili'           => '哔哩哔哩',
    'bilibili.com'       => '哔哩哔哩',
    '阿里云'              => '阿里云',
    'aliyun'             => '阿里云',
    'aliyun.com'         => '阿里云',
    '阿里云 · 包年'        => '阿里云',
    '腾讯云'              => '腾讯云',
    '腾讯视频VIP'         => '腾讯视频',
    '爱奇艺'              => '爱奇艺',
    'iqiyi'              => '爱奇艺',
    '网易云音乐 黑胶'      => '网易云音乐',
    'QQ音乐'              => 'QQ音乐',
    'q。q音乐' => null,  // 乱输入，只要不崩
    'Apple Music'        => 'Apple Music',
    '淘宝 88VIP'          => '淘宝',
    '京东PLUS'            => '京东',
    '美团'                => '美团',
    '招商银行'            => '招商银行',
    'cmbchina.com'       => '招商银行',
    'Steam'              => 'Steam',
    '小米'                => '小米',
    'Notion'             => 'Notion',
    'Figma'              => 'Figma',
    'ChatGPT Plus'       => 'ChatGPT',
    'DeepSeek'           => 'DeepSeek',
    'iCloud 50G'         => 'iCloud',
    '优酷会员'            => '优酷',
    '芒果TV'             => '芒果TV',
    '喜马拉雅'            => '喜马拉雅',
    '12306'              => '12306',
    '中国联通'            => '中国联通',
    '中国移动'            => '中国移动',
    '顺丰速运'            => '顺丰',
    '滴滴打车'            => '滴滴出行',
    '高德地图'            => '高德地图',
    'Spotify'            => 'Spotify',
    'YouTube Premium'    => 'YouTube',
    'Disney+'            => 'Disney+',
    'kindle unlimited'   => 'Kindle',
    '随便乱写的东西'       => null,
    'x'                  => null,
    '   '                => null,
);

foreach ($cases as $q => $want) {
    $r = GF_BrandIndex::find($q, 'https://nawu.example');
    t_show($q, $r);
    $got = $r['matched'] === null ? null : $r['matched']['name'];
    if ($want === null) {
        t_ok(true, '[不崩] ' . $q);       // 结构完整性由下面统一校验
    } else {
        t_ok($got === $want, "[命中] {$q} → {$want}", '实际 ' . var_export($got, true));
    }
    // 结构校验：无论命中与否，返回体形状必须稳定
    t_ok(is_array($r['candidates']) && array_key_exists('matched', $r)
        && is_array($r['suggestion']) && isset($r['suggestion']['action'])
        && array_key_exists('normalized', $r) && array_key_exists('query', $r),
        '  返回结构完整：' . $q);
    if ($got !== null) {
        $w = $r['matched']['write'];
        t_ok(is_string($w) && $w !== '', '  write 非空：' . $q, $w);
        t_ok(isset($r['matched']['icon']['absolute']) && strpos($r['matched']['icon']['absolute'], '/api/icon/img?d=') !== false,
            '  绝对回源 URL 正确：' . $q);
    }
}

echo "\n== 命中项必须能落进 subscriptions.icon（三种写法都合法） ==\n";
$legal = function ($v) {
    if (!is_string($v) || $v === '') { return false; }
    if (strpos($v, 'brand:') === 0) { return true; }
    if (strpos($v, 'url:') === 0) { return true; }
    if (preg_match('#^/[a-z0-9\-/\.\?=&%]+$#i', $v)) { return true; }
    if (preg_match('#^[a-z][a-z0-9\-]{0,59}$#i', $v)) { return true; } // lucide id
    return false;
};
foreach (array('阿里云', 'B站大会员', 'Netflix', '网易云音乐', 'QQ音乐', '招商银行', '淘宝') as $q) {
    $r = GF_BrandIndex::find($q);
    t_ok($r['matched'] !== null && $legal($r['matched']['write']), '写值合法：' . $q, $r['matched'] ? $r['matched']['write'] : 'null');
}

echo "\n== 兜底建议（没品牌时 Agent 有下一步） ==\n";
$r = GF_BrandIndex::find('某个我没听过的小众服务');
t_ok($r['matched'] === null, '未收录品牌 matched=null');
t_ok(isset($r['suggestion']['steps']) && count($r['suggestion']['steps']) >= 3, '给出 ≥3 条兜底步骤');
t_ok(in_array('credit-card', array($r['suggestion']['icon']), true), '兜底图标为 credit-card');
t_ok(!empty($r['suggestion']['emojis']), '兜底 emoji 非空：' . implode(' ', (array) $r['suggestion']['emojis']));
print_r($r['suggestion']);

echo "\n== 列表 / 过滤 ==\n";
$all = GF_BrandIndex::listAll('', 0);
t_ok(count($all) === GF_BrandIndex::stats()['brands'], 'listAll 全量条数一致', (string) count($all));
$yun = GF_BrandIndex::listAll('云', 0);
t_ok(count($yun) > 3, '关键词「云」有结果', (string) count($yun));

echo "\n== 归一化尾巴剥离 ==\n";
$norm = array(
    'B站大会员'   => 'b站',
    '阿里云 · 包年' => '阿里云',
    'Netflix 家庭版' => 'netflix',
    'QQ会员SVIP'  => 'qq',
    ' 哔哩哔哩 年卡 ' => '哔哩哔哩',
    '哔哩哔哩会员'  => '哔哩哔哩',
    '优酷会员'     => '优酷',
);
foreach ($norm as $in => $want) {
    $got = GF_BrandIndex::normalizeQuery($in);
    t_ok($got === $want, "normalize('{$in}') = '{$want}'", "'{$got}'");
}

echo "\n== 编辑距离纠错（1 处错拼自动采用 / 2 处只作候选） ==\n";
$r = GF_BrandIndex::find('netflx');
t_show('netflx', $r);
t_ok($r['matched'] !== null && $r['matched']['name'] === 'Netflix', 'netflx（1 处错拼）纠成 Netflix',
    $r['matched'] ? $r['matched']['name'] . '/' . $r['matched']['match'] : 'null');
$r = GF_BrandIndex::find('netfilx');
t_show('netfilx', $r);
t_ok($r['matched'] === null && $r['candidates'] && $r['candidates'][0]['name'] === 'Netflix',
    'netfilx（2 处错拼）只给候选不自动采用',
    $r['matched'] ? 'matched=' . $r['matched']['name'] : 'cand=' . ($r['candidates'] ? $r['candidates'][0]['name'] : '-'));

echo "\n----------------------------------------\n";
echo "PASS={$pass}  FAIL={$fail}\n";
exit($fail > 0 ? 1 : 0);