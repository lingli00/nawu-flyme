/* 生成 src/lib/simpleBrand.ts —— 内置品牌图标数据（自包含，不依赖运行时包）。
 * 数据源：simple-icons（CC0）。只挑常用品牌，路径内联进产物。
 * 跑法：node scripts/gen-simple-brand.cjs
 */
const fs = require('fs');
const path = require('path');
const si = require('simple-icons');

/** 分组定义：label + [slug, 中文名, 别名]。 */
const GROUPS = [
  {
    label: 'AI 助手 / 订阅',
    items: [
      ['claude', 'Claude', 'anthropic'],
      ['deepseek', 'DeepSeek', '深度求索'],
      ['kimi', 'Kimi', '月之暗面 moonshot'],
      ['moonshotai', 'Moonshot AI', '月之暗面'],
      ['googlegemini', 'Gemini', 'gemini google 谷歌'],
      ['perplexity', 'Perplexity', 'pplx'],
      ['huggingface', 'Hugging Face', 'huggingface hf'],
      ['mistralai', 'Mistral AI', 'mistral'],
      ['ollama', 'Ollama', '本地大模型'],
      ['elevenlabs', 'ElevenLabs', '语音合成'],
      ['midjourney', 'Midjourney', 'mj 绘画'],
      ['githubcopilot', 'GitHub Copilot', 'copilot'],
      ['xai', 'xAI', 'grok'],
      ['groq', 'Groq', 'groq'],
      ['cohere', 'Cohere', 'cohere'],
      ['openai', 'OpenAI', 'chatgpt gpt'],
      ['doubao', '豆包', 'doubao 字节'],
      ['tongyi', '通义千问', 'qwen 阿里'],
      ['xinghuo', '讯飞星火', 'xfyun'],
      ['baichuan', '百川', 'baichuan'],
      ['zhipu', '智谱', 'chatglm glm'],
    ],
  },
  {
    label: '云服务 / 网盘',
    items: [
      ['alibabacloud', '阿里云', 'aliyun ecs'],
      ['icloud', 'iCloud', 'apple 苹果 云'],
      ['googledrive', 'Google Drive', 'google 谷歌盘'],
      ['dropbox', 'Dropbox', 'db'],
      ['backblaze', 'Backblaze', 'b2 备份'],
      ['cloudflare', 'Cloudflare', 'cf cdn'],
      ['digitalocean', 'DigitalOcean', 'do vps'],
      ['vultr', 'Vultr', 'vps'],
      ['hetzner', 'Hetzner', 'vps'],
      ['linode', 'Linode', 'vps'],
      ['oracle', 'Oracle', '甲骨文 oci'],
      ['aws', 'AWS', 'amazon 亚马逊云'],
      ['kubernetes', 'Kubernetes', 'k8s'],
      ['docker', 'Docker', 'docker hub'],
      ['npm', 'npm', 'node npmjs'],
      ['jsdelivr', 'jsDelivr', 'cdn'],
      ['fastly', 'Fastly', 'cdn'],
      ['vercel', 'Vercel', 'vercel'],
      ['netlify', 'Netlify', 'netlify'],
      ['cloudflarepages', 'Cloudflare Pages', 'cf pages'],
      ['deno', 'Deno', 'deno'],
      ['supabase', 'Supabase', 'supabase'],
      ['firebase', 'Firebase', 'google 后端'],
    ],
  },
  {
    label: '影音 / 视频',
    items: [
      ['bilibili', '哔哩哔哩', 'b站 bili'],
      ['kuaishou', '快手', 'ks'],
      ['tiktok', 'TikTok / 抖音', 'douyin 抖音'],
      ['netflix', 'Netflix', '网飞'],
      ['youtube', 'YouTube', 'yt 谷歌'],
      ['youtubemusic', 'YouTube Music', 'yt music'],
      ['spotify', 'Spotify', 'spotify'],
      ['applemusic', 'Apple Music', 'itunes 苹果'],
      ['appletv', 'Apple TV+', '苹果 tv'],
      ['primevideo', 'Prime Video', '亚马逊 video'],
      ['hulu', 'Hulu', 'hulu'],
      ['disneyplus', 'Disney+', '迪士尼'],
      ['hbo', 'HBO', 'max'],
      ['twitch', 'Twitch', '直播'],
      ['vk', 'VK', 'vk'],
      ['kakaotalk', 'KakaoTalk', 'kakao'],
      ['naver', 'NAVER', 'naver'],
      ['bilibilimanga', '哔哩哔哩漫画', 'b漫'],
    ],
  },
  {
    label: '音乐 / 电台',
    items: [
      ['neteasecloudmusic', '网易云音乐', '网易云 cloudmusic'],
      ['qqmusic', 'QQ音乐', 'qq music'],
      ['kugou', '酷狗音乐', 'kugou'],
      ['kuwo', '酷我音乐', 'kuwo'],
      ['ximalaya', '喜马拉雅', 'xmly 电台'],
      ['soundcloud', 'SoundCloud', 'sc'],
      ['bandcamp', 'Bandcamp', 'bandcamp'],
      ['tidal', 'TIDAL', 'tidal'],
      ['deezer', 'Deezer', 'deezer'],
      ['podcast', '播客', 'podcast apple'],
    ],
  },
  {
    label: '社交 / 通讯',
    items: [
      ['wechat', '微信', 'wechat weixin'],
      ['qq', 'QQ', 'tencent 企鹅'],
      ['qzone', 'QQ 空间', 'qzone'],
      ['sinaweibo', '微博', 'weibo'],
      ['xiaohongshu', '小红书', 'xhs rednote'],
      ['zhihu', '知乎', 'zhihu'],
      ['douban', '豆瓣', 'douban'],
      ['doubanread', '豆瓣阅读', 'douban read'],
      ['telegram', 'Telegram', 'tg 电报'],
      ['discord', 'Discord', 'discord'],
      ['slack', 'Slack', 'slack'],
      ['instagram', 'Instagram', 'ins ig'],
      ['facebook', 'Facebook', 'fb meta'],
      ['x', 'X / Twitter', 'twitter 推特'],
      ['threads', 'Threads', 'threads'],
      ['linkedin', 'LinkedIn', '领英'],
      ['reddit', 'Reddit', 'reddit'],
      ['pinterest', 'Pinterest', 'pinterest'],
      ['snapchat', 'Snapchat', 'snap'],
      ['whatsapp', 'WhatsApp', 'whatsapp'],
      ['line', 'LINE', 'line'],
      ['kuaikanmanhua', '快看漫画', '快看'],
    ],
  },
  {
    label: '购物 / 电商',
    items: [
      ['taobao', '淘宝', 'taobao'],
      ['tmall', '天猫', 'tmall'],
      ['jingdong', '京东', 'jd'],
      ['pinduoduo', '拼多多', 'pdd'],
      ['xianyu', '闲鱼', 'goofish 二手'],
      ['suning', '苏宁易购', 'suning'],
      ['dewu', '得物', '毒 dewu'],
      ['vipshop', '唯品会', 'vip'],
      ['shein', 'SHEIN', 'shein'],
      ['aliexpress', '全球速卖通', 'aliexpress 阿里国际'],
      ['amazon', 'Amazon', '亚马逊'],
      ['shopee', 'Shopee', '虾皮'],
      ['lazada', 'Lazada', 'lazada'],
      ['alibabadotcom', 'Alibaba.com', '阿里国际站'],
      ['temu', 'Temu', 'temu'],
      ['etsy', 'Etsy', 'etsy'],
      ['ebay', 'eBay', 'ebay'],
      ['walmart', 'Walmart', '沃尔玛'],
      ['target', 'Target', 'target'],
      ['ikea', 'IKEA', '宜家'],
      ['muji', 'MUJI', '无印良品'],
      ['uniqlo', '优衣库', 'uniqlo'],
      ['zara', 'ZARA', 'zara'],
      ['nike', 'Nike', '耐克'],
      ['adidas', 'Adidas', '阿迪达斯'],
      ['lululemon', 'lululemon', 'lulu'],
      ['newbalance', 'New Balance', 'nb 新百伦'],
      ['converse', 'Converse', '匡威'],
      ['vans', 'Vans', 'vans'],
      ['puma', 'PUMA', '彪马'],
      ['anta', '安踏', 'anta'],
      ['liening', '李宁', 'lining'],
    ],
  },
  {
    label: '金融 / 支付',
    items: [
      ['alipay', '支付宝', 'alipay 支付'],
      ['alipayplus', 'Alipay+', '支付宝国际'],
      ['unionpay', '云闪付', '银联 unionpay 95516'],
      ['wechatpay', '微信支付', '微信 支付'],
      ['paypal', 'PayPal', 'paypal'],
      ['visa', 'Visa', 'visa'],
      ['mastercard', 'Mastercard', '万事达'],
      ['americanexpress', 'American Express', 'amex 运通'],
      ['discover', 'Discover', 'discover'],
      ['jcb', 'JCB', 'jcb'],
      ['wise', 'Wise', 'wise'],
      ['stripe', 'Stripe', 'stripe'],
      ['binance', 'Binance', '币安'],
      ['coinbase', 'Coinbase', 'coinbase'],
      ['futu', '富途', 'futu moomoo'],
      ['tigerbrokers', '老虎证券', 'tiger'],
      ['eastmoney', '东方财富', 'eastmoney'],
      ['xueqiu', '雪球', 'xueqiu'],
      ['thegraph', 'The Graph', 'graph'],
    ],
  },
  {
    label: '游戏 / 娱乐',
    items: [
      ['steam', 'Steam', 'steam valve'],
      ['epicgames', 'Epic Games', 'epic'],
      ['playstation', 'PlayStation', 'psn ps5 索尼'],
      ['xbox', 'Xbox', 'xgp 微软'],
      ['nintendo', 'Nintendo', 'switch 任天堂'],
      ['nintendo3ds', 'Nintendo 3DS', '3ds'],
      ['riotgames', 'Riot Games', 'lol 英雄联盟'],
      ['blizzard', '暴雪', 'blizzard 战网'],
      ['mihoyo', '米哈游', '原神 星穹铁道'],
      ['ubisoft', '育碧', 'ubisoft'],
      ['ea', 'EA', 'ea'],
      ['rockstargames', 'R星', 'rockstar gta'],
      ['itchdotio', 'itch.io', '独立游戏'],
      ['gogdotcom', 'GOG', 'gog'],
      ['taptap', 'TapTap', 'taptap'],
      ['dji', '大疆', 'dji 无人机'],
      ['gopro', 'GoPro', 'gopro'],
      ['raspberrypi', '树莓派', 'raspberry pi'],
      ['arduinocc', 'Arduino', 'arduino'],
      ['lego', '乐高', 'lego'],
    ],
  },
  {
    label: '硬件 / 数码品牌',
    items: [
      ['apple', 'Apple', '苹果 iphone mac'],
      ['samsung', 'Samsung', '三星'],
      ['xiaomi', '小米', 'mi 红米'],
      ['redmi', 'Redmi', '红米'],
      ['huawei', '华为', 'huawei 鸿蒙'],
      ['honor', '荣耀', 'honor'],
      ['oppo', 'OPPO', 'oppo'],
      ['vivo', 'vivo', 'vivo iqoo'],
      ['oneplus', '一加', 'oneplus'],
      ['meizu', '魅族', 'meizu'],
      ['lenovo', '联想', 'lenovo thinkpad 拯救者'],
      ['asus', '华硕', 'asus rog'],
      ['msi', '微星', 'msi'],
      ['acer', '宏碁', 'acer'],
      ['dell', '戴尔', 'dell'],
      ['hp', '惠普', 'hp'],
      ['nvidia', 'NVIDIA', 'n 卡 显卡'],
      ['amd', 'AMD', 'amd 锐龙'],
      ['intel', 'Intel', '英特尔'],
      ['qualcomm', '高通', 'snapdragon 骁龙'],
      ['mediatek', '联发科', 'mtk 天玑'],
      ['sony', '索尼', 'sony wh 相机'],
      ['canon', '佳能', 'canon 相机'],
      ['nikon', '尼康', 'nikon 相机'],
      ['fujifilm', '富士', 'fujifilm 相机'],
      ['panasonic', '松下', 'panasonic'],
      ['leica', '徕卡', 'leica'],
      ['goprocamera', 'GoCam', ''],
      ['logitech', '罗技', 'logitech g'],
      ['razer', '雷蛇', 'razer'],
      ['steelseries', '赛睿', 'steelseries'],
      ['hyperx', 'HyperX', 'hyperx'],
      ['jbl', 'JBL', 'jbl 音箱'],
      ['bose', 'Bose', 'bose 耳机'],
      ['sennheiser', '森海塞尔', 'sennheiser'],
      ['marshall', 'Marshall', 'marshall 音箱'],
      ['anker', 'Anker', 'anker 充电'],
      ['baseus', '倍思', 'baseus'],
      ['kindle', 'Kindle', 'kindle 电子书'],
      ['dyson', '戴森', 'dyson 吸尘器'],
      ['philips', '飞利浦', 'philips'],
      ['xiaomijiashe', '米家', 'mi home'],
    ],
  },
  {
    label: '开发 / 办公 / 效率',
    items: [
      ['github', 'GitHub', 'github git'],
      ['gitlab', 'GitLab', 'gitlab'],
      ['gitee', 'Gitee', '码云'],
      ['juejin', '掘金', 'juejin'],
      ['v2ex', 'V2EX', 'v2ex'],
      ['jetbrains', 'JetBrains', 'idea pycharm'],
      ['visualstudiocode', 'VS Code', 'vscode'],
      ['neovim', 'Neovim', 'nvim'],
      ['figma', 'Figma', 'figma 设计'],
      ['notion', 'Notion', 'notion'],
      ['obsidian', 'Obsidian', 'obsidian 笔记'],
      ['canva', 'Canva', 'canva 设计'],
      ['adobe', 'Adobe', 'ps pr ae'],
      ['blender', 'Blender', 'blender 3d'],
      ['unity', 'Unity', 'unity3d'],
      ['unrealengine', '虚幻引擎', 'unreal'],
      ['godotengine', 'Godot', 'godot'],
      ['markdown', 'Markdown', 'md'],
      ['todoist', 'Todoist', 'todo'],
      ['trello', 'Trello', 'trello'],
      ['airtable', 'Airtable', 'airtable'],
      ['microsoftteams', 'Teams', 'teams 微软'],
      ['onedrive', 'OneDrive', '微软 网盘'],
      ['microsoftoffice', 'Office', 'word excel ppt 微软'],
      ['wps', 'WPS', '金山 office'],
      ['youdao', '有道', 'youdao 词典'],
      ['deepl', 'DeepL', 'deepl 翻译'],
      ['duolingo', '多邻国', 'duolingo'],
      ['wolfram', 'Wolfram', 'wolfram alpha'],
      ['archiveofourown', 'AO3', 'ao3'],
      ['wikipedia', '维基百科', 'wikipedia wiki'],
      ['mozillafirefox', 'Firefox', '火狐'],
      ['googlechrome', 'Chrome', '谷歌浏览器'],
      ['microsoftedge', 'Edge', 'edge 浏览器'],
      ['safari', 'Safari', '苹果浏览器'],
      ['arc', 'Arc', 'arc 浏览器'],
    ],
  },
  {
    label: '出行 / 生活服务',
    items: [
      ['uber', 'Uber', '优步'],
      ['lyft', 'Lyft', 'lyft'],
      ['bolt', 'Bolt', 'bolt'],
      ['airbnb', 'Airbnb', '爱彼迎'],
      ['bookingdotcom', 'Booking', '缤客'],
      ['tripdotcom', 'Trip.com', '携程国际'],
      ['skyscanner', 'Skyscanner', '天巡'],
      ['revolut', 'Revolut', 'revolut'],
      ['starbucks', '星巴克', 'starbucks 咖啡'],
      ['mcdonalds', '麦当劳', 'mcd 金拱门'],
      ['kfc', 'KFC', '肯德基'],
      ['burgerking', '汉堡王', 'bk'],
      ['dominos', '达美乐', 'pizza'],
      ['cocacola', '可口可乐', '可乐'],
      ['pepsi', '百事', 'pepsi'],
      ['redbull', '红牛', 'redbull'],
      ['nespresso', 'Nespresso', '咖啡'],
      ['deliveroo', 'Deliveroo', '外卖'],
      ['doordash', 'DoorDash', '外卖'],
      ['grubhub', 'Grubhub', '外卖'],
      ['opentable', 'OpenTable', '订餐'],
      ['strava', 'Strava', '跑步骑行'],
      ['nikeplus', 'Nike Run', 'nike 跑步'],
      ['keep', 'Keep', '健身'],
      ['myfitnesspal', 'MyFitnessPal', '卡路里'],
      ['garmin', '佳明', 'garmin 手表'],
      ['fitbit', 'Fitbit', 'fitbit'],
      ['whoop', 'WHOOP', 'whoop'],
      ['duolingocn', '多邻国中国', ''],
    ],
  },
];

/** 第二数据源：simple-icons v16 因商标下架、但 Iconify 仍托管旧版的品牌。
 * 构建期抓 api.iconify.design，hex 用知名品牌色手工标注。 */
const EXTRA = [
  ['amazon', 'Amazon', '亚马逊', 'FF9900'],
  ['xbox', 'Xbox', 'xgp 微软', '107C10'],
  ['nintendo', 'Nintendo', 'switch 任天堂', '8F8F8F'],
  ['playstation1', 'PlayStation', '', ''],
  ['adobe', 'Adobe', 'ps pr ae', 'FA0F00'],
  ['canva', 'Canva', 'canva 设计', '00C4CC'],
  ['slack', 'Slack', 'slack', '4A154B'],
  ['linkedin', 'LinkedIn', '领英', '0A66C2'],
  ['openai', 'OpenAI', 'chatgpt gpt', '412991'],
  ['logitech', '罗技', 'logitech g', '00B8FC'],
  ['microsoftoffice', 'Office', 'word excel ppt 微软', 'D83B01'],
  ['onedrive1', 'OneDrive', '', ''],
  ['firefoxbrowser', 'Firefox', '火狐', 'FF7139'],
  ['microsoftedge', 'Edge', 'edge 浏览器', '0078D7'],
  ['amazonaws', 'AWS', 'amazon 亚马逊云', '232F3E'],
  ['android', 'Android', '安卓 谷歌', '3DDC84'],
  ['androidauto', 'Android Auto', '', ''],
  ['windows', 'Windows', '微软', '0078D6'],
  ['applepay', 'Apple Pay', '苹果支付', '000000'],
  ['googlepay', 'Google Pay', '谷歌支付', '4285F4'],
  ['googledrive1', 'Google Drive', '', ''],
  ['blender1', 'Blender', '', ''],
  ['telegram1', 'Telegram', '', ''],
  ['discord1', 'Discord', '', ''],
];

/** 汇总查找并产出 TS。 */
let ok = 0;
const missing = [];
const usedSlugs = new Set();
const outGroups = [];
/** 由 slug 从包内取（getter 入口带 si 前缀驼峰）。 */
function fromPackage(slug) {
  const camel = slug.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
  return si[`si${camel}`] ?? Object.values(si).find((v) => v.slug === slug) ?? null;
}
/** 由 Iconify 取（构建期一次），返回 {path, hex}。 */
async function fromIconify(slug, hex) {
  try {
    const res = await fetch(`https://api.iconify.design/simple-icons/${slug}.svg`);
    if (!res.ok) return null;
    const svg = await res.text();
    const m = svg.match(/d="([^"]+)"/);
    if (!m) return null;
    return { path: m[1], hex };
  } catch {
    return null;
  }
}

(async () => {
  const extraByKey = new Map();
  for (const [slug, name, alias, hex] of EXTRA) extraByKey.set(slug.replace(/1$/, ''), { slug, name, alias, hex });
  for (const g of GROUPS) {
    const items = [];
    for (const [slug, name, alias, builtinHex] of g.items.map((r) => [r[0], r[1], r[2], null])) {
      if (usedSlugs.has(slug)) continue;
      usedSlugs.add(slug);
      const pkg = fromPackage(slug);
      if (pkg) {
        items.push({ name, slug, hex: pkg.hex, path: pkg.path, alias: alias || '' });
        ok++;
        continue;
      }
      const extra = extraByKey.get(slug);
      if (extra && extra.hex) {
        const ic = await fromIconify(slug, extra.hex);
        if (ic) {
          items.push({ name, slug, hex: ic.hex, path: ic.path, alias: alias || '' });
          ok++;
          continue;
        }
      }
      missing.push(`${g.label} / ${slug}`);
    }
    if (items.length) outGroups.push({ label: g.label, items });
  }

  const ts = `/**
 * 内置品牌图标数据（v1.0.18 自动生成，勿手改 —— 跑 scripts/gen-simple-brand.cjs 再生）。
 * 数据源 simple-icons（CC0）+ Iconify 构建期补齐，只保留常用 ${ok} 个品牌，
 * 路径数据自包含、零网络、三端离线秒显。
 * 存储：选中时由 glyphToImgIcon 光栅化为 img: dataURL（随备份携带，与现有管线完全兼容）。
 */
export interface GlyphItem {
  /** 展示名（中文优先）。 */
  name: string;
  /** simple-icons slug（渲染/测试用）。 */
  slug: string;
  /** 品牌色（#RRGGBB 无 # 前缀）。 */
  hex: string;
  /** SVG path（viewBox 0 0 24 24）。 */
  path: string;
  /** 搜索别名（中英文）。 */
  alias?: string;
}
export interface GlyphGroup {
  label: string;
  items: GlyphItem[];
}
export const GLYPH_GROUPS: GlyphGroup[] = ${JSON.stringify(outGroups, null, 2)};

const ALL_GLYPHS: GlyphItem[] = GLYPH_GROUPS.flatMap((g) => g.items);

/** 关键词搜内置品牌（名称/别名/slug，不分大小写，多词 AND）。 */
export function searchGlyphs(query: string): GlyphItem[] {
  const words = (query ?? '').trim().toLowerCase().split(/\\s+/).filter(Boolean);
  if (!words.length) return [];
  return ALL_GLYPHS.filter((g) => {
    const hay = \`\${g.name} \${g.alias ?? ''} \${g.slug}\`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 光栅化品牌 glyph → img: dataURL（128px，透明底 + 品牌色路径；选中即用，随备份走）。 */
export async function glyphToImgIcon(g: GlyphItem, size = 128): Promise<string> {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) return 'img:';
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = \`#\${g.hex}\`;
  ctx.fill(new Path2D(g.path));
  return \`img:\${cv.toDataURL('image/png')}\`;
}
`;

  fs.writeFileSync(path.join(__dirname, '..', 'src', 'lib', 'simpleBrand.ts'), ts);
  console.log(`generated: ${ok} glyphs, missing ${missing.length}`);
  if (missing.length) console.log('missing:\n' + missing.join('\n'));
})();
