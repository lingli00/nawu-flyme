<?php
/**
 * NawuAI 规则引擎本地单元测试（CLI 直跑，不依赖数据库）。
 *   php tools/test-nawu-ai.php
 */
define('GF_ROOT', dirname(__DIR__) . '/server');
require_once GF_ROOT . '/app/lib/NawuAI.php';

function line($s = '')
{
    echo $s . "\n";
}

function showItem($it)
{
    $kind = isset($it['kind']) ? $it['kind'] : '?';
    $bits = array('[' . $kind . ']');
    if (isset($it['type'])) {
        $bits[] = $it['type'];
    }
    if (isset($it['amount'])) {
        $bits[] = $it['amount'] . '元';
    }
    if (isset($it['name'])) {
        $bits[] = '名称:' . $it['name'];
    }
    if (isset($it['categoryName'])) {
        $bits[] = '分类:' . $it['categoryName'];
    }
    if (isset($it['judgement'])) {
        $bits[] = '归需否:' . $it['judgement'];
    }
    if (isset($it['period'])) {
        $bits[] = '周期:' . $it['period'] . 'x' . $it['every'];
    }
    $bits[] = '日期:' . $it['date'];
    return implode(' ', $bits);
}

$cat = NawuAI::defaultCategories();

$cases = array(
    '昨天买了个耳机 899',
    '星巴克 35',
    '腾讯视频月卡 25',
    '打车花了三十块',
    '工资到账 12000',
    '买了个空调 3299',
    '卖了旧手机 1500',
    '中午吃饭 42，晚上点了杯奶茶 18',
    '两千五的相机',
    '停车费 8 块',
    '这个月房租 2500，水电 120',
    '充值了游戏月卡 30',
);

line('==================== 解析 ====================');
foreach ($cases as $c) {
    $d = NawuAI::parseText($c, array('categories' => $cat));
    line('输入: ' . $c);
    if (!$d['items']) {
        line('  ✗ 未解析 ' . implode('；', $d['warnings']));
        continue;
    }
    foreach ($d['items'] as $it) {
        line('  ✓ ' . showItem($it));
    }
}

line('');
line('==================== 中文数字 ====================');
$nums = array('三十五', '一百二十', '两千五', '一万二', '三块五', '十五', '九十九');
foreach ($nums as $n) {
    line('  ' . $n . ' → ' . NawuAI::cnNumber($n));
}

line('');
line('==================== 金额抽取 ====================');
$amts = array('花了35', '一共128.5元', '买了台电脑 8999', '收入 12000', '25 块钱的奶茶', '2026-11-03 花 20');
foreach ($amts as $a) {
    $hit = NawuAI::extractAmount($a);
    line('  ' . $a . ' → ' . ($hit ? $hit['amount'] : 'null'));
}

line('');
line('==================== 日期解析 ====================');
$dates = array('今天花了20', '昨天花了20', '前天花了20', '3月5日花了20', '11月1号花了20', '上周花了20');
foreach ($dates as $d) {
    line('  ' . $d . ' → ' . NawuAI::resolveDate($d, '2026-11-10'));
}

line('');
line('==================== 值不值 ====================');
$goods = array(
    'id' => 'g1', 'name' => '索尼耳机', 'price' => 899, 'buyDate' => '2026-01-10',
    'extraFees' => array(array('name' => '运费', 'amount' => 11)), 'targetDailyCost' => 1.5,
);
$recs = array(
    array('id' => 'v1', 'type' => 'expense', 'amount' => 910, 'date' => '2026-01-10'),
);
$ev = NawuAI::evaluateGoods($goods, $recs, '2026-11-10');
line('  总投入 ' . $ev['totalInvest'] . ' / 天数 ' . $ev['days'] . ' / 日均 ' . $ev['dailyCost']
    . ' / 达成率 ' . $ev['achieveRatio']);
line('  结论: ' . $ev['verdict']);

$goods2 = array('id' => 'g2', 'name' => '旧手机', 'price' => 3000, 'buyDate' => '2025-01-01',
    'extraFees' => array(), 'targetDailyCost' => 2);
$recs2 = array(array('id' => 'v2', 'type' => 'income', 'amount' => 1500, 'date' => '2026-06-01',
    'src' => 'goods-sale', 'refId' => 'g2'));
$ev2 = NawuAI::evaluateGoods($goods2, $recs2, '2026-11-10');
line('  卖出场景: ' . $ev2['verdict']);

line('');
line('==================== 问答 ====================');
$ctx = array(
    'valueRecords' => array(
        array('id' => 'a', 'type' => 'expense', 'amount' => 100, 'date' => '2026-11-02', 'judgement' => '需', 'note' => '吃饭'),
        array('id' => 'b', 'type' => 'expense', 'amount' => 300, 'date' => '2026-11-05', 'judgement' => '归', 'note' => '耳机'),
        array('id' => 'c', 'type' => 'income', 'amount' => 12000, 'date' => '2026-11-01', 'note' => '工资'),
    ),
    'goods' => array($goods, $goods2),
    'subscriptions' => array(
        array('name' => '腾讯视频', 'amount' => 25, 'period' => 'month', 'every' => 1),
        array('name' => 'iCloud', 'amount' => 240, 'period' => 'year', 'every' => 1),
    ),
    'today' => '2026-11-10',
);
$qs = array('这个月花了多少', '耳机值不值', '订阅每月多少钱', '最近买了什么', '归需否占比', '昨天花了多少');
foreach ($qs as $q) {
    $r = NawuAI::ask($q, $ctx);
    line('  Q: ' . $q);
    line('  A: ' . $r['answer']);
}

line('');
line('==================== 草案 → 记录 ====================');
$draft = NawuAI::parseText('买了个耳机 899', array('categories' => $cat));
$records = NawuAI::draftToRecords($draft, array());
line('  valueRecords: ' . count($records['valueRecords']) . ' / goods: ' . count($records['goods'])
    . ' / subscriptions: ' . count($records['subscriptions']));
line('  ' . json_encode($records, JSON_UNESCAPED_UNICODE));
