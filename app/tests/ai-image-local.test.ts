import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock 本地 OCR：用 fixture 的真实行文本模拟识别输出（不跑真 Tesseract）
vi.mock('../src/lib/localOcr', () => ({
  ocrLines: vi.fn(async () => [] as string[]),
  ocrText: vi.fn(async () => ''),
  warmUpOcr: vi.fn(),
}));

import { ocrLines } from '../src/lib/localOcr';
import { parseImage } from '../src/ai/parseService';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { Category } from '../src/types/entities';
import ocr from './fixtures/ecom-ocr.json';

/**
 * ★v1.2.2 识图链路接入（用户反馈 2）：
 *   parseImage（未配 AI）→ ocrLines → parseOrderShot → 合成句 → parseLocal → normalizeItems。
 * 验证 9 张真实截图端到端产出正确的记账条目（名称/金额/备注/来源）。
 */

const JD_1 = ocr['S61019-11180546_com.jingdong.app.mall.png'] as string[];
const JD_3 = ocr['S61019-11181238_com.jingdong.app.mall.png'] as string[];
const PDD_1 = ocr['S61019-11182730_com.xunmeng.pinduoduo.png'] as string[];
const TB_1 = ocr['S61019-11184157_com.taobao.taobao.png'] as string[];
const DY_2 = ocr['S61019-11190247_com.ss.android.ugc.aweme.png'] as string[];

const cats: Category[] = SEED_CATEGORIES;

/** 跨域取价：生活流取 amount，物品取 price。 */
function amountOf(item: { ledgerDraft?: { amount?: number }; goodsDraft?: { price?: number } }): number | undefined {
  return item.ledgerDraft?.amount ?? item.goodsDraft?.price;
}

/** 跑一遍「未配置 AI」的识图链路（OCR 输出由 mock 注入）。 */
async function run(lines: string[]) {
  vi.mocked(ocrLines).mockResolvedValue(lines);
  return parseImage('data:image/png;base64,xx', {
    categories: cats,
    settings: { currency: 'CNY' } as never,
    today: '2026-10-19',
  });
}

beforeEach(() => {
  vi.mocked(ocrLines).mockReset();
});

describe('parseImage 本地链路：订单截图 → 记账条目', () => {
  it('京东订单详情 → 1 条生活流（酒精湿巾 0.99），备注带平台', async () => {
    const out = await run(JD_1);
    expect(out.source).toBe('local');
    expect(out.reason).toContain('识别出 1 笔订单');
    expect(out.items).toHaveLength(1);
    const it0 = out.items[0]!;
    expect(it0.action).toBe('create_ledger');
    expect(it0.ledgerDraft?.amount).toBe(0.99);
    expect(it0.ledgerDraft?.note).toContain('京东');
    expect(it0.ledgerDraft?.note).toContain('酒精温巾');
  });

  it('京东订单列表 → 2 条（0.99 消耗品 + 0.56 耐用品），逐条带金额', async () => {
    const out = await run(JD_3);
    expect(out.items).toHaveLength(2);
    expect(out.items.map(amountOf).sort()).toEqual([0.56, 0.99]);
  });

  it('拼多多订单 → 1 条（老鼠夹 3.59），备注带平台', async () => {
    const out = await run(PDD_1);
    expect(out.items).toHaveLength(1);
    expect(amountOf(out.items[0]!)).toBe(3.59);
    expect(out.items[0]!.ledgerDraft?.note ?? out.items[0]!.goodsDraft?.note).toContain('拼多多');
  });

  it('淘宝订单（实付 0.01 非总价 2.01）→ 金额取实付', async () => {
    const out = await run(TB_1);
    expect(out.items).toHaveLength(1);
    expect(amountOf(out.items[0]!)).toBe(0.01);
    expect(out.items[0]!.ledgerDraft?.note ?? out.items[0]!.goodsDraft?.note).toContain('淘宝');
  });

  it('抖音订单列表 → 3 条（0.01 + 0.01 + 59.99）', async () => {
    const out = await run(DY_2);
    expect(out.items).toHaveLength(3);
    expect(out.items.map(amountOf).sort()).toEqual([0.01, 0.01, 59.99]);
  });

  it('非订单图（聊天记录）→ 回落整段解析，识别不出时给出原因', async () => {
    vi.mocked(ocrLines).mockResolvedValue(['在吗', '今晚一起吃饭吗', '好的没问题']);
    const out = await parseImage('data:image/png;base64,xx', {
      categories: cats,
      settings: { currency: 'CNY' } as never,
      today: '2026-10-19',
    });
    expect(out.items).toHaveLength(0);
    expect(out.reason).toContain('没有解析出可记账内容');
  });

  it('OCR 空结果 → 直接告知没有文字', async () => {
    vi.mocked(ocrLines).mockResolvedValue([]);
    const out = await parseImage('data:image/png;base64,xx', {
      categories: cats,
      settings: { currency: 'CNY' } as never,
      today: '2026-10-19',
    });
    expect(out.items).toHaveLength(0);
    expect(out.reason).toContain('没有识别出文字');
  });
});
