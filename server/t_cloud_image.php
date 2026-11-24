<?php
/**
 * 云端图归一化回归测试（★v1.7.7）：确认云端引用不会被回落成 system emoji。
 * CLI only。
 */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
define('GF_ROOT', __DIR__);
require_once __DIR__ . '/app/lib/EntityNormalize.php';

$pass = 0; $fail = 0;
function ok($name, $cond, $extra = '') {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  [OK]   $name\n"; }
    else { $fail++; echo "  [FAIL] $name" . ($extra ? "  => $extra" : '') . "\n"; }
}

$sha = str_repeat('a', 64);

echo "== 1. 对象形态 {source:cloud, ref, sha256} ==\n";
$r = GF_EntityNormalize::image(array('source' => 'cloud', 'ref' => "/api/user/images/$sha", 'sha256' => $sha));
ok('source 保持 cloud', is_array($r) && ($r['source'] ?? '') === 'cloud', json_encode($r));
ok('ref 保持相对路径', is_array($r) && ($r['ref'] ?? '') === "/api/user/images/$sha", json_encode($r));
ok('sha256 透传', is_array($r) && ($r['sha256'] ?? '') === $sha, json_encode($r));
ok('不是 system emoji', !(is_array($r) && ($r['source'] ?? '') === 'system'), json_encode($r));

echo "\n== 2. ref 是绝对 URL（同站）==\n";
$abs = "https://your.domain.com/api/user/images/$sha?t=123&s=abc";
$r = GF_EntityNormalize::image(array('source' => 'cloud', 'ref' => $abs));
ok('绝对值 → 归成相对路径', is_array($r) && ($r['ref'] ?? '') === "/api/user/images/$sha", json_encode($r));
ok('sha256 自动提取', is_array($r) && ($r['sha256'] ?? '') === $sha, json_encode($r));

echo "\n== 3. 字符串形态 cloud: ==\n";
$r = GF_EntityNormalize::image("cloud:/api/user/images/$sha");
ok('cloud: 前缀被识别', is_array($r) && ($r['source'] ?? '') === 'cloud', json_encode($r));
ok('ref 归一', is_array($r) && ($r['ref'] ?? '') === "/api/user/images/$sha", json_encode($r));

echo "\n== 4. 裸相对路径字符串 ==\n";
$r = GF_EntityNormalize::image("/api/user/images/$sha");
ok('裸路径识别为 cloud', is_array($r) && ($r['source'] ?? '') === 'cloud', json_encode($r));

echo "\n== 5. 裸 sha256 ==\n";
$r = GF_EntityNormalize::image($sha);
ok('裸 sha 识别为 cloud', is_array($r) && ($r['source'] ?? '') === 'cloud', json_encode($r));
ok('ref 拼成标准路径', is_array($r) && ($r['ref'] ?? '') === "/api/user/images/$sha", json_encode($r));

echo "\n== 6. 有 URL token 的绝对地址（前端落库形态）==\n";
$withTok = "https://your.domain.com/api/user/images/$sha?t=1770000000&s=deadbeef";
$r = GF_EntityNormalize::image(array('source' => 'cloud', 'ref' => $withTok, 'sha256' => $sha));
ok('保留 cloud', is_array($r) && ($r['source'] ?? '') === 'cloud', json_encode($r));
ok('ref 去 token 留标准路径', is_array($r) && ($r['ref'] ?? '') === "/api/user/images/$sha", json_encode($r));

echo "\n== 7. 不能影响原有形态 ==\n";
$local = GF_EntityNormalize::image(array('source' => 'local', 'ref' => 'data:image/jpeg;base64,/9j/AAA'));
ok('local/dataURL 不变', is_array($local) && ($local['source'] ?? '') === 'local', json_encode($local));
$web = GF_EntityNormalize::image(array('source' => 'web', 'ref' => 'https://a.com/x.jpg'));
ok('web 普通外链不变', is_array($web) && ($web['source'] ?? '') === 'web', json_encode($web));
$sys = GF_EntityNormalize::image(array('source' => 'system', 'ref' => '📦'));
ok('system emoji 不变', is_array($sys) && ($sys['source'] ?? '') === 'system', json_encode($sys));
$b64 = GF_EntityNormalize::image('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv');
ok('裸 base64 仍归 local', is_array($b64) && ($b64['source'] ?? '') === 'local', json_encode($b64));

echo "\n== 8. 整行归一：goods.image 云端不被替换 ==\n";
$row = array(
    'id' => 'g_test', 'name' => '测试', 'price' => 1,
    'image' => array('source' => 'cloud', 'ref' => "/api/user/images/$sha", 'sha256' => $sha),
);
$out = GF_EntityNormalize::row('goods', $row, array('when' => 'write'));
ok('row.image.source = cloud', ($out['image']['source'] ?? '') === 'cloud', json_encode($out['image'] ?? null));
ok('row.image.ref 保留', ($out['image']['ref'] ?? '') === "/api/user/images/$sha", json_encode($out['image'] ?? null));
ok('extraFees 仍补齐', is_array($out['extraFees'] ?? null), 'extraFees 未补');

echo "\n== 9. read 路径同样保住云端图 ==\n";
$out2 = GF_EntityNormalize::row('goods', $row, array('when' => 'read'));
ok('read 后仍是 cloud', ($out2['image']['source'] ?? '') === 'cloud', json_encode($out2['image'] ?? null));

echo "\n== 10. 集合级归一 ==\n";
$cols = GF_EntityNormalize::collections(array('goods' => array($row)), array('when' => 'read'));
ok('collections 保住 cloud', ($cols['goods'][0]['image']['source'] ?? '') === 'cloud', json_encode($cols['goods'][0]['image'] ?? null));

echo "\n" . str_repeat('-', 44) . "\n";
echo "通过 $pass 项，失败 $fail 项\n";
exit($fail > 0 ? 1 : 0);