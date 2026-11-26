const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function createChromeMock(initialSync = {}) {
  const syncStore = {
    provider: 'openai',
    apiBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key',
    model: 'gpt-4o-mini',
    autoTranslate: false,
    showSlangNotes: true,
    defaultTone: 'mix',
    defaultLength: 'auto',
    glossary: '',
    ...initialSync
  };
  const localStore = {};

  return {
    syncStore,
    localStore,
    runtime: {
      onMessage: { addListener: () => {} }
    },
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...syncStore }),
        set: async (data) => Object.assign(syncStore, data)
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
}

describe('background.js', () => {
  let bg;
  let originalFetch;
  let originalChrome;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalChrome = globalThis.chrome;
    globalThis.chrome = createChromeMock();
    delete require.cache[require.resolve('../background.js')];
    bg = require('../background.js');
    bg._resetCacheForTest();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  });

  it('translates tweet with takeaway and caches identical requests', async () => {
    let llmCalls = 0;
    globalThis.fetch = async (url, opts) => {
      llmCalls++;
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'gpt-4o-mini');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translation: '这波真凉透了',
                  takeaway: '作者在吐槽这次发布彻底翻车',
                  slang_notes: ['cooked：完蛋了/凉透了']
                })
              }
            }
          ]
        })
      };
    };

    const res1 = await bg.handleMessage({
      type: 'TRANSLATE_TWEET',
      text: 'We are cooked',
      author: '@alice'
    });
    assert.equal(res1.translation, '这波真凉透了');
    assert.equal(res1.takeaway, '作者在吐槽这次发布彻底翻车');
    assert.deepEqual(res1.slangNotes, ['cooked：完蛋了/凉透了']);
    assert.equal(res1.visionFallback, false);
    assert.equal(llmCalls, 1);

    // Second call hits cache
    const res2 = await bg.handleMessage({
      type: 'TRANSLATE_TWEET',
      text: 'We are cooked',
      author: '@alice'
    });
    assert.equal(res2.translation, '这波真凉透了');
    assert.equal(llmCalls, 1);

    // Clear cache and call again
    await bg.handleMessage({ type: 'CLEAR_CACHE' });
    await bg.handleMessage({
      type: 'TRANSLATE_TWEET',
      text: 'We are cooked',
      author: '@alice'
    });
    assert.equal(llmCalls, 2);
  });

  it('automatically falls back from vision to text when model rejects image payload with 400', async () => {
    const seenPayloads = [];
    globalThis.fetch = async (url, opts) => {
      if (url.includes('pbs.twimg.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/jpeg' },
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
        };
      }
      const body = JSON.parse(opts.body);
      seenPayloads.push(body);
      const userMsg = body.messages[1];
      if (Array.isArray(userMsg.content)) {
        // Simulate text-only model (e.g. deepseek-chat) rejecting image_url
        return {
          ok: false,
          status: 400,
          text: async () => 'image_url is not supported by this model'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  post_takeaway: '博主晒出截图吹嘘增长，但基数其实很小',
                  candidates: [
                    { style: '挑刺/引战', en: 'Easy to 10x when you start from 3 users.', zh_back: '从3个用户起步当然容易翻十倍。' }
                  ]
                })
              }
            }
          ]
        })
      };
    };

    const res = await bg.handleMessage({
      type: 'GENERATE_AUTO_REPLIES',
      context: '@founder: 10x growth this month!',
      images: [{ url: 'https://pbs.twimg.com/media/chart.jpg', alt: 'Graph from 3 to 30' }],
      stance: 'contrarian',
      length: 'medium',
      continuation: { en: 'Love the optimism here.', style: '挑刺/引战' }
    });

    assert.equal(seenPayloads.length, 2);
    assert.ok(Array.isArray(seenPayloads[0].messages[1].content));
    assert.equal(typeof seenPayloads[1].messages[1].content, 'string');
    assert.match(seenPayloads[1].messages[1].content, /Graph from 3 to 30/);
    assert.match(seenPayloads[1].messages[1].content, /Love the optimism here/);
    assert.equal(res.visionFallback, true);
    assert.equal(res.postTakeaway, '博主晒出截图吹嘘增长，但基数其实很小');
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].en, 'Easy to 10x when you start from 3 users.');
  });

  it('handles 429 rate limit and AbortError timeout with clear messages', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited'
    });

    await assert.rejects(
      () => bg.handleMessage({ type: 'TEST_CONNECTION' }),
      /429/
    );

    globalThis.fetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      () => bg.handleMessage({ type: 'TEST_CONNECTION' }),
      /请求超时/
    );
  });

  it('requires API key for remote endpoints but allows empty key for localhost', async () => {
    globalThis.chrome = createChromeMock({ apiKey: '', apiBaseUrl: 'https://api.openai.com/v1' });
    await assert.rejects(
      () => bg.handleMessage({ type: 'TEST_CONNECTION' }),
      /配置 API Key/
    );

    globalThis.chrome = createChromeMock({ apiKey: '', apiBaseUrl: 'http://localhost:11434/v1' });
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'OK' } }] })
    });
    const res = await bg.handleMessage({ type: 'TEST_CONNECTION' });
    assert.equal(res, 'OK');
  });
});
