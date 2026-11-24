<?php
/**
 * ★v1.8.0 图片云托管（GF_ImageStore）服务端自测（CLI 跑，不进生产包）
 *
 * 用法：C:\Users\Administrator\ego\php\php.exe t_image_store.php
 *
 * 覆盖：内容寻址去重、sha 计算、扩展名/类型嗅探、签名 URL 生成与校验（含过期、
 * 篡改）、引用集合（LIST）、GC 的三重保险、路径穿越防护。
 * 不连数据库、不读 config.php（GF_Config 缺失时 secret 走兜底值）。
 * 所有落盘都在 storage/images/__selftest_<pid>/ 下，跑完自动清理。
 */

if (!defined('GF_ROOT')) {
    if (PHP_SAPI !== 'cli') {
        http_response_code(403);
        exit('forbidden');
    }
}

define('GF_ROOT', __DIR__);
require_once GF_ROOT . '/app/lib/Config.php';
require_once GF_ROOT . '/app/lib/ImageStore.php';

$pass = 0;
$fail = 0;

function check($name, $cond)
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  ✓ " . $name . "\n";
    } else {
        $fail++;
        echo "  ✗ " . $name . "\n";
    }
}

/** 一张最小的合法 PNG（1x1）。 */
function tiny_png()
{
    return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
}

/** 一张最小的合法 JPEG 头（足够嗅探）。 */
function tiny_jpg()
{
    return "\xFF\xD8\xFF\xE0" . str_repeat("\x00", 64) . "\xFF\xD9";
}

$me = array('email' => '__selftest_' . getmypid() . '@example.invalid');
$ownerHash = GF_ImageStore::ownerHash($me['email']);
$ownerDir = GF_ROOT . '/storage/images/' . $ownerHash;

echo "[1] 嗅探与路径安全\n";
check('PNG 魔数 → image/png', GF_ImageStore::sniff(tiny_png()) === 'image/png');
check('JPEG 魔数 → image/jpeg', GF_ImageStore::sniff(tiny_jpg()) === 'image/jpeg');
check('SVG 被识别（调用方拒绝）', GF_ImageStore::sniff('<svg xmlns="x"></svg>') === 'image/svg+xml');
check('乱码 → null', GF_ImageStore::sniff('hello world') === null);
check('sha 合法性：64 hex 通过', GF_ImageStore::validSha(str_repeat('a', 64)) === str_repeat('a', 64));
check('sha 合法性：大写归一化为小写', GF_ImageStore::validSha(str_repeat('A', 64)) === str_repeat('a', 64));
check('sha 合法性：路径穿越被拒', GF_ImageStore::validSha('../../config') === null);
check('sha 合法性：长度不足被拒', GF_ImageStore::validSha('abc') === null);

echo "[2] 上传 / 内容寻址去重\n";
$png = tiny_png();
$sha = hash('sha256', $png);
$r1 = GF_ImageStore::put($me, 'data:image/png;base64,' . base64_encode($png));
check('首次上传 ok', !empty($r1['ok']));
check('返回 sha256 与内容一致', isset($r1['sha256']) && $r1['sha256'] === $sha);
check('size = 字节数', isset($r1['size']) && $r1['size'] === strlen($png));
check('mime = image/png', isset($r1['mime']) && $r1['mime'] === 'image/png');
check('deduped = false（首次）', isset($r1['deduped']) && $r1['deduped'] === false);
check('落盘路径符合 storage/images/<ownerHash>/<前2位>/<sha>.png',
    is_file($ownerDir . '/' . substr($sha, 0, 2) . '/' . $sha . '.png'));
check('返回的是带签名的读取 URL', isset($r1['url']) && strpos($r1['url'], '/api/user/images/' . $sha . '?t=') === 0);

$r2 = GF_ImageStore::put($me, base64_encode($png)); // 裸 base64 也能收
check('重复上传 ok', !empty($r2['ok']));
check('重复上传 deduped = true', isset($r2['deduped']) && $r2['deduped'] === true);
$files = glob($ownerDir . '/*/*.png');
check('磁盘上仍然只有一个文件', is_array($files) && count($files) === 1);

$r3 = GF_ImageStore::put($me, tiny_jpg());
check('二进制直传（无 data 前缀）也能收', !empty($r3['ok']) && $r3['mime'] === 'image/jpeg');
check('jpg 的扩展名正确', is_file($ownerDir . '/' . substr($r3['sha256'], 0, 2) . '/' . $r3['sha256'] . '.jpg'));

$bad = GF_ImageStore::put($me, '<svg>alert(1)</svg>');
check('SVG 被拒绝', empty($bad['ok']) && $bad['code'] === 400);
$empty = GF_ImageStore::put($me, '');
check('空内容被拒绝', empty($empty['ok']) && $empty['code'] === 400);
$junk = GF_ImageStore::put($me, base64_encode('not an image at all'));
check('非图片内容被拒绝', empty($junk['ok']) && $junk['code'] === 400);

echo "[3] 签名 URL\n";
$url = GF_ImageStore::urlFor($sha);
parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
check('URL 带 t / s 两个参数', isset($q['t'], $q['s']));
check('签名校验通过', GF_ImageStore::verify($sha, $q['t'], $q['s']) === true);
check('签名换 sha 即失效', GF_ImageStore::verify(str_repeat('0', 64), $q['t'], $q['s']) === false);
check('篡改过期时间即失效', GF_ImageStore::verify($sha, (int) $q['t'] + 3600, $q['s']) === false);
check('过期时间已过去 → 失效', GF_ImageStore::verify($sha, time() - 10, GF_ImageStore::sign($sha, time() - 10)) === false);
check('shaFromRef 能从完整 URL 解析', GF_ImageStore::shaFromRef($url) === $sha);
check('shaFromRef 能解析无签名的相对路径', GF_ImageStore::shaFromRef('/api/user/images/' . $sha) === $sha);
check('shaFromRef 解析不出返回 null', GF_ImageStore::shaFromRef('/api/user/images/not-a-sha') === null);

echo "[4] LIST 与引用集合\n";
$list = GF_ImageStore::listHashes($me);
check('LIST ok', !empty($list['ok']));
check('LIST 含 PNG', in_array($sha, $list['hashes'], true));
check('LIST 含 JPG', in_array($r3['sha256'], $list['hashes'], true));
check('LIST 条数 = 2', $list['count'] === 2);
check('referencedBy 认得已上传的图', GF_ImageStore::referencedBy($ownerHash, $sha) === true);
check('referencedBy 不认没上传过的图', GF_ImageStore::referencedBy($ownerHash, str_repeat('f', 64)) === false);

echo "[5] 回收（GC）三重保险\n";
$noList = GF_ImageStore::gc($me, null);
check('不给 referenced 清单 → 拒绝执行', empty($noList['ok']));
$gc1 = GF_ImageStore::gc($me, array($sha)); // 只声明 PNG 还在用
check('GC ok', !empty($gc1['ok']));
check('被引用的 PNG 保留', is_file($ownerDir . '/' . substr($sha, 0, 2) . '/' . $sha . '.png'));
check('未引用的 JPG 被回收', !is_file($ownerDir . '/' . substr($r3['sha256'], 0, 2) . '/' . $r3['sha256'] . '.jpg'));
check('GC 报告 deleted=1 kept=1', $gc1['deleted'] === 1 && $gc1['kept'] === 1);
$list2 = GF_ImageStore::listHashes($me);
check('回收后 LIST 只剩 PNG', $list2['count'] === 1 && $list2['hashes'][0] === $sha);

echo "[6] 清理\n";
foreach ((array) glob($ownerDir . '/*/*') as $f) {
    @unlink($f);
}
foreach ((array) glob($ownerDir . '/*', GLOB_ONLYDIR) as $d) {
    @rmdir($d);
}
@unlink($ownerDir . '/refs.json');
@rmdir($ownerDir);
check('自测目录已清理（storage/images 下不留垃圾）', !is_dir($ownerDir));

echo "\n通过 " . $pass . " / 失败 " . $fail . "\n";
exit($fail > 0 ? 1 : 0);