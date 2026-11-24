<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * ★v1.7.7 · 实体级归一化（服务端「单一真相源」）
 *
 * 背景（线上事故取证）：
 *   19 条物品里 11 条来自 AI API（/api/ai/mutate、/api/ai/commit）的全部缺
 *   `extraFees` / `tags` / `incomes` 三个字段 → 前端详情页
 *   `detail.extraFees.length` 直接抛 `Cannot read properties of undefined`，白屏；
 *   同时这 11 条的 `image.ref` 是**裸 base64**（无 `data:` 前缀），
 *   前端的 goodsIconValue() 认不出（既不是 data: 也不是 http(s)）→ 首图不显示。
 *
 *   其实服务端早就有一份正确实现 —— Api.php 的 normalizeBackupPayload() 里的
 *   「实体级加固」，但它只覆盖 3 个备份/同步调用点（备份上传 / 分片上传合并 /
 *   /api/sync/push），**AI 写入路径完全没走过它**。
 *
 * 本文件把那套加固抽成人人可用的公共函数，并按 app/src/types/entities.ts 的
 * 必填字段把 12 个集合全部补齐，任何写入口（备份、同步、AI mutate/commit、
 * 读取回显）都只调这里，不再各写一份。
 *
 * 纯函数、不碰数据库、不依赖其它 lib（只 require Support 的约定不成立也没关系，
 * 本文件不调用任何全局函数）。
 */
class GF_EntityNormalize
{
    /** 12 个集合（与 app/src/types/entities.ts COLLECTIONS 严格一致，顺序也一致）。 */
    const COLLECTIONS = array(
        'goods', 'subscriptions', 'bills', 'valueRecords', 'moods', 'times',
        'wishlist', 'cooldowns', 'categories', 'usageRecords', 'reminders', 'walls',
    );

    /** 图片缺失时的兜底形态（与 Api.php 历史加固逐字节一致：source=system + 📦）。 */
    const IMAGE_FALLBACK = array('source' => 'system', 'ref' => '📦');

    /**
     * 图片上限（★v1.7.7）：
     *   · 单体 base64 解码后 ≤ 2MB（2,097,152 字节）→ 编码成 dataURL 约 2.8MB 字符串；
     *   · 整行 image 字符串（含 data: 前缀）≤ 3,200,000 字符，两者互为兜底。
     * 超过上限**不静默截断**（截断 = 图坏了），而是拒绝该图片并记一条 warning，
     * 其它字段照常写入 —— 免得一张巨图拖垮整份快照（云备份单包上限 16MB）。
     */
    const IMAGE_MAX_BYTES  = 2097152;
    const IMAGE_MAX_STRING = 3200000;

    /** 前端唯一认的 source 枚举（见 app/src/lib/goodsIcon.ts）。 */
    const IMAGE_SOURCES = array('local', 'web', 'system', 'brand', 'builtin');

    /* ==========================================================
     * 实体级归一化：补默认字段 + 归一化图片
     * ========================================================== */

    /**
     * 归一化一行记录。
     *
     * @param string $collection 12 个集合之一（未知集合原样返回，保证前向兼容）
     * @param array  $row        一行记录（非数组返回 null）
     * @param array  $opts
     *   · when   'read' | 'write'（默认 'read'）。区别只在**缺省 image**：
     *            read → 补 `{source:system, ref:'📦'}`（与备份加固逐字节一致，前端永不崩）；
     *            write → 不写 image（让用户「没选图」时回落分类图标，而不是被硬塞一个📦）。
     *   · image  bool（默认 true）是否处理图片。
     *   · fill   bool（默认 true）是否补缺省字段。
     *   · now    时间戳（默认 nowISO()），补 createdAt / updatedAt 用。
     *
     * @param array $warnings 引用传入：图片超限 / 非法被拒绝时追加的人类可读提示
     * @return array|null
     */
    public static function row($collection, $row, $opts = array(), &$warnings = null)
    {
        if (!is_array($row)) {
            return null;
        }
        if (!is_array($warnings)) {
            $warnings = array();
        }
        $opts = array_merge(array(
            'when'  => 'read',
            'image' => true,
            'fill'  => true,
            'now'   => null,
        ), (array) $opts);
        $when = $opts['when'] === 'write' ? 'write' : 'read';
        $now  = $opts['now'] !== null ? (string) $opts['now'] : self::nowISO();

        if (!in_array($collection, self::COLLECTIONS, true)) {
            return $row; // 未知集合：原样保留（前向兼容，客户端可能扩集合）
        }

        $row = (array) $row;

        if ($opts['fill']) {
            $row = self::fillDefaults($collection, $row, $now);
        }
        if ($opts['image']) {
            $row = self::normalizeImageField($collection, $row, $when, $warnings);
        }
        return $row;
    }

    /**
     * 归一化一整份集合表（备份 payload / AI 读取回显都用它）。
     *
     * 与 row() 的差别：这里**同时**保证 12 个集合键都存在（缺的补空数组）、
     * 非数组行剔除、非数组集合转空数组 —— 正是 Api.php 历史 normalizeBackupPayload
     * 里「缺失的集合补空数组、非数组值剔除」那段，行为保持一致。
     *
     * @param array  $collections
     * @param array  $opts  同 row()；另外 opts['dropInvalid'] 默认 true（剔除非数组行）
     * @param array  $warnings 引用传入
     * @return array 补齐后的 12+ 集合表（保留客户端自定义的其它集合）
     */
    public static function collections($collections, $opts = array(), &$warnings = null)
    {
        if (!is_array($collections)) {
            $collections = array();
        }
        if (!is_array($warnings)) {
            $warnings = array();
        }
        $opts = array_merge(array('dropInvalid' => true), (array) $opts);

        $clean = array();
        // ① 12 个标准集合：缺的补空数组，非数组转空数组，逐行归一
        foreach (self::COLLECTIONS as $n) {
            $v = isset($collections[$n]) ? $collections[$n] : array();
            $clean[$n] = self::rows($n, $v, $opts, $warnings);
        }
        // ② 客户端可能扩展的其它集合：同样校验为数组，键能对上就归一，对不上原样保留
        foreach ($collections as $k => $v) {
            if (!is_string($k) || isset($clean[$k])) {
                continue;
            }
            if (in_array($k, self::COLLECTIONS, true)) {
                continue;
            }
            $clean[$k] = self::rows($k, $v, $opts, $warnings);
        }
        return $clean;
    }

    /** 归一化一个集合的行数组（非数组行按 $opts['dropInvalid'] 丢弃）。 */
    public static function rows($collection, $rows, $opts = array(), &$warnings = null)
    {
        if (!is_array($rows)) {
            return array();
        }
        if (!is_array($warnings)) {
            $warnings = array();
        }
        $opts = array_merge(array('dropInvalid' => true), (array) $opts);
        $out = array();
        foreach ($rows as $row) {
            if (!is_array($row)) {
                if (!empty($opts['dropInvalid'])) {
                    continue;
                }
                $out[] = $row;
                continue;
            }
            $w = array();
            $one = self::row($collection, $row, $opts, $w);
            if ($w) {
                foreach ($w as $msg) {
                    $warnings[] = $msg;
                }
            }
            if ($one !== null) {
                $out[] = $one;
            }
        }
        return $out;
    }

    /* ==========================================================
     * 各集合必填字段（口径 = app/src/types/entities.ts）
     * ========================================================== */

    /**
     * 补齐单个集合的缺省字段。
     * ★铁律：只补「缺失或类型不对」的字段，**绝不覆盖**已存在的合法值；
     *        未知 / 自定义字段一律原样保留（AiSchema 的 additionalFields = true）。
     */
    public static function fillDefaults($collection, $row, $now = null)
    {
        if ($now === null) {
            $now = self::nowISO();
        }
        $row = (array) $row;
        switch ($collection) {
            case 'goods':
                // 前端 detail.extraFees.length / reduce / tags 全裸用 → 必填数组
                $row['tags']       = self::arr($row, 'tags');
                $row['extraFees']  = self::arr($row, 'extraFees');
                $row['incomes']    = self::arr($row, 'incomes');
                $row['status']     = self::pick($row, 'status', array('active', 'retired', 'favorite'), 'active');
                $row['currency']   = self::str($row, 'currency', 'CNY');
                $row['categoryId'] = self::str($row, 'categoryId', 'cg0');
                $row['name']       = self::str($row, 'name', '未命名物品');
                self::num($row, 'price', 0);
                $row = self::stamp($row, $now, true);
                break;

            case 'subscriptions':
                $row['categoryId']    = self::str($row, 'categoryId', 'cs0');
                $row['icon']          = self::str($row, 'icon', 'credit-card');
                $row['currency']      = self::str($row, 'currency', 'CNY');
                $row['type']          = self::pick($row, 'type', array('recurring', 'lifetime'), 'recurring');
                $row['period']        = self::pick($row, 'period', array('month', 'year', 'week'), 'month');
                $row['name']          = self::str($row, 'name', '未命名订阅');
                $row['status']        = self::str($row, 'status', 'active');
                self::num($row, 'every', 1);
                self::num($row, 'amount', 0);
                $row['autoRenew'] = self::bool($row, 'autoRenew', true);
                // remind 恒为对象且必有 renewLead（前端订阅页直接读 s.remind.renewLead）
                $remind = isset($row['remind']) && is_array($row['remind']) ? $row['remind'] : array();
                if (!isset($remind['renewLead']) || !is_numeric($remind['renewLead'])) {
                    $remind['renewLead'] = 3;
                }
                $row['remind'] = $remind;
                $row = self::stamp($row, $now, true);
                break;

            case 'bills':
                $row['currency'] = self::str($row, 'currency', 'CNY');
                $row['status']   = self::pick($row, 'status', array('paid', 'pending', 'skipped', 'failed'), 'pending');
                $row['subId']    = self::str($row, 'subId', '');
                self::num($row, 'amount', 0);
                $row = self::stamp($row, $now, false);
                break;

            case 'valueRecords':
                $row['type']       = self::pick($row, 'type', array('expense', 'income'), 'expense');
                $row['currency']   = self::str($row, 'currency', 'CNY');
                $row['categoryId'] = self::str($row, 'categoryId', 'cl0');
                // judgement 默认口径与 GF_AiSchema::judgement('') 一致 = xu；中文/自定义值由 AI 层归一
                $row['judgement'] = self::str($row, 'judgement', 'xu');
                self::num($row, 'amount', 0);
                // ★历史行为：旧加固对 valueRecords 不补 createdAt（AI 记账由客户端落库时补），保持不变
                break;

            case 'moods':
                $row['feeling'] = self::str($row, 'feeling', '');
                $row['text']    = self::str($row, 'text', '');
                $row['crushed'] = self::bool($row, 'crushed', false);
                $row['inHeart'] = self::bool($row, 'inHeart', false);
                $row['date']    = self::str($row, 'date', '');
                break;

            case 'times':
                $row['tags']    = self::arr($row, 'tags');
                $row['meaning'] = self::str($row, 'meaning', 'xu');
                $row['date']    = self::str($row, 'date', '');
                self::num($row, 'durationMin', 0);
                break;

            case 'wishlist':
                $row['reasons'] = self::arr($row, 'reasons');
                $row['name']    = self::str($row, 'name', '');
                $row = self::stamp($row, $now, false);
                break;

            case 'cooldowns':
                $row['name']   = self::str($row, 'name', '');
                $row['until']  = self::str($row, 'until', '');
                $row = self::stamp($row, $now, false);
                break;

            case 'categories':
                $row['name']  = self::str($row, 'name', '未命名分类');
                $row['kind']  = self::pick($row, 'kind', array('ledger', 'goods', 'sub'), 'ledger');
                $row['icon']  = self::str($row, 'icon', 'tag');
                if (!isset($row['order']) || !is_numeric($row['order'])) {
                    $row['order'] = 99;
                } else {
                    $row['order'] = (int) $row['order'];
                }
                break;

            case 'usageRecords':
                $row['goodsId'] = self::str($row, 'goodsId', '');
                $row['date']    = self::str($row, 'date', '');
                $row = self::stamp($row, $now, false);
                break;

            case 'reminders':
                $row['kind']  = self::pick($row, 'kind', array('goods_warranty', 'sub_renew'), 'goods_warranty');
                $row['refId'] = self::str($row, 'refId', '');
                $row['at']    = self::str($row, 'at', '');
                $row['done']  = self::bool($row, 'done', false);
                $row = self::stamp($row, $now, false);
                break;

            case 'walls':
                $row['text'] = self::str($row, 'text', '');
                $row = self::stamp($row, $now, false);
                break;
        }
        return $row;
    }

    /* ==========================================================
     * ★图片归一化：各种输入 → 前端唯一认的形态
     * ========================================================== */

    /**
     * 归一化一行里的图片字段（就地返回新行，原行不动）。
     *
     * 集合 → 字段 / 缺省策略：
     *   goods          image 对象，缺省补 {source:system, ref:'📦'}
     *   valueRecords   image 对象，只有 read 才补 system（写入缺省不写）
     *   subscriptions  image 对象（schema 里声明了 image），缺省不补
     *   wishlist       image 字符串（img:dataURL / url:https:// / brand:xxx）
     *   cooldowns      image 字符串（同上；历史数据里也混有对象形态，一并归一）
     */
    public static function normalizeImageField($collection, $row, $when = 'read', &$warnings = null)
    {
        if (!is_array($warnings)) {
            $warnings = array();
        }
        $objectField = in_array($collection, array('goods', 'valueRecords', 'subscriptions'), true);
        $stringField = in_array($collection, array('wishlist', 'cooldowns'), true);
        if (!$objectField && !$stringField) {
            return $row;
        }

        $raw = array_key_exists('image', $row) ? $row['image'] : null;

        if ($objectField) {
            $img = self::image($raw, $warnings, $when === 'read' ? self::IMAGE_FALLBACK : null);
            if ($img === null) {
                unset($row['image']);
            } else {
                $row['image'] = $img;
            }
            return $row;
        }

        // 心愿 / 冷静期：存字符串三形态
        $s = self::imageString($raw, $warnings, $when === 'read' ? self::IMAGE_FALLBACK : null);
        if ($s === null) {
            unset($row['image']);
        } else {
            $row['image'] = $s;
        }
        return $row;
    }

    /**
     * ★核心：把任意图片输入归一成 `{source, ref}`（前端 goodsIconValue 唯一认的形态）。
     *
     * | 输入                                              | 输出                                          |
     * |---------------------------------------------------|-----------------------------------------------|
     * | {"source":"base64","ref":"/9j/4AA..."}（裸 base64）| {source:"local", ref:"data:image/jpeg;base64,…"} |
     * | "/9j/4AA..."（字符串裸 base64）                    | {source:"local", ref:"data:image/jpeg;base64,…"} |
     * | "data:image/png;base64,iVBOR…"                     | {source:"local", ref:<原样>}                  |
     * | {"source":"url","ref":"https://..."}              | {source:"web",   ref:"https://..."}           |
     * | "https://..."                                     | {source:"web",   ref:"https://..."}           |
     * | ["base64","/9j/4AA..."]（数组）                    | 取第一个有效元素按上面规则处理                |
     * | {"source":"system","ref":"📦"}                    | 原样保留                                      |
     * | {"source":"brand","ref":"brand:apple.com"}        | 原样保留                                      |
     * | null / {} / "" / 缺省                              | $fallback（默认 null = 不写 image）           |
     *
     * 图片类型**按 base64 解码后的魔数识别**，绝不一律写 jpeg：
     *   FF D8 FF → jpeg；89 50 4E 47 → png；47 49 46 38 → gif；
     *   RIFF????WEBP → webp；42 4D → bmp；00 00 01 00 → ico；<svg → svg（svg 一律不当图，防 XSS）。
     *
     * 超过 IMAGE_MAX_BYTES 的图片：**拒绝（返回 null）并记 warning**，不截断（截断必坏图）。
     *
     * @param mixed $input
     * @param array $warnings 引用
     * @param array|null $fallback 无法识别时的兜底（null = 不写）
     * @return array|null
     */
    public static function image($input, &$warnings = null, $fallback = null)
    {
        if (!is_array($warnings)) {
            $warnings = array();
        }

        // ① 对象形态 {source, ref}：优先识别（不能先扁平化，否则会把 source 当成图片内容）
        if (is_array($input)) {
            if (array_key_exists('source', $input) || array_key_exists('ref', $input)) {
                return self::fromShape($input, $warnings, $fallback);
            }
            // ② 其它数组：递归扁平，取第一个「有效」元素
            foreach (self::flatten($input) as $one) {
                $img = self::image($one, $warnings, null);
                if ($img !== null) {
                    return $img;
                }
            }
            return self::fallback($fallback);
        }
        if (!is_string($input)) {
            return self::fallback($fallback);
        }

        $s = trim($input);
        /* ★v1.7.7 修复线上 11 条物品：历史数据可能是一条**被双重 JSON 编码的字符串**
         * （`"{\"source\":\"base64\",\"ref\":\"/9j/4AAQ...\"}"`）—— 注意 trim() 只去空白，
         * 外层那对引号必须自己剥，剥完再 json_decode 才是「内层 JSON 对象」；
         * 而且必须在体积校验**之前**解开，否则光看外壳长度会误判「图片过大」。 */
        $candidates = array($s);
        if (strlen($s) > 2 && $s[0] === '"' && substr($s, -1) === '"') {
            $unquoted = substr($s, 1, -1);
            $candidates[] = str_replace(array('\\"', '\\\\'), array('"', '\\'), $unquoted);
            $candidates[] = $unquoted; // 万一外层本来就是 JSON 里的转义文本
        }
        foreach ($candidates as $probe) {
            $probe = trim($probe);
            if (strlen($probe) < 3 || ($probe[0] !== '{' && $probe[0] !== '[')) {
                continue;
            }
            $decoded = json_decode($probe, true);
            if (is_array($decoded)) {
                return self::image($decoded, $warnings, $fallback);
            }
        }

        // 外壳去掉后可能变成空：{ } 之类 → 兜底
        if ($s === '' || $s === '[]' || $s === '{}' || $s === 'null') {
            return self::fallback($fallback);
        }
        // 裸的形态提示词（"base64" / "url"…）不是图片内容，直接忽略
        if (self::isHintWord($s)) {
            return self::fallback($fallback);
        }

        // ② dataURL：前端认 data: 前缀 → source 归 local（原样保留 ref）
        if (preg_match('#^data:#i', $s)) {
            return self::localFromDataUrl($s, $warnings, $fallback);
        }
        /* ★v1.7.7 云端化：`cloud:` 前缀 / 裸 `/api/user/images/<sha>` / 绝对同站 URL
         * 一律保持**云端引用**，绝不回落 system emoji —— 否则图片会被静默替换成 📦，
         * 备份与同步里就再也看不到真实图片了（这是云端化与实体归一化之间的接口约定）。 */
        if (self::looksCloudRef($s)) {
            return self::cloudFromString($s);
        }
        // ③ 带前缀的三形态（客户端的 img: / url:）
        if (stripos($s, 'img:') === 0) {
            $body = trim(substr($s, 4));
            if (preg_match('#^data:#i', $body)) {
                return self::localFromDataUrl($body, $warnings, $fallback);
            }
            return self::image($body, $warnings, $fallback);
        }
        if (stripos($s, 'url:') === 0) {
            $body = trim(substr($s, 4));
            return self::image($body, $warnings, $fallback);
        }
        if (stripos($s, 'brand:') === 0) {
            return array('source' => 'brand', 'ref' => $s);
        }
        // ④ 网络直链 → web（ref 存裸 URL，与 v1.0.29 约定一致）
        if (preg_match('#^https?://#i', $s)) {
            if (strlen($s) > 2000) {
                $warnings[] = '图片 URL 过长（>2000 字符），已忽略该图片';
                return self::fallback($fallback);
            }
            return array('source' => 'web', 'ref' => $s);
        }
        // ⑤ 裸 base64 → local + dataURL（★线上事故点）
        if (self::looksBase64($s)) {
            return self::localFromBase64($s, $warnings, $fallback);
        }
        // ⑥ 其它裸字符串：按客户端「裸 lucide id」约定当内置图标（source=builtin）
        if (preg_match('#^[a-z][a-z0-9\-]{0,59}$#i', $s)) {
            return array('source' => 'builtin', 'ref' => $s);
        }
        // ⑦ 单个 emoji / 很短的文本（含「充电器」这类纯中文）：当系统图标
        if (mb_strlen($s, 'UTF-8') <= 8) {
            return array('source' => 'system', 'ref' => $s);
        }
        $warnings[] = '图片内容无法识别（既不是 base64、也不是 http(s) 或 data: URL），已忽略该图片';
        return self::fallback($fallback);
    }

    /**
     * 图片归一化后转回**字符串三形态**（wishlist / cooldowns 的 image 字段就这样存）：
     *   local   → `img:<dataURL>`
     *   web     → `url:<https://…>`
     *   brand   → 原样（已带 brand:）
     *   其它    → ref 原样（system emoji / builtin lucide id）
     *
     * @return string|null
     */
    public static function imageString($input, &$warnings = null, $fallback = null)
    {
        $img = self::image($input, $warnings, $fallback);
        return $img === null ? null : self::toIconString($img);
    }

    /** {source, ref} → 客户端 icon 字符串（与 app/src/lib/goodsIcon.ts 的 goodsIconValue 互逆）。 */
    public static function toIconString($img)
    {
        if (!is_array($img) || !isset($img['ref'])) {
            return null;
        }
        $ref = (string) $img['ref'];
        $src = isset($img['source']) ? (string) $img['source'] : '';
        if ($src === 'local') {
            return 'img:' . $ref;
        }
        if ($src === 'web') {
            return 'url:' . $ref;
        }
        if ($src === 'brand') {
            return strpos($ref, 'brand:') === 0 ? $ref : 'brand:' . $ref;
        }
        return $ref;
    }

    /* ==========================================================
     * 图片内部工具
     * ========================================================== */

    /** 兜底形态：null / 空数组 / 非 {source,ref} 对象一律走这里。 */
    private static function fallback($fallback)
    {
        if (is_array($fallback) && isset($fallback['source'], $fallback['ref'])) {
            return array('source' => (string) $fallback['source'], 'ref' => (string) $fallback['ref']);
        }
        return null;
    }

    /**
     * 对象形态 `{source, ref}` 的归一（★AI 最爱传这几种写法）。
     *
     * 老 schema 里写的 `source: base64 / url / upload` 一律按**内容**重新判定：
     *   source=base64 + 裸 base64  → local + dataURL（★线上 11 条物品的真实形态）
     *   source=url / upload + http → web
     *   source=local               → 非 data: 的 ref 补 dataURL 前缀
     *   source=system              → 原样（emoji 图标）
     *   source=brand               → 原样
     *   source=builtin             → 原样（lucide id）
     */
    private static function fromShape($shape, &$warnings, $fallback)
    {
        $ref = isset($shape['ref']) ? $shape['ref'] : null;
        if (is_array($ref)) {
            return self::image($ref, $warnings, $fallback);
        }
        $src = isset($shape['source']) && is_string($shape['source']) ? strtolower(trim($shape['source'])) : '';
        $refStr = is_string($ref) ? trim($ref) : (is_scalar($ref) ? trim((string) $ref) : '');

        if ($refStr === '') {
            return self::fallback($fallback);
        }

        /* ★v1.7.7 云端图：{source:'cloud', ref, sha256} —— 必须原样保住，不能被
         * default 分支当成「无法识别」而回落 system emoji。sha256 透传给客户端，
         * 用于差异上传比对与 URL 重签。 */
        if ($src === 'cloud' || self::looksCloudRef($refStr)) {
            $img = self::cloudFromString($refStr);
            if ($img !== null) {
                if (isset($shape['sha256']) && is_string($shape['sha256']) && preg_match('/^[0-9a-f]{64}$/i', $shape['sha256'])) {
                    $img['sha256'] = strtolower($shape['sha256']);
                }
                return $img;
            }
        }

        switch ($src) {
            case 'system':
                return array('source' => 'system', 'ref' => $refStr);
            case 'brand':
                return array('source' => 'brand', 'ref' => strpos($refStr, 'brand:') === 0 ? $refStr : 'brand:' . $refStr);
            case 'builtin':
                return array('source' => 'builtin', 'ref' => $refStr);
            case 'local':
                // source 已经是前端枚举，但 ref 可能还是裸 base64（旧客户端会这么存）
                if (preg_match('#^data:#i', $refStr)) {
                    return self::localFromDataUrl($refStr, $warnings, $fallback);
                }
                if (preg_match('#^https?://#i', $refStr)) {
                    return array('source' => 'web', 'ref' => $refStr);
                }
                if (self::looksBase64($refStr)) {
                    return self::localFromBase64($refStr, $warnings, $fallback);
                }
                return array('source' => 'local', 'ref' => $refStr);
            default:
                // base64 / url / upload / web / img / 空 source：全部按内容判定
                return self::image($refStr, $warnings, $fallback);
        }
    }

    /**
     * 是否「云端图片引用」（★v1.7.7 云端化约定）。
     * 认四种写法：`cloud:<url>`、裸 `/api/user/images/<sha>`、同站绝对 URL、裸 64 位 sha256。
     */
    public static function looksCloudRef($s)
    {
        $s = trim((string) $s);
        if ($s === '') {
            return false;
        }
        if (stripos($s, 'cloud:') === 0) {
            return true;
        }
        if (preg_match('#^[0-9a-f]{64}$#i', $s)) {
            return true;
        }
        return (bool) preg_match('#/api/user/images/[0-9a-f]{64}#i', $s);
    }

    /**
     * 云端引用 → 标准形态 `{source:'cloud', ref:'/api/user/images/<sha>', sha256:'<sha>'}`。
     * 只保留相对路径（换域名/换服务器不失效），认不出 sha 时保留原始 ref 但仍标 cloud，
     * **绝不回落 system emoji** —— 宁可让图片加载失败，也不能把用户照片静默换成 📦。
     *
     * @return array|null
     */
    public static function cloudFromString($s)
    {
        $s = trim((string) $s);
        if (stripos($s, 'cloud:') === 0) {
            $s = trim(substr($s, 6));
        }
        if (stripos($s, 'url:') === 0) {
            $s = trim(substr($s, 4));
        }
        $sha = '';
        if (preg_match('#^[0-9a-f]{64}$#i', $s)) {
            $sha = strtolower($s);
        } elseif (preg_match('#/api/user/images/([0-9a-f]{64})#i', $s, $m)) {
            $sha = strtolower($m[1]);
        }
        if ($sha === '') {
            if ($s === '') {
                return null;
            }
            return array('source' => 'cloud', 'ref' => $s);
        }
        return array(
            'source' => 'cloud',
            'ref'    => '/api/user/images/' . $sha,
            'sha256' => $sha,
        );
    }

    /** 递归扁平化：把 ["base64", "<图片>"] / 嵌套数组统一摊开。 */
    private static function flatten($input)
    {
        $out = array();
        foreach ((array) $input as $v) {
            if (is_array($v)) {
                if (array_key_exists('source', $v) || array_key_exists('ref', $v)) {
                    // 先判断「是不是形态提示词」—— 是就跳过，否则把整个对象交给 image() 判定
                    $refStr = isset($v['ref']) && is_string($v['ref']) ? trim($v['ref']) : '';
                    $srcStr = isset($v['source']) && is_string($v['source']) ? strtolower(trim($v['source'])) : '';
                    if ($refStr === '' || self::isHintWord($srcStr)) {
                        continue;
                    }
                    $out[] = $v;
                    continue;
                }
                foreach (self::flatten($v) as $one) {
                    $out[] = $one;
                }
            } else {
                $out[] = $v;
            }
        }
        return $out;
    }

    /** 是不是「形态提示词」而非图片数据（AI 常写 ["base64", "<裸base64>"] 这种结构）。 */
    private static function isHintWord($s)
    {
        static $hints = array(
            'base64' => true, 'b64' => true, 'dataurl' => true, 'data' => true, 'raw' => true,
            'string' => true, 'str' => true, 'url' => true, 'http' => true, 'https' => true,
            'link' => true, 'image' => true, 'img' => true, 'photo' => true, 'picture' => true,
            'upload' => true, 'file' => true,
        );
        return is_string($s) && isset($hints[strtolower(trim($s))]);
    }

    /** 裸 base64 判定：去掉空白后 ≥ 40 字符、字符集合法、可解码。 */
    private static function looksBase64($s)
    {
        $compact = preg_replace('/\s+/', '', $s);
        if (!is_string($compact) || strlen($compact) < 40) {
            return false;
        }
        if (!preg_match('#^[A-Za-z0-9+/]+={0,2}$#', $compact)) {
            return false;
        }
        return base64_decode($compact, true) !== false;
    }

    /**
     * 裸 base64 → `{source:local, ref:data:image/<真实类型>;base64,<原串>}`。
     * ★类型必须从解码后的魔数判定 —— 一律写 jpeg 会让 png/webp/gif 在部分浏览器渲染失败。
     */
    private static function localFromBase64($compact, &$warnings, $fallback)
    {
        $compact = preg_replace('/\s+/', '', (string) $compact);
        if (strlen($compact) > self::IMAGE_MAX_STRING) {
            $warnings[] = self::tooBigMsg();
            return self::fallback($fallback);
        }
        $bin = base64_decode($compact, true);
        if ($bin === false || $bin === '') {
            $warnings[] = '图片 base64 无法解码，已忽略该图片';
            return self::fallback($fallback);
        }
        if (strlen($bin) > self::IMAGE_MAX_BYTES) {
            $warnings[] = self::tooBigMsg();
            return self::fallback($fallback);
        }
        $mime = self::sniff($bin);
        if ($mime === null) {
            $warnings[] = '图片内容不是可识别的位图格式（jpeg/png/gif/webp/bmp/ico），已忽略该图片';
            return self::fallback($fallback);
        }
        return array('source' => 'local', 'ref' => 'data:' . $mime . ';base64,' . $compact);
    }

    /** 已是 dataURL：原样保留 ref（只补 source=local），同时做体积 / 类型校验。 */
    private static function localFromDataUrl($s, &$warnings, $fallback)
    {
        if (strpos($s, ',') === false) {
            $warnings[] = '图片 dataURL 缺少数据段（没有逗号），已忽略该图片';
            return self::fallback($fallback);
        }
        if (strlen($s) > self::IMAGE_MAX_STRING) {
            $warnings[] = self::tooBigMsg();
            return self::fallback($fallback);
        }
        $head = strtolower(substr($s, 0, (int) strpos($s, ',')));
        if (strpos($head, ';base64') !== false) {
            // base64 段：解码前 16 字节做大小估算与类型嗅探
            $b64 = substr($s, (int) strpos($s, ',') + 1);
            $b64 = preg_replace('/\s+/', '', (string) $b64);
            if (strlen($b64) > self::IMAGE_MAX_STRING) {
                $warnings[] = self::tooBigMsg();
                return self::fallback($fallback);
            }
            $probe = base64_decode(substr($b64, 0, 24), true);
            if ($probe === false || $probe === '') {
                $warnings[] = '图片 dataURL 的 base64 段无法解码，已忽略该图片';
                return self::fallback($fallback);
            }
            $bytes = (int) floor(strlen($b64) * 3 / 4);
            if ($bytes > self::IMAGE_MAX_BYTES) {
                $warnings[] = self::tooBigMsg();
                return self::fallback($fallback);
            }
            $mime = self::sniff($probe);
            if ($mime === null || $mime === 'image/svg+xml') {
                $warnings[] = '图片内容不是可识别的位图格式（jpeg/png/gif/webp/bmp/ico），已忽略该图片';
                return self::fallback($fallback);
            }
            return array('source' => 'local', 'ref' => $s);
        }
        // 非 base64 的 dataURL（如 data:image/svg+xml;<svg…>）：SVG 可能内嵌脚本，一律不收
        if (strpos($head, 'image/') !== 0 || strpos($head, 'svg') !== false) {
            $warnings[] = '图片 dataURL 类型不受支持（只接受位图 base64），已忽略该图片';
            return self::fallback($fallback);
        }
        return array('source' => 'local', 'ref' => $s);
    }

    /**
     * 按魔数识别真实图片类型（不依赖 getimagesize / GD —— 线上 PHP 未必有 GD）。
     *
     * @param string $bin 图片字节串的前若干字节
     * @return string|null MIME（image/svg+xml 表示 SVG，调用方应拒绝），无法识别返回 null
     */
    public static function sniff($bin)
    {
        if (!is_string($bin) || strlen($bin) < 4) {
            return null;
        }
        if (strncmp($bin, "\xFF\xD8\xFF", 3) === 0) {
            return 'image/jpeg';
        }
        if (strncmp($bin, "\x89PNG\r\n\x1A\n", 8) === 0) {
            return 'image/png';
        }
        if (strncmp($bin, 'GIF8', 4) === 0) {
            return 'image/gif';
        }
        if (strlen($bin) >= 12 && strncmp($bin, 'RIFF', 4) === 0 && substr($bin, 8, 4) === 'WEBP') {
            return 'image/webp';
        }
        if (strncmp($bin, 'BM', 2) === 0) {
            return 'image/bmp';
        }
        if (strncmp($bin, "\x00\x00\x01\x00", 4) === 0) {
            return 'image/x-icon';
        }
        $head = ltrim($bin);
        if (stripos($head, '<svg') === 0 || stripos($head, '<?xml') === 0) {
            return 'image/svg+xml';
        }
        return null;
    }

    private static function tooBigMsg()
    {
        return '图片过大（上限 ' . self::maxImageKb() . 'KB，base64 字符串 ' . self::IMAGE_MAX_STRING
            . ' 字符），已拒绝该图片但保留其它字段';
    }

    /** 前端 / 文档展示用：上限 KB。 */
    public static function maxImageKb()
    {
        return (int) round(self::IMAGE_MAX_BYTES / 1024);
    }

    /* ==========================================================
     * 字段小工具（只补「缺失或类型不对」，绝不覆盖合法值）
     * ========================================================== */

    /** 数组字段：缺失 / 非数组 → array()。 */
    private static function arr($row, $key)
    {
        return (isset($row[$key]) && is_array($row[$key])) ? $row[$key] : array();
    }

    /** 字符串字段：缺失 / null / 数组 / 空串 → $def；数字转字符串。 */
    private static function str($row, $key, $def)
    {
        if (!isset($row[$key]) || $row[$key] === '' || is_array($row[$key]) || is_bool($row[$key])) {
            return $def;
        }
        return (string) $row[$key];
    }

    /** 枚举字段：值在 $allowed 里才保留，否则 $def。 */
    private static function pick($row, $key, $allowed, $def)
    {
        $v = self::str($row, $key, '');
        return in_array($v, $allowed, true) ? $v : $def;
    }

    /** 布尔字段：真布尔/数字/字符串 'true' 都认；缺失 → $def。 */
    private static function bool($row, $key, $def)
    {
        if (!array_key_exists($key, $row) || $row[$key] === null) {
            return $def;
        }
        $v = $row[$key];
        if (is_bool($v)) {
            return $v;
        }
        if (is_numeric($v)) {
            return ((float) $v) != 0;
        }
        if (is_string($v)) {
            $s = strtolower(trim($v));
            if (in_array($s, array('1', 'true', 'on', 'yes'), true)) {
                return true;
            }
            if (in_array($s, array('0', 'false', 'off', 'no'), true)) {
                return false;
            }
        }
        return $def;
    }

    /** 数值字段：缺失 / 非数字 → $def（就地写回）；已是数字原样。 */
    private static function num(&$row, $key, $def)
    {
        if (!array_key_exists($key, $row) || $row[$key] === null || $row[$key] === '') {
            $row[$key] = $def;
            return;
        }
        if (is_numeric($row[$key])) {
            return;
        }
        if (is_array($row[$key])) {
            $row[$key] = $def;
        }
    }

    /** createdAt（+ updatedAt）时间戳：只补缺失，不覆盖。 */
    private static function stamp($row, $now, $withUpdated)
    {
        if (!isset($row['createdAt']) || !is_string($row['createdAt']) || $row['createdAt'] === '') {
            $row['createdAt'] = $now;
        }
        if ($withUpdated && (!isset($row['updatedAt']) || !is_string($row['updatedAt']) || $row['updatedAt'] === '')) {
            $row['updatedAt'] = $now;
        }
        return $row;
    }

    /** ISO 8601 UTC，与客户端 createdAt/updatedAt 同口径。 */
    public static function nowISO()
    {
        return gmdate('Y-m-d\TH:i:s\Z');
    }
}