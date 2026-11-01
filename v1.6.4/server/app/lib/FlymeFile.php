<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * v1.1 · .flyme 备份文件格式（服务端侧）——与前端 `src/lib/flymeFile.ts`
 * 及网页版 SPA bundle 二进制互通。
 *
 * 字节布局（与前端逐字节一致）：
 *   [0..5]   魔数 ASCII "FLYME1"（6 字节）
 *   [6]      版本：0 = 未加密（后跟明文 JSON UTF-8）；1 = 加密
 *   -- 版本 1 --
 *   [7..22]  salt   16 字节随机（PBKDF2）
 *   [23..34] iv     12 字节随机（AES-GCM nonce）
 *   [35..]   AES-256-GCM 密文（末尾含 16 字节 tag）
 *
 * 密钥派生：PBKDF2(password, salt, iterations=200000, hash=SHA-256) → 32 字节，
 * 用作 AES-GCM-256 密钥。明文为 JSON.stringify(payload) 的 UTF-8 编码。
 *
 * PHP 侧实现要点：
 *  - hash_pbkdf2(..., true) 输出原始字节；
 *  - openssl_encrypt 的 aes-256-gcm 通过第 6 个引用参数返回 16 字节 tag，
 *    WebCrypto 的密文输出 = ct . tag，这里手动拼接保持互通；
 *  - 解密时把末 16 字节拆回来传给 openssl_decrypt。
 *
 * 兼容性：PHP 7.1+（aes-256-gcm 与 tag 参数）、openssl 扩展。
 * 服务端目标环境 PHP 7.2 ~ 8.0，均满足。
 */
class GF_FlymeFile
{
    /** 魔数（6 字节 ASCII，前端常量 MAGIC / 网页版 oa）。 */
    const MAGIC = 'FLYME1';
    /** 版本字节：未加密。 */
    const VERSION_PLAIN = 0;
    /** 版本字节：加密。 */
    const VERSION_ENCRYPTED = 1;
    /** PBKDF2 迭代次数（前端 FLYME_PBKDF2_ITERATIONS / 网页版 wm = 2e5）。 */
    const PBKDF2_ITERATIONS = 200000;
    /** PBKDF2 salt 长度（字节）。 */
    const SALT_LEN = 16;
    /** AES-GCM IV 长度（字节）。 */
    const IV_LEN = 12;
    /** AES-GCM tag 长度（字节）。 */
    const TAG_LEN = 16;
    /** 加密头总长：魔数 6 + 版本 1 + salt 16 + iv 12。 */
    const ENC_HEADER_LEN = 35;
    /** 文件大小上限（256MB，防内存爆炸）。 */
    const MAX_BYTES = 268435456;

    /**
     * 序列化为 .flyme 字节。
     *
     * @param array  $payload  可 JSON 化的备份内容
     * @param string $password 密码；trim 后为空 = 不加密（版本 0 明文）
     * @return string 二进制字节串
     */
    public static function encode($payload, $password = '')
    {
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE);
        if (!is_string($json)) {
            throw new Exception('备份内容无法序列化为 JSON');
        }
        $pwd = trim((string) $password);

        if ($pwd === '') {
            return self::MAGIC . chr(self::VERSION_PLAIN) . $json;
        }

        $salt = random_bytes(self::SALT_LEN);
        $iv   = random_bytes(self::IV_LEN);
        $key  = hash_pbkdf2('sha256', $pwd, $salt, self::PBKDF2_ITERATIONS, 32, true);
        $ct   = openssl_encrypt($json, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($ct === false || strlen($tag) !== self::TAG_LEN) {
            throw new Exception('备份加密失败（openssl aes-256-gcm 不可用？）');
        }
        return self::MAGIC . chr(self::VERSION_ENCRYPTED) . $salt . $iv . $ct . $tag;
    }

    /**
     * 解析 .flyme 字节为备份数组。
     *
     * 容错（与前端 decodeFlyme 对齐）：
     *  - 非 FLYME1 魔数：按纯 JSON 尝试（兼容 v1.0.34 及更早导出的 .json 明文备份）；
     *  - 版本 0：后随明文 JSON；
     *  - 版本 1：PBKDF2 + AES-256-GCM 解密。
     *
     * @param string $bytes    文件字节
     * @param string $password 密码（未加密文件可留空）
     * @return array 解码后的备份数组
     * @throws Exception 无法识别 / 已损坏 / 缺密码 / 密码错误
     */
    public static function decode($bytes, $password = '')
    {
        if (!is_string($bytes) || strlen($bytes) > self::MAX_BYTES) {
            throw new Exception('备份文件过大或不可读');
        }
        if (!self::isFlyme($bytes)) {
            // 兼容旧版明文 JSON 备份
            $j = json_decode($bytes, true);
            if (is_array($j)) {
                return $j;
            }
            throw new Exception('无法识别的文件（不是 .flyme 备份）');
        }
        if (strlen($bytes) < 7) {
            throw new Exception('备份文件已损坏');
        }
        $version = ord($bytes[6]);

        if ($version === self::VERSION_PLAIN) {
            $j = json_decode(substr($bytes, 7), true);
            if (!is_array($j)) {
                throw new Exception('备份文件已损坏');
            }
            return $j;
        }
        if ($version !== self::VERSION_ENCRYPTED) {
            throw new Exception('不支持的备份文件版本：' . $version);
        }

        $pwd = trim((string) $password);
        if ($pwd === '') {
            throw new Exception('该备份已加密，请输入备份密码');
        }
        if (strlen($bytes) < self::ENC_HEADER_LEN + self::TAG_LEN) {
            throw new Exception('备份文件已损坏');
        }
        $salt = substr($bytes, 7, self::SALT_LEN);
        $iv   = substr($bytes, 7 + self::SALT_LEN, self::IV_LEN);
        $blob = substr($bytes, self::ENC_HEADER_LEN);
        $ct   = substr($blob, 0, -self::TAG_LEN);
        $tag  = substr($blob, -self::TAG_LEN);

        $key   = hash_pbkdf2('sha256', $pwd, $salt, self::PBKDF2_ITERATIONS, 32, true);
        $plain = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($plain === false) {
            throw new Exception('密码错误，或文件已损坏');
        }
        $j = json_decode($plain, true);
        if (!is_array($j)) {
            throw new Exception('备份文件已损坏');
        }
        return $j;
    }

    /** 是否为 .flyme 格式（前 6 字节 == "FLYME1"）。 */
    public static function isFlyme($bytes)
    {
        return is_string($bytes) && strlen($bytes) >= 6 && substr($bytes, 0, 6) === self::MAGIC;
    }

    /** 是否「已加密的 .flyme」（魔数 + 版本字节 1）。 */
    public static function isEncrypted($bytes)
    {
        return self::isFlyme($bytes) && strlen($bytes) >= 7 && ord($bytes[6]) === self::VERSION_ENCRYPTED;
    }
}
