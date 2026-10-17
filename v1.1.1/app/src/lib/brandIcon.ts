/**
 * 品牌/网络图标（品牌图 / 网络 / App 图标来源，资源自建不搬运其 COS）。
 *
 * 原理：绝大多数互联网服务的公开 favicon 就是其品牌图标（阿里云、腾讯云、QQ 会员、
 * 音乐平台……），通过公共 favicon 镜像服务按域名热链获取，无需自建图床。
 * - 主服务：`https://favicon.im/<domain>?larger=true`（国内直连稳定，无需 key）
 * - 备用：`https://icon.horse/icon/<domain>`
 *
 * 存储约定（Subscription.icon / 物品 image.ref）：
 * - lucide 内置图标：裸 id（如 'bilibili'）——原有数据完全兼容
 * - 网络图标：`url:<完整https链接>`
 * - 本地上传：`img:data:image/...`（canvas 压缩后的小图）
 */

/** 生成某域名的 favicon 直链。 */
export function faviconUrl(domain: string, larger = true): string {
  return `https://favicon.im/${domain}${larger ? '?larger=true' : ''}`;
}

/** 生成备选 favicon 直链（主服务挂时的手动备用）。 */
export function faviconUrlBackup(domain: string): string {
  return `https://icon.horse/icon/${domain}`;
}

import { BRAND_ICON_ASSETS } from '../generated/brandIconAssets';

/**
 * 服务端图标内容的「缓存击穿标签」。
 * ★v1.0.33：代理返回的内容一旦变化（旧版缓存过 favicon.im 的灰色占位图，
 * Cache-Control 长达 30 天），老客户端/浏览器会继续吃旧缓存。改内容就必须改这里，
 * 让所有 URL 变化、绕过存量缓存。
 */
export const ICON_CACHE_TAG = 'v1033';

/**
 * 自建图标代理直链（v1.0.4 起首选）：服务端抓目标站真实 <link icon> 并缓存。
 * 第三方镜像（favicon.im/icon.horse）对大量国内站点只会返回统一灰色占位图，
 * 自建代理国内外站点通吃、返回真实品牌图。
 */
export function iconApiUrl(base: string, domain: string): string {
  return `${base.replace(/\/+$/, '')}/api/icon/img?d=${encodeURIComponent(domain)}&v=${ICON_CACHE_TAG}`;
}

/**
 * 打包进安装包/站点的品牌图标资产（v1.0.32）：domain → 站内路径
 * （public/brand-icons/，APK 与网页都随包分发，离线可用、永不失效）。
 * 未收录的域名返回 null（继续走网络链）。
 */
export function localBrandIconPath(domain: string): string | null {
  return BRAND_ICON_ASSETS[domain] ?? null;
}

/**
 * 品牌图标落库引用（v1.0.32）：有打包资产 → 引用站内路径（永久、离线可用）；
 * 没有才回落代理直链。物品与订阅共用同一引用 → 同一图标天然共享。
 */
export function brandIconRef(base: string, domain: string): string {
  const local = localBrandIconPath(domain);
  return toUrlIcon(local ?? iconApiUrl(base, domain));
}

/** 品牌图标展示/预热直链（本地资产优先）。 */
export function brandIconSrc(base: string, domain: string): string {
  return localBrandIconPath(domain) ?? iconApiUrl(base, domain);
}

/**
 * 网络图标加载失败的回退链：本地打包资产 → 自建代理 → icon.horse。
 * ★v1.0.33：已剔除 favicon.im——实测它对大量国内站（联通/国网/云闪付/顺丰…）
 * 只回「灰圆 + 字母 f」的假 SVG，而假图比空白更糟（用户看到的是「斜杠/花图」）。
 */
export function faviconChain(base: string, domain: string): string[] {
  const local = localBrandIconPath(domain);
  return [...(local ? [local] : []), iconApiUrl(base, domain), faviconUrlBackup(domain)];
}

/** icon 值的三种形态。 */
export type IconKind = 'builtin' | 'url' | 'img';

/** 解析 icon 字段形态（App/网页共用）。 */
export function iconKindOf(icon?: string | null): IconKind {
  const v = (icon ?? '').trim();
  if (v.startsWith('url:')) return 'url';
  if (v.startsWith('img:')) return 'img';
  return 'builtin';
}

/** 取网络图标的直链（非 url: 形态返回 null）。 */
export function iconUrlOf(icon?: string | null): string | null {
  if (iconKindOf(icon) !== 'url') return null;
  return (icon ?? '').slice(4).trim() || null;
}

/** 取本地图标的 dataURL（非 img: 形态返回 null）。 */
export function iconDataUrlOf(icon?: string | null): string | null {
  if (iconKindOf(icon) !== 'img') return null;
  return (icon ?? '').slice(4).trim() || null;
}

/**
 * 从用户输入提取域名：支持「cloud.tencent.com」「https://xx.com/path?a=1」「腾讯云 https://...」。
 * 提不出域名返回 null。
 */
export function normalizeDomainInput(raw: string): string | null {
  const input = (raw ?? '').trim();
  if (!input) return null;
  // 抠出里面的网址（若无协议，给个 // 让 URL 解析）
  const m = input.match(/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g);
  if (!m) return null;
  // 取最长的一串当域名（避免把「QQ会员」这种中文词附近的散点误判）
  const best = m.sort((a, b) => b.length - a.length)[0];
  try {
    const u = new URL(`https://${best}`);
    const host = u.hostname.toLowerCase();
    // 至少两段（x.com），排除纯数字误判
    if (!host.includes('.') || /^\d+(\.\d+){3}$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/** 常用品牌预设（domain + 展示名 + 可选英文别名，favicon 热链零维护）。 */
export interface BrandItem {
  name: string;
  domain: string;
  /** 英文/拼音别名（搜索匹配用）。 */
  alias?: string;
}

/**
 * 品牌预设库（v1.0.3 扩充至 120+，覆盖云/影音/音乐/社交/电商/外卖/出行/运营商/
 * 游戏/开发者/办公/金融/读书学习等场景）。搜索走 searchBrands()，中英文均可命中。
 */
export const BRAND_GROUPS: Array<{ label: string; items: BrandItem[] }> = [
  {
    label: '云服务 / 网盘',
    items: [
      { name: '阿里云', domain: 'aliyun.com', alias: 'aliyun ecs' },
      { name: '腾讯云', domain: 'cloud.tencent.com', alias: 'tencent cloud' },
      { name: '华为云', domain: 'huaweicloud.com', alias: 'huawei' },
      { name: '百度智能云', domain: 'cloud.baidu.com', alias: 'baidu bce' },
      { name: '金山云', domain: 'ksyun.com', alias: 'kingsoft' },
      { name: 'UCloud', domain: 'ucloud.cn', alias: 'ucloud' },
      { name: '七牛云', domain: 'qiniu.com', alias: 'qiniu qn' },
      { name: '又拍云', domain: 'upyun.com', alias: 'upyun' },
      { name: 'Cloudflare', domain: 'cloudflare.com', alias: 'cf cdn' },
      { name: 'AWS', domain: 'aws.amazon.com', alias: 'amazon amazonweb' },
      { name: 'Azure', domain: 'azure.microsoft.com', alias: 'microsoft' },
      { name: '谷歌云', domain: 'cloud.google.com', alias: 'gcp google' },
      { name: '百度网盘', domain: 'pan.baidu.com', alias: 'baidu 网盘' },
      { name: '阿里云盘', domain: 'www.alipan.com', alias: 'alipan 网盘' },
      { name: '夸克网盘', domain: 'pan.quark.cn', alias: 'quark' },
      { name: '迅雷', domain: 'xunlei.com', alias: 'thunder' },
      { name: 'iCloud', domain: 'icloud.com', alias: 'apple 苹果' },
      { name: 'OneDrive', domain: 'onedrive.live.com', alias: 'microsoft 微软' },
      { name: 'Google Drive', domain: 'drive.google.com', alias: 'google 谷歌' },
      { name: 'Dropbox', domain: 'dropbox.com', alias: 'db' },
      { name: '坚果云', domain: 'jianguoyun.com', alias: 'nutstore' },
    ],
  },
  {
    label: '影音 / 视频',
    items: [
      { name: '哔哩哔哩', domain: 'bilibili.com', alias: 'b站 bilibili bili' },
      { name: '腾讯视频', domain: 'v.qq.com', alias: 'tencent video' },
      { name: '爱奇艺', domain: 'iqiyi.com', alias: 'iqiyi' },
      { name: '优酷', domain: 'youku.com', alias: 'youku' },
      { name: '芒果TV', domain: 'mgtv.com', alias: 'mango mgtv' },
      { name: '抖音', domain: 'douyin.com', alias: 'douyin tiktok' },
      { name: '快手', domain: 'kuaishou.com', alias: 'ks' },
      { name: '西瓜视频', domain: 'ixigua.com', alias: 'xigua' },
      { name: '剪映', domain: 'capcut.cn', alias: 'capcut jianying' },
      { name: ' Netflix', domain: 'netflix.com', alias: 'netflix' },
      { name: 'Disney+', domain: 'disneyplus.com', alias: 'disney 迪士尼' },
      { name: 'YouTube', domain: 'youtube.com', alias: 'yt 谷歌' },
      { name: '哔哩哔哩漫画', domain: 'manga.bilibili.com', alias: '漫画' },
      { name: '腾讯动漫', domain: 'ac.qq.com', alias: '动漫' },
      { name: '快看漫画', domain: 'kuaikanmanhua.com', alias: '快看' },
    ],
  },
  {
    label: '音乐 / 电台',
    items: [
      { name: '网易云音乐', domain: 'music.163.com', alias: '网易云 网易 cloudmusic' },
      { name: 'QQ音乐', domain: 'y.qq.com', alias: 'qq music' },
      { name: '酷狗音乐', domain: 'kugou.com', alias: 'kugou' },
      { name: '酷我音乐', domain: 'kuwo.cn', alias: 'kuwo' },
      { name: '汽水音乐', domain: 'qishui.douyin.com', alias: 'qishui' },
      { name: '喜马拉雅', domain: 'ximalaya.com', alias: 'xmly 电台' },
      { name: '蜻蜓FM', domain: 'qingting.fm', alias: 'qingting fm' },
      { name: '懒人听书', domain: 'lazyaudio.com', alias: 'lanren 听书' },
      { name: 'Spotify', domain: 'spotify.com', alias: 'spotify' },
      { name: 'Apple Music', domain: 'music.apple.com', alias: 'itunes 苹果' },
      { name: '小宇宙', domain: 'xiaoyuzhoufm.com', alias: 'podcast 播客' },
    ],
  },
  {
    label: '社交 / 通讯',
    items: [
      { name: '微信', domain: 'weixin.qq.com', alias: 'wechat weixin' },
      { name: '企业微信', domain: 'work.weixin.qq.com', alias: 'wecom 企微' },
      { name: 'QQ', domain: 'qq.com', alias: 'tencent 企鹅' },
      { name: '微博', domain: 'weibo.com', alias: 'weibo 微博' },
      { name: '知乎', domain: 'zhihu.com', alias: 'zhihu' },
      { name: '小红书', domain: 'xiaohongshu.com', alias: 'xhs rednote' },
      { name: '豆瓣', domain: 'douban.com', alias: 'douban' },
      { name: '百度', domain: 'baidu.com', alias: 'baidu 搜索' },
      { name: '贴吧', domain: 'tieba.baidu.com', alias: 'tieba' },
      { name: '钉钉', domain: 'dingtalk.com', alias: 'dingtalk' },
      { name: '飞书', domain: 'feishu.cn', alias: 'lark 字节' },
      { name: 'Telegram', domain: 'telegram.org', alias: 'tg 电报' },
      { name: 'Discord', domain: 'discord.com', alias: 'discord' },
      { name: 'Slack', domain: 'slack.com', alias: 'slack' },
    ],
  },
  {
    label: '会员 / 附属',
    items: [
      { name: 'QQ会员', domain: 'vip.qq.com', alias: 'qq 会员 王卡' },
      { name: '腾讯王卡', domain: '10010.com', alias: 'wangka 王卡' },
      { name: '微博会员', domain: 'vip.weibo.com', alias: 'weibo 会员' },
      { name: '知乎会员', domain: 'vip.zhihu.com', alias: 'zhihu 盐选' },
      { name: '迅雷会员', domain: 'vip.xunlei.com', alias: 'xunlei 快鸟' },
      { name: '百度网盘会员', domain: 'pan.baidu.com', alias: 'svip 超级会员' },
      { name: 'WPS会员', domain: 'vip.wps.cn', alias: 'wps 金山' },
      { name: '夸克会员', domain: 'pan.quark.cn', alias: 'quark svip' },
    ],
  },
  {
    label: '购物 / 电商',
    items: [
      { name: '淘宝', domain: 'taobao.com', alias: 'taobao 天猫' },
      { name: '天猫', domain: 'tmall.com', alias: 'tmall' },
      { name: '京东', domain: 'jd.com', alias: 'jd 京东' },
      { name: '拼多多', domain: 'pinduoduo.com', alias: 'pdd' },
      { name: '闲鱼', domain: 'goofish.com', alias: 'xianyu 二手' },
      { name: '转转', domain: 'zhuanzhuan.com', alias: 'zhuanzhuan' },
      { name: '唯品会', domain: 'vip.com', alias: 'vipshop' },
      { name: '苏宁易购', domain: 'suning.com', alias: 'suning' },
      { name: '小米有品', domain: 'xiaomiyoupin.com', alias: 'mi youpin' },
      { name: '网易严选', domain: 'you.163.com', alias: 'yanxuan' },
      { name: '得物', domain: 'dewu.com', alias: 'dewu 毒' },
      { name: '饿了么', domain: 'h5.ele.me', alias: 'ele me 外卖' },
      { name: '美团', domain: 'meituan.com', alias: 'meituan 外卖' },
      { name: '大众点评', domain: 'dianping.com', alias: 'dianping' },
      { name: '山姆会员店', domain: 'samsclub.cn', alias: 'sams' },
      { name: '盒马', domain: 'freshippo.com', alias: 'hema 盒马' },
      { name: '淘宝买菜', domain: 'taobao.com', alias: '买菜' },
    ],
  },
  {
    label: '出行 / 交通',
    items: [
      { name: '携程', domain: 'ctrip.com', alias: 'ctrip trip' },
      { name: '去哪儿', domain: 'qunar.com', alias: 'qunar' },
      { name: '飞猪', domain: 'fliggy.com', alias: 'fliggy 阿里' },
      { name: '同程旅行', domain: 'ly.com', alias: 'tongcheng 同程' },
      { name: '12306', domain: '12306.cn', alias: 'railway 火车 高铁' },
      { name: '滴滴出行', domain: 'didiglobal.com', alias: 'didi 打车' },
      { name: '高德地图', domain: 'amap.com', alias: 'amap 导航' },
      { name: '百度地图', domain: 'map.baidu.com', alias: 'baidu map 导航' },
      { name: '腾讯地图', domain: 'map.qq.com', alias: 'qq map 导航' },
      { name: '哈啰', domain: 'hellohorse.com', alias: 'hellobike 单车' },
      { name: '航旅纵横', domain: 'umetrip.com', alias: 'umetrip 航班' },
      { name: '华住会', domain: 'huazhu.com', alias: 'huazhu 酒店' },
      { name: '如家', domain: 'homeinns.com', alias: '酒店' },
    ],
  },
  {
    label: '运营商 / 生活缴费',
    items: [
      { name: '中国移动', domain: '10086.cn', alias: 'china mobile 移动 话费' },
      { name: '中国联通', domain: '10010.com', alias: 'china unicom 联通 话费' },
      { name: '中国电信', domain: 'www.189.cn', alias: 'china telecom 电信 话费' },
      { name: '中国广电', domain: 'cbn.cn', alias: '广电 192 广电网络' },
      { name: '国家电网', domain: 'www.sgcc.com.cn', alias: '电费 电网 sgcc 网上国网' },
      { name: '支付宝', domain: 'www.alipay.com', alias: 'alipay 支付' },
      { name: '云闪付', domain: '95516.com', alias: 'unionpay 银联 云闪付' },
      { name: '顺丰速运', domain: 'www.sf-express.com', alias: 'sf 快递 顺丰' },
      { name: '菜鸟裹裹', domain: 'cainiao.com', alias: 'cainiao 快递' },
      { name: '京东物流', domain: 'jl.jd.com', alias: 'jd 快递' },
    ],
  },
  {
    label: '游戏 / 游戏服务',
    items: [
      { name: 'Steam', domain: 'steampowered.com', alias: 'steam valve' },
      { name: 'Epic', domain: 'epicgames.com', alias: 'epic' },
      { name: 'WeGame', domain: 'wegame.com', alias: 'wegame tencent' },
      { name: 'TapTap', domain: 'taptap.cn', alias: 'taptap' },
      { name: '好游快爆', domain: 'haoyoukuai.com', alias: 'haoyou' },
      { name: '米哈游', domain: 'mihoyo.com', alias: 'miHoYo 原神 星穹铁道' },
      { name: '网易游戏', domain: 'netease.com', alias: 'netease 梦幻西游' },
      { name: '暴雪', domain: 'blizzard.com', alias: 'blizzard 战网' },
      { name: 'Riot', domain: 'riotgames.com', alias: 'lol 英雄联盟' },
      { name: 'PlayStation', domain: 'playstation.com', alias: 'psn ps5 索尼' },
      { name: 'Xbox', domain: 'xbox.com', alias: 'xgp 微软' },
      { name: 'Nintendo', domain: 'nintendo.com', alias: 'switch 任天堂 eshop' },
      { name: '腾讯游戏充值', domain: 'pay.weixin.qq.com', alias: '点券 充值' },
    ],
  },
  {
    label: '开发者 / 效率',
    items: [
      { name: 'GitHub', domain: 'github.com', alias: 'github git copilot' },
      { name: 'Gitee', domain: 'gitee.com', alias: '码云' },
      { name: '掘金', domain: 'juejin.cn', alias: 'juejin' },
      { name: 'CSDN', domain: 'csdn.net', alias: 'csdn' },
      { name: 'V2EX', domain: 'v2ex.com', alias: 'v2ex' },
      { name: 'StackOverflow', domain: 'stackoverflow.com', alias: 'so' },
      { name: 'npm', domain: 'npmjs.com', alias: 'npm node' },
      { name: 'Docker', domain: 'docker.com', alias: 'docker hub' },
      { name: 'JetBrains', domain: 'jetbrains.com', alias: 'idea pycharm' },
      { name: 'VS Code', domain: 'code.visualstudio.com', alias: 'vscode visualstudio' },
      { name: 'Notion', domain: 'notion.so', alias: 'notion' },
      { name: 'Figma', domain: 'figma.com', alias: 'figma 设计' },
      { name: 'Adobe', domain: 'adobe.com', alias: 'adobe ps pr' },
      { name: 'Canva可画', domain: 'canva.cn', alias: 'canva 设计' },
      { name: '稿定设计', domain: 'gaoding.com', alias: 'gaoding' },
      { name: 'DeepL', domain: 'deepl.com', alias: 'deepl 翻译' },
      { name: 'OpenAI', domain: 'openai.com', alias: 'chatgpt gpt' },
      { name: 'Claude', domain: 'claude.ai', alias: 'anthropic claude' },
      { name: 'DeepSeek', domain: 'deepseek.com', alias: 'deepseek ai' },
      { name: 'Kimi', domain: 'kimi.com', alias: 'moonshot 月之暗面' },
      { name: '豆包', domain: 'doubao.com', alias: 'doubao 字节 ai' },
      { name: '通义千问', domain: 'tongyi.aliyun.com', alias: 'qwen 阿里 ai' },
      { name: '讯飞星火', domain: 'xinghuo.xfyun.cn', alias: 'xfyun 讯飞' },
    ],
  },
  {
    label: '办公 / 文档 / 笔记',
    items: [
      { name: 'WPS', domain: 'wps.cn', alias: 'wps 金山 office' },
      { name: '金山文档', domain: 'kdocs.cn', alias: 'kdocs' },
      { name: '腾讯文档', domain: 'docs.qq.com', alias: 'docs 在线文档' },
      { name: '石墨文档', domain: 'shimo.im', alias: 'shimo' },
      { name: '语雀', domain: 'yuque.com', alias: 'yuque 阿里' },
      { name: '幕布', domain: 'mubu.com', alias: 'mubu 大纲' },
      { name: '飞书文档', domain: 'feishu.cn', alias: 'lark docs' },
      { name: '有道云笔记', domain: 'note.youdao.com', alias: 'youdao 有道' },
      { name: '印象笔记', domain: 'yinxiang.com', alias: 'evernote' },
      { name: 'Obsidian', domain: 'obsidian.md', alias: 'obsidian 笔记' },
      { name: 'flomo浮墨', domain: 'flomoapp.com', alias: 'flomo' },
    ],
  },
  {
    label: '读书 / 学习',
    items: [
      { name: '微信读书', domain: 'weread.qq.com', alias: 'weread 读书' },
      { name: '得到', domain: 'www.dedao.cn', alias: 'dedao 罗辑思维' },
      { name: '樊登读书', domain: 'dengtedushu.com', alias: 'fandeng 帆书' },
      { name: '网易公开课', domain: 'open.163.com', alias: 'mooc 公开课' },
      { name: '中国大学MOOC', domain: 'icourse163.org', alias: 'mooc 课程' },
      { name: '多邻国', domain: 'duolingo.cn', alias: 'duolingo 英语' },
      { name: '百词斩', domain: 'baicizhan.com', alias: '单词 背单词' },
      { name: '扇贝', domain: 'shanbay.com', alias: 'shanbay 单词' },
      { name: '流利说', domain: 'liulishuo.com', alias: 'liulishuo 英语' },
      { name: '有道词典', domain: 'dict.youdao.com', alias: 'youdao 翻译' },
      { name: 'Kindle', domain: 'amazon.cn', alias: 'kindle 电子书' },
      { name: '掌阅', domain: 'izhen.com', alias: 'ireader 小说' },
      { name: 'QQ阅读', domain: 'yuewen.com', alias: '阅文 小说' },
      { name: '起点读书', domain: 'qidian.com', alias: 'qidian 小说' },
    ],
  },
  {
    label: '金融 / 证券',
    items: [
      { name: '同花顺', domain: '10jqka.com.cn', alias: 'ths 炒股' },
      { name: '东方财富', domain: 'eastmoney.com', alias: 'eastmoney 财富' },
      { name: '雪球', domain: 'xueqiu.com', alias: 'xueqiu 股票' },
      { name: '富途', domain: 'futunn.com', alias: 'futu moomoo' },
      { name: '老虎证券', domain: 'laohu8.com', alias: 'tiger tigerbrokers' },
      { name: '招商银行', domain: 'cmbchina.com', alias: 'cmb 招行' },
      { name: '工商银行', domain: 'icbc.com.cn', alias: 'icbc 工行' },
      { name: '建设银行', domain: 'ccb.com', alias: 'ccb 建行' },
      { name: '农业银行', domain: 'abchina.com', alias: 'abc 农行' },
      { name: '中国银行', domain: 'boc.cn', alias: 'boc 中行' },
      { name: '平安', domain: 'pingan.com', alias: 'pingan 保险' },
      { name: '众安保险', domain: 'zhongan.com', alias: 'zhongan 保险' },
    ],
  },
];

/** 扁平品牌总表（搜索用）。 */
const ALL_BRANDS: BrandItem[] = BRAND_GROUPS.flatMap((g) => g.items);

/**
 * 关键词搜品牌图标：命中 名称 / 别名 / 域名（不区分大小写，多词 AND）。
 * 「网易云」「netflix」「腾讯」「12306」「steam」这类自然关键词都能直出。
 */
export function searchBrands(query: string): BrandItem[] {
  const words = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return ALL_BRANDS.filter((b) => {
    const hay = `${b.name} ${b.alias ?? ''} ${b.domain}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 图片文件 → 压缩 dataURL（正方形裁边，边长 size，默认 96px，JPEG）。 */
export function compressIconFile(file: File, size = 96): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('解析图片失败'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = side === img.width ? 0 : (img.width - side) / 2;
        const sy = side === img.height ? 0 : (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('画布不可用'));
          return;
        }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 包一层 img: 前缀。 */
export function toImgIcon(dataUrl: string): string {
  return `img:${dataUrl}`;
}

/** 包一层 url: 前缀。 */
export function toUrlIcon(link: string): string {
  return `url:${link}`;
}
