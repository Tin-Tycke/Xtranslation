const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mediaGen = require('../lib/media_gen.js');

describe('lib/media_gen.js', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('builds distinct editorial image and motion video prompts', () => {
    const imgMsgs = mediaGen.buildVisualPromptMessages({
      title: 'Why AI moats are shrinking',
      mainPost: 'API prices dropped again.',
      kind: 'image'
    });
    assert.match(imgMsgs[0].content, /NO text, NO letters/);
    assert.match(imgMsgs[1].content, /Why AI moats are shrinking/);

    const vidMsgs = mediaGen.buildVisualPromptMessages({
      mainPost: 'GPU clusters running hot.',
      kind: 'video'
    });
    assert.match(vidMsgs[0].content, /5-second video generation prompt/);
  });

  it('normalizes image generation URLs and supports both b64_json and url responses', async () => {
    assert.equal(
      mediaGen.normalizeImageGenUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/images/generations'
    );

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'iVBORw0KGgo=' }] })
    });
    const res1 = await mediaGen.generateImageFromProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-img',
      model: 'gpt-image-1',
      prompt: 'Minimalist glowing silicon wafer'
    });
    assert.equal(res1.dataUrl, 'data:image/png;base64,iVBORw0KGgo=');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ url: 'https://cdn.example.com/gen.png' }] })
    });
    const res2 = await mediaGen.generateImageFromProvider({
      baseUrl: 'https://api.x.ai/v1/images/generations',
      apiKey: 'xai-img',
      model: 'grok-2-image',
      prompt: 'Dark server room'
    });
    assert.equal(res2.url, 'https://cdn.example.com/gen.png');
  });

  it('supports both synchronous video URL and async task polling in generateVideoFromProvider', async () => {
    let pollCalls = 0;
    globalThis.fetch = async (url, opts) => {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        assert.equal(body.image_url, 'https://cdn.example.com/ref.jpg');
        return {
          ok: true,
          json: async () => ({ task_id: 'vid_123' })
        };
      }
      pollCalls++;
      if (pollCalls === 1) {
        return { ok: true, json: async () => ({ status: 'processing' }) };
      }
      return { ok: true, json: async () => ({ status: 'succeeded', video_url: 'https://cdn.example.com/out.mp4' }) };
    };

    const res = await mediaGen.generateVideoFromProvider({
      baseUrl: 'https://api.video.example.com/v1/videos',
      apiKey: 'vk-test',
      model: 'kling-v2',
      prompt: 'Slow cinematic zoom on chip',
      imageUrl: 'https://cdn.example.com/ref.jpg',
      pollIntervalMs: 5,
      maxPolls: 4
    });

    assert.equal(pollCalls, 2);
    assert.equal(res.url, 'https://cdn.example.com/out.mp4');
  });
});

describe('background.js optional AI image/video collaboration', () => {
  let bg;
  let originalFetch;
  let originalChrome;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalChrome = globalThis.chrome;
    globalThis.chrome = {
      runtime: { onMessage: { addListener: () => {} } },
      storage: {
        sync: {
          get: async (defaults) => ({
            ...defaults,
            apiBaseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-text',
            model: 'gpt-4o-mini',
            imageGenEnabled: true,
            imageGenBaseUrl: 'https://api.openai.com/v1/images/generations',
            imageGenApiKey: 'sk-img',
            imageGenModel: 'gpt-image-1',
            videoGenEnabled: false
          })
        },
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
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

  it('collaborates text LLM + image API for GENERATE_AI_IMAGE and blocks disabled GENERATE_AI_VIDEO', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('/chat/completions')) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Minimalist isometric glass chip under dramatic blue light' } }]
          })
        };
      }
      if (url.includes('/images/generations')) {
        return {
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn.example.com/collab-img.png' }] })
        };
      }
      return { ok: false };
    };

    const imgRes = await bg.handleMessage({
      type: 'GENERATE_AI_IMAGE',
      title: 'Chip war',
      mainPost: 'Inference cost is collapsing.'
    });
    assert.equal(imgRes.url, 'https://cdn.example.com/collab-img.png');
    assert.match(imgRes.prompt, /isometric glass chip/);

    await assert.rejects(
      () => bg.handleMessage({ type: 'GENERATE_AI_VIDEO', mainPost: 'Test' }),
      /开启「AI 生视频协作」/
    );
  });
});
