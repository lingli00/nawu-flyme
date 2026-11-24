<?php
/**
 * ★v1.7.7 · AI 写入链路自测（CLI 跑，不入生产包）
 *
 * 用法：C:\Users\Administrator\ego\php\php.exe t_ai_write_path.php
 *
 * 覆盖：GF_AiSchema::normalizeRow()（AI 写入落点）、AiApi 的 itemsToRecords 路径等价行为。
 * 只做纯函数校验，不连数据库、不需要 config.php / 网络。
 */

define('GF_ROOT', __DIR__);
if (PHP_SAPI !== 'cli') {
    // 只允许 CLI 跑：万一被误传到站点根，也要挡掉直接被浏览器访问
    http_response_code(403);
    exit('forbidden');
}
require_once GF_ROOT . '/app/lib/Support.php';
require_once GF_ROOT . '/app/lib/EntityNormalize.php';

/* 只取 AiSchema 的纯计算部分：它文件头 require EntityNormalize，且依赖 NawuAI::nextRenew。
 * 这里用桩替身，避免引入整个 AI 层（NawuAI 需要 DB/其它依赖）。 */
if (!class_exists('NawuAI')) {
    class NawuAI
    {
        public static function nextRenew($start, $period = 'month', $every = 1)
        {
            return $start;
        }
    }
}
require_once GF_ROOT . '/app/lib/AiSchema.php';

$pass = 0;
$fail = 0;
function check($name, $cond, $detail = '')
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  [OK]   $name\n";
    } else {
        $fail++;
        echo "  [FAIL] $name" . ($detail !== '' ? "  → " . $detail : '') . "\n";
    }
}
function js($v)
{
    return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

$pngB64 = base64_encode(base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='));
$cfg = array('judgementOptions' => array(), 'judgementRules' => array(), 'customFields' => array());

echo "== 1. AI 写入路径：GF_AiSchema::normalizeRow('goods') ==\n";

// 线上 11 条物品的最小 AI 写入形态（mirror /api/ai/mutate 的 upsert record）
$in = array('name' => '索尼 WH-1000XM5', 'price' => 2499, 'buyDate' => '2026-11-10', 'image' => array('source' => 'base64', 'ref' => $pngB64));
$w = array();
$row = GF_AiSchema::normalizeRow('goods', $in, $cfg, $w);
check('缺 tags → []', $row['tags'] === array(), js(isset($row['tags']) ? $row['tags'] : null));
check('缺 extraFees → []', $row['extraFees'] === array(), js(isset($row['extraFees']) ? $row['extraFees'] : null));
check('缺 incomes → []', $row['incomes'] === array(), js(isset($row['incomes']) ? $row['incomes'] : null));
check('缺 status → active', $row['status'] === 'active', js(isset($row['status']) ? $row['status'] : null));
check('缺 currency → CNY', $row['currency'] === 'CNY', js(isset($row['currency']) ? $row['currency'] : null));
check('缺 categoryId → cg0', $row['categoryId'] === 'cg0', js(isset($row['categoryId']) ? $row['categoryId'] : null));
check('裸 base64 image → data:image/png;base64,…（source=local）',
    isset($row['image']['ref']) && strpos($row['image']['ref'], 'data:image/png;base64,') === 0 && $row['image']['source'] === 'local', js($row['image']));
check('补了 id / createdAt / updatedAt', !empty($row['id']) && !empty($row['createdAt']) && !empty($row['updatedAt']));
check('无 warning（图片合法）', $w === array(), js($w));

// 无图片时写入态不硬塞 📦（前端回落分类图标）
$row2 = GF_AiSchema::normalizeRow('goods', array('name' => '键盘', 'price' => 399), $cfg, $w);
check('无 image（write）→ 不写 image 字段', !array_key_exists('image', $row2), js($row2));

// AI 传字符串裸 base64
$row3 = GF_AiSchema::normalizeRow('goods', array('name' => '音箱', 'price' => 99, 'image' => $pngB64), $cfg, $w);
check('image 直接传裸 base64 字符串 → local dataURL',
    isset($row3['image']['ref']) && strpos($row3['image']['ref'], 'data:image/png;base64,') === 0, js(isset($row3['image']) ? $row3['image'] : null));

// 超限图：拒绝 + warning，其它字段保留
$bigB64 = base64_encode("\xFF\xD8\xFF\xE0" . str_repeat('A', 2200000));
$w = array();
$rowBig = GF_AiSchema::normalizeRow('goods', array('name' => '巨图', 'price' => 1, 'note' => '备注保留', 'image' => $bigB64), $cfg, $w);
check('超限图被拒（无 image）但 name/price/note 保留',
    !array_key_exists('image', $rowBig) && $rowBig['name'] === '巨图' && $rowBig['price'] === 1 && $rowBig['note'] === '备注保留', js($rowBig));
check('超限图有显式 warning', count($w) === 1 && strpos($w[0], '图片过大') !== false, js($w));

echo "\n== 2. AI 写入路径：valueRecords / subscriptions ==\n";

$vr = GF_AiSchema::normalizeRow('valueRecords', array('amount' => '25.5', 'date' => '2026-11-20', 'judgement' => '归', 'note' => '午饭'), $cfg);
check('judgement 中文「归」→ gui（AI 层归一保持原行为）', $vr['judgement'] === 'gui', js($vr['judgement']));
check('amount 字符串转数字', $vr['amount'] === 25.5, js($vr['amount']));
check('缺 type → expense / currency → CNY / categoryId → cl0',
    $vr['type'] === 'expense' && $vr['currency'] === 'CNY' && $vr['categoryId'] === 'cl0', js(array($vr['type'], $vr['currency'], $vr['categoryId'])));

$sub = GF_AiSchema::normalizeRow('subscriptions', array('name' => '网易云', 'amount' => 15, 'startDate' => '2026-11-01'), $cfg);
check('subscriptions 缺 remind → {renewLead:3}（前端订阅页直接读）', isset($sub['remind']['renewLead']) && $sub['remind']['renewLead'] === 3, js(isset($sub['remind']) ? $sub['remind'] : null));
check('subscriptions 缺 every → 1 / autoRenew → true', $sub['every'] === 1 && $sub['autoRenew'] === true, js(array($sub['every'], $sub['autoRenew'])));

echo "\n== 3. 已存在值不被改写（幂等）==\n";

$input = array(
    'id' => 'g_keep', 'name' => '耳机', 'price' => 2499, 'status' => 'retired',
    'tags' => array('通勤'), 'extraFees' => array(array('name' => '运费', 'amount' => 12)),
    'incomes' => array(array('amount' => 1000)), 'currency' => 'USD', 'categoryId' => 'cg3',
    'image' => array('source' => 'system', 'ref' => '🎧'), 'myCustom' => array('x' => 1),
    'createdAt' => '2026-01-01T00:00:00Z', 'updatedAt' => '2026-02-01T00:00:00Z',
);
$once = GF_AiSchema::normalizeRow('goods', $input, $cfg);
$twice = GF_AiSchema::normalizeRow('goods', $once, $cfg);
check('二次归一结果 = 一次归一结果（幂等）', $once == $twice, js($twice));
check('id / status / tags / extraFees / incomes 原样', $once['id'] === 'g_keep' && $once['status'] === 'retired'
    && $once['tags'] === array('通勤') && $once['extraFees'] === array(array('name' => '运费', 'amount' => 12))
    && $once['incomes'] === array(array('amount' => 1000)));
check('currency / categoryId 原样（不覆盖用户值）', $once['currency'] === 'USD' && $once['categoryId'] === 'cg3');
check('system emoji 图原样', $once['image'] === array('source' => 'system', 'ref' => '🎧'), js($once['image']));
check('自定义字段保留', isset($once['myCustom']) && $once['myCustom'] === array('x' => 1));
check('createdAt/updatedAt 不被改写', $once['createdAt'] === '2026-01-01T00:00:00Z' && $once['updatedAt'] === '2026-02-01T00:00:00Z');

echo "\n== 4. 备份路径同源（GF_EntityNormalize::collections）==\n";
$cols = array(
    'goods' => array(
        array('id' => 'g1', 'name' => 'a', 'price' => 1),
        array('id' => 'g2', 'name' => 'b', 'price' => 2, 'extraFees' => array()),
    ),
);
$warn = array();
$out = GF_EntityNormalize::collections($cols, array('when' => 'read'), $warn);
$allGood = true;
foreach ($out['goods'] as $g) {
    if (!isset($g['extraFees'], $g['tags'], $g['incomes']) || !is_array($g['extraFees'])) {
        $allGood = false;
    }
}
check('备份里所有 goods 行都补齐三个数组字段（前端详情页安全）', $allGood, js($out['goods']));

echo "\n----------------------------------------\n";
echo "通过 $pass 项，失败 $fail 项\n";
exit($fail === 0 ? 0 : 1);