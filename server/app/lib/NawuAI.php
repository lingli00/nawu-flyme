<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * ★v1.6.5 · NaWu AI 服务端引擎
 *
 * 供「Muse 等外部智能体」通过 /api/ai/* 记账使用，能力与 App/Web 对齐：
 *   ① 解析：把一句中文（「昨天买了个耳机 899」「星巴克 35」「腾讯视频月卡 25」）解析成结构化草案；
 *   ② 值不值：物品生命周期账（总投入 / 日均成本 / 达成率 / 净赚）+ 归·需·否 结构；
 *   ③ 问答：自然语言问账（「这个月花了多少」「耳机值不值」「订阅每月多少钱」）。
 *
 * 口径来源（与客户端同源，改造同步）：
 *   app/src/ai/localParser.ts  → 解析规则
 *   app/src/ai/keywords.ts     → 分类关键词表
 *   app/src/domain/goods.ts     → 物品生命周期账
 *   app/src/domain/stats.ts     → 归/需/否、Top 分类、趋势
 *
 * 设计约束：
 *   - 纯规则、零外部依赖：不配置任何大模型也能用（Muse 自己就是 LLM，可先自行结构化再调 commit）；
 *   - 只读用户自己的数据，所有查询都按 owner_id 隔离；
 *   - 中文数字、金额、日期、分类判定与客户端保持同一套规则（详见各方法注释）。
 */
class NawuAI
{
    /* ==========================================================
     * 一、基础工具
     * ========================================================== */

    /**
     * 中文数字 → 数字。
     * 支持：十/百/千/万/亿、两、零、小数点，以及口语省尾（「两千五」=2500、「一百二」=120、「一万二」=12000）。
     */
    public static function cnNumber($s)
    {
        $s = trim((string) $s);
        if ($s === '') {
            return 0;
        }
        if (preg_match('/^\d+(\.\d+)?$/', $s)) {
            return (float) $s;
        }

        $digits = array('零' => 0, '〇' => 0, '一' => 1, '壹' => 1, '二' => 2, '两' => 2, '贰' => 2,
            '三' => 3, '叁' => 3, '四' => 4, '肆' => 4, '五' => 5, '伍' => 5, '六' => 6, '陆' => 6,
            '七' => 7, '柒' => 7, '八' => 8, '捌' => 8, '九' => 9, '玖' => 9);
        $units = array('十' => 10, '拾' => 10, '百' => 100, '佰' => 100, '千' => 1000, '仟' => 1000);
        $bigs  = array('万' => 10000, '萬' => 10000, '亿' => 100000000);

        $chars = preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY);
        $n = count($chars);
        $total = 0.0;
        $section = 0.0;
        $number = 0.0;
        $lastUnit = 0;

        for ($i = 0; $i < $n; $i++) {
            $ch = $chars[$i];
            if (isset($digits[$ch])) {
                $number = (float) $digits[$ch];
                // 口语省尾：单位后的最后一位数字按「下一级单位」算（两千五 → 2500）
                if ($i === $n - 1 && $lastUnit > 0 && $number > 0 && $number < 10) {
                    $number = $number * ($lastUnit / 10);
                }
            } elseif (isset($units[$ch])) {
                $u = $units[$ch];
                if ($number == 0) {
                    $number = 1;
                }
                $section += $number * $u;
                $number = 0;
                $lastUnit = $u;
            } elseif (isset($bigs[$ch])) {
                $u = $bigs[$ch];
                $section += $number;
                if ($section == 0) {
                    $section = 1;
                }
                $total += $section * $u;
                $section = 0;
                $number = 0;
                // 一万一 / 三万五：尾数按「万位下一级」= 千（故这里记 万 本身，尾数再 /10）
                $lastUnit = $u;
            } elseif ($ch === '点' || $ch === '.') {
                $frac = '';
                for ($j = $i + 1; $j < $n; $j++) {
                    if (isset($digits[$chars[$j]])) {
                        $frac .= (string) $digits[$chars[$j]];
                    } else {
                        break;
                    }
                }
                if ($frac !== '') {
                    $total += $number + (float) ('0.' . $frac);
                    $number = 0;
                }
                $i = $n;
            }
        }
        $total += $section + $number;
        return $total > 0 ? $total : 0;
    }

    /** 归一化金额：四舍五入到分。 */
    public static function money($n)
    {
        return round((float) $n, 2);
    }

    /** 生成记录 id（与客户端 newId 同口径：时间戳 + 随机）。 */
    public static function newId($prefix = 'm')
    {
        return $prefix . '_' . substr((string) (int) (microtime(true) * 1000), -13) . substr(md5(uniqid('', true)), 0, 6);
    }

    public static function today()
    {
        return date('Y-m-d');
    }

    public static function nowISO()
    {
        return gmdate('Y-m-d\TH:i:s\Z');
    }

    /** 解析自然语言日期 → 'YYYY-MM-DD'。 */
    public static function resolveDate($text, $today = null)
    {
        $today = $today ? $today : self::today();
        $t = strtotime($today);
        $text = (string) $text;

        if (preg_match('/前天|大前天/', $text)) {
            $offset = strpos($text, '大前天') !== false ? 3 : 2;
            return date('Y-m-d', strtotime('-' . $offset . ' days', $t));
        }
        if (preg_match('/昨天|昨晚|昨日/', $text)) {
            return date('Y-m-d', strtotime('-1 day', $t));
        }
        if (preg_match('/前天/', $text)) {
            return date('Y-m-d', strtotime('-2 days', $t));
        }
        if (preg_match('/今天|今日|刚才|刚才还|刚买|刚花/', $text)) {
            return $today;
        }
        if (preg_match('/明天|明日/', $text)) {
            return date('Y-m-d', strtotime('+1 day', $t));
        }
        if (preg_match('/上周|上个星期/', $text)) {
            return date('Y-m-d', strtotime('-7 days', $t));
        }
        if (preg_match('/上个月|上月/', $text)) {
            return date('Y-m-d', strtotime('-1 month', $t));
        }
        // 3月5日 / 3-5 / 3/5
        if (preg_match('/(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})\s*[日号]?/u', $text, $m)) {
            $y = (int) date('Y', $t);
            $mo = (int) $m[1];
            $d = (int) $m[2];
            if ($mo >= 1 && $mo <= 12 && $d >= 1 && $d <= 31) {
                $cand = sprintf('%04d-%02d-%02d', $y, $mo, $d);
                // 跨年：比今天早 300 天以上 → 认为是去年
                if (strtotime($cand) < $t - 86400 * 300) {
                    $cand = sprintf('%04d-%02d-%02d', $y - 1, $mo, $d);
                }
                return $cand;
            }
        }
        // 本月 X 号
        if (preg_match('/(?:本月|这个月)?\s*(\d{1,2})\s*[日号]/u', $text, $m)) {
            $d = (int) $m[1];
            if ($d >= 1 && $d <= 31) {
                return date('Y-m-d', strtotime(date('Y-m-', $t) . sprintf('%02d', $d)));
            }
        }
        return $today;
    }

    /* ==========================================================
     * 二、关键词表（与 app/src/ai/keywords.ts 对齐）
     * ========================================================== */

    /** 生活流（记账）分类关键词。 */
    public static function ledgerKeywords()
    {
        return array(
            array('name' => '餐饮', 'words' => array('吃饭', '早餐', '午餐', '晚餐', '夜宵', '外卖', 'food', '食堂', '餐厅', '奶茶', '咖啡', '星巴克', '瑞幸', '喜茶', '火锅', '烧烤', '麦当劳', '肯德基', '汉堡', '面包', '蛋糕', '零食', '水果', '饭', '菜', '喝')),
            array('name' => '交通', 'words' => array('打车', '地铁', '公交', '高铁', '火车', '飞机', '机票', '加油', '停车', '共享单车', '滴滴', '出行', '车票', '油费', '过路费', 'etc')),
            array('name' => '居住', 'words' => array('房租', '水电', '物业', '燃气', '取暖', '宽带费', '宿舍', '住宿', '酒店', '房贷', '水费', '电费')),
            array('name' => '学习', 'words' => array('书', '课程', '培训', '网课', '学费', '考试', '报名费', '文具', '书店', '买书', '教程')),
            array('name' => '健康', 'words' => array('药', '医院', '挂号', '体检', '看病', '门诊', '保健', '口罩', '疫苗', '牙医', '健身房', '药店')),
            array('name' => '娱乐', 'words' => array('电影', 'ktv', '演出', '演唱会', '剧本杀', '酒吧', '按摩', '足浴', '展览', '游戏', ' Steam', 'steam', '充值', '皮肤', '点券', '会员')),
            array('name' => '人情', 'words' => array('红包', '礼物', '份子钱', '送礼', '随礼', '请客', '孝敬', '请吃饭')),
            array('name' => '服饰', 'words' => array('衣服', '买衣', '裤子', '鞋', '帽子', '外套', '卫衣', '羽绒服', '裙子', '袜子', '包', 't恤', '衬衫', '内衣')),
            array('name' => '饰品', 'words' => array('首饰', '项链', '戒指', '耳环', '手链', '配饰', '饰品', '手表', '手串')),
            array('name' => '食材', 'words' => array('买菜', '菜', '水果', '零食', '超市', '食材', '肉', '蛋', '奶', '米', '粮油', '生鲜')),
            array('name' => '日用', 'words' => array('纸', '洗衣液', '牙膏', '日用品', '清洁', '垃圾袋', '洗护', '毛巾', '抽纸', '洗发水')),
            array('name' => '美妆', 'words' => array('口红', '粉底', '香水', '护肤', '面膜', '化妆品', '美妆', '化妆', '理发', '剪头')),
            array('name' => '数码', 'words' => array('手机', '电脑', '耳机', '充电宝', '数据线', '配件', '贴膜', '键盘', '鼠标', '显示器', '音箱', '平板', '相机')),
            array('name' => '通讯', 'words' => array('话费', '充话费', '电话费', '流量', '宽带', '手机费', '套餐', '网卡', '短信')),
            array('name' => '游戏', 'words' => array('游戏', '充值', '皮肤', '点券', 'steam', '点卡', '氪金', '抽卡', '月卡', '通行证', '首充')),
            array('name' => '云服务', 'words' => array('阿里云', '腾讯云', '华为云', '服务器', '域名', '备案', 'cdn', '云主机', '对象存储', 'vps', '云盘')),
            array('name' => '宠物', 'words' => array('猫', '狗', '猫粮', '狗粮', '宠物', '猫砂', '驱虫', '打疫苗')),
            array('name' => '旅行', 'words' => array('旅游', '旅行', '酒店', '民宿', '门票', '景区', '度假', '跟团')),
            array('name' => '健身', 'words' => array('健身', '健身房', '私教', '游泳', '瑜伽', '普拉提', '球场', '运动')),
            array('name' => '母婴', 'words' => array('奶粉', '尿布', '尿不湿', '母婴', '婴儿', '宝宝', '辅食')),
            array('name' => '办公', 'words' => array('文具', '打印', '办公', '耗材', '快递', '邮寄')),
            array('name' => '保险', 'words' => array('保险', '社保', '医保', '车险', '保费')),
            array('name' => '维修', 'words' => array('维修', '修理', '换屏', '保养', '管道', '家政')),
        );
    }

    /** 物品分类关键词。 */
    public static function goodsKeywords()
    {
        return array(
            array('name' => '数码', 'words' => array('手机', 'iphone', '电脑', '笔记本', '平板', 'ipad', '耳机', '音箱', '显示器', '键盘', '鼠标', '手表', '手环', '相机', '充电宝', 'u盘', '硬盘', 'nas', '投影')),
            array('name' => '衣物', 'words' => array('衣', '裤', '鞋', '帽', '袜', '外套', '羽绒', '裙', '靴', 't恤', '衬衫', '卫衣', '大衣')),
            array('name' => '家居', 'words' => array('沙发', '床', '桌', '椅', '收纳', '灯', '家居', '被子', '枕头', '床垫', '沙发垫', '地毯', '窗帘')),
            array('name' => '美妆', 'words' => array('口红', '粉底', '香水', '护肤', '美妆', '化妆', '面膜', '精华', '眼霜')),
            array('name' => '厨房', 'words' => array('锅', '碗', '刀', '餐具', '厨房', '烘焙', '杯子', '水壶', '空气炸锅', '烤箱', '电饭煲')),
            array('name' => '交通', 'words' => array('自行车', '电动车', '摩托', '汽车', '滑板', '头盔', '轮胎')),
            array('name' => '家电', 'words' => array('冰箱', '空调', '洗衣机', '电视', '微波炉', '家电', '扫地机', '风扇', '热水器', '洗碗机', '投影仪')),
            array('name' => '工具', 'words' => array('螺丝', '钳', '电钻', '工具', '扳手', '工具箱')),
            array('name' => '玩具', 'words' => array('手办', '模型', '积木', '娃娃', '玩具', '乐高')),
            array('name' => '乐器', 'words' => array('吉他', '钢琴', '尤克里里', '鼓', '乐器', '笛子')),
            array('name' => '珠宝', 'words' => array('戒指', '项链', '首饰', '珠宝', '手表', '黄金', '手镯')),
            array('name' => '运动', 'words' => array('跑鞋', '球鞋', '运动鞋', '运动', '健身', '球', '瑜伽', '户外', '哑铃', '跳绳', '滑板')),
            array('name' => '日用', 'words' => array('收纳', '纸巾', '洗发水', '沐浴露', '牙膏', '毛巾', '袜子', '闹钟', '晾衣架')),
        );
    }

    /** 收入线索词。 */
    public static function incomeCues()
    {
        return array('工资', '薪水', '发工资', '奖金', '年终奖', '报销', '退款', '退货', '返现', '收到', '赚了', '赚到', '收入', '分红', '利息', '卖', '卖出', '中奖', '红包收', '转账给我', '进账');
    }

    /** 支出线索词。 */
    public static function expenseCues()
    {
        return array('花了', '花费', '用了', '支付', '付款', '实付', '付了', '买', '购', '充', '充值', '交', '缴', '订', '点了', '点了杯', '消费');
    }

    /** 订阅线索词（判定是否订阅）。 */
    public static function subCues()
    {
        return array('月卡', '年卡', '季卡', '周卡', '包月', '包年', '订阅', '会员', 'vip', '大会员', '连续包月', '自动续费', '充值会员');
    }

    /** 心情线索。 */
    public static function moodCues()
    {
        return array(
            array('emoji' => '😄', 'words' => array('开心', '高兴', '爽', '快乐', '哈哈', '嘿嘿', '愉快')),
            array('emoji' => '😢', 'words' => array('难过', '伤心', '郁闷', '低落', '哭', '委屈')),
            array('emoji' => '😡', 'words' => array('生气', '愤怒', '气死', '火大', '暴躁')),
            array('emoji' => '😴', 'words' => array('累', '疲惫', '困', '疲乏')),
            array('emoji' => '😮', 'words' => array('惊讶', '居然', '没想到', '离谱')),
            array('emoji' => '😐', 'words' => array('一般', '普通', '还行', '凑合')),
        );
    }

    /* ==========================================================
     * 三、金额抽取
     * ========================================================== */

    /** 从文本里抽金额（返回 array(amount, matched) 或 null）。 */
    public static function extractAmount($text)
    {
        $text = (string) $text;
        $cn = '零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万萬亿';
        $num = '(?:\d+(?:\.\d+)?|[' . $cn . ']+)';

        // 口语小数：「三块五」= 3.5、「十二块八」= 12.8
        if (preg_match('/(?:^|[^\d])(' . $num . ')\s*(?:块|元)\s*([一二三四五六七八九\d])(?![\d])/u', $text, $mm)) {
            $a = preg_match('/^\d/', $mm[1]) ? (float) $mm[1] : self::cnNumber($mm[1]);
            $b = preg_match('/^\d/', $mm[2]) ? (float) $mm[2] : self::cnNumber($mm[2]);
            if ($a > 0) {
                return array('amount' => self::money($a + $b / 10), 'matched' => $mm[0]);
            }
        }

        $patterns = array(
            '/(?:花了|花费|用了|支付了?|付款|实付|付了|一共|总共|价格是?|掏了|砸了|充值|买了|买|花了|收入了?|赚了|收到|卖了|卖掉|出掉|出售|回血|转让|续费|订了?|交了?)\s*(' . $num . ')/u',
            '/(' . $num . ')\s*(?:块钱|块|元|￥|¥|人民币)/u',
            '/(?:月卡|年卡|季卡|周卡|包月|包年)\s*(' . $num . ')/u',
        );
        foreach ($patterns as $re) {
            if (preg_match($re, $text, $m)) {
                $raw = $m[1];
                $v = preg_match('/^\d/', $raw) ? (float) $raw : self::cnNumber($raw);
                if ($v > 0) {
                    return array('amount' => self::money($v), 'matched' => $m[0]);
                }
            }
        }
        // 兜底：裸数字（排除日期）
        $clean = preg_replace('/\d{1,2}\s*[月\-\/\.]\s*\d{1,2}\s*[日号]?/u', '', $text);
        if (preg_match('/(?<![A-Za-z0-9_+#.])(' . $num . ')(?![A-Za-z0-9_+#%.])/u', $clean, $m)) {
            $raw = $m[1];
            $v = preg_match('/^\d/', $raw) ? (float) $raw : self::cnNumber($raw);
            if ($v > 0 && $v < 10000000) {
                return array('amount' => self::money($v), 'matched' => $m[0]);
            }
        }
        return null;
    }

    /* ==========================================================
     * 四、分类判定
     * ========================================================== */

    /** 在关键词表里找命中的分类名（取关键词最长的那个，避免「游戏会员」被「会员」截胡）。 */
    public static function matchKeyword($text, $table)
    {
        $best = '';
        $bestLen = 0;
        foreach ($table as $row) {
            foreach ($row['words'] as $w) {
                $wl = mb_strlen($w, 'UTF-8');
                if ($wl > $bestLen && mb_stripos($text, $w, 0, 'UTF-8') !== false) {
                    $best = $row['name'];
                    $bestLen = $wl;
                }
            }
        }
        return $best;
    }

    /**
     * 分类 id 解析：优先用用户自己的分类表（快照里的 categories），
     * 没有就用内置默认表（客户端 seed.ts 同口径）。
     */
    public static function categoryId($name, $kind, $categories)
    {
        foreach ((array) $categories as $c) {
            if (isset($c['name'], $c['kind']) && $c['name'] === $name && $c['kind'] === $kind) {
                return $c['id'];
            }
        }
        $defaults = self::defaultCategories();
        foreach ($defaults as $c) {
            if ($c['name'] === $name && $c['kind'] === $kind) {
                return $c['id'];
            }
        }
        // 兜底：同 kind 的第一个
        foreach ($defaults as $c) {
            if ($c['kind'] === $kind) {
                return $c['id'];
            }
        }
        return '';
    }

    /** 内置默认分类（与 app/src/storage/seed.ts 对齐）。 */
    public static function defaultCategories()
    {
        static $cache = null;
        if ($cache !== null) {
            return $cache;
        }
        $goods = array('数码', '衣物', '家居', '美妆', '厨房', '运动', '交通', '家电', '工具', '玩具', '乐器', '珠宝', '日用');
        $sub   = array('影音', '效率', '学习', '云服务', '游戏', '生活');
        // ★生活流 id 必须与 app/src/storage/seed.ts 严格一致（cl7=其他 垫底，cl0..cl6 / cl8..cl23）
        $ledger = array(
            'cl0' => '餐饮', 'cl1' => '交通', 'cl2' => '居住', 'cl3' => '学习', 'cl4' => '健康',
            'cl5' => '娱乐', 'cl6' => '人情', 'cl8' => '服饰', 'cl9' => '饰品', 'cl10' => '食材',
            'cl11' => '日用', 'cl12' => '美妆', 'cl13' => '数码', 'cl14' => '通讯', 'cl15' => '游戏',
            'cl16' => '云服务', 'cl17' => '宠物', 'cl18' => '旅行', 'cl19' => '健身', 'cl20' => '母婴',
            'cl21' => '办公', 'cl22' => '保险', 'cl23' => '维修', 'cl7' => '其他',
        );
        $out = array();
        foreach ($goods as $i => $n) {
            $out[] = array('id' => 'cg' . $i, 'name' => $n, 'kind' => 'goods', 'order' => $i);
        }
        foreach ($sub as $i => $n) {
            $out[] = array('id' => 'cs' . $i, 'name' => $n, 'kind' => 'sub', 'order' => $i);
        }
        foreach ($ledger as $id => $n) {
            $out[] = array('id' => $id, 'name' => $n, 'kind' => 'ledger', 'order' => (int) substr($id, 2));
        }
        $cache = $out;
        return $out;
    }

    /** 物品分类名 → 生活流分类名（买物品要同时落一笔生活流支出）。 */
    public static function goodsToLedgerName($goodsName)
    {
        $map = array(
            '数码' => '数码', '衣物' => '服饰', '家居' => '日用', '美妆' => '美妆', '厨房' => '日用',
            '交通' => '交通', '家电' => '数码', '工具' => '日用', '玩具' => '娱乐', '乐器' => '娱乐',
            '珠宝' => '饰品', '运动' => '健身', '日用' => '日用',
        );
        return isset($map[$goodsName]) ? $map[$goodsName] : '日用';
    }

    /** 归·需·否 判定（与客户端 guessJudgement 同思路）。 */
    public static function judgement($text)
    {
        $t = (string) $text;
        if (preg_match('/没必要|不值|白买|浪费|亏|踩雷|智商税/', $t)) {
            return '否';
        }
        if (preg_match('/刚需|必须|需要|每天|天天|离不开|没法替代|一定要/u', $t)) {
            return '需';
        }
        if (preg_match('/值得|划算|便宜|好用|喜欢|爱了|真香|提升|效率/u', $t)) {
            return '归';
        }
        return '归';
    }

    /* ==========================================================
     * 五、解析（核心）
     * ========================================================== */

    /**
     * 解析一句话 → 草案。
     *
     * @param string $text      原始话术
     * @param array  $ctx       ['categories'=>[], 'today'=>'YYYY-MM-DD']
     * @return array 草案（可多句多条）
     */
    public static function parseText($text, $ctx = array())
    {
        $today = isset($ctx['today']) ? $ctx['today'] : self::today();
        $categories = isset($ctx['categories']) ? $ctx['categories'] : array();
        $text = trim((string) $text);
        if ($text === '') {
            return array('items' => array(), 'warnings' => array('空文本'), 'needsConfirm' => true);
        }

        $sentences = self::splitSentences($text);
        $items = array();
        $warnings = array();

        foreach ($sentences as $s) {
            $item = self::parseSentence($s, $today, $categories);
            if ($item) {
                $items[] = $item;
            } else {
                $warnings[] = '未能解析：' . $s;
            }
        }
        if (!$items) {
            $warnings[] = '没识别出金额或类型，请补充「花了多少钱 / 买了什么」';
        }
        return array(
            'items'   => $items,
            'warnings' => $warnings,
            'needsConfirm' => true,
            'source'  => 'rules',
        );
    }

    /** 分句：中文标点 / 换行 / 「然后、还有、以及」等连接词。 */
    public static function splitSentences($text)
    {
        $parts = preg_split('/[，,。；;！!\n\r]+/u', $text, -1, PREG_SPLIT_NO_EMPTY);
        $out = array();
        foreach ((array) $parts as $p) {
            $p = trim($p);
            if ($p === '') {
                continue;
            }
            // 「还有」「然后」「以及」再切一刀（前面部分通常已独立成句）
            $sub = preg_split('/(?=还有|然后|另外|以及|顺便)/u', $p, -1, PREG_SPLIT_NO_EMPTY);
            foreach ((array) $sub as $x) {
                $x = trim($x);
                if ($x !== '') {
                    $out[] = $x;
                }
            }
        }
        return $out;
    }

    /** 单句解析。 */
    private static function parseSentence($s, $today, $categories)
    {
        $amountHit = self::extractAmount($s);
        if (!$amountHit) {
            return null;
        }
        $amount = $amountHit['amount'];
        $date = self::resolveDate($s, $today);

        // 收支判定
        $isIncome = false;
        foreach (self::incomeCues() as $cue) {
            if (mb_stripos($s, $cue, 0, 'UTF-8') !== false) {
                $isIncome = true;
                break;
            }
        }
        if (!$isIncome) {
            foreach (self::expenseCues() as $cue) {
                if (mb_stripos($s, $cue, 0, 'UTF-8') !== false) {
                    $isIncome = false;
                    break;
                }
            }
        }
        // 「卖」既是收入也是物品转卖 —— 由 trade 分支接管
        $isSell = (bool) preg_match('/卖了|卖掉|出掉|出售|回血|转让/u', $s);

        // 订阅？
        $isSub = false;
        foreach (self::subCues() as $cue) {
            if (mb_stripos($s, $cue, 0, 'UTF-8') !== false) {
                $isSub = true;
                break;
            }
        }
        // 周期
        $period = 'month';
        $every = 1;
        if (preg_match('/年卡|包年| yearly |一年/u', $s)) {
            $period = 'year';
        } elseif (preg_match('/季卡|三个月/u', $s)) {
            $period = 'month';
            $every = 3;
        } elseif (preg_match('/周卡|每周/u', $s)) {
            $period = 'week';
        }

        // 物品购买判定（关键词 + 购买动词 + 金额较大）
        $goodsCat = self::matchKeyword($s, self::goodsKeywords());
        $isGoods = false;
        if ($goodsCat !== '' && preg_match('/买|购|入手|下单|到了|买了/u', $s)) {
            $isGoods = true;
        } elseif ($goodsCat !== '' && $amount >= 50) {
            // 「两千五的相机」「耳机 899」：没动词但明显是买物件，按物品入库
            $isGoods = true;
        }
        // 「XX多少钱值不值」这类只提问不记账
        $isQuestion = (bool) preg_match('/值不值|值不值|划算吗|好不好|贵不贵/u', $s);

        $name = self::cleanName($s, $amountHit['matched']);

        if ($isQuestion) {
            return array(
                'kind' => 'question',
                'text' => $s,
                'amount' => $amount,
                'name' => $name,
                'date' => $date,
            );
        }

        if ($isSell) {
            // 转卖：按物品关键词给分类（卖手机 → 数码），识别不出才落「人情」
            $sellCat = $goodsCat !== '' ? self::goodsToLedgerName($goodsCat) : '人情';
            return array(
                'kind' => 'ledger',
                'type' => 'income',
                'amount' => $amount,
                'categoryId' => self::categoryId($sellCat, 'ledger', $categories),
                'categoryName' => $sellCat,
                'judgement' => '归',
                'date' => $date,
                'note' => $s,
                'text' => $s,
                'source' => 'rules',
            );
        }

        if ($isSub) {
            return array(
                'kind' => 'subscription',
                'name' => $name,
                'amount' => $amount,
                'period' => $period,
                'every' => $every,
                'categoryId' => self::categoryId('生活', 'sub', $categories),
                'categoryName' => '生活',
                'date' => $date,
                'text' => $s,
                'source' => 'rules',
            );
        }

        if ($isGoods) {
            $catName = $goodsCat;
            return array(
                'kind' => 'goods',
                'name' => $name,
                'amount' => $amount,
                'categoryId' => self::categoryId($catName, 'goods', $categories),
                'categoryName' => $catName,
                // 物品买入同时记一笔生活流支出，分类要落到「生活流」的 id 上（不能混用 cgX）
                'ledgerCategoryId' => self::categoryId(self::goodsToLedgerName($catName), 'ledger', $categories),
                'judgement' => self::judgement($s),
                'date' => $date,
                'note' => $s,
                'text' => $s,
                'source' => 'rules',
            );
        }

        $catName = self::matchKeyword($s, self::ledgerKeywords());
        if ($catName === '') {
            $catName = $isIncome ? '人情' : '日用';
        }
        return array(
            'kind' => 'ledger',
            'type' => $isIncome ? 'income' : 'expense',
            'amount' => $amount,
            'categoryId' => self::categoryId($catName, 'ledger', $categories),
            'categoryName' => $catName,
            'judgement' => self::judgement($s),
            'date' => $date,
            'note' => $s,
            'text' => $s,
            'source' => 'rules',
        );
    }

    /** 从句子里抹掉金额与动词尾巴，得到物品/订阅名。 */
    public static function cleanName($text, $matched)
    {
        $s = (string) $text;
        if ($matched !== '') {
            $s = str_replace($matched, '', $s);
        }
        // 时间前缀（「昨天买了个耳机」不该带「昨天」进名字）
        $s = preg_replace('/^(今天|昨天|前天|大前天|刚才|早上|中午|晚上|下午|上午|上周|本周|这个月|上个月|刚刚)/u', '', $s);
        $s = preg_replace('/(花了|花费|用了|支付了?|付款|实付|付了|一共|总共|价格是?|掏了|砸了|充值|买了|买|入手|下单|一个|两个|了|个|的)/u', '', $s);
        $s = preg_replace('/[\s，。、,.\-]+/u', '', $s);
        $s = trim($s);
        if (mb_strlen($s, 'UTF-8') > 24) {
            $s = mb_substr($s, 0, 24, 'UTF-8');
        }
        return $s;
    }

    /* ==========================================================
     * 六、值不值引擎（物品生命周期账）
     * ========================================================== */

    /**
     * 评估一个物品「值不值」。
     *
     * 口径与 app/src/domain/goods.ts 的 summarizeGoods 一致：
     *   总投入 = 买入价 + 附加费；净赚 = 卖出价 - 总投入；
     *   日均成本 = 总投入 / 已持有天数；达成率 = 目标日均 ? (目标日均/日均成本) : 0
     */
    public static function evaluateGoods($goods, $records, $today = null)
    {
        $today = $today ? $today : self::today();
        $price = (float) (isset($goods['price']) ? $goods['price'] : 0);
        $fees = 0;
        foreach ((array) (isset($goods['extraFees']) ? $goods['extraFees'] : array()) as $f) {
            $fees += (float) (isset($f['amount']) ? $f['amount'] : 0);
        }
        $totalInvest = self::money($price + $fees);
        $buyDate = isset($goods['buyDate']) ? $goods['buyDate'] : $today;
        $days = max(1, (int) floor((strtotime($today) - strtotime($buyDate)) / 86400));
        $daily = self::money($totalInvest / $days);
        $target = isset($goods['targetDailyCost']) ? (float) $goods['targetDailyCost'] : 0;
        $achieve = $target > 0 && $daily > 0 ? round($target / $daily, 3) : 0;

        // 卖出记录（valueRecords 里 src='goods-sale' 或 refId 匹配）
        $sold = 0;
        foreach ((array) $records as $r) {
            if (!isset($r['type']) || $r['type'] !== 'income') {
                continue;
            }
            $ref = isset($r['refId']) ? $r['refId'] : '';
            $src = isset($r['src']) ? $r['src'] : '';
            if (($ref !== '' && $ref === $goods['id']) || $src === 'goods-sale') {
                $sold += (float) (isset($r['amount']) ? $r['amount'] : 0);
            }
        }
        $net = self::money($sold - $totalInvest);

        // 结论
        if ($net > 0) {
            $verdict = '值：转卖净赚 ' . number_format($net, 2) . ' 元';
        } elseif ($sold > 0) {
            $verdict = '一般：转卖回本 ' . number_format($sold, 2) . ' 元，净亏 ' . number_format(abs($net), 2) . ' 元';
        } elseif ($achieve >= 1) {
            $verdict = '值：日均 ' . number_format($daily, 2) . ' 元，优于目标日均 ' . number_format($target, 2) . ' 元';
        } elseif ($target > 0) {
            $verdict = '不太值：日均 ' . number_format($daily, 2) . ' 元，高于目标日均 ' . number_format($target, 2) . ' 元';
        } else {
            $verdict = '持有中：日均 ' . number_format($daily, 2) . ' 元（' . $days . ' 天）';
        }

        return array(
            'goodsId' => isset($goods['id']) ? $goods['id'] : '',
            'name' => isset($goods['name']) ? $goods['name'] : '',
            'totalInvest' => $totalInvest,
            'fees' => self::money($fees),
            'days' => $days,
            'dailyCost' => $daily,
            'targetDailyCost' => $target,
            'achieveRatio' => $achieve,
            'sold' => self::money($sold),
            'net' => $net,
            'verdict' => $verdict,
        );
    }

    /* ==========================================================
     * 七、问答（本地规则）
     * ========================================================== */

    /**
     * 自然语言问账。
     * 支持：花了多少 / 值不值 / 日均 / 订阅多少钱 / 最近买了什么 / 归需否占比。
     */
    public static function ask($question, $ctx)
    {
        $q = (string) $question;
        $records = isset($ctx['valueRecords']) ? $ctx['valueRecords'] : array();
        $goods = isset($ctx['goods']) ? $ctx['goods'] : array();
        $subs = isset($ctx['subscriptions']) ? $ctx['subscriptions'] : array();
        $today = isset($ctx['today']) ? $ctx['today'] : self::today();

        // 1) 值不值 / 日均
        if (preg_match('/值不值|划算|贵不贵|值不值|日均|每天花|摊销/u', $q)) {
            $kw = self::askKeyword($q, $goods);
            if ($kw === '') {
                return array(
                    'answer' => '没听出想问哪件物品。可以说「耳机值不值」「空调日均多少」。',
                    'data' => array('goods' => self::pickGoods($goods, '')),
                );
            }
            $g = self::pickGoods($goods, $kw);
            if (!$g) {
                return array('answer' => '物品库里没有「' . $kw . '」。', 'data' => array());
            }
            $ev = self::evaluateGoods($g, $records, $today);
            $tail = '；总投入 ' . number_format($ev['totalInvest'], 2) . ' 元，已用 ' . $ev['days'] . ' 天';
            if ($ev['sold'] > 0) {
                $tail .= '，卖出 ' . number_format($ev['sold'], 2) . ' 元，净赚 ' . number_format($ev['net'], 2) . ' 元';
            }
            return array(
                'answer' => $g['name'] . '，' . $ev['verdict'] . $tail . '。',
                'data' => $ev,
            );
        }

        // 2) 订阅
        if (preg_match('/订阅|会员|月卡|年卡/u', $q)) {
            $monthly = 0;
            $names = array();
            foreach ((array) $subs as $s) {
                $amt = (float) (isset($s['amount']) ? $s['amount'] : 0);
                $per = isset($s['period']) ? $s['period'] : 'month';
                $every = isset($s['every']) ? max(1, (int) $s['every']) : 1;
                $m = $per === 'year' ? $amt / 12 : ($per === 'week' ? $amt * 52 / 12 : $amt * $every);
                $monthly += $m;
                $names[] = $s['name'] . '（' . number_format($m, 2) . ' 元/月）';
            }
            return array(
                'answer' => $subs ? ('订阅每月合计约 ' . number_format($monthly, 2) . ' 元：' . implode('、', $names))
                                 : '当前没有订阅记录。',
                'data' => array('monthly' => self::money($monthly), 'count' => count((array) $subs)),
            );
        }

        // 3) 花了多少（按月/近 N 天）
        $range = self::askRange($q, $today);
        $income = 0;
        $expense = 0;
        $count = 0;
        foreach ((array) $records as $r) {
            $d = isset($r['date']) ? $r['date'] : '';
            if ($d < $range['start'] || $d > $range['end']) {
                continue;
            }
            $amt = (float) (isset($r['amount']) ? $r['amount'] : 0);
            if (isset($r['type']) && $r['type'] === 'income') {
                $income += $amt;
            } else {
                $expense += $amt;
            }
            $count++;
        }
        if (preg_match('/买了什么|最近买|买了啥/u', $q)) {
            $recent = array();
            foreach ((array) $records as $r) {
                $d = isset($r['date']) ? $r['date'] : '';
                if ($d >= $range['start'] && $d <= $range['end'] && (!isset($r['type']) || $r['type'] === 'expense')) {
                    $recent[] = array('date' => $d, 'amount' => $r['amount'], 'note' => isset($r['note']) ? $r['note'] : '');
                }
            }
            $recent = array_slice($recent, -10);
            $lines = array();
            foreach ($recent as $r) {
                $lines[] = $r['date'] . ' ' . number_format((float) $r['amount'], 2) . ' 元'
                    . ($r['note'] ? '（' . $r['note'] . '）' : '');
            }
            return array(
                'answer' => $lines ? ('最近记录：' . implode('；', $lines)) : '这段时间没有支出记录。',
                'data' => array('records' => $recent, 'range' => $range),
            );
        }

        // 4) 归·需·否
        if (preg_match('/归|需|否|值不值类/u', $q) && preg_match('/占比|比例|结构/u', $q)) {
            $jd = self::judgementBreakdown((array) $records, $range);
            $parts = array();
            foreach ($jd as $row) {
                $parts[] = $row['label'] . ' ' . number_format($row['amount'], 2) . ' 元（' . round($row['ratio'] * 100) . '%）';
            }
            return array(
                'answer' => $parts ? ('归·需·否：' . implode('，', $parts)) : '这段时间没有数据。',
                'data' => array('judgement' => $jd),
            );
        }

        return array(
            'answer' => '这段时间支出 ' . number_format($expense, 2) . ' 元、收入 ' . number_format($income, 2)
                . ' 元，共 ' . $count . ' 条记录（' . $range['label'] . '）。',
            'data' => array(
                'income' => self::money($income),
                'expense' => self::money($expense),
                'net' => self::money($income - $expense),
                'count' => $count,
                'range' => $range,
            ),
        );
    }

    /** 问句里的时间范围。 */
    public static function askRange($q, $today)
    {
        $t = strtotime($today);
        if (preg_match('/今天|今日/u', $q)) {
            return array('start' => $today, 'end' => $today, 'label' => '今天');
        }
        if (preg_match('/昨天|昨日/u', $q)) {
            $d = date('Y-m-d', strtotime('-1 day', $t));
            return array('start' => $d, 'end' => $d, 'label' => '昨天');
        }
        if (preg_match('/本周|这周|这个星期/u', $q)) {
            return array('start' => date('Y-m-d', strtotime('monday this week', $t)), 'end' => $today, 'label' => '本周');
        }
        if (preg_match('/上周|上个星期/u', $q)) {
            return array('start' => date('Y-m-d', strtotime('monday last week', $t)),
                         'end' => date('Y-m-d', strtotime('sunday last week', $t)), 'label' => '上周');
        }
        if (preg_match('/上个月|上月/u', $q)) {
            return array('start' => date('Y-m-01', strtotime('-1 month', $t)),
                         'end' => date('Y-m-t', strtotime('-1 month', $t)), 'label' => '上个月');
        }
        if (preg_match('/今年| annually |全年/u', $q)) {
            return array('start' => date('Y-01-01', $t), 'end' => date('Y-12-31', $t), 'label' => '今年');
        }
        if (preg_match('/近(\d+)天|最近(\d+)天/u', $q, $m)) {
            $n = (int) ($m[1] ? $m[1] : $m[2]);
            $n = $n > 0 ? $n : 30;
            return array('start' => date('Y-m-d', strtotime('-' . ($n - 1) . ' days', $t)), 'end' => $today, 'label' => '近' . $n . '天');
        }
        if (preg_match('/近(\d+)个?月/u', $q, $m)) {
            $n = (int) $m[1];
            $n = $n > 0 ? $n : 6;
            return array('start' => date('Y-m-d', strtotime('-' . ($n - 1) . ' months', $t)), 'end' => $today, 'label' => '近' . $n . '个月');
        }
        // 默认本月
        return array('start' => date('Y-m-01', $t), 'end' => date('Y-m-t', $t), 'label' => '本月');
    }

    /**
     * 从问句里找出最匹配的物品名。
     *
     * 「耳机值不值」要能对上库里叫「索尼耳机」的物品 → 用名字片段（≥2 字）反查问句，
     * 命中片段越长越优先；全名命中最高。
     */
    public static function askKeyword($q, $goods)
    {
        $best = '';
        $bestScore = 0;
        foreach ((array) $goods as $g) {
            $name = isset($g['name']) ? $g['name'] : '';
            if ($name === '') {
                continue;
            }
            $score = 0;
            if (mb_stripos($q, $name, 0, 'UTF-8') !== false) {
                $score = 1000 + mb_strlen($name, 'UTF-8');
            } else {
                $len = mb_strlen($name, 'UTF-8');
                $maxL = min(6, $len);
                for ($l = $maxL; $l >= 2 && $score === 0; $l--) {
                    for ($i = 0; $i + $l <= $len; $i++) {
                        $gram = mb_substr($name, $i, $l, 'UTF-8');
                        if ($gram !== '' && mb_stripos($q, $gram, 0, 'UTF-8') !== false) {
                            $score = $l * 10;
                            break;
                        }
                    }
                }
            }
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $name;
            }
        }
        if ($best !== '') {
            return $best;
        }
        // 退而求其次：关键词表里的词（用于库里还没有该物品时的提示）
        return self::matchKeyword($q, self::goodsKeywords());
    }

    /** 找出最匹配的物品（名称包含优先，其次分类匹配）。 */
    public static function pickGoods($goods, $kw)
    {
        if ($kw === '') {
            return null;
        }
        $best = null;
        $bestScore = 0;
        foreach ((array) $goods as $g) {
            $name = isset($g['name']) ? $g['name'] : '';
            $score = 0;
            if ($name === $kw) {
                $score = 100;
            } elseif (mb_stripos($name, $kw, 0, 'UTF-8') !== false) {
                $score = 60 + mb_strlen($kw, 'UTF-8');
            } elseif (mb_stripos($kw, $name, 0, 'UTF-8') !== false && $name !== '') {
                $score = 30 + mb_strlen($name, 'UTF-8');
            }
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $g;
            }
        }
        return $bestScore > 0 ? $best : null;
    }

    /** 归·需·否 汇总。 */
    public static function judgementBreakdown($records, $range)
    {
        $sum = array('归' => 0.0, '需' => 0.0, '否' => 0.0);
        $total = 0.0;
        foreach ((array) $records as $r) {
            $d = isset($r['date']) ? $r['date'] : '';
            if ($d < $range['start'] || $d > $range['end']) {
                continue;
            }
            if (isset($r['type']) && $r['type'] === 'income') {
                continue;
            }
            $j = isset($r['judgement']) ? $r['judgement'] : '归';
            if (!isset($sum[$j])) {
                $j = '归';
            }
            $sum[$j] += (float) (isset($r['amount']) ? $r['amount'] : 0);
            $total += (float) (isset($r['amount']) ? $r['amount'] : 0);
        }
        $out = array();
        foreach ($sum as $k => $v) {
            $out[] = array('key' => $k, 'label' => $k, 'amount' => self::money($v),
                           'ratio' => $total > 0 ? round($v / $total, 4) : 0);
        }
        return $out;
    }

    /* ==========================================================
     * 八、草案 → 可落库记录
     * ========================================================== */

    /**
     * 把草案转成真正要写入集合的记录（valueRecords / goods / subscriptions）。
     * 返回 array('valueRecords'=>[], 'goods'=>[], 'subscriptions'=>[])
     */
    public static function draftToRecords($draft, $ctx = array())
    {
        $today = isset($ctx['today']) ? $ctx['today'] : self::today();
        $out = array('valueRecords' => array(), 'goods' => array(), 'subscriptions' => array());
        foreach ((array) $draft['items'] as $item) {
            $kind = isset($item['kind']) ? $item['kind'] : 'ledger';
            if ($kind === 'ledger') {
                $out['valueRecords'][] = array(
                    'id' => self::newId('vr'),
                    'type' => isset($item['type']) ? $item['type'] : 'expense',
                    'amount' => self::money(isset($item['amount']) ? $item['amount'] : 0),
                    'currency' => 'CNY',
                    'date' => isset($item['date']) ? $item['date'] : $today,
                    'categoryId' => isset($item['categoryId']) ? $item['categoryId'] : 'cl0',
                    'judgement' => isset($item['judgement']) ? $item['judgement'] : '归',
                    'note' => isset($item['note']) ? mb_substr($item['note'], 0, 200, 'UTF-8') : '',
                    'createdAt' => self::nowISO(),
                );
            } elseif ($kind === 'goods') {
                $gid = self::newId('g');
                $out['goods'][] = array(
                    'id' => $gid,
                    'name' => isset($item['name']) && $item['name'] !== '' ? $item['name'] : '未命名物品',
                    'categoryId' => isset($item['categoryId']) ? $item['categoryId'] : 'cg0',
                    'tags' => array(),
                    'price' => self::money(isset($item['amount']) ? $item['amount'] : 0),
                    'currency' => 'CNY',
                    'buyDate' => isset($item['date']) ? $item['date'] : $today,
                    'status' => 'active',
                    'extraFees' => array(),
                    'incomes' => array(),
                    'note' => isset($item['note']) ? mb_substr($item['note'], 0, 200, 'UTF-8') : '',
                    'createdAt' => self::nowISO(),
                    'updatedAt' => self::nowISO(),
                );
                // 买物品 = 一笔支出（与 App 端「物品入库同时记支出」口径一致）
                $out['valueRecords'][] = array(
                    'id' => self::newId('vr'),
                    'type' => 'expense',
                    'amount' => self::money(isset($item['amount']) ? $item['amount'] : 0),
                    'currency' => 'CNY',
                    'date' => isset($item['date']) ? $item['date'] : $today,
                    // ★必须用生活流分类（clX），不能把物品分类（cgX）写进生活流
                    'categoryId' => isset($item['ledgerCategoryId']) ? $item['ledgerCategoryId'] : 'cl0',
                    'judgement' => isset($item['judgement']) ? $item['judgement'] : '归',
                    'note' => '买入：' . (isset($item['name']) ? $item['name'] : '物品'),
                    'createdAt' => self::nowISO(),
                    'refId' => $gid,
                );
            } elseif ($kind === 'subscription') {
                $start = isset($item['date']) ? $item['date'] : $today;
                $period = isset($item['period']) ? $item['period'] : 'month';
                $every = isset($item['every']) ? max(1, (int) $item['every']) : 1;
                $next = self::nextRenew($start, $period, $every);
                $out['subscriptions'][] = array(
                    'id' => self::newId('s'),
                    'name' => isset($item['name']) && $item['name'] !== '' ? $item['name'] : '订阅',
                    'categoryId' => isset($item['categoryId']) ? $item['categoryId'] : 'cs5',
                    'icon' => 'credit-card',
                    'currency' => 'CNY',
                    'type' => 'recurring',
                    'period' => $period,
                    'every' => $every,
                    'amount' => self::money(isset($item['amount']) ? $item['amount'] : 0),
                    'startDate' => $start,
                    'nextRenewDate' => $next,
                    'autoRenew' => true,
                    'status' => 'active',
                    'remind' => array('renewLead' => 3),
                    'createdAt' => self::nowISO(),
                    'updatedAt' => self::nowISO(),
                );
            }
        }
        return $out;
    }

    public static function nextRenew($start, $period, $every)
    {
        $d = strtotime($start);
        if ($period === 'year') {
            $n = date('Y-m-d', strtotime('+' . $every . ' year', $d));
        } elseif ($period === 'week') {
            $n = date('Y-m-d', strtotime('+' . ($every * 7) . ' day', $d));
        } else {
            $n = date('Y-m-d', strtotime('+' . $every . ' month', $d));
        }
        return $n;
    }
}
