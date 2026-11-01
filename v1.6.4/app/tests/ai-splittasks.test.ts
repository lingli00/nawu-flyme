import { describe, expect, it } from 'vitest';
import { splitTasks } from '../src/ai/splitTasks';

/**
 * ★v1.2.2 多任务拆分（用户反馈 4：一条消息问 4 个问题只回 1 句）。
 * 查询段逐个回答、省略追问继承时间范围、记录段合并弹卡。
 */
describe('splitTasks 多任务拆分', () => {
  it('单查询 → 单个 query 段', () => {
    expect(splitTasks('这周买过最贵的东西是什么？')).toEqual([
      { kind: 'query', text: '这周买过最贵的东西是什么' },
    ]);
  });

  it('单记录 → 单个 record 段', () => {
    expect(splitTasks('今天在淘宝花了29块钱买了30斤大米')).toEqual([
      { kind: 'record', text: '今天在淘宝花了29块钱买了30斤大米' },
    ]);
  });

  it('一条消息多个问题 → 逐个 query 段（视频反馈核心场景）', () => {
    const segs = splitTasks('这周买过最贵的东西是什么？最便宜的呢？昨天心情怎么样？');
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.kind === 'query')).toBe(true);
    expect(segs[0]?.text).toBe('这周买过最贵的东西是什么');
    expect(segs[1]?.text).toBe('这周最便宜的呢'); // 省略追问继承「这周」
    expect(segs[2]?.text).toBe('昨天心情怎么样');
  });

  it('省略追问继承上一个查询的时间词', () => {
    const segs = splitTasks('昨天买了什么？最便宜的呢？');
    expect(segs).toEqual([
      { kind: 'query', text: '昨天买了什么' },
      { kind: 'query', text: '昨天最便宜的呢' },
    ]);
  });

  it('无时间词可继承时省略追问按原样回答', () => {
    const segs = splitTasks('买过最贵的东西是什么？最便宜的呢？');
    expect(segs[1]).toEqual({ kind: 'query', text: '最便宜的呢' });
  });

  it('记录 + 追问混合 → record 段在前、query 段在后（顺序保持）', () => {
    const segs = splitTasks('今天买了牛奶花了50。查下这周一共花了多少');
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: 'record', text: '今天买了牛奶花了50' });
    expect(segs[1]).toEqual({ kind: 'query', text: '查下这周一共花了多少' });
  });

  it('句内逗号二级切分：记录 + 追问拆开', () => {
    const segs = splitTasks('我今天在淘宝花了29块钱买了大米，这周买过最贵的东西是什么');
    expect(segs).toHaveLength(2);
    expect(segs[0]?.kind).toBe('record');
    expect(segs[0]?.text).toBe('我今天在淘宝花了29块钱买了大米');
    expect(segs[1]).toEqual({ kind: 'query', text: '这周买过最贵的东西是什么' });
  });

  it('查询句内部的逗号不拆（「查一下昨天花了多少，这周呢」是一整句）', () => {
    const segs = splitTasks('查一下昨天花了多少，这周呢');
    expect(segs).toEqual([{ kind: 'query', text: '查一下昨天花了多少，这周呢' }]);
  });

  it('连续记录段合并成一个 record 段', () => {
    const segs = splitTasks('买了大米花了29。又买了纸巾花了12');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.kind).toBe('record');
    expect(segs[0]?.text).toContain('买了大米花了29');
    expect(segs[0]?.text).toContain('又买了纸巾花了12');
  });

  it('「记一下…」开头按记录处理，不拆查询', () => {
    const segs = splitTasks('记一下昨天花了多少钱');
    expect(segs).toEqual([{ kind: 'record', text: '记一下昨天花了多少钱' }]);
  });

  it('空文本 → 空数组', () => {
    expect(splitTasks('')).toEqual([]);
    expect(splitTasks('   ')).toEqual([]);
  });

  it('查询与记录交替 → 顺序与类型都不乱', () => {
    const segs = splitTasks('查下今天花了多少。买了牛奶花了50。昨天心情怎么样？');
    expect(segs.map((s) => s.kind)).toEqual(['query', 'record', 'query']);
    expect(segs[1]?.text).toBe('买了牛奶花了50');
  });
});
