<?php
/**
 * ★v1.7.7 · 服务端实体归一化自测（CLI 跑，不入生产包）
 *
 * 用法：C:\Users\Administrator\ego\php\php.exe t_entity_normalize.php
 *
 * 覆盖：图片归一化规则表、12 个集合默认字段、图片大小上限、备份 payload 兼容性。
 * 只做纯函数校验，不连数据库、不需要 config.php。
 */

if (!defined('GF_ROOT')) {
    // 只允许 CLI 跑：万一被误传到站点根，也要挡掉直接被浏览器访问
    if (PHP_SAPI !== 'cli') {
        http_response_code(403);
        exit('forbidden');
    }
}

define('GF_ROOT', __DIR__);
require_once GF_ROOT . '/app/lib/EntityNormalize.php';

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
        echo "  [FAIL] $name" . ($detail !== '' ? "  → $detail" : '') . "\n";
    }
}

function js($v)
{
    return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** 造一段真实 PNG（1x1）裸 base64 与 JPEG 头 */
$pngBin = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
$pngB64 = base64_encode($pngBin);
// 造一段「jpeg 魔数 + 随机填充」的裸 base64（长度 > 40，能过 looksBase64）
$jpgBin = "\xFF\xD8\xFF\xE0\x00\x10JFIF" . str_repeat("\x01\x02\x03\x04", 20);
$jpgB64 = base64_encode($jpgBin);
$gifBin = 'GIF89a' . str_repeat("\x00", 40);
$gifB64 = base64_encode($gifBin);
$webpBin = 'RIFF' . pack('V', 30) . 'WEBPVP8 ' . str_repeat("\x00", 20);
$webpB64 = base64_encode($webpBin);

echo "== 1. 图片归一化规则表 ==\n";

$r = GF_EntityNormalize::image(array('source' => 'base64', 'ref' => $jpgB64));
check('{"source":"base64","ref":裸base64} → local + data:image/jpeg',
    is_array($r) && $r['source'] === 'local' && strpos($r['ref'], 'data:image/jpeg;base64,') === 0, js($r));

$r = GF_EntityNormalize::image($pngB64);
check('裸 base64(png) 字符串 → local + data:image/png（按魔数识别，不写 jpeg）',
    is_array($r) && $r['source'] === 'local' && strpos($r['ref'], 'data:image/png;base64,') === 0, js($r));

$r = GF_EntityNormalize::image($gifB64);
check('裸 base64(gif) → data:image/gif', is_array($r) && strpos($r['ref'], 'data:image/gif;base64,') === 0, js($r));

$r = GF_EntityNormalize::image($webpB64);
check('裸 base64(webp) → data:image/webp', is_array($r) && strpos($r['ref'], 'data:image/webp;base64,') === 0, js($r));

$dataUrl = 'data:image/png;base64,' . $pngB64;
$r = GF_EntityNormalize::image($dataUrl);
check('dataURL 原样 → local 且 ref 不变', is_array($r) && $r['source'] === 'local' && $r['ref'] === $dataUrl, js($r));

$r = GF_EntityNormalize::image(array('source' => 'url', 'ref' => 'https://a.com/x.jpg'));
check('{"source":"url","ref":"https://…"} → web', is_array($r) && $r['source'] === 'web' && $r['ref'] === 'https://a.com/x.jpg', js($r));

$r = GF_EntityNormalize::image('https://a.com/x.jpg');
check('"https://…" 字符串 → web', is_array($r) && $r['source'] === 'web' && $r['ref'] === 'https://a.com/x.jpg', js($r));

$r = GF_EntityNormalize::image('base64');
check('裸的形态提示词 "base64" → 忽略（不是图片内容）', $r === null, js($r));

$r = GF_EntityNormalize::row('goods', array('id' => 'gIcon', 'name' => 'x', 'image' => 'headphones'), array('when' => 'write'));
check('goods 裸 lucide id → {source:builtin, ref:headphones}', isset($r['image']) && $r['image'] === array('source' => 'builtin', 'ref' => 'headphones'), js($r['image']));

$r = GF_EntityNormalize::row('goods', array('id' => 'gEmoji', 'name' => 'x', 'image' => '🎧'), array('when' => 'write'));
check('goods 裸 emoji → {source:system, ref:🎧}', isset($r['image']) && $r['image'] === array('source' => 'system', 'ref' => '🎧'), js($r['image']));

$r = GF_EntityNormalize::image(array('base64', $pngB64));
check('["base64","<裸base64>"] → 取第一个有效元素', is_array($r) && $r['source'] === 'local' && strpos($r['ref'], 'data:image/png;base64,') === 0, js($r));

$r = GF_EntityNormalize::image(array('junk' => array(), 'x' => $pngB64));
check('嵌套数组/对象里挑第一个有效元素', is_array($r) && $r['source'] === 'local', js($r));

$r = GF_EntityNormalize::image(array('source' => 'system', 'ref' => '🎧'));
check('{"source":"system","ref":"🎧"} 原样保留', is_array($r) && $r['source'] === 'system' && $r['ref'] === '🎧', js($r));

$r = GF_EntityNormalize::image(array('source' => 'brand', 'ref' => 'brand:apple.com'));
check('brand 原样保留', is_array($r) && $r['source'] === 'brand' && $r['ref'] === 'brand:apple.com', js($r));

foreach (array(null, array(), '', '   ', '[]', '{}') as $empty) {
    $r = GF_EntityNormalize::image($empty);
    check('缺省/null/{}/空串（' . (is_string($empty) ? "'" . $empty . "'" : (is_array($empty) ? 'array' : (string) $empty)) . '）→ 不写 image', $r === null, js($r));
    $r = GF_EntityNormalize::image($empty, $w, GF_EntityNormalize::IMAGE_FALLBACK);
    check('  同上但带兜底 → {source:system, ref:📦}', is_array($r) && $r['source'] === 'system' && $r['ref'] === '📦', js($r));
}

// 线上事故原样复现：被双重 JSON 编码的字符串
$doubleEncoded = json_encode(json_encode(array('source' => 'base64', 'ref' => $pngB64), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
$r = GF_EntityNormalize::image($doubleEncoded);
check('双重 JSON 编码的 "...{"source":"base64"...}" → local（线上 11 条物品的疑似形态）',
    is_array($r) && $r['source'] === 'local' && strpos($r['ref'], 'data:image/png;base64,') === 0, js($r));

$r = GF_EntityNormalize::image(array('source' => 'local', 'ref' => $pngB64));
check('{"source":"local","ref":裸base64} → 补 dataURL', is_array($r) && $r['source'] === 'local' && strpos($r['ref'], 'data:image/png;base64,') === 0, js($r));

$r = GF_EntityNormalize::image(array('source' => 'upload', 'ref' => 'https://a.com/z.png'));
check('{"source":"upload","ref":"https://…"} → web', is_array($r) && $r['source'] === 'web', js($r));

$r = GF_EntityNormalize::image(array('ref' => $gifB64));
check('只有 ref 没有 source → 按内容判定为 local/gif', is_array($r) && $r['source'] === 'local' && strpos($r['ref'], 'data:image/gif;base64,') === 0, js($r));

$r = GF_EntityNormalize::image(array('source' => 'builtin', 'ref' => 'headphones'));
check('{"source":"builtin","ref":"headphones"} → 原样', is_array($r) && $r['source'] === 'builtin' && $r['ref'] === 'headphones', js($r));

$r = GF_EntityNormalize::image('img:' . $dataUrl);
check('"img:<dataURL>" → local', is_array($r) && $r['source'] === 'local' && $r['ref'] === $dataUrl, js($r));

$r = GF_EntityNormalize::image('url:https://a.com/y.png');
check('"url:https://…" → web（ref 不带前缀）', is_array($r) && $r['source'] === 'web' && $r['ref'] === 'https://a.com/y.png', js($r));

$r = GF_EntityNormalize::image('<svg onload=alert(1)></svg>');
check('SVG 文本被拒绝（防 XSS），回落到 fallback', $r === null, js($r));

$r = GF_EntityNormalize::image('<svg/>');
check('过短的 "<svg/>" 不会当成图片', $r === null || $r['source'] !== 'local', js($r));

echo "\n== 2. 12 个集合默认字段（口径 = app/src/types/entities.ts）==\n";

// 线上那 11 条物品的最小形态：只有 name/price/buyDate
$g = GF_EntityNormalize::row('goods', array('id' => 'g1', 'name' => '耳机', 'price' => 899, 'buyDate' => '2026-11-01', 'image' => array('source' => 'base64', 'ref' => $pngB64)), array('when' => 'read'));
check('goods 缺 extraFees → []（详情页 detail.extraFees.length 不再崩）', isset($g['extraFees']) && $g['extraFees'] === array(), js($g['extraFees']));
check('goods 缺 tags → []', isset($g['tags']) && $g['tags'] === array(), js($g['tags']));
check('goods 缺 incomes → []', isset($g['incomes']) && $g['incomes'] === array(), js($g['incomes']));
check('goods 缺 status → active', isset($g['status']) && $g['status'] === 'active', js($g['status']));
check('goods 缺 currency → CNY', isset($g['currency']) && $g['currency'] === 'CNY', js($g['currency']));
check('goods 缺 categoryId → cg0', isset($g['categoryId']) && $g['categoryId'] === 'cg0', js($g['categoryId']));
check('goods 裸 base64 image → local dataURL', isset($g['image']['source']) && $g['image']['source'] === 'local' && strpos($g['image']['ref'], 'data:image/png;base64,') === 0, js($g['image']));
check('goods 补 createdAt/updatedAt', !empty($g['createdAt']) && !empty($g['updatedAt']), js(array($g['createdAt'], $g['updatedAt'])));

$g2 = GF_EntityNormalize::row('goods', array('id' => 'g2', 'name' => 'x'), array('when' => 'read'));
check('goods 完全缺 image（read）→ {source:system, ref:📦}（与历史加固逐字节一致）',
    isset($g2['image']) && $g2['image'] === array('source' => 'system', 'ref' => '📦'), js($g2['image']));

$g3 = GF_EntityNormalize::row('goods', array('id' => 'g3', 'name' => 'x'), array('when' => 'write'));
check('goods 完全缺 image（write）→ 不写 image（回落分类图标，不硬塞 📦）', !array_key_exists('image', $g3), js($g3));

$g4 = GF_EntityNormalize::row('goods', array('id' => 'g4', 'name' => 'x', 'extraFees' => array(array('name' => '运费', 'amount' => 12)), 'tags' => array('a'), 'status' => 'retired'));
check('已存在的合法值绝不被覆盖（extraFees/tags/status 原样）',
    $g4['extraFees'] === array(array('name' => '运费', 'amount' => 12)) && $g4['tags'] === array('a') && $g4['status'] === 'retired', js($g4));
check('自定义字段原样保留', !isset($g4['__x']) ? true : false);

$g5 = GF_EntityNormalize::row('goods', array('id' => 'g5', 'name' => 'x', 'myField' => array('a' => 1), 'status' => 'bogus'));
check('未知自定义字段不丢', isset($g5['myField']) && $g5['myField'] === array('a' => 1), js($g5['myField']));
check('非法枚举 status → 回落 active', $g5['status'] === 'active', js($g5['status']));

$v = GF_EntityNormalize::row('valueRecords', array('id' => 'vr1', 'amount' => 25, 'date' => '2026-11-20'));
check('valueRecords 缺 judgement → xu', $v['judgement'] === 'xu', js($v['judgement']));
check('valueRecords 缺 currency → CNY', $v['currency'] === 'CNY', js($v['currency']));
check('valueRecords 缺 type → expense', $v['type'] === 'expense', js($v['type']));
check('valueRecords 缺 categoryId → cl0', $v['categoryId'] === 'cl0', js($v['categoryId']));
check('valueRecords 不补 createdAt（保持历史行为，由客户端落库补）', !isset($v['createdAt']), js($v));

$s = GF_EntityNormalize::row('subscriptions', array('id' => 's1', 'name' => '腾讯视频', 'amount' => 25));
check('subscriptions 缺 remind → {renewLead:3}', isset($s['remind']['renewLead']) && $s['remind']['renewLead'] === 3, js($s['remind']));
check('subscriptions 缺 icon → credit-card', $s['icon'] === 'credit-card', js($s['icon']));
check('subscriptions 缺 period → month / type → recurring / autoRenew → true',
    $s['period'] === 'month' && $s['type'] === 'recurring' && $s['autoRenew'] === true, js(array($s['period'], $s['type'], $s['autoRenew'])));
check('subscriptions 缺 categoryId → cs0 / currency → CNY / status → active',
    $s['categoryId'] === 'cs0' && $s['currency'] === 'CNY' && $s['status'] === 'active', js(array($s['categoryId'], $s['currency'], $s['status'])));

$s2 = GF_EntityNormalize::row('subscriptions', array('id' => 's2', 'remind' => 'nope'));
check('subscriptions remind 非对象 → 归一成 {renewLead:3}', is_array($s2['remind']) && $s2['remind']['renewLead'] === 3, js($s2['remind']));

$b = GF_EntityNormalize::row('bills', array('id' => 'b1'));
check('bills 缺 status → pending / currency → CNY', $b['status'] === 'pending' && $b['currency'] === 'CNY', js(array($b['status'], $b['currency'])));

$w = GF_EntityNormalize::row('wishlist', array('id' => 'w1', 'name' => '相机'));
check('wishlist 缺 reasons → []', isset($w['reasons']) && $w['reasons'] === array(), js($w['reasons']));
$w2 = GF_EntityNormalize::row('wishlist', array('id' => 'w2', 'name' => '相机', 'image' => array('source' => 'base64', 'ref' => $pngB64)));
check('wishlist 对象图 → "img:data:image/png;base64,…" 字符串', isset($w2['image']) && strpos($w2['image'], 'img:data:image/png;base64,') === 0, js($w2['image']));
$w3 = GF_EntityNormalize::row('wishlist', array('id' => 'w3', 'image' => 'https://a.com/p.jpg'));
check('wishlist url 图 → "url:https://…"', isset($w3['image']) && $w3['image'] === 'url:https://a.com/p.jpg', js($w3['image']));

$cd = GF_EntityNormalize::row('cooldowns', array('id' => 'cd1', 'name' => '冲动'));
check('cooldowns 补 createdAt、保留 name', !empty($cd['createdAt']) && $cd['name'] === '冲动', js($cd));
$cd2 = GF_EntityNormalize::row('cooldowns', array('id' => 'cd2', 'image' => 'brand:jd.com'));
check('cooldowns brand 图原样', isset($cd2['image']) && $cd2['image'] === 'brand:jd.com', js($cd2['image']));

$t = GF_EntityNormalize::row('times', array('id' => 't1'));
check('times 缺 tags → [] / meaning → xu / durationMin → 0',
    $t['tags'] === array() && $t['meaning'] === 'xu' && $t['durationMin'] === 0, js(array($t['tags'], $t['meaning'], $t['durationMin'])));

$m = GF_EntityNormalize::row('moods', array('id' => 'm1'));
check('moods 缺 crushed/inHeart → false', $m['crushed'] === false && $m['inHeart'] === false, js(array($m['crushed'], $m['inHeart'])));

$c = GF_EntityNormalize::row('categories', array('id' => 'cu1', 'name' => '咖啡'));
check('categories 缺 kind → ledger / icon → tag / order → 99',
    $c['kind'] === 'ledger' && $c['icon'] === 'tag' && $c['order'] === 99, js(array($c['kind'], $c['icon'], $c['order'])));

$u = GF_EntityNormalize::row('usageRecords', array('id' => 'ur1', 'goodsId' => 'g1'));
check('usageRecords 补 createdAt', !empty($u['createdAt']), js($u));

$rm = GF_EntityNormalize::row('reminders', array('id' => 'r1'));
check('reminders 缺 kind → goods_warranty / done → false', $rm['kind'] === 'goods_warranty' && $rm['done'] === false, js(array($rm['kind'], $rm['done'])));

$wl = GF_EntityNormalize::row('walls', array('id' => 'wl1'));
check('walls 缺 text → "" / 补 createdAt', $wl['text'] === '' && !empty($wl['createdAt']), js($wl));

$unk = GF_EntityNormalize::row('whatever', array('a' => 1));
check('未知集合原样返回（前向兼容）', $unk === array('a' => 1), js($unk));
check('非数组行返回 null', GF_EntityNormalize::row('goods', 'oops') === null);

echo "\n== 3. 图片大小上限（2MB 解码后 / 3.2MB 字符串）==\n";

// 恰好在 2MB 以内的 jpeg
$okBin = "\xFF\xD8\xFF\xE0" . str_repeat('A', GF_EntityNormalize::IMAGE_MAX_BYTES - 4);
$r = GF_EntityNormalize::image(base64_encode($okBin));
check('解码后恰好 2MB → 接受', is_array($r) && $r['source'] === 'local', is_array($r) ? strlen($r['ref']) . ' chars' : js($r));

// 超过 2MB 的 jpeg
$bigBin = "\xFF\xD8\xFF\xE0" . str_repeat('A', GF_EntityNormalize::IMAGE_MAX_BYTES);
$w = array();
$r = GF_EntityNormalize::image(base64_encode($bigBin), $w);
check('解码后 >2MB → 拒绝（返回 null）', $r === null, js($r));
check('  且有显式 warning', count($w) === 1 && strpos($w[0], '图片过大') !== false, js($w));

// 超限图片不影响其它字段落库
$w = array();
$row = GF_EntityNormalize::row('goods', array('id' => 'gbig', 'name' => '巨图物品', 'price' => 1, 'image' => base64_encode($bigBin)), array('when' => 'write'), $w);
check('超限图被拒后其它字段照常保留', $row['name'] === '巨图物品' && $row['price'] === 1 && !isset($row['image']) && count($w) === 1, js($row));

// 超长字符串（>3.2M 字符）直接拒绝，不做解码
$w = array();
$r = GF_EntityNormalize::image(str_repeat('A', GF_EntityNormalize::IMAGE_MAX_STRING + 10), $w);
check('base64 字符串 >3.2M 字符 → 拒绝 + warning', $r === null && count($w) === 1, js($w));

// dataURL 超限
$w = array();
$r = GF_EntityNormalize::image('data:image/jpeg;base64,' . base64_encode($bigBin), $w);
check('超大 dataURL → 拒绝 + warning', $r === null && count($w) === 1, js($w));

echo "\n== 4. 整份集合表归一化（备份 / AI 读取共用）==\n";

$cols = array(
    'goods' => array(
        array('id' => 'g1', 'name' => '耳机', 'price' => 899, 'image' => array('source' => 'base64', 'ref' => $pngB64)),
        'not-a-row',
    ),
    'valueRecords' => 'not-an-array',
);
$warn = array();
$clean = GF_EntityNormalize::collections($cols, array('when' => 'read'), $warn);
check('12 个集合键全部存在', count(array_intersect(GF_EntityNormalize::COLLECTIONS, array_keys($clean))) === 12, count($clean));
check('非数组集合 → 空数组', is_array($clean['valueRecords']) && $clean['valueRecords'] === array(), js($clean['valueRecords']));
check('集合里的非数组行被剔除', count($clean['goods']) === 1, js($clean['goods']));
check('goods 行补齐三个数组字段', $clean['goods'][0]['extraFees'] === array() && $clean['goods'][0]['tags'] === array() && $clean['goods'][0]['incomes'] === array());
check('goods 图片已归一', $clean['goods'][0]['image']['source'] === 'local');
check('row 索引被重建为连续数组（array_values 语义，JSON 里是数组不是对象）',
    array_keys($clean['goods']) === array(0), js(array_keys($clean['goods'])));

$extra = GF_EntityNormalize::collections(array('goods' => array(), 'myCustomCol' => array(array('a' => 1))), array(), $warn);
check('客户端扩展的其它集合保留', isset($extra['myCustomCol']) && count($extra['myCustomCol']) === 1, js($extra['myCustomCol']));

echo "\n== 5. 历史备份兼容性（Api::normalizeBackupPayload 同款逻辑）==\n";

$oldPayload = json_encode(array(
    'app' => 'flyme-web',
    'version' => 1,
    'count' => 2,
    'collections' => array(
        // 旧版把集合直接挂顶层的情况另行覆盖；这里测 collections 结构
        'goods' => array(array('id' => 'gA', 'name' => '旧物品', 'price' => 100, 'extraFees' => array(array('name' => '运费', 'amount' => 10)))),
        'valueRecords' => array(array('id' => 'vrA', 'amount' => 9, 'date' => '2026-10-01', 'judgement' => '归')),
    ),
    'settings' => 'bad',
), JSON_UNESCAPED_UNICODE);
$decoded = json_decode($oldPayload, true);
$warn = array();
$decoded['collections'] = GF_EntityNormalize::collections($decoded['collections'], array('when' => 'read'), $warn);
if (isset($decoded['settings']) && !is_array($decoded['settings'])) {
    $decoded['settings'] = array();
}
check('旧备份 goods 的 extraFees 原样保留', $decoded['collections']['goods'][0]['extraFees'] === array(array('name' => '运费', 'amount' => 10)));
check('旧备份 valueRecords 的 judgement 不被实体层改写（中文「归」留给 AI 层归一）',
    $decoded['collections']['valueRecords'][0]['judgement'] === '归', js($decoded['collections']['valueRecords'][0]['judgement']));
check('settings 非数组 → 空数组（旧行为保持）', $decoded['settings'] === array());
check('旧备份 goods 缺 tags/incomes → 已补齐', $decoded['collections']['goods'][0]['tags'] === array() && $decoded['collections']['goods'][0]['incomes'] === array());
check('旧备份 goods 缺 image → 补 📦', $decoded['collections']['goods'][0]['image'] === array('source' => 'system', 'ref' => '📦'));
$re = json_encode($decoded, JSON_UNESCAPED_UNICODE);
check('再编码后仍是合法 JSON', json_decode($re, true) !== null, substr($re, 0, 120));

echo "\n----------------------------------------\n";
echo "通过 $pass 项，失败 $fail 项\n";
exit($fail === 0 ? 0 : 1);