<?php
/**
 * 纳物 NaWu · IP 归属地查询（v1.1.7）
 *
 * 为什么自带库：前端原来靠 ipwho.is / ipapi.co 这类境外免费接口，国内手机 IP
 * 常被归到省会甚至直接给北京（用户实测：河南南阳桐柏 → 郑州/北京），区县级
 * 根本拿不到；国内能到区县的公开接口（淘宝 / 百度开放数据 / pconline）要么
 * 只给到市级、要么限流严重。So：随站点带一份纯真 IP 库（qqwry.dat，GBK，含区县），
 * 本地二分查找 —— 零外部依赖、无限流、不把用户 IP 交给第三方。
 *
 * 文件：app/data/qqwry.dat（约 26MB，随服务端包下发）。缺失时本类静默返回 null，
 * 前端自动降级为「只显示省市」，不会白屏。
 *
 * 记录格式（纯真标准，对齐 lib-qqwry 的实现）：
 *   文件头 8 字节 = 首索引偏移(4,LE) + 末索引偏移(4,LE)
 *   索引条目 7 字节 = 起始 IP(4,LE) + 记录偏移(3,LE)
 *   记录区：结束 IP(4) + [flag(1) + 3 字节偏移] 或 [国家串...]
 *     flag=1 → 跳到偏移处再判一次：
 *                flag=2 → 国家串 = 偏移处再跳一层；地区从 p+4 起
 *                否则   → 国家串就地，地区紧随其后
 *     flag=2 → 国家串 = 偏移处字符串；地区从 p+4 起
 *     其他   → 国家串就地（该字节就是串首字节），地区紧随其后
 *   地区：若首字节是 1/2 则再跳一层，否则就地。
 *
 * 地址串形如「中国–河南–南阳–桐柏县」（新版用 en-dash 分段），
 * 旧格式也可能是「河南省南阳市」，故 splitAddress() 两条路都吃。
 */
class GF_IpLoc
{
    private static $fp = null;
    private static $head = 0;
    private static $tail = 0;
    private static $size = 0;
    private static $ready = false;
    private static $memo = array();

    /**
     * 查询一个 IPv4 的归属地。
     *
     * @return array|null array(province, city, district, isp, text, display)
     *                    display 是给前端展示的最短地名（区县 > 市 > 省）
     */
    public static function lookup($ip)
    {
        $ip = trim((string) $ip);
        if ($ip === '' || !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return null;
        }
        if (isset(self::$memo[$ip])) {
            return self::$memo[$ip];
        }
        if (!self::open()) {
            return null;
        }
        $ipNum = sprintf('%u', ip2long($ip));
        if ($ipNum === false) {
            return null;
        }

        /* —— 二分：找最后一个「起始 IP <= 目标」的索引条目（只比 start，与 lib-qqwry 一致） —— */
        $b = self::$head;
        $e = self::$tail;
        $g = $b;
        $guard = 0;
        while ($b < $e && $guard++ < 64) {
            $mid = (int) ((($e - $b) / 7) / 2) * 7 + $b;
            if ($mid <= $b) {
                $mid = $b + 7;
            }
            $g = $mid;
            $start = self::u32($g);
            if (self::cmpNum($ipNum, $start) > 0) {
                $b = $g;
            } elseif (self::cmpNum($ipNum, $start) < 0) {
                if ($g >= $e) {
                    $g -= 7;
                    break;
                }
                $e = $g;
            } else {
                break;
            }
        }

        $text = self::recordAddress($g);
        if ($text === null || $text === '') {
            return null;
        }
        $parsed = self::splitAddress($text);
        self::$memo[$ip] = $parsed;
        return $parsed;
    }

    /** 库是否可用 */
    public static function available()
    {
        return self::open();
    }

    /**
     * 行政区划中心点 → 天气用的经纬度（v1.1.7）。
     *
     * 公开地名词典（含 open-meteo）普遍查不到区县，「桐柏县」返回空 →
     * 前端只能退回省会，这正是「人在桐柏、天气显示郑州」的根因。
     * 所以随包带一张 geo-cn.json（源：阿里 DataV 行政区划中心点，2874 条），
     * 键是纯真库的写法「省|市|区县」，查不到区县就退市、再退省。
     *
     * @return array|null array(lat, lon, accuracy)  accuracy: 2 区县 / 1 市 / 0 省
     */
    public static function coords($province, $city, $district)
    {
        static $table = null;
        if ($table === null) {
            $table = array();
            $file  = GF_ROOT . '/app/data/geo-cn.json';
            if (is_file($file)) {
                $raw = @file_get_contents($file);
                if ($raw !== false && $raw !== '') {
                    $d = json_decode($raw, true);
                    if (is_array($d)) {
                        $table = $d;
                    }
                }
            }
        }
        if (!$table) {
            return null;
        }
        $province = (string) $province;
        $city     = (string) $city;
        $district = (string) $district;

        /* 表里的键用的是纯真库原文（河南 / 南阳），本类解析出来是规范名
         * （河南省 / 南阳市），查之前统一去掉「省/市/自治区…」后缀。 */
        $strip = function ($s) {
            $s = (string) $s;
            return (string) preg_replace('/(特别行政区|自治区|自治州|地区|市|省|盟)$/u', '', $s);
        };
        $p = $strip($province);
        $c = $strip($city);
        $d = $district;

        $candidates = array();
        if ($d !== '') {
            $candidates[] = $p . '|' . $c . '|' . $d;
        }
        $candidates[] = $p . '|' . $c . '|';
        $candidates[] = $province . '|' . $city . '|' . $d;
        $candidates[] = $province . '|' . $city . '|';
        $candidates[] = $p . '||' . $d;
        $candidates[] = $p . '|' . $d . '|';
        $candidates[] = $p . '|' . $c . '|';
        $candidates[] = $p . '||';

        foreach ($candidates as $k) {
            if ($k !== '' && $k !== '||' && isset($table[$k]) && is_array($table[$k]) && count($table[$k]) >= 2) {
                $v = $table[$k];
                return array((float) $v[0], (float) $v[1], isset($v[2]) ? (int) $v[2] : 1);
            }
        }
        return null;
    }

    /* ---------------- 内部实现 ---------------- */

    private static function open()
    {
        if (self::$ready) {
            return self::$fp !== null;
        }
        self::$ready = true;

        $candidates = array(
            dirname(__DIR__) . '/data/qqwry.dat',
        );
        $path = null;
        foreach ($candidates as $p) {
            if (is_file($p) && filesize($p) > 1024) {
                $path = $p;
                break;
            }
        }
        if ($path === null) {
            return false;
        }
        $fp = @fopen($path, 'rb');
        if (!$fp) {
            return false;
        }
        self::$fp   = $fp;
        self::$size = (int) filesize($path);
        $h = self::read(0, 8);
        if ($h === false) {
            self::close();
            return false;
        }
        $a = unpack('Vfirst/Vlast', $h);
        self::$head = (int) $a['first'];
        self::$tail = (int) $a['last'];
        if (self::$head < 8 || self::$tail <= self::$head || self::$tail >= self::$size) {
            self::close();
            return false;
        }
        return true;
    }

    private static function close()
    {
        if (self::$fp) {
            @fclose(self::$fp);
        }
        self::$fp = null;
    }

    private static function read($off, $len)
    {
        if (!self::$fp || $off < 0 || $off + $len > self::$size) {
            return false;
        }
        if (fseek(self::$fp, $off) !== 0) {
            return false;
        }
        $buf = fread(self::$fp, $len);
        return ($buf === false || strlen($buf) < $len) ? false : $buf;
    }

    /** 4 字节小端无符号（返回字符串，避免 32 位 PHP 溢出） */
    private static function u32($off)
    {
        $b = self::read($off, 4);
        if ($b === false) {
            return '0';
        }
        $v = unpack('V', $b);
        return sprintf('%u', $v[1]);
    }

    /** 3 字节小端 */
    private static function u24($off)
    {
        $b = self::read($off, 3);
        if ($b === false) {
            return -1;
        }
        return ord($b[0]) | (ord($b[1]) << 8) | (ord($b[2]) << 16);
    }

    /** 单字节 */
    private static function byte($off)
    {
        $b = self::read($off, 1);
        return $b === false ? -1 : ord($b);
    }

    /** 大数比较（两边都是十进制字符串） */
    private static function cmpNum($a, $b)
    {
        $la = strlen($a);
        $lb = strlen($b);
        if ($la !== $lb) {
            return $la > $lb ? 1 : -1;
        }
        if ($a === $b) {
            return 0;
        }
        return strcmp($a, $b) > 0 ? 1 : -1;
    }

    /** 从索引条目解析出「国家 + 地区」原始串（GBK 已转 UTF-8） */
    private static function recordAddress($indexOff)
    {
        $rec = self::u24($indexOff + 4);
        if ($rec < 0) {
            return null;
        }
        $p  = $rec + 4;              // 跳过结束 IP
        $lx = self::byte($p);
        if ($lx < 0) {
            return null;
        }

        if ($lx === 1) {
            $p = self::u24($p + 1);
            if ($p < 0) {
                return null;
            }
            $lx2 = self::byte($p);
            if ($lx2 === 2) {
                $country = self::readString(self::u24($p + 1));
                $p += 4;
            } else {
                $country = self::readString($p);
                $p += strlen($country) + 1;
            }
            $area = self::readArea($p);
        } elseif ($lx === 2) {
            $country = self::readString(self::u24($p + 1));
            $area    = self::readArea($p + 4);
        } else {
            $country = self::readString($p);
            $p += strlen($country) + 1;
            $area = self::readArea($p);
        }

        $c = trim(self::gbk($country));
        $a = trim(self::gbk($area));
        $text = trim($c . ($a !== '' ? ' ' . $a : ''));
        return $text === '' ? null : $text;
    }

    private static function readArea($off)
    {
        $one = self::byte($off);
        if ($one === 1 || $one === 2) {
            $ao = self::u24($off + 1);
            if ($ao <= 0) {
                return '';
            }
            return self::readString($ao);
        }
        if ($one < 0) {
            return '';
        }
        return self::readString($off);
    }

    /** 读以 \0 结束的字符串（最多 256 字节） */
    private static function readString($off)
    {
        if ($off < 0) {
            return '';
        }
        $b = self::read($off, 256);
        if ($b === false) {
            return '';
        }
        $pos = strpos($b, "\0");
        return $pos === false ? $b : substr($b, 0, $pos);
    }

    private static function gbk($s)
    {
        if ($s === '') {
            return '';
        }
        if (function_exists('mb_convert_encoding')) {
            $r = @mb_convert_encoding($s, 'UTF-8', 'GBK');
            if ($r !== false && $r !== '') {
                return $r;
            }
        }
        if (function_exists('iconv')) {
            $r = @iconv('GBK', 'UTF-8//IGNORE', $s);
            if ($r !== false) {
                return $r;
            }
        }
        return $s;
    }

    /**
     * 拆「国家–省–市–区县 运营商」→ 省 / 市 / 区县 / 运营商。
     * 新版库用 en-dash 分段，旧版是「河南省南阳市桐柏县」连写，两条路都吃。
     */
    /**
     * 把库里的地址串拆成 省 / 市 / 区县 / 运营商。
     *
     * 库里实测有这些形态：
     *   中国-河南-南阳-桐柏县                    → 省 / 市 / 区县
     *   中国-河南-南阳                          → 省 / 市
     *   中国-江苏-南京 南京信风…DNS服务器         → 段内空格后面粘着运营商说明
     *   中国-广东-广州 移动/北京百度网讯…移动节点   → 同上，还可能带斜杠
     *   美国-加利福尼亚州-圣克拉拉-山景城          → 非中国，不能补「省/市」后缀
     *   澳大利亚 APNIC_Debogon-prefix网络         → 段里混着机构名，要剔掉
     */
    private static function splitAddress($text)
    {
        $raw = trim((string) $text);
        if ($raw === '') {
            return null;
        }
        $raw = str_replace(array('CZ88.NET', '纯真网络', '纯真'), '', $raw);
        /* en-dash / em-dash / 全角横线统一成 ASCII 分隔符 */
        $raw = str_replace(array("\xe2\x80\x93", "\xe2\x80\x94", '－', '—', '–'), '-', $raw);
        $raw = trim($raw);
        if ($raw === '') {
            return null;
        }

        /* ---- 1) 切段：段内空格之后多半是运营商/机构说明，只留第一个词作地名 ---- */
        $segs  = array();
        $noise = array();
        foreach (explode('-', $raw) as $chunk) {
            $chunk = trim($chunk);
            if ($chunk === '') {
                continue;
            }
            $bits = preg_split('/\s+/u', $chunk);
            $head = trim((string) array_shift($bits));
            $tail = trim(implode(' ', $bits));
            if ($head !== '') {
                $segs[] = $head;
            }
            if ($tail !== '') {
                $noise[] = $tail;
            }
        }

        /* 机构名混进了地名段（「…科技股份有限公司」「…网络」「…DNS服务器」）→ 挪进 noise */
        $junkRe = '/(公司|网络|科技|服务器|节点|DNS|信息|通信|集团|有限|股份|宽带|网吧|数据|机房|IDC|互联网|anycast|Anycast|教育网)/u';
        $clean  = array();
        foreach ($segs as $s) {
            if (preg_match($junkRe, $s)) {
                $noise[] = $s;
            } else {
                $clean[] = $s;
            }
        }
        $segs = $clean;
        if (!$segs) {
            return null;
        }

        /* ---- 2) 国别 ---- */
        $cn = false;
        if ($segs[0] === '中国' || $segs[0] === '中國') {
            $cn = true;
            array_shift($segs);
        } elseif (count($segs) >= 2 && preg_match('/(省|自治区)$/u', $segs[0])) {
            $cn = true;
        }
        if (!$segs) {
            return null;
        }

        $province = '';
        $city     = '';
        $district = '';

        if ($cn) {
            $province = (string) $segs[0];
            $rest     = array_slice($segs, 1);
            /* 直辖市的重复段（北京-北京）去掉 */
            if (count($rest) >= 2 && $rest[0] === $province) {
                array_shift($rest);
            }
            if (count($rest) >= 2) {
                $city     = (string) $rest[0];
                $district = (string) $rest[1];
            } elseif (count($rest) === 1) {
                $only = (string) $rest[0];
                /* 「XX县 / XX区 / XX旗」当区县；其余（南阳、苏州…）当市 */
                if (preg_match('/(县|旗)$/u', $only) || (preg_match('/区$/u', $only) && !preg_match('/(地区|自治区)$/u', $only))) {
                    $district = $only;
                } else {
                    $city = $only;
                }
            }

            /* 补后缀：库里是简称（南阳 / 河南），补成规范名 */
            if ($province !== '' && !preg_match('/(省|市|自治区|特别行政区)$/u', $province)) {
                $muni = array('北京', '上海', '天津', '重庆');
                $auto = array('内蒙古', '广西', '西藏', '宁夏', '新疆');
                if (in_array($province, $muni, true)) {
                    $province .= '市';
                } elseif (in_array($province, $auto, true)) {
                    $province .= '自治区';
                } else {
                    $province .= '省';
                }
            }
            if ($city !== '' && !preg_match('/(市|州|地区|盟|县)$/u', $city)) {
                $city .= '市';
            }
            /* 直辖市只有区县、没有地级市时，用直辖市本身当市 */
            if ($city === '' && $district !== '' && in_array($province, array('北京市', '上海市', '天津市', '重庆市'), true)) {
                $city = $province;
            }
        } else {
            /* 国外：原样保留，绝不补「省/市」后缀（曾出现「美国省」这种鬼东西） */
            $province = (string) $segs[0];
            $city     = isset($segs[1]) ? (string) $segs[1] : '';
            $district = isset($segs[2]) ? (string) $segs[2] : '';
        }

        /* ---- 3) 运营商 ---- */
        $isp  = '';
        $blob = implode(' ', $noise);
        $known = array(
            '中国电信' => '电信', '中国联通' => '联通', '中国移动' => '移动',
            '中国铁通' => '铁通', '中国广电' => '广电', '长城宽带' => '长城宽带',
            '歌华有线' => '歌华有线', '鹏博士' => '鹏博士', '教育网' => '教育网',
            '电信' => '电信', '联通' => '联通', '移动' => '移动', '铁通' => '铁通', '广电' => '广电',
        );
        foreach ($known as $needle => $label) {
            if ($blob !== '' && mb_strpos($blob, $needle) !== false) {
                $isp = $label;
                break;
            }
        }
        if ($isp === '' && $blob !== '') {
            $isp = mb_substr($blob, 0, 24, 'UTF-8');
        }

        /* ---- 4) 展示名：区县 > 市 > 省，去掉行政后缀更好看 ---- */
        $display = $district !== '' ? $district : ($city !== '' ? $city : $province);
        $display = preg_replace('/(特别行政区|自治区|自治州|地区|省|市|区|县|旗)$/u', '', $display);
        if ($display === '') {
            $display = $district !== '' ? $district : ($city !== '' ? $city : $province);
        }

        return array(
            'province' => $province,
            'city'     => $city,
            'district' => $district,
            'isp'      => $isp,
            'text'     => $raw,
            'display'  => $display,
        );
    }
}
