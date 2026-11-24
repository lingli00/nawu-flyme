<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * ★v1.6.6 · AI 通用数据平面（字段字典 / 归一化 / 自定义功能 / OpenAPI 生成）
 *
 * 设计目标：让外部智能体「能调用用户所设置的一切，并能添加任意功能」。
 *   · 12 个集合、每个字段都有自描述（类型 / 含义 / 示例 / 枚举 / 默认值）；
 *   · 任意集合都允许附加自定义字段（additionalFields = true），不丢字段；
 *   · 归需选项、分类、自定义字段、自定义动作都可由 API 增删；
 *   · 自定义动作用 {{param}} 模板渲染成写入操作，等于让 AI 自己扩展功能。
 *
 * 本文件只做「描述与纯计算」，不碰数据库；所有存储由 GF_Ai 负责。
 *
 * ★v1.7.7：行级归一化下沉到 GF_EntityNormalize（实体级默认字段 + 图片归一化），
 *   本文件的 normalizeRow() 只负责 AI 侧的语义（id / 归需 / 类型转换），最后由它兜底。
 */
require_once dirname(__FILE__) . '/EntityNormalize.php';

class GF_AiSchema
{
    /** 12 个集合（与 app/src/types/entities.ts COLLECTIONS 严格一致，顺序也一致）。 */
    const COLLECTIONS = array(
        'goods', 'subscriptions', 'bills', 'valueRecords', 'moods', 'times',
        'wishlist', 'cooldowns', 'categories', 'usageRecords', 'reminders', 'walls',
    );

    /** 集合 id 前缀（与客户端 newId 同口径，便于生成可读 id）。 */
    const ID_PREFIX = array(
        'goods' => 'g', 'subscriptions' => 's', 'bills' => 'b', 'valueRecords' => 'vr',
        'moods' => 'm', 'times' => 't', 'wishlist' => 'w', 'cooldowns' => 'cd',
        'categories' => 'cu', 'usageRecords' => 'ur', 'reminders' => 'r', 'walls' => 'wl',
    );

    /** 字段构造助手。 */
    private static function F($type, $label, $extra = array())
    {
        return array_merge(array('type' => $type, 'label' => $label), $extra);
    }

    /**
     * 全量字段字典。
     * 说明里的「用户说的」对应products需求：物品 / 备注 / 手续费 / 图片 / 日期 /
     * 截止时间 / 每个月多少钱 / 订阅图片 / 归需 / 分类。
     */
    public static function collections($customFields = array())
    {
        $money = array('example' => 35, 'minimum' => 0);
        $date = array('format' => 'YYYY-MM-DD', 'example' => '2026-11-10');
        $iso = array('format' => 'ISO 8601', 'readOnly' => true);

        $def = array(
            'goods' => array(
                'label' => '物品库',
                'description' => '买过的耐用品。可以写名称、价格、日期、备注、手续费、图片与任意自定义字段。',
                'fields' => array(
                    'id' => self::F('string', '物品 ID', array('readOnly' => true, 'example' => 'g_m1abc')),
                    'name' => self::F('string', '物品名称', array('required' => true, 'example' => '索尼 WH-1000XM5')),
                    'categoryId' => self::F('string', '物品分类 ID', array('example' => 'cg0', 'note' => '见 /api/ai/categories?kind=goods')),
                    'tags' => self::F('array<string>', '标签', array('example' => array('通勤', '降噪'))),
                    'price' => self::F('number', '购入价格', array_merge($money, array('required' => true))),
                    'currency' => self::F('string', '币种', array('default' => 'CNY', 'example' => 'CNY')),
                    'buyDate' => self::F('string', '购入日期', $date),
                    'status' => self::F('string', '状态', array('enum' => array('active', 'retired', 'favorite'), 'default' => 'active')),
                    'image' => self::F('object', '物品图片（实物图）', array(
                        'example' => array('source' => 'cloud', 'ref' => '/api/user/images/<sha256>'),
                        'note' => '★必须是实物图，不能拿订单图 / 商品宣传图代替 —— 用户明确要求「物品必须上传实物图，'
                            . '没有就问用户要」。取图链路：① 用户发的图 → POST /api/user/images（JSON `{image:"<dataURL 或裸 base64>"}`，'
                            . '或二进制 body + Content-Type: image/*）→ 返回 `{sha256, url:"/api/user/images/<sha>?t=&s="}`；'
                            . '② 把 `{source:"cloud", ref:"/api/user/images/<sha256>"}`（也可带 sha256 字段）写进 goods.image。'
                            . '也支持 {source:"web",ref:"https://…"} 直链、裸 base64（自动补 dataURL）、dataURL、img:/url:/brand: 前缀。'
                            . '单体图片上限 2MB（约 2.7MB 字符串），超限整条图片被拒并回 warning，其它字段照常写入。'
                            . '★没有实物图就不要编 —— 先向用户要，或留空（读回时补 📦 占位）。',
                    )),
                    'note' => self::F('string', '备注', array('example' => '双十一入手，送了个收纳盒')),
                    'extraFees' => self::F('array<object>', '附加费用 / 手续费', array(
                        'example' => array(array('name' => '运费', 'amount' => 12), array('name' => '手续费', 'amount' => 3.5)),
                        'note' => '每项 {name,amount}；会计入物品总投入与日均成本。',
                    )),
                    'feeRatePermille' => self::F('number', '手续费费率（千分比）', array('example' => 21, 'note' => '2.1% 填 21；转卖时按售价折算手续费')),
                    'incomes' => self::F('array', '转卖/回本记录'),
                    'sellPrice' => self::F('number', '转卖价', $money),
                    'targetDailyCost' => self::F('number', '目标日均成本', $money),
                    'countEnabled' => self::F('boolean', '启用使用次数'),
                    'totalCount' => self::F('number', '预计使用次数'),
                    'usedCount' => self::F('number', '已使用次数'),
                    'warrantyDate' => self::F('string', '保修截止日期', $date),
                    'warrantyRemind' => self::F('object', '保修提醒', array('example' => array('on' => true, 'leadDays' => 7, 'time' => '09:00'))),
                    'createdAt' => self::F('string', '创建时间', $iso),
                    'updatedAt' => self::F('string', '更新时间', $iso),
                ),
            ),
            'subscriptions' => array(
                'label' => '订阅',
                'description' => '周期性扣款。「每个月多少钱」= amount + period:month + every:1；也支持季/年/周与到期日。',
                'fields' => array(
                    'id' => self::F('string', '订阅 ID', array('readOnly' => true)),
                    'name' => self::F('string', '订阅名称', array('required' => true, 'example' => '腾讯视频月卡')),
                    'categoryId' => self::F('string', '订阅分类 ID', array('example' => 'cs0', 'note' => '见 /api/ai/categories?kind=sub')),
                    'icon' => self::F('string', '订阅图标', array(
                        'example' => 'brand:bilibili',
                        'note' => '四种合法形态（优先级从高到低）：'
                            . '① `brand:<slug>` 内置品牌引用码（最轻，备份只带几个字节，客户端即时绘制）；'
                            . '② `url:<https 图标地址>` 网络图标；'
                            . '③ 站内路径 `/brand-icons/<域名>.png`（177 张随包品牌图，离线可用）；'
                            . '④ 裸 lucide id（如 `credit-card`）或单个 emoji。'
                            . '★不要靠猜 slug —— 先用 GET /api/ai/icons?q=<订阅名> 查，'
                            . '命中后取 `matched.write` 原样写入即可（内置 192 品牌 + 182 条域名，零外网）。'
                            . '缺省补 `credit-card`。',
                    )),
                    'image' => self::F('object', '订阅图片', array('example' => array('source' => 'url', 'ref' => 'https://example.com/logo.png'), 'note' => '同物品图片：字符串输入会自动归一成 {source,ref}。'
                        . '★订阅一般不需要用户传图 —— 优先用 `icon` 字段（先查 /api/ai/icons），别向用户索要订阅 logo。')),
                    'currency' => self::F('string', '币种', array('default' => 'CNY')),
                    'type' => self::F('string', '类型', array('enum' => array('recurring', 'lifetime'), 'default' => 'recurring')),
                    'period' => self::F('string', '周期', array('enum' => array('month', 'year', 'week'), 'default' => 'month')),
                    'every' => self::F('number', '每 N 个周期扣一次', array('default' => 1, 'example' => 1)),
                    'amount' => self::F('number', '每期金额（如「每个月多少钱」）', array_merge($money, array('required' => true, 'example' => 25))),
                    'startDate' => self::F('string', '开始日期', $date),
                    'nextRenewDate' => self::F('string', '下次扣款日', $date),
                    'endDate' => self::F('string', '截止 / 到期日', array_merge($date, array('note' => '自定义字段：到期后不再续订'))),
                    'autoRenew' => self::F('boolean', '自动续订', array('default' => true)),
                    'initSpent' => self::F('number', '已投入', $money),
                    'status' => self::F('string', '状态', array('default' => 'active')),
                    'remind' => self::F('object', '续费提醒', array('example' => array('renewLead' => 3))),
                    'note' => self::F('string', '备注'),
                    'createdAt' => self::F('string', '创建时间', $iso),
                    'updatedAt' => self::F('string', '更新时间', $iso),
                ),
            ),
            'bills' => array(
                'label' => '订阅账单',
                'description' => '每一期扣款流水，含截止时间（dueDate）与四态。',
                'fields' => array(
                    'id' => self::F('string', '账单 ID', array('readOnly' => true)),
                    'subId' => self::F('string', '所属订阅 ID', array('required' => true)),
                    'dueDate' => self::F('string', '扣款截止日期', array_merge($date, array('required' => true))),
                    'amount' => self::F('number', '金额', $money),
                    'currency' => self::F('string', '币种', array('default' => 'CNY')),
                    'status' => self::F('string', '状态', array('enum' => array('paid', 'pending', 'skipped', 'failed'), 'default' => 'pending')),
                    'paidDate' => self::F('string', '实付日期', $date),
                    'refund' => self::F('number', '退款', $money),
                    'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'valueRecords' => array(
                'label' => '生活流',
                'description' => '每一笔收支。judgement 即「是否归需」，值可用自定义选项（见 /api/ai/options）。',
                'fields' => array(
                    'id' => self::F('string', '记录 ID', array('readOnly' => true)),
                    'type' => self::F('string', '收支', array('enum' => array('expense', 'income'), 'default' => 'expense')),
                    'amount' => self::F('number', '金额', array_merge($money, array('required' => true))),
                    'currency' => self::F('string', '币种', array('default' => 'CNY')),
                    'date' => self::F('string', '业务日期', array_merge($date, array('required' => true))),
                    'categoryId' => self::F('string', '生活流分类 ID', array('example' => 'cl0', 'note' => '见 /api/ai/categories?kind=ledger；可由 API 自行新增分类')),
                    'judgement' => self::F('string', '是否归需', array(
                        'default' => 'xu', 'example' => 'xu',
                        'note' => '内置 gui(归/值得) / xu(需/必要) / fou(否/本可避免)；可用 /api/ai/options 自定义任意选项值。也接受中文「归」「需」「否」。',
                    )),
                    'note' => self::F('string', '备注', array('example' => '午饭 · 牛肉面')),
                    'image' => self::F('object', '小票 / 图片', array('example' => array('source' => 'url', 'ref' => 'https://example.com/receipt.jpg'), 'note' => '同物品图片：字符串输入会自动归一成 {source,ref}。'
                        . '★生活流一般不需要图 —— 直接识别订单图或用户口述的内容记账即可，别为了配图去要图。')),
                    'src' => self::F('string', '来源标记', array('example' => 'goods-sale')),
                    'refId' => self::F('string', '关联业务 ID（如物品 id）'),
                    'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'categories' => array(
                'label' => '分类表',
                'description' => '三类分类：ledger(生活流) / goods(物品) / sub(订阅)。可自由增删改，API 新增后立即对所有端生效。',
                'fields' => array(
                    'id' => self::F('string', '分类 ID', array('readOnly' => true, 'example' => 'cu_abc123')),
                    'name' => self::F('string', '分类名', array('required' => true, 'example' => '咖啡')),
                    'kind' => self::F('string', '归属', array('enum' => array('ledger', 'goods', 'sub'), 'required' => true)),
                    'icon' => self::F('string', '图标（lucide 名或 emoji）', array('example' => 'coffee')),
                    'order' => self::F('number', '排序', array('example' => 99)),
                ),
            ),
            'wishlist' => array(
                'label' => '心愿单',
                'description' => '想买的东西，可带价格、链接、图片、心动理由、截止时间。',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'name' => self::F('string', '名称', array('required' => true)),
                    'price' => self::F('number', '价格', $money),
                    'url' => self::F('string', '商品链接'),
                    'image' => self::F('string', '商品图（img:/url:/brand: 前缀或对象）', array('note' => '对象形态 {source,ref} 会自动转成 img:/url:/brand: 字符串，无需自行转换。')),
                    'reasons' => self::F('array<string>', '心动理由'),
                    'channel' => self::F('string', '渠道'),
                    'note' => self::F('string', '备注'),
                    'deadline' => self::F('string', '想买截止日', $date),
                    'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'cooldowns' => array(
                'label' => '冷静期',
                'description' => '冲动消费冷却，含精确截止时间 until / untilAt。',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'name' => self::F('string', '名称', array('required' => true)),
                    'until' => self::F('string', '冷静截止日', $date),
                    'untilAt' => self::F('string', '精确截止时刻', array('format' => 'ISO 8601')),
                    'hours' => self::F('number', '冷静小时数'),
                    'amount' => self::F('number', '金额', $money),
                    'reason' => self::F('string', '冲动来源'),
                    'url' => self::F('string', '链接'),
                    'image' => self::F('string', '商品图', array('note' => '同心愿单：对象形态会自动转成字符串三形态。')),
                    'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'moods' => array(
                'label' => '情绪速写',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'feeling' => self::F('string', '心情'), 'text' => self::F('string', '内容'),
                    'crushed' => self::F('boolean', '已消解'), 'inHeart' => self::F('boolean', '收藏'),
                    'date' => self::F('string', '日期', $date), 'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'times' => array(
                'label' => '时间切片',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'durationMin' => self::F('number', '时长（分钟）'), 'tags' => self::F('array<string>', '标签'),
                    'meaning' => self::F('string', '意义判定'), 'date' => self::F('string', '日期', $date),
                    'note' => self::F('string', '备注'), 'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'usageRecords' => array(
                'label' => '使用打卡',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'goodsId' => self::F('string', '物品 ID', array('required' => true)),
                    'date' => self::F('string', '日期', $date), 'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'reminders' => array(
                'label' => '提醒',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'kind' => self::F('string', '类型', array('enum' => array('goods_warranty', 'sub_renew'))),
                    'refId' => self::F('string', '关联 ID'), 'at' => self::F('string', '提醒时间'),
                    'done' => self::F('boolean', '已完成'), 'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
            'walls' => array(
                'label' => '心墙',
                'fields' => array(
                    'id' => self::F('string', 'ID', array('readOnly' => true)),
                    'text' => self::F('string', '一句话', array('required' => true)),
                    'color' => self::F('string', '颜色'), 'createdAt' => self::F('string', '创建时间', $iso),
                ),
            ),
        );

        // 用户通过 /api/ai/options 声明的自定义字段，并入对应集合的字典
        foreach ((array) $customFields as $f) {
            if (!is_array($f) || empty($f['collection']) || empty($f['name'])) {
                continue;
            }
            $c = (string) $f['collection'];
            if (!isset($def[$c])) {
                continue;
            }
            $def[$c]['fields'][(string) $f['name']] = self::F(
                isset($f['type']) ? (string) $f['type'] : 'string',
                isset($f['label']) ? (string) $f['label'] : (string) $f['name'],
                array('custom' => true, 'note' => isset($f['note']) ? (string) $f['note'] : '用户自定义字段')
            );
        }

        foreach ($def as $k => &$v) {
            if (empty($v['description'])) {
                $v['description'] = $v['label'] . '数据，可用 /api/ai/mutate 自由读写，允许附加自定义字段。';
            }
            $v['additionalFields'] = true; // 关键：任意未声明字段也原样保留，不丢数据
            $v['fieldCount'] = count($v['fields']);
        }
        unset($v);
        return $def;
    }

    /** 内置「是否归需」选项。value 必须与客户端 Judgement 枚举一致。 */
    public static function defaultJudgements()
    {
        return array(
            array('value' => 'gui', 'label' => '归 · 值得', 'aliases' => array('归', '值得', 'gui'), 'color' => 'var(--gui)', 'builtin' => true),
            array('value' => 'xu', 'label' => '需 · 必要', 'aliases' => array('需', '必要', '刚需', 'xu'), 'color' => 'var(--xu)', 'builtin' => true),
            array('value' => 'fou', 'label' => '否 · 本可避免', 'aliases' => array('否', '不值', '浪费', 'fou'), 'color' => 'var(--fou)', 'builtin' => true),
        );
    }

    /**
     * 归需值归一化：接受 gui/xu/fou、中文「归/需/否」、自定义 value / label / 别名。
     * 未知值原样保留（自定义选项），空值回退 xu。
     */
    public static function judgement($v, $options = array())
    {
        $raw = trim((string) $v);
        if ($raw === '') {
            return 'xu';
        }
        $all = array_merge(self::defaultJudgements(), (array) $options);
        foreach ($all as $o) {
            if (!is_array($o) || empty($o['value'])) {
                continue;
            }
            $val = (string) $o['value'];
            $cand = array($val);
            if (isset($o['label'])) {
                $cand[] = (string) $o['label'];
            }
            if (isset($o['aliases']) && is_array($o['aliases'])) {
                $cand = array_merge($cand, $o['aliases']);
            }
            if (in_array($raw, $cand, true)) {
                return $val;
            }
            // 「归 · 值得」这类带分隔符的标签，取首字比对
            if (isset($o['label']) && strpos((string) $o['label'], $raw) === 0) {
                return $val;
            }
        }
        return $raw;
    }

    /** 按自定义关键词规则给一句话判定归需（返回 '' 表示不覆盖）。 */
    public static function judgementByRules($text, $rules)
    {
        foreach ((array) $rules as $rule) {
            if (!is_array($rule) || empty($rule['value'])) {
                continue;
            }
            $kws = isset($rule['keywords']) ? (array) $rule['keywords'] : array();
            foreach ($kws as $kw) {
                if ((string) $kw !== '' && mb_strpos((string) $text, (string) $kw, 0, 'UTF-8') !== false) {
                    return (string) $rule['value'];
                }
            }
        }
        return '';
    }

    /**
     * 归一化一行记录：补 id/时间戳、归需归一、数值字段转数字。
     *
     * ★v1.7.7：末尾统一走 GF_EntityNormalize::row() —— 按 entities.ts 补齐 12 个集合的
     * 必填字段（goods 的 tags/extraFees/incomes、valueRecords 的 tags 等），
     * 并把各种图片输入归一成前端唯一认的 `{source,ref}`。
     * 这是「AI 写入不再产生半成品记录」的落点（线上 11 条缺字段物品的根因）。
     * 被拒绝的图片（过大 / 非法）以 warning 形式带回去，不静默吞掉。
     */
    public static function normalizeRow($collection, $row, $cfg = array(), &$warnings = null)
    {
        if (!is_array($row)) {
            return null;
        }
        if (!is_array($warnings)) {
            $warnings = array();
        }
        $row = (array) $row;
        if (empty($row['id'])) {
            $prefix = isset(self::ID_PREFIX[$collection]) ? self::ID_PREFIX[$collection] : 'x';
            $row['id'] = $prefix . '_' . bin2hex(random_bytes(8));
        }
        if ($collection === 'valueRecords') {
            $row['judgement'] = self::judgement(isset($row['judgement']) ? $row['judgement'] : 'xu', isset($cfg['judgementOptions']) ? $cfg['judgementOptions'] : array());
            $row['type'] = (isset($row['type']) && $row['type'] === 'income') ? 'income' : 'expense';
        }
        foreach (array('amount', 'price', 'sellPrice', 'initSpent', 'refund', 'totalCount', 'usedCount', 'feeRatePermille', 'every') as $n) {
            if (isset($row[$n]) && !is_array($row[$n])) {
                $row[$n] = is_numeric($row[$n]) ? $row[$n] + 0 : $row[$n];
            }
        }
        $now = gmdate('Y-m-d\TH:i:s\Z');
        if ($collection !== 'valueRecords' && empty($row['createdAt'])) {
            $row['createdAt'] = $now;
        }
        if (in_array($collection, array('goods', 'subscriptions'), true) && empty($row['updatedAt'])) {
            $row['updatedAt'] = $now;
        }
        if ($collection === 'subscriptions' && empty($row['nextRenewDate']) && !empty($row['startDate'])) {
            $p = isset($row['period']) ? $row['period'] : 'month';
            $e = isset($row['every']) ? max(1, (int) $row['every']) : 1;
            $row['nextRenewDate'] = NawuAI::nextRenew($row['startDate'], $p, $e);
        }
        // ★v1.7.7 实体级兜底：12 个集合必填字段 + 图片归一化（写入态：缺省 image 不硬塞信箱图标）
        $w = array();
        $row = GF_EntityNormalize::row($collection, $row, array('when' => 'write', 'now' => $now), $w);
        foreach ($w as $msg) {
            $warnings[] = $msg;
        }
        return $row;
    }

    /** 递归把模板里的 {{param}} 换成实际值（保留数字/布尔类型）。 */
    public static function renderTemplate($value, $params)
    {
        if (is_string($value)) {
            if (preg_match('/^\{\{\s*([\w\.]+)\s*\}\}$/', $value, $m)) {
                return isset($params[$m[1]]) ? $params[$m[1]] : '';
            }
            return preg_replace_callback('/\{\{\s*([\w\.]+)\s*\}\}/', function ($m) use ($params) {
                $v = isset($params[$m[1]]) ? $params[$m[1]] : '';
                return is_scalar($v) ? (string) $v : json_encode($v, JSON_UNESCAPED_UNICODE);
            }, $value);
        }
        if (is_array($value)) {
            $out = array();
            foreach ($value as $k => $v) {
                $out[$k] = self::renderTemplate($v, $params);
            }
            return $out;
        }
        return $value;
    }

    /** 生成一条待入账事件的展示摘要（前端「明细」直接用）。 */
    public static function summarize($records)
    {
        $labels = array(
            'valueRecords' => '生活流', 'goods' => '物品', 'subscriptions' => '订阅',
            'bills' => '账单', 'categories' => '分类', 'wishlist' => '心愿',
            'cooldowns' => '冷静期', 'moods' => '情绪', 'times' => '时间',
            'usageRecords' => '打卡', 'reminders' => '提醒', 'walls' => '心墙',
        );
        $items = array();
        $total = 0;
        foreach (self::COLLECTIONS as $c) {
            if (empty($records[$c]) || !is_array($records[$c])) {
                continue;
            }
            foreach ($records[$c] as $row) {
                if (!is_array($row)) {
                    continue;
                }
                $items[] = array(
                    'collection' => $c,
                    'collectionLabel' => isset($labels[$c]) ? $labels[$c] : $c,
                    'id' => isset($row['id']) ? $row['id'] : '',
                    'title' => isset($row['name']) ? (string) $row['name'] : (isset($row['note']) ? (string) $row['note'] : (isset($row['text']) ? (string) $row['text'] : (isset($labels[$c]) ? $labels[$c] : $c))),
                    'amount' => isset($row['amount']) ? $row['amount'] : (isset($row['price']) ? $row['price'] : null),
                    'date' => isset($row['date']) ? $row['date'] : (isset($row['buyDate']) ? $row['buyDate'] : (isset($row['startDate']) ? $row['startDate'] : (isset($row['dueDate']) ? $row['dueDate'] : ''))),
                    'note' => isset($row['note']) ? (string) $row['note'] : '',
                    'fields' => array_keys($row),
                );
                $total++;
            }
        }
        if (isset($records['patches']) && is_array($records['patches'])) {
            foreach ($records['patches'] as $c => $rows) {
                foreach ((array) $rows as $p) {
                    $items[] = array('collection' => $c, 'collectionLabel' => '修改 · ' . (isset($labels[$c]) ? $labels[$c] : $c),
                        'id' => is_array($p) && isset($p['id']) ? $p['id'] : '', 'title' => '更新已有记录', 'amount' => null, 'date' => '', 'note' => '', 'fields' => array());
                    $total++;
                }
            }
        }
        if (isset($records['deletes']) && is_array($records['deletes'])) {
            foreach ($records['deletes'] as $c => $ids) {
                foreach ((array) $ids as $id) {
                    $items[] = array('collection' => $c, 'collectionLabel' => '删除 · ' . (isset($labels[$c]) ? $labels[$c] : $c),
                        'id' => (string) $id, 'title' => '移除记录', 'amount' => null, 'date' => '', 'note' => '', 'fields' => array());
                    $total++;
                }
            }
        }
        return array('items' => $items, 'total' => $total);
    }

    /** 把字段字典转成 OpenAPI 的 components.schemas。 */
    public static function openapiSchemas($customFields = array())
    {
        $out = array();
        foreach (self::collections($customFields) as $name => $meta) {
            $props = array();
            $required = array();
            foreach ($meta['fields'] as $fn => $f) {
                $t = $f['type'];
                if (strpos($t, 'array') === 0) {
                    $p = array('type' => 'array', 'items' => array('type' => 'object'), 'description' => $f['label']);
                } elseif (strpos($t, 'object') === 0) {
                    $p = array('type' => 'object', 'description' => $f['label'], 'additionalProperties' => true);
                } elseif ($t === 'number') {
                    $p = array('type' => 'number', 'description' => $f['label']);
                } elseif ($t === 'boolean') {
                    $p = array('type' => 'boolean', 'description' => $f['label']);
                } else {
                    $p = array('type' => 'string', 'description' => $f['label']);
                }
                if (isset($f['enum'])) {
                    $p['enum'] = $f['enum'];
                }
                if (isset($f['example'])) {
                    $p['example'] = $f['example'];
                }
                if (isset($f['default'])) {
                    $p['default'] = $f['default'];
                }
                if (isset($f['note'])) {
                    $p['description'] .= '。' . $f['note'];
                }
                $props[$fn] = $p;
                if (!empty($f['required'])) {
                    $required[] = $fn;
                }
            }
            $out[ucfirst($name)] = array(
                'type' => 'object',
                'description' => $meta['label'] . '：' . $meta['description'],
                'properties' => $props,
                'required' => $required,
                'additionalProperties' => true,
            );
        }
        return $out;
    }
}
