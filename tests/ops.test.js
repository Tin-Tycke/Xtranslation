const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../lib/ops.js');
const core = require('../lib/core.js');

describe('lib/ops.js', () => {
  it('records daily replies, quotes, posts and resets counts on new local day while keeping rolling hourly window', () => {
    const day1 = new Date(2026, 10, 27, 23, 50, 0).getTime();
    let stats = ops.createEmptyOpsStats(day1);
    stats = ops.recordOpsAction(stats, { kind: 'reply', author: '@alice' }, day1);
    stats = ops.recordOpsAction(stats, { kind: 'quote', author: '@bob' }, day1 + 1000);
    stats = ops.recordOpsAction(stats, { kind: 'post' }, day1 + 2000);

    assert.equal(stats.repliesToday, 1);
    assert.equal(stats.quotesToday, 1);
    assert.equal(stats.postsToday, 1);
    assert.deepEqual(stats.recentAuthors, ['@bob', '@alice']);

    // 20 minutes later (next day 00:10): daily counters reset, rolling 1h timestamps preserved
    const day2 = day1 + 20 * 60 * 1000;
    const normalized = ops.normalizeOpsStats(stats, day2);
    assert.equal(normalized.repliesToday, 0);
    assert.equal(normalized.quotesToday, 0);
    assert.equal(normalized.postsToday, 0);
    assert.equal(normalized.hourlyTimestamps.length, 3);
  });

  it('evaluates pace safety levels (safe -> caution -> cooldown)', () => {
    const now = Date.now();
    let stats = ops.createEmptyOpsStats(now);
    assert.equal(ops.evaluatePaceSafety(stats, now).level, 'safe');

    const base = now - 60000;
    for (let i = 0; i < 12; i++) {
      stats = ops.recordOpsAction(stats, { kind: 'reply' }, base + i * 1000);
    }
    assert.equal(ops.evaluatePaceSafety(stats, now).level, 'caution');

    for (let i = 0; i < 8; i++) {
      stats = ops.recordOpsAction(stats, { kind: 'quote' }, base + 20000 + i * 500);
    }
    const pace = ops.evaluatePaceSafety(stats, now);
    assert.equal(pace.level, 'cooldown');
    assert.equal(pace.hourlyCount, 20);
    assert.match(pace.warning, /暂停 15 分钟/);
  });
});

describe('Quote Remix & Ops background handlers', () => {
  let bg;
  let originalFetch;
  let originalChrome;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalChrome = globalThis.chrome;
    const localStore = {};
    globalThis.chrome = {
      runtime: { onMessage: { addListener: () => {} } },
      storage: {
        sync: {
          get: async (defaults) => ({
            ...defaults,
            targetRegion: 'en',
            apiBaseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test',
            model: 'gpt-4o-mini'
          })
        },
        local: {
          get: async (key) => ({ [key]: localStore[key] }),
          set: async (data) => Object.assign(localStore, data),
          remove: async (key) => {
            delete localStore[key];
          }
        }
      }
    };
    delete require.cache[require.resolve('../background.js')];
    bg = require('../background.js');
    bg._resetCacheForTest();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  });

  it('builds Quote Tweet remix prompts for both EN and ZH regions', () => {
    const enMsgs = core.buildQuoteRemixMessages({ context: '@ceo: AGI next month', region: 'en' });
    assert.match(enMsgs[0].content, /Quote Tweet/);
    assert.match(enMsgs[0].content, /YOUR OWN followers/);

    const zhMsgs = core.buildQuoteRemixMessages({ context: '@ceo: AGI 下月发布', region: 'zh' });
    assert.match(zhMsgs[0].content, /引用转发/);
    assert.match(zhMsgs[0].content, /自己粉丝看/);
  });

  it('handles GENERATE_QUOTE_REMIX, LOG_OPS_EVENT, GET_OPS_STATS, and RESET_OPS_STATS', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                post_takeaway: '博主在画大饼',
                candidates: [
                  { style: '犀利拆台', en: 'Same AGI timeline every quarter lmao.', zh_back: '每个季度都是同一套 AGI 时间表笑死。' }
                ]
              })
            }
          }
        ]
      })
    });

    const quoteRes = await bg.handleMessage({
      type: 'GENERATE_QUOTE_REMIX',
      context: '@ceo: AGI next month'
    });
    assert.equal(quoteRes.candidates[0].style, '犀利拆台');
    assert.match(quoteRes.candidates[0].en, /Same AGI timeline/);

    await bg.handleMessage({ type: 'LOG_OPS_EVENT', kind: 'quote', author: '@ceo' });
    await bg.handleMessage({ type: 'LOG_OPS_EVENT', kind: 'reply', author: '@dev' });
    const stats = await bg.handleMessage({ type: 'GET_OPS_STATS' });
    assert.equal(stats.quotesToday, 1);
    assert.equal(stats.repliesToday, 1);
    assert.equal(stats.pace.level, 'safe');

    const reset = await bg.handleMessage({ type: 'RESET_OPS_STATS' });
    assert.equal(reset.quotesToday, 0);
    assert.equal(reset.repliesToday, 0);
  });
});
