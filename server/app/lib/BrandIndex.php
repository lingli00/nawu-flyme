<?php
if (!defined('GF_ROOT')) {
    http_response_code(403);
    exit;
}

/**
 * ★v1.8.1 · 品牌图标检索（订阅 / 物品的「配图标」能力）
 *
 * 背景（用户需求）：
 *   「订阅：根据订阅的来源，自己去调用 API 接口看能不能实现。如果能实现，就找到对应的
 *     图标用上去；如果实现不了，就迭代咱们的 API。也可以自己去网上或者图标库里搜索对应的图标。」
 *   → 服务端此前**没有任何按名字找图标的能力**，外部 Agent 只能靠猜 lucide id，
 *     或让用户自己传图。本类补上这块。
 *
 * 数据来源（全部本地、零外网、离线可用、毫秒级）：
 *   ① simpleBrand 品牌字形库 —— 192 个品牌，自带 SVG path（viewBox 0 0 24 24）+ 品牌色。
 *   ② brandIcon 品牌域名库 —— 182 条（177 个唯一域名），带中文名 / 英文别名 / 域名。
 *   ③ 随包品牌图标文件 —— server/brand-icons/<domain>.<ext>，177 个。
 *   ②+③ 合起来正好是「按域名出真品牌图」，而域名可以再走 /api/icon/img 回源。
 *
 * 三套数据在构建期分属前端（TS），服务端这里**不复制 280KB 的 path 数据**，只保留
 * 「名字 / 别名 / 域名 / 字形 slug / 有无随包图」，需要 SVG 时可从已打包的静态文件取，
 * 或由客户端用 `brand:<slug>` 引用码即时绘制（备份只带几个字节）。
 *
 * 存储协议：本类**只读**，不写任何 flyme.* 键、不改 12 个集合名。
 */
class GF_BrandIndex
{
    /** 匹配质量分级（越高越可信，Agent 可据此决定是否直接采用）。 */
    const SCORE_DOMAIN  = 100; // 查询本身就是一个域名（aliyun.com）
    const SCORE_SLUG    = 96;  // 查询命中品牌字形 slug（bilibili / alibabacloud）
    const SCORE_EXACT   = 92;  // 查询 = 中文名 / 英文名全等（阿里云 / Netflix）
    const SCORE_PREFIX  = 78;  // 中文名 / 英文名 前缀命中（阿里 → 阿里云）
    const SCORE_ALIAS   = 70;  // 别名全等 / 别名词命中（aliyun → 阿里云）
    const SCORE_CONTAIN = 55;  // 子串命中（哔哩 → 哔哩哔哩）
    const SCORE_TYPO    = 52;  // 编辑距离 = 1 的错拼（netfix → netflix，可直接采用）
    const SCORE_FUZZY   = 40;  // 编辑距离 = 2 的近似（netf1ix → netflix，只作候选）

    /** 可接受的最低分（低于此分只作为「候选建议」返回，agent 需自行确认）。 */
    const ACCEPT_MIN = self::SCORE_TYPO;

    /**
     * 品牌表：name（中文/展示名） / aliases（英文别名，空格分隔） / domain / glyph（simpleBrand slug，无则空）。
     * 由 brandIcon.ts + simpleBrand.ts + server/brand-icons/ 三份数据在构建期对齐，
     * 线上补品牌只需往这里加一行（并在 brand-icons/ 放图）。
     */
    private static function table()
    {
        return array(
            // ---- AI 助手 / 订阅 ----
            array('Claude', 'claude anthropic', 'claude.ai', 'claude'),
            array('ChatGPT', 'chatgpt openai gpt o1', 'chatgpt.com', 'openai'),
            array('OpenAI', 'openai', 'openai.com', 'openai'),
            array('DeepSeek', 'deepseek 深度求索', 'deepseek.com', 'deepseek'),
            array('Kimi', 'kimi moonshot 月之暗面', 'kimi.moonshot.cn', 'kimi'),
            array('月之暗面', 'moonshot', 'moonshot.cn', 'moonshotai'),
            array('Gemini', 'gemini google 谷歌', 'gemini.google.com', 'googlegemini'),
            array('Perplexity', 'perplexity pplx', 'perplexity.ai', 'perplexity'),
            array('Hugging Face', 'huggingface hf', 'huggingface.co', 'huggingface'),
            array('Mistral AI', 'mistral', 'mistral.ai', 'mistralai'),
            array('Ollama', 'ollama 本地大模型', 'ollama.com', 'ollama'),
            array('ElevenLabs', 'elevenlabs 语音合成', 'elevenlabs.io', 'elevenlabs'),
            array('GitHub Copilot', 'copilot', 'github.com', 'githubcopilot'),
            array('GitHub', 'github', 'github.com', 'github'),
            // ---- 云服务 / 网盘 ----
            array('阿里云', 'aliyun alibaba alibabacloud ecs oss', 'aliyun.com', 'alibabacloud'),
            array('腾讯云', 'tencentcloud tencent cloud', 'cloud.tencent.com', ''),
            array('华为云', 'huaweicloud huawei', 'huaweicloud.com', 'huawei'),
            array('百度智能云', 'baidu bce', 'cloud.baidu.com', ''),
            array('金山云', 'kingsoft ksyun', 'ksyun.com', ''),
            array('UCloud', 'ucloud', 'ucloud.cn', ''),
            array('七牛云', 'qiniu qn', 'qiniu.com', ''),
            array('又拍云', 'upyun', 'upyun.com', ''),
            array('Cloudflare', 'cloudflare cf cdn', 'cloudflare.com', 'cloudflare'),
            array('AWS', 'aws amazonweb 亚马逊云', 'aws.amazon.com', 'amazon'),
            array('Azure', 'azure microsoft 微软云', 'azure.microsoft.com', ''),
            array('谷歌云', 'gcp googlecloud google', 'cloud.google.com', ''),
            array('百度网盘', 'baidupan baidu 网盘', 'pan.baidu.com', ''),
            array('阿里云盘', 'alipan 网盘', 'www.alipan.com', ''),
            array('夸克网盘', 'quark 网盘', 'pan.quark.cn', ''),
            array('迅雷', 'thunder xunlei 迅雷会员', 'xunlei.com', ''),
            array('iCloud', 'icloud apple 苹果', 'icloud.com', 'icloud'),
            array('OneDrive', 'onedrive microsoft 微软', 'onedrive.live.com', ''),
            array('Google Drive', 'googledrive google 谷歌', 'drive.google.com', 'googledrive'),
            array('Dropbox', 'dropbox db', 'dropbox.com', 'dropbox'),
            array('坚果云', 'nutstore jianguoyun', 'jianguoyun.com', ''),
            // ---- 影音 / 视频 ----
            array('哔哩哔哩', 'bilibili b站 bili 大会员', 'bilibili.com', 'bilibili'),
            array('腾讯视频', 'tencentvideo vqq v.qq', 'v.qq.com', ''),
            array('爱奇艺', 'iqiyi 奇艺', 'iqiyi.com', ''),
            array('优酷', 'youku 优酷视频', 'youku.com', ''),
            array('芒果TV', 'mango mgtv 芒果', 'mgtv.com', ''),
            array('抖音', 'douyin tiktok', 'douyin.com', 'tiktok'),
            array('快手', 'kuaishou ks', 'kuaishou.com', ''),
            array('西瓜视频', 'xigua ixigua', 'ixigua.com', ''),
            array('剪映', 'capcut jianying', 'capcut.cn', ''),
            array('Netflix', 'netflix 奈飞', 'netflix.com', 'netflix'),
            array('Disney+', 'disney disneyplus 迪士尼', 'disneyplus.com', ''),
            array('YouTube', 'youtube yt google 谷歌', 'youtube.com', 'youtube'),
            array('哔哩哔哩漫画', 'bilibili漫画 漫画', 'manga.bilibili.com', ''),
            array('腾讯动漫', 'qq动漫 动漫', 'ac.qq.com', ''),
            array('快看漫画', 'kuaikan 快看', 'kuaikanmanhua.com', ''),
            // ---- 音乐 / 电台 ----
            array('QQ音乐', 'qqmusic qq y.qq 绿钻 豪华绿钻', 'y.qq.com', ''),
            array('网易云音乐', 'neteasecloudmusic netease 网易云 黑胶', 'music.163.com', 'neteasecloudmusic'),
            array('酷狗音乐', 'kugou 酷狗', 'kugou.com', ''),
            array('酷我音乐', 'kuwo 酷我', 'kuwo.cn', ''),
            array('汽水音乐', 'soda qishui', 'qishui.douyin.com', ''),
            array('Spotify', 'spotify', 'spotify.com', 'spotify'),
            array('Apple Music', 'applemusic apple 苹果', 'music.apple.com', 'applemusic'),
            array('喜马拉雅', 'ximalaya 喜马', 'ximalaya.com', ''),
            array('蜻蜓FM', 'qingting fm', 'qingting.fm', ''),
            array('小宇宙', 'xiaoyuzhou 播客', 'xiaoyuzhoufm.com', ''),
            // ---- 社交 / 通讯 ----
            array('微信', 'wechat wx', 'weixin.qq.com', 'wechat'),
            array('QQ', 'qq qq会员 qq会员svip', 'qq.com', 'qq'),
            array('QQ 空间', 'qzone qzone黄钻', 'qzone.qq.com', ''),
            array('QQ 会员', 'qqvip vip.qq 超级会员', 'vip.qq.com', ''),
            array('微博', 'weibo 微博会员', 'weibo.com', 'sinaweibo'),
            array('知乎', 'zhihu 知乎会员 盐选', 'zhihu.com', 'zhihu'),
            array('小红书', 'xiaohongshu rednote', 'xiaohongshu.com', 'xiaohongshu'),
            array('Telegram', 'tg telegram', 'telegram.org', 'telegram'),
            array('WhatsApp', 'whatsapp', 'whatsapp.com', 'whatsapp'),
            array('Discord', 'discord', 'discord.com', 'discord'),
            array('Twitter / X', 'twitter x', 'x.com', 'x'),
            array('Facebook', 'facebook fb', 'facebook.com', 'facebook'),
            array('Instagram', 'instagram ins', 'instagram.com', 'instagram'),
            array('Reddit', 'reddit', 'reddit.com', 'reddit'),
            array('钉钉', 'dingtalk dingding', 'dingtalk.com', ''),
            array('飞书', 'feishu lark', 'feishu.cn', ''),
            array('企业微信', 'wecom wxwork', 'work.weixin.qq.com', ''),
            // ---- 购物 / 电商 ----
            array('淘宝', 'taobao 88vip', 'taobao.com', 'taobao'),
            array('天猫', 'tmall', 'tmall.com', 'taobao'),
            array('京东', 'jd jingdong 京东plus', 'jd.com', ''),
            array('拼多多', 'pinduoduo pdd', 'pinduoduo.com', ''),
            array('美团', 'meituan 大众点评', 'meituan.com', ''),
            array('饿了么', 'eleme elearning 外卖', 'ele.me', ''),
            array('大众点评', 'dianping', 'dianping.com', ''),
            array('携程', 'ctrip 携程旅行', 'ctrip.com', ''),
            array('飞猪', 'fliggy 阿里旅行', 'fliggy.com', ''),
            array('亚马逊', 'amazon 亚马逊', 'amazon.cn', 'amazon'),
            array('淘宝买菜', 'taobaicai', 'taobao.com', ''),
            array('闲鱼', 'xianyu 二手', 'goofish.com', ''),
            array('Shopee', 'shopee 虾皮', 'shopee.cn', 'shopee'),
            array('AliExpress', 'aliexpress 速卖通', 'aliexpress.com', 'aliexpress'),
            // ---- 金融 / 支付 ----
            array('支付宝', 'alipay 支付宝会员', 'alipay.com', 'alipay'),
            array('微信支付', 'wechatpay wxpay', 'pay.weixin.qq.com', 'wechat'),
            array('云闪付', 'unionpay 银联', '95516.com', ''),
            array('同花顺', 'ths 炒股', '10jqka.com.cn', ''),
            array('东方财富', 'eastmoney 财富', 'eastmoney.com', ''),
            array('雪球', 'xueqiu 股票', 'xueqiu.com', ''),
            array('富途', 'futu moomoo 富途牛牛', 'futunn.com', ''),
            array('老虎证券', 'tiger tigerbrokers', 'laohu8.com', ''),
            array('招商银行', 'cmb 招行', 'cmbchina.com', ''),
            array('工商银行', 'icbc 工行', 'icbc.com.cn', ''),
            array('建设银行', 'ccb 建行', 'ccb.com', ''),
            array('农业银行', 'abc 农行', 'abchina.com', ''),
            array('中国银行', 'boc 中行', 'boc.cn', ''),
            array('平安', 'pingan 平安保险', 'pingan.com', ''),
            array('众安保险', 'zhongan 保险', 'zhongan.com', ''),
            array('PayPal', 'paypal', 'paypal.com', 'paypal'),
            array('Stripe', 'stripe', 'stripe.com', 'stripe'),
            // ---- 游戏 / 娱乐 ----
            array('Steam', 'steam', 'steampowered.com', 'steam'),
            array('Epic Games', 'epic fortnite', 'epicgames.com', 'epicgames'),
            array('PlayStation', 'psn playstation', 'playstation.com', 'playstation'),
            array('Xbox', 'xbox gamepass microsoft', 'xbox.com', 'xbox'),
            array('Nintendo', 'nintendo switch', 'nintendo.com', 'nintendo'),
            array('暴雪', 'blizzard 魔兽 炉石', 'blizzard.com', ''),
            array('米哈游', 'mihoyo hoyoverse 原神 星穹铁道', 'mihoyo.com', ''),
            array('网易游戏', 'neteasegame 梦幻西游', 'game.163.com', ''),
            array('Steam 充值卡', 'steamcard', 'steampowered.com', 'steam'),
            // ---- 硬件 / 数码 ----
            array('Apple', 'apple 苹果 iphone mac', 'apple.com', 'apple'),
            array('小米', 'xiaomi mi 米家', 'mi.com', 'xiaomi'),
            array('华为', 'huawei 鸿蒙', 'huawei.com', 'huawei'),
            array('OPPO', 'oppo', 'oppo.com', 'oppo'),
            array('vivo', 'vivo', 'vivo.com.cn', 'vivo'),
            array('荣耀', 'honor', 'honor.com', 'honor'),
            array('三星', 'samsung 三星电子', 'samsung.com', 'samsung'),
            array('索尼', 'sony 索尼耳机', 'sony.com', 'sony'),
            array('戴尔', 'dell', 'dell.com', 'dell'),
            array('联想', 'lenovo 小新 拯救者', 'lenovo.com.cn', 'lenovo'),
            array('惠普', 'hp 惠普电脑', 'hp.com', 'hp'),
            array('安克', 'anker 充电宝', 'anker.com', ''),
            array('绿联', 'ugreen', 'ugreen.com.cn', ''),
            array('Intel', 'intel 英特尔', 'intel.cn', 'intel'),
            array('NVIDIA', 'nvidia 英伟达 显卡', 'nvidia.cn', 'nvidia'),
            array('AMD', 'amd', 'amd.com', 'amd'),
            // ---- 开发 / 办公 / 效率 ----
            array('Notion', 'notion', 'notion.so', 'notion'),
            array('Figma', 'figma', 'figma.com', 'figma'),
            array('Adobe', 'adobe ps pr 全家桶', 'adobe.com', 'adobe'),
            array('Canva', 'canva 可画', 'canva.cn', 'canva'),
            array('Microsoft 365', 'microsoft365 office 微软office', 'microsoft365.com', 'microsoftoffice'),
            array('WPS', 'wps 金山办公', 'wps.cn', ''),
            array('印象笔记', 'evernote yinxiang', 'yinxiang.com', ''),
            array('有道云笔记', 'youdaocloudnote youdao', 'note.youdao.com', ''),
            array('有道词典', 'youdaodict youdao 翻译', 'dict.youdao.com', ''),
            array('Notion Calendar', 'notioncalendar cron', 'cron.com', ''),
            array('Slack', 'slack', 'slack.com', 'slack'),
            array('Zoom', 'zoom meeting', 'zoom.us', ''),
            array('腾讯会议', 'tencentmeeting voov', 'meeting.tencent.com', ''),
            array('石墨文档', 'shimo 文档', 'shimo.im', ''),
            array('语雀', 'yuque 蚂蚁文档', 'yuque.com', ''),
            array('GitLab', 'gitlab', 'gitlab.com', 'gitlab'),
            array('Bitbucket', 'bitbucket atlassian', 'bitbucket.org', ''),
            array('Docker', 'docker', 'docker.com', 'docker'),
            array('Vercel', 'vercel', 'vercel.com', 'vercel'),
            array('Netlify', 'netlify', 'netlify.com', 'netlify'),
            array('JetBrains', 'jetbrains ide idea', 'jetbrains.com', 'jetbrains'),
            array('Postman', 'postman', 'postman.com', ''),
            // ---- 学习 / 阅读 ----
            array('Duolingo', 'duolingo 多邻国', 'duolingo.com', 'duolingo'),
            array('流利说', 'liulishuo 英语', 'liulishuo.com', ''),
            array('Kindle', 'kindle amazon 电子书', 'amazon.cn', 'amazon'),
            array('掌阅', 'ireader izhen 小说', 'izhen.com', ''),
            array('QQ阅读', 'qqread yuewen 阅文 小说', 'yuewen.com', ''),
            array('起点读书', 'qidian 小说', 'qidian.com', ''),
            array('得到', 'dedao 知识付费', 'dedao.cn', ''),
            array('Coursera', 'coursera', 'coursera.org', ''),
            array('Udemy', 'udemy', 'udemy.com', ''),
            array('Medium', 'medium', 'medium.com', ''),
            // ---- 出行 / 生活服务 ----
            array('滴滴出行', 'didi 打车', 'didiglobal.com', ''),
            array('高德地图', 'amap gaode 高德', 'amap.com', ''),
            array('百度地图', 'baidumap 地图', 'map.baidu.com', ''),
            array('12306', 'railway 火车票 铁路', '12306.cn', ''),
            array('中国联通', 'chinaunicom unicom 联通', '10010.com', ''),
            array('中国移动', 'chinamobile cmcc 移动', '10086.cn', ''),
            array('中国电信', 'chinatelecom telecom 电信', '189.cn', ''),
            array('顺丰', 'sf sfexpress 顺丰速运', 'sf-express.com', ''),
            array('菜鸟', 'cainiao 菜鸟裹裹', 'cainiao.com', ''),
            array('中国邮政', 'ems chinapost', 'ems.com.cn', ''),
            array('国家电网', 'sgcc 电费', 'sgcc.com.cn', ''),
            array('Airbnb', 'airbnb 民宿', 'airbnb.cn', 'airbnb'),
            array('Booking', 'booking 缤客', 'booking.com', 'bookingdotcom'),
            array('Uber', 'uber', 'uber.com', 'uber'),
            array('大众点评外卖', 'dianpingord', 'dianping.com', ''),
        );
    }

    /** 品牌表 → 归一化索引（首次调用时构建，进程内缓存）。 */
    private static function index()
    {
        static $idx = null;
        if ($idx !== null) {
            return $idx;
        }
        $idx = array();
        foreach (self::table() as $row) {
            $name = (string) $row[0];
            $aliases = trim((string) $row[1]);
            $domain = strtolower(trim((string) $row[2]));
            $glyph = trim((string) $row[3]);
            $idx[] = array(
                'name'    => $name,
                'domain'  => $domain,
                'slug'    => $glyph,
                'aliases' => preg_split('/\s+/', $aliases, -1, PREG_SPLIT_NO_EMPTY)
                    ? preg_split('/\s+/', $aliases, -1, PREG_SPLIT_NO_EMPTY)
                    : array(),
            );
        }
        return $idx;
    }

    /* ==========================================================
     * 查询归一化 / 打分（★与 /api/icon/search 保持同一套中文口径）
     * ========================================================== */

    /** 查询串归一：小写、去空白、全角→半角、常见后缀（会员/月卡/年卡）剥离。 */
    public static function normalizeQuery($q)
    {
        $s = trim((string) $q);
        if ($s === '') {
            return '';
        }
        // 全角 → 半角（「Ｂ站」这种）
        if (function_exists('mb_convert_kana')) {
            $s = mb_convert_kana($s, 'as', 'UTF-8');
        } else {
            $s = strtolower($s);
        }
        $s = strtolower($s);
        $s = preg_replace('/\s+/', '', $s);
        /* 分隔符归一：「阿里云 · 包年」→「阿里云」；「阿里云/腾讯云」这种多品牌留在第一阶段。
         * 只把**非单词字符**（·、-、_、()、/、+ 等）当分隔符；`.` 保留（域名要用）。 */
        $s = preg_replace('/[·•‧・,、丨|\/(\[【{「]+/u', ' ', $s);
        /* 订阅名里常见的「尾巴」不参与品牌匹配：
         * 「阿里云 包年」「B站 大会员 年卡」「Netflix 家庭版」→ 阿里云 / b站 / netflix */
        $tails = array(
            'supervip', 'vip', 'svip', 'plus', 'pro', 'premium', '会员', '大会员', '超级会员',
            '年卡', '季卡', '月卡', '包年', '包月', '年付', '月付', '续费', '自动续费', '订阅',
            '家庭版', '学生版', '个人版', '专业版', '标准版', '基础版', '体验版', '黑胶', '绿钻',
            '豪华绿钻', '盐选', '会员版', '连续包月', '连续包年',
        );
        $words = preg_split('/\s+/', trim($s), -1, PREG_SPLIT_NO_EMPTY);
        if ($words === false) {
            $words = array($s);
        }
        /* 先剥「尾巴」，直到一个词都不剩地剥不动为止。
         * 规则：只要剥完还剩 ≥2 个字符（避免把「vip」整名剥没）就允许剥。
         * 中文词整名被剥（「哔哩哔哩会员」→「哔哩哔哩」）是想要的：
         * 主名本身一定能被 contains/prefix 命中；万一剥过头还有两阶段主词重试兜底。 */
        $strip = function ($x) use ($tails) {
            $guard = 0;
            $again = true;
            while ($again && $guard < 12) {
                $again = false;
                $guard++;
                foreach ($tails as $t) {
                    $len = strlen($t);
                    if ($len === 0 || strlen($x) <= $len + 1) {
                        continue;
                    }
                    if (substr($x, - $len) === $t) {
                        $x = substr($x, 0, - $len);
                        $again = true;
                        break;
                    }
                }
                /* 「QQ会员SVIP」→ 小写「qq会员svip」→ 剥「svip」后剩「qq会员」→ 剥「会员」后剩「qq」。
                 * 但尾巴表里没有孤立的 "s"/"x"/"版"，所以再加一条通用规则：
                 * **中文词（≥2 字）后面挂着的 1~3 个 ASCII 字母**一律当后缀剥掉
                 * （「会员s」「版pro」都算），纯 ASCII 的品牌名（netflix/qq）决不受影响。 */
                if (preg_match('/^(.{2,}[\x{4e00}-\x{9fa5}])([a-z]{1,3})$/ui', $x, $mm)) {
                    $x = $mm[1];
                    $again = true;
                    break;
                }
            }
            return $x;
        };
        foreach ($words as $i => $w) {
            $words[$i] = $strip($w);
        }
        $words = array_values(array_filter($words, function ($w) {
            return $w !== '';
        }));
        if (!$words) {
            $words = array($s);
        }
        /* 去分隔符拼接后再剥一次尾巴（「阿里云 包年」→ 先拼成「阿里云包年」再剥「包年」）。
         * 顺序很关键：先按空格逐词剥，能处理「Netflix 家庭版」；拼接后再剥，能处理
         * 「阿里云 包年」「哔哩哔哩 年卡」这种分隔符 + 尾巴同时出现的情况。 */
        $joined = trim(implode('', $words));
        if ($joined === '') {
            $joined = $s;
        }
        $joined = $strip($joined);
        /* 中文单字残留：剥完只剩「大」这种 1 字尾巴（「b站大会员」→「b站大」），并回主名。 */
        if (mb_strlen($joined, 'UTF-8') >= 3 && preg_match('/^(.+?)(.)$/u', $joined, $m)) {
            $cand = $m[1];
            if (mb_strlen($cand, 'UTF-8') >= 2 && preg_match('/^[大\.]$/u', $m[2])) {
                $joined = $cand;
            }
        }
        return trim($joined);
    }

    /**
     * 查询串的「主词」：去掉版本号/容量等噪点（iCloud 50G → icloud），用于第二阶段重试。
     */
    private static function primaryOf($nq)
    {
        $s = preg_replace('/\d+(\.\d+)?\s*(g|gb|t|tb|m|mb|元|块|个|年|月|天)\b/i', ' ', $nq);
        $s = preg_replace('/\b\d+\b/', ' ', (string) $s);
        $s = str_replace(array('+', '-', '_'), ' ', (string) $s);
        $s = preg_replace('/\s+/', '', $s);
        return (string) $s;
    }

    /** 编辑距离（≤2 时用于错拼纠正，如 netfilx → netflix）。 */
    private static function levenshtein($a, $b)
    {
        $la = mb_strlen($a, 'UTF-8');
        $lb = mb_strlen($b, 'UTF-8');
        if ($la === 0) {
            return $lb;
        }
        if ($lb === 0) {
            return $la;
        }
        if (abs($la - $lb) > 3) {
            return 999;
        }
        if (function_exists('levenshtein')) {
            return levenshtein(self::asciiOf($a), self::asciiOf($b));
        }
        return 999;
    }

    /** 多字节安全：只用于编辑距离时把中文降级成占位（中文靠子串匹配，不靠距离）。 */
    private static function asciiOf($s)
    {
        return preg_replace('/[^\x20-\x7E]/', '?', (string) $s);
    }

    /**
     * 给一条品牌打一个分。返回 0 表示不匹配。
     * @param array  $entry  index() 的一行
     * @param string $q      normalizeQuery 之后的查询串
     * @param bool   $isDomainLike 查询本身像域名 / slug
     */
    private static function score($entry, $q, $isDomainLike)
    {
        $best = 0;
        $why = '';
        $set = function ($s, $w) use (&$best, &$why) {
            if ($s > $best) {
                $best = $s;
                $why = $w;
            }
        };

        $name = strtolower($entry['name']);
        $domain = $entry['domain'];
        $slug = strtolower($entry['slug']);
        $bare = preg_replace('/^www\./', '', $domain);
        $host = preg_replace('/\..*$/', '', $bare); // aliyun.com → aliyun

        if ($isDomainLike) {
            if ($q === $domain || $q === $bare) {
                $set(self::SCORE_DOMAIN, 'domain');
            }
            if ($host !== '' && $q === $host) {
                $set(self::SCORE_SLUG, 'domain-host');
            }
        }
        if ($slug !== '' && $q === $slug) {
            $set(self::SCORE_SLUG, 'slug');
        }
        if ($q === $name) {
            $set(self::SCORE_EXACT, 'name');
        }
        foreach ($entry['aliases'] as $a) {
            $a = strtolower($a);
            if ($a === '') {
                continue;
            }
            if ($q === $a) {
                $set(self::SCORE_ALIAS, 'alias');
            } elseif ($a !== '' && strpos($a, $q) === 0 && strlen($q) >= 2) {
                $set(self::SCORE_PREFIX, 'alias-prefix');
            } elseif (strlen($a) >= 3 && strpos($q, $a) !== false) {
                $set(self::SCORE_CONTAIN, 'alias-contain');
            }
            if ($a !== '' && $q !== $a && strlen($q) >= 4 && preg_match('/^[a-z0-9\-]+$/', $q)
                && preg_match('/^[a-z0-9\-]+$/', $a) && abs(strlen($a) - strlen($q)) <= 3) {
                $dist = self::levenshtein($q, $a);
                if ($dist === 1) {
                    $set(self::SCORE_TYPO, 'alias-typo');
                } elseif ($dist === 2) {
                    $set(self::SCORE_FUZZY, 'alias-fuzzy');
                }
            }
        }
        if ($domain !== '' && strlen($q) >= 3 && strpos($domain, $q) !== false) {
            $set(self::SCORE_CONTAIN, 'domain-contain');
        }
        if ($name !== '' && $q !== $name && mb_strlen($q, 'UTF-8') >= 2) {
            if (mb_strpos($name, $q, 0, 'UTF-8') === 0) {
                $set(self::SCORE_PREFIX, 'name-prefix');
            } elseif (mb_strpos($name, $q, 0, 'UTF-8') !== false) {
                $set(self::SCORE_CONTAIN, 'name-contain');
            }
        }
        return array($best, $why);
    }

    /* ==========================================================
     * 对外：按名字查图标
     * ========================================================== */

    /** 跑一轮匹配，返回 array(排序后的命中列表, 实际使用的查询串)。 */
    private static function runMatch($usedQuery)
    {
        $isDomainLike = (bool) preg_match('/^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+$/', $usedQuery)
            || (bool) preg_match('/^[a-z0-9\-]{3,}$/', $usedQuery);

        $ranked = array();
        foreach (self::index() as $e) {
            list($s, $why) = self::score($e, $usedQuery, $isDomainLike);
            if ($s <= 0) {
                continue;
            }
            $ranked[] = array('entry' => $e, 'score' => $s, 'why' => $why);
        }
        // 同分按域名短优先（根域比子域更「是这家」），再按名字稳定排序
        usort($ranked, function ($x, $y) {
            if ($x['score'] !== $y['score']) {
                return $y['score'] - $x['score'];
            }
            $dx = substr_count($x['entry']['domain'], '.');
            $dy = substr_count($y['entry']['domain'], '.');
            if ($dx !== $dy) {
                return $dx - $dy;
            }
            return strcmp($x['entry']['domain'], $y['entry']['domain']);
        });
        return array($ranked, $usedQuery);
    }

    /**
     * 查一个名字对应的品牌图标。
     *
     * @param string $q         订阅名 / 物品名（阿里云、B站大会员、Netflix 年卡…）
     * @param string $baseUrl   站点根（用于拼绝对 URL；传 '' 则只给相对路径）
     * @param int    $limit     候选数量上限
     * @return array 见下方返回体
     */
    public static function find($q, $baseUrl = '', $limit = 5)
    {
        $raw = trim((string) $q);
        $nq = self::normalizeQuery($raw);
        $limit = max(1, min(20, (int) $limit));
        if ($nq === '') {
            return array('query' => $raw, 'normalized' => '', 'matched' => null, 'candidates' => array(), 'suggestion' => self::suggestion($raw, '', null, $baseUrl));
        }

        /* 两阶段：
         * ① 用完整归一结果查（带版本号/容量也能中，如 iCloud 50G → icloud50g）；
         * ② 没中就用「主词」再查一次（icloud），提高长名字的召回。 */
        list($hits, $usedQuery) = self::runMatch($nq);
        if (!$hits) {
            $primary = self::primaryOf($nq);
            if ($primary !== '' && $primary !== $nq) {
                list($hits2, $_) = self::runMatch($primary);
                if ($hits2) {
                    $hits = $hits2;
                    $usedQuery = $primary;
                }
            }
        }

        $candidates = array();
        foreach ($hits as $h) {
            if (count($candidates) >= $limit) {
                break;
            }
            $candidates[] = self::entryPayload($h['entry'], $h['score'], $h['why'], $baseUrl);
        }
        $top = $candidates ? $candidates[0] : null;
        // 最高分不足阈值 → 不给 matched，只给候选建议（让 Agent 自己决定要不要用）
        $matched = ($top !== null && $top['score'] >= self::ACCEPT_MIN) ? $top : null;
        return array(
            'query'      => $raw,
            'normalized' => $nq,
            'usedQuery'  => $usedQuery,
            'matched'    => $matched,
            'candidates' => $candidates,
            'suggestion' => self::suggestion($raw, $nq, $matched, $baseUrl),
        );
    }

    /** 一条品牌结果 → 对 Agent 友好的完整形态。 */
    private static function entryPayload($entry, $score, $why, $baseUrl)
    {
        $domain = $entry['domain'];
        $hasLocal = self::hasLocalFile($domain);
        /* 四种落库写法，Agent 挑一种写进 subscriptions.icon：
         *  builtin：lucide id（没品牌时的通用图标）
         *  brand  ：`brand:<slug>` 引用码（备份只带几个字节，客户端即时绘制，★首选）
         *  url    ：`url:<图片地址>`（随包品牌图 / 服务端回源代理）
         */
        $icon = array();
        if ($entry['slug'] !== '') {
            $icon['brand'] = 'brand:' . $entry['slug'];
        }
        if ($hasLocal) {
            $icon['local'] = '/brand-icons/' . self::localFileName($domain);
        }
        $icon['proxy']  = '/api/icon/img?d=' . rawurlencode($domain);
        $icon['absolute'] = ($baseUrl !== '' ? rtrim($baseUrl, '/') : '')
            . '/api/icon/img?d=' . rawurlencode($domain);
        $emojis = self::emojiFor($entry['name']);
        $icon['emoji']  = $emojis;
        return array(
            'name'       => $entry['name'],
            'domain'     => $domain,
            'slug'       => $entry['slug'],
            'score'      => $score,
            'match'      => $why,
            'accept'     => $score >= self::ACCEPT_MIN,
            'bundled'    => $hasLocal,
            'icon'       => $icon,
            'write'      => $entry['slug'] !== '' ? 'brand:' . $entry['slug'] : ($hasLocal ? '/brand-icons/' . self::localFileName($domain) : '/api/icon/img?d=' . rawurlencode($domain)),
            'emojis'     => $emojis,
            'aliases'    => $entry['aliases'],
        );
    }

    /** 没有命中品牌时的建议（告诉 Agent 下一步怎么走，而不是干瞪眼）。 */
    private static function suggestion($raw, $nq, $matched, $baseUrl)
    {
        $emojis = self::emojiFor($raw);
        if ($matched !== null) {
            return array(
                'action' => 'use-icon',
                'icon'   => $matched['write'],
                'note'   => '直接写进 subscriptions.icon（brand: 引用码最轻，随备份只带几个字节）。',
            );
        }
        return array(
            'action'   => 'fallback',
            'icon'     => 'credit-card',
            'emojis'   => $emojis,
            'steps'    => array(
                '1. 名称里带域名（如 aliyun.com）或品牌英文名（aliyun）时，再查一次 /api/ai/icons，命中率会高很多。',
                '2. 知道官网域名：直接写 `url:/api/icon/img?d=<域名>`（服务端抓真实站点图标并缓存，离线由随包品牌图兜底）。',
                '3. 想用通用图形图标：GET /api/icon/search?q=<关键词> 拿 Iconify 图标 id，写 `source:builtin` 或 `url:/api/icon/proxy?u=…`。',
                '4. 都不合适：用 emoji（' . implode(' ', $emojis) . '）或保留默认 credit-card。',
            ),
            'note'     => '没找到品牌也不影响写入 —— subscriptions.icon 缺省会补 credit-card。',
            'endpoints' => array(
                'brandSearch' => ($baseUrl !== '' ? rtrim($baseUrl, '/') : '') . '/api/ai/icons?q=<名称>',
                'iconify'     => ($baseUrl !== '' ? rtrim($baseUrl, '/') : '') . '/api/icon/search?q=<关键词>',
                'siteIcon'    => '/api/icon/img?d=<域名>',
            ),
        );
    }

    /* ==========================================================
     * 静止数据：随包图标文件 / emoji 兜底
     * ========================================================== */

    /** 随包品牌图标目录（server/brand-icons/，177 个）。 */
    private static function localDir()
    {
        // index.php 里用的是 GF_ROOT . '/storage/brand-icons'（站点实际落点），
        // 而随包目录是 GF_ROOT . '/brand-icons'；两处都查，任一处命中即算「有本地图」。
        return array(GF_ROOT . '/brand-icons', GF_ROOT . '/storage/brand-icons');
    }

    public static function localFileName($domain)
    {
        $domain = strtolower(trim((string) $domain));
        foreach (array('png', 'svg', 'webp', 'jpg', 'jpeg', 'ico', 'gif') as $ext) {
            foreach (self::localDir() as $dir) {
                if (is_file($dir . '/' . $domain . '.' . $ext)) {
                    return $domain . '.' . $ext;
                }
            }
        }
        return '';
    }

    private static function hasLocalFile($domain)
    {
        return self::localFileName($domain) !== '';
    }

    /**
     * 品牌名 → emoji 兜底（与 index.php 的 /api/icon/search 词典同一口径）。
     * 分类粗映射，够 Agent 在「没图」时聊胜于无。
     */
    /** 品牌名 → emoji 兜底（与 index.php 的 /api/icon/search 词典同一口径）。
     * ★按「从具体到宽泛」排序：先命中先返回。「网易云音乐」不能被 `云` 抢走，
     * 「腾讯云」也不能被 `腾讯视频` 抢走 —— 所以具体品类（音乐/视频/游戏…）排在云之前。 */
    public static function emojiFor($name)
    {
        $n = strtolower((string) $name);
        $rules = array(
            // ① 具体品类（最容易被泛词抢走，优先）
            '音乐|fm|music|spotify|电台|喜马拉雅|播客|小宇宙|酷狗|酷我|网易云|qq音乐|apple music' => array('🎵', '🎧'),
            '视频|影|tv|netflix|disney|youtube|bili|iqiyi|youku|mango|抖音|快手|西瓜|剪映|哔哩|哔哩哔哩|爱奇艺|优酷|芒果|腾讯视频' => array('📺', '🎬'),
            '游戏|steam|epic|playstation|xbox|nintendo|暴雪|米哈游|网易游戏|充值' => array('🎮', '🕹️'),
            '学习|教育|阅读|书|kindle|duolingo|流利|掌阅|起点|得到|coursera|udemy|medium|q阅读' => array('📚', '🎓'),
            'office|adobe|figma|notion|slack|zoom|会议|文档|语雀|石墨|wps|笔记|词典|git|jetbrains|postman|microsoft|印象|有道|canva' => array('💼', '📝'),
            '社交|微信|qq|微博|知乎|小红书|telegram|whatsapp|discord|twitter|facebook|instagram|reddit|钉钉|飞书|qq空间' => array('💬', '👥'),
            '购物|淘宝|京东|拼多多|美团|饿了么|电商|amazon|shopee|闲鱼|点评|买菜|天猫|亚马逊' => array('🛒', '🛍️'),
            '银行|支付|证券|股票|保险|alipay|paypal|stripe|银联|闪付|同花顺|东方财富|雪球|富途|老虎|招商|工商|建设|农业|中国银行|平安|众安' => array('💳', '🏦'),
            '出行|打车|地图|火车|铁路|联通|移动|电信|顺丰|菜鸟|邮政|电网|airbnb|booking|uber|电费|话费|流量|滴滴|高德|12306|携程|飞猪' => array('🚗', '📶'),
            '手机|apple|xiaomi|华为|oppo|vivo|荣耀|samsung|sony|dell|联想|电脑|耳机|数码|小米|三星|惠普|安克|绿联|intel|nvidia|amd' => array('📱', '💻'),
            'ai|claude|chatgpt|openai|deepseek|kimi|gemini|perplexity|mistral|ollama|hugging|copilot|eleven|助手|大模型' => array('🤖', '✨'),
            // ② 泛品类（兜底，放最后）
            '会员|订阅' => array('🎫', '💳'),
            '云|cloud|aws|azure|drive|网盘|dropbox|oss|cdn|vercel|netlify|docker|存储|盘' => array('☁️', '🗄️'),
        );
        foreach ($rules as $kw => $emojis) {
            if (preg_match('/(' . $kw . ')/i', $n)) {
                return $emojis;
            }
        }
        return array('📦');
    }

    /* ==========================================================
     * 清单（Agent 想「浏览品牌库」时用）
     * ========================================================== */

    /** 全部品牌（可按 group 关键词过滤），返回极简字段。 */
    public static function listAll($keyword = '', $limit = 0)
    {
        $kw = strtolower(trim((string) $keyword));
        $out = array();
        foreach (self::index() as $e) {
            if ($kw !== '') {
                $hay = strtolower($e['name'] . ' ' . implode(' ', $e['aliases']) . ' ' . $e['domain']);
                if (strpos($hay, $kw) === false) {
                    continue;
                }
            }
            $out[] = array(
                'name'   => $e['name'],
                'domain' => $e['domain'],
                'slug'   => $e['slug'],
                'icon'   => $e['slug'] !== '' ? 'brand:' . $e['slug'] : '/api/icon/img?d=' . rawurlencode($e['domain']),
                'bundled' => self::hasLocalFile($e['domain']),
            );
            if ($limit > 0 && count($out) >= $limit) {
                break;
            }
        }
        return $out;
    }

    /** 统计（供 /api/ai/icons?q= 的 meta 与健康自检用）。 */
    public static function stats()
    {
        $all = self::index();
        $bundled = 0;
        $glyphs = 0;
        $domains = array();
        foreach ($all as $e) {
            if ($e['slug'] !== '') {
                $glyphs++;
            }
            if (self::hasLocalFile($e['domain'])) {
                $bundled++;
            }
            $domains[$e['domain']] = true;
        }
        $dir = '';
        foreach (self::localDir() as $d) {
            if (is_dir($d)) {
                $dir = $d;
                break;
            }
        }
        return array(
            'brands'          => count($all),
            'uniqueDomains'   => count($domains),
            'withGlyph'       => $glyphs,
            'withBundledIcon' => $bundled,
            'brandIconsDir'   => ($dir !== '' ? preg_replace('#.*/#', '', $dir) . '/' : ''),
        );
    }
}
