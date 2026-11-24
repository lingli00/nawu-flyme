<?php
/**
 * 纳物 AI 接口 · 纯逻辑回归（不需要数据库 / 不需要起服务）
 *
 *   php tools/test-ai-api.php
 *
 * 覆盖：12 集合字段字典、归需归一化、自定义字段、模板渲染、
 *       事件 payload 的 upsert / patch / delete / replace、items 全字段透传。
 */
/* 位置无关：本地放在 工程/tools/，仓库里放在 server/tests/，两边都能直接跑 */
$probe = dirname(__DIR__);
if (!is_file($probe . '/app/lib/AiApi.php')) {
    $probe = $probe . '/server';
}
define('GF_ROOT', $probe);
require_once GF_ROOT . '/app/lib/NawuAI.php';
require_once GF_ROOT . '/app/lib/AiSchema.php';

/* ---- 最小 stub：AiApi.php 里只有「运行时」才会用到这些 ---- */
class GF_Db
{
    public static function q($sql, $args = array()) { return true; }
    public static function one($sql, $args = array()) { return null; }
    public static function rows($sql, $args = array()) { return array(); }
    public static function insertId() { return 1; }
}
class GF_Auth
{
    public static function get($k, $d = '') { return $d; }
    public static function set($k, $v) { return true; }
    public static function currentUser() { return null; }
}
function flyme_json($data, $code = 200) { echo json_encode($data, JSON_UNESCAPED_UNICODE); exit; }
function flyme_ok($extra = null) { flyme_json(array_merge(array('ok' => true), (array) $extra)); }
function flyme_fail($msg, $code = 400) { flyme_json(array('ok' => false, 'error' => $msg), $code); }
function flyme_body() { return array(); }
function flyme_param($k, $d = null) { return $d; }
function flyme_str($v, $l = 0) { $s = trim(is_scalar($v) ? (string) $v : ''); return $l ? substr($s, 0, $l) : $s; }
function flyme_bearer() { return ''; }
require_once GF_ROOT . '/app/lib/AiApi.php';

$pass = 0;
$fail = 0;
function ok($name, $cond)
{
    global $pass, $fail;
    if ($cond) { $pass++; echo "  [ok] $name\n"; }
    else { $fail++; echo "  [FAIL] $name\n"; }
}

echo "== 1. 字段字典 ==\n";
$cols = GF_AiSchema::collections();
ok('12 个集合', count($cols) === 12);
ok('字段总数 > 100', array_sum(array_map(function ($c) { return $c['fieldCount']; }, $cols)) > 100);
ok('物品含备注/手续费/图片/截止/自定义能力',
    isset($cols['goods']['fields']['note'], $cols['goods']['fields']['extraFees'],
          $cols['goods']['fields']['image'], $cols['goods']['fields']['warrantyDate'])
    && $cols['goods']['additionalFields'] === true);
ok('订阅含每月金额/周期/图片/截止日',
    isset($cols['subscriptions']['fields']['amount'], $cols['subscriptions']['fields']['period'],
          $cols['subscriptions']['fields']['image'], $cols['subscriptions']['fields']['endDate']));
$custom = GF_AiSchema::collections(array(array('collection' => 'goods', 'name' => 'purchaseChannel', 'type' => 'string', 'label' => '购买渠道')));
ok('自定义字段并入字典', isset($custom['goods']['fields']['purchaseChannel']));

echo "== 2. 归需（是否归需） ==\n";
ok('中文「归」→ gui', GF_AiSchema::judgement('归') === 'gui');
ok('中文「需」→ xu', GF_AiSchema::judgement('需') === 'xu');
ok('中文「否」→ fou', GF_AiSchema::judgement('否') === 'fou');
ok('英文原样', GF_AiSchema::judgement('fou') === 'fou');
$options = array(array('value' => 'tun', 'label' => '囤货', 'aliases' => array('囤')));
ok('自定义选项 value', GF_AiSchema::judgement('tun', $options) === 'tun');
ok('自定义选项别名', GF_AiSchema::judgement('囤', $options) === 'tun');
ok('未知值原样保留', GF_AiSchema::judgement('随手买', $options) === '随手买');
ok('关键词规则命中', GF_AiSchema::judgementByRules('又囤了一箱', array(array('value' => 'fou', 'keywords' => array('囤')))) === 'fou');

echo "== 3. 模板（自定义功能） ==\n";
$t = GF_AiSchema::renderTemplate(array('amount' => '{{n}}', 'note' => '买 {{thing}}', 'tags' => array('{{thing}}')), array('n' => 35, 'thing' => '咖啡'));
ok('数字占位保持类型', $t['amount'] === 35);
ok('字符串占位替换', $t['note'] === '买 咖啡');
ok('数组内递归替换', $t['tags'][0] === '咖啡');

echo "== 4. 事件 payload 合并（全 12 集合） ==\n";
$payload = array('collections' => array(
    'valueRecords' => array(array('id' => 'vr1', 'amount' => 10, 'note' => '旧')),
    'goods' => array(array('id' => 'g1', 'name' => '耳机', 'price' => 899)),
    'wishlist' => array(array('id' => 'w1', 'name' => '想买')),
    'walls' => array(array('id' => 'wl1', 'text' => '一句话')),
));
$ev = array('payload' => json_encode(array(
    'goods' => array(array('id' => 'g2', 'name' => '键盘', 'price' => 299, 'image' => array('source' => 'url', 'ref' => 'x'), 'extraFees' => array(array('name' => '手续费', 'amount' => 3)))),
    'valueRecords' => array(array('id' => 'vr1', 'amount' => 10, 'note' => '覆盖')),
    'patches' => array('goods' => array(array('id' => 'g1', 'patch' => array('note' => '加了备注', 'feeRatePermille' => 21)))),
    'deletes' => array('wishlist' => array('w1')),
    'replace' => array('walls' => array(array('id' => 'wl2', 'text' => '整组替换'))),
), JSON_UNESCAPED_UNICODE));
$merged = GF_Ai::mergeIntoPayload($payload, array($ev));
$c = $merged['collections'];
ok('新增物品且全字段保留', count($c['goods']) === 2 && $c['goods'][1]['extraFees'][0]['name'] === '手续费' && $c['goods'][1]['image']['ref'] === 'x');
ok('同 id 覆盖不重复', count($c['valueRecords']) === 1 && $c['valueRecords'][0]['note'] === '覆盖');
ok('patch 局部更新', $c['goods'][0]['note'] === '加了备注' && $c['goods'][0]['feeRatePermille'] === 21 && $c['goods'][0]['name'] === '耳机');
ok('delete 生效', count($c['wishlist']) === 0);
ok('replace 整组替换', count($c['walls']) === 1 && $c['walls'][0]['text'] === '整组替换');
ok('count 重算全部集合', $merged['count'] === (count($c['goods']) + count($c['valueRecords']) + count($c['walls'])));

echo "== 5. items 全字段透传 ==\n";
$ref = new ReflectionMethod('GF_Ai', 'itemsToRecords');
$cfg = array('judgementOptions' => array(), 'judgementRules' => array());
$r = $ref->invoke(null, array(
    array('collection' => 'goods', 'name' => '显示器', 'price' => 1299, 'note' => '下单备注', 'buyDate' => '2026-11-10',
          'image' => array('source' => 'url', 'ref' => 'https://x/y.jpg'),
          'extraFees' => array(array('name' => '运费', 'amount' => 20), array('name' => '手续费', 'amount' => 5)),
          'feeRatePermille' => 21, 'warrantyDate' => '2029-11-10', 'purchaseChannel' => '京东'),
    array('collection' => 'subscriptions', 'name' => '网盘', 'amount' => 25, 'period' => 'month', 'every' => 1,
          'startDate' => '2026-11-10', 'endDate' => '2027-11-10', 'image' => array('source' => 'url', 'ref' => 'logo.png'), 'note' => '自动续费'),
    array('collection' => 'valueRecords', 'type' => 'expense', 'amount' => 35, 'date' => '2026-11-10', 'judgement' => '归', 'note' => '午饭', 'categoryId' => 'cl0'),
), $cfg, '');
ok('物品 9 个字段全部保留', $r['goods'][0]['name'] === '显示器' && $r['goods'][0]['extraFees'][1]['name'] === '手续费'
    && $r['goods'][0]['image']['ref'] === 'https://x/y.jpg' && $r['goods'][0]['purchaseChannel'] === '京东'
    && $r['goods'][0]['warrantyDate'] === '2029-11-10' && $r['goods'][0]['feeRatePermille'] === 21);
ok('订阅每月金额/周期/图片/截止日保留', $r['subscriptions'][0]['amount'] === 25 && $r['subscriptions'][0]['period'] === 'month'
    && $r['subscriptions'][0]['endDate'] === '2027-11-10' && $r['subscriptions'][0]['image']['ref'] === 'logo.png'
    && !empty($r['subscriptions'][0]['nextRenewDate']));
ok('归需归一为客户端枚举', $r['valueRecords'][0]['judgement'] === 'gui');
ok('每条都有 id', !empty($r['goods'][0]['id']) && !empty($r['subscriptions'][0]['id']) && !empty($r['valueRecords'][0]['id']));

$legacy = $ref->invoke(null, array(array('kind' => 'goods', 'name' => '耳机', 'amount' => 899, 'note' => '双十一', 'image' => array('source' => 'system', 'ref' => '🎧'), 'extraFees' => array(array('name' => '手续费', 'amount' => 9)))), $cfg, '');
ok('兼容旧 kind=goods：物品 + 一笔支出', count($legacy['goods']) === 1 && count($legacy['valueRecords']) === 1);
ok('旧 kind 也透传备注/图片/手续费', $legacy['goods'][0]['note'] === '双十一' && $legacy['goods'][0]['image']['ref'] === '🎧' && $legacy['goods'][0]['extraFees'][0]['amount'] === 9);

echo "== 6. 摘要 / OpenAPI ==\n";
$sum = GF_AiSchema::summarize($r);
ok('摘要覆盖 3 条记录', $sum['total'] === 3);
ok('摘要带集合与标题', $sum['items'][0]['collectionLabel'] === '物品' && $sum['items'][0]['title'] === '显示器');
$schemas = GF_AiSchema::openapiSchemas();
ok('OpenAPI 生成 12 个 schema', count($schemas) === 12);
ok('schema 允许附加字段', !empty($schemas['Goods']['additionalProperties']));

echo "\n结果：$pass 通过 / $fail 失败\n";
exit($fail ? 1 : 0);
