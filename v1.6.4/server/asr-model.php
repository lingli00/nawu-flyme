<?php
/**
 * ★v1.4.0 离线语音模型下发接口。
 *
 * 为什么单独一个文件而不并进 index.php：
 * - 需要 `Access-Control-Allow-Origin: *`（App 内页面源是 https://localhost，
 *   跨到本站取模型必须带 CORS 头；网页版同源不受影响）；
 * - 需要准确的 Content-Length 让客户端显示下载进度；
 * - 只读一个固定文件，不参与业务路由，独立文件最不容易被后续改动误伤。
 *
 * 模型文件位置：storage/asr/vosk-model-small-cn-0.22.tar.gz（约 42MB）
 * nginx 已封死 /storage/ 直链，只能经本接口读取。
 */

declare(strict_types=1);

$file = __DIR__ . '/storage/asr/vosk-model-small-cn-0.22.tar.gz';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
header('Access-Control-Allow-Headers: Range, Content-Type');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: public, max-age=604800');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (!is_file($file)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'asr model missing';
    exit;
}

$size = filesize($file);
header('Content-Type: application/gzip');
header('Accept-Ranges: bytes');

// 支持 Range（断点续传 / 分块拉取；客户端目前整包下载，留作兜底）
$range = isset($_SERVER['HTTP_RANGE']) ? trim((string) $_SERVER['HTTP_RANGE']) : '';
if ($range !== '' && preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m)) {
    $start = $m[1] === '' ? 0 : (int) $m[1];
    $end = $m[2] === '' ? $size - 1 : (int) $m[2];
    if ($start > $end || $start >= $size) {
        http_response_code(416);
        header('Content-Range: bytes */' . $size);
        exit;
    }
    $end = min($end, $size - 1);
    http_response_code(206);
    header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    header('Content-Length: ' . ($end - $start + 1));
    $fp = fopen($file, 'rb');
    fseek($fp, $start);
    $left = $end - $start + 1;
    while ($left > 0 && !feof($fp)) {
        $chunk = fread($fp, min(262144, $left));
        if ($chunk === false) {
            break;
        }
        echo $chunk;
        $left -= strlen($chunk);
        @ob_flush();
        flush();
    }
    fclose($fp);
    exit;
}

header('Content-Length: ' . $size);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    exit;
}
readfile($file);
