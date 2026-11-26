const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const radar = require('../lib/radar.js');

describe('lib/radar.js', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('parseRssItems', () => {
    it('parses RSS 2.0 items with CDATA and HTML stripped', () => {
      const xml = `
        <rss><channel>
          <item>
            <title><![CDATA[OpenAI launches new Agent SDK &amp; pricing]]></title>
            <link>https://openai.com/news/agent-sdk</link>
            <description><![CDATA[<p>Developers can now build <b>multi-agent</b> workflows.</p>]]></description>
            <pubDate>Thu, 26 Nov 2026 10:00:00 GMT</pubDate>
          </item>
        </channel></rss>
      `;
      const items = radar.parseRssItems(xml, 'OpenAI News');
      assert.equal(items.length, 1);
      assert.equal(items[0].title, 'OpenAI launches new Agent SDK & pricing');
      assert.equal(items[0].url, 'https://openai.com/news/agent-sdk');
      assert.match(items[0].snippet, /multi-agent workflows/);
    });

    it('parses Atom entries with link href attribute', () => {
      const atom = `
        <feed>
          <entry>
            <title>Apple delays Siri LLM upgrade again</title>
            <link href="https://www.theverge.com/ai/siri-delay" />
            <summary>Internal benchmarks fell short of targets.</summary>
          </entry>
        </feed>
      `;
      const items = radar.parseRssItems(atom, 'The Verge AI');
      assert.equal(items.length, 1);
      assert.equal(items[0].url, 'https://www.theverge.com/ai/siri-delay');
    });
  });

  describe('isTechAiRelevant & dedupeAndRankItems', () => {
    it('filters AI / Big Tech items and respects custom focus tokens', () => {
      assert.equal(radar.isTechAiRelevant('Anthropic releases Claude 4.5 benchmarks'), true);
      assert.equal(radar.isTechAiRelevant('Best pasta recipes for winter'), false);
      assert.equal(radar.isTechAiRelevant('Best pasta recipes for winter', 'pasta'), true);
    });

    it('deduplicates by URL and normalized title while boosting X (Grok) items', () => {
      const items = [
        { source: 'Hacker News', title: 'OpenAI cuts API prices', url: 'https://example.com/a', score: 90, comments: 40 },
        { source: 'TechCrunch AI', title: 'OpenAI cuts API prices!', url: 'https://example.com/b', score: 60, comments: 0 },
        { source: 'X (Grok)', title: 'Nvidia Blackwell supply crunch hits startups', url: 'https://x.com/user/status/1', score: 100, comments: 50 }
      ];
      const ranked = radar.dedupeAndRankItems(items, 10);
      assert.equal(ranked.length, 2);
      assert.equal(ranked[0].source, 'X (Grok)');
    });
  });

  describe('enrichSelectedTopic', () => {
    it('fetches top Reddit comments and article excerpt to build verified fact block', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('reddit.com/r/LocalLLaMA/comments/abc.json')) {
          return {
            ok: true,
            json: async () => [
              {},
              {
                data: {
                  children: [
                    { data: { score: 210, body: 'Tested on 4090, memory usage is still too high for 32k context.' } },
                    { data: { score: 85, body: '[deleted]' } }
                  ]
                }
              }
            ]
          };
        }
        if (url === 'https://blog.example.com/release') {
          return {
            ok: true,
            headers: { get: () => 'text/html; charset=utf-8' },
            text: async () => '<html><body><script>evil()</script><article>Model X cuts inference latency by 40%.</article></body></html>'
          };
        }
        return { ok: false };
      };

      const enriched = await radar.enrichSelectedTopic({
        source: 'Reddit r/LocalLLaMA',
        titleEn: 'Model X open weights released',
        url: 'https://blog.example.com/release',
        discussionUrl: 'https://www.reddit.com/r/LocalLLaMA/comments/abc',
        rawFacts: 'Apache 2.0 license, 32B params'
      });

      assert.match(enriched, /Apache 2\.0 license/);
      assert.match(enriched, /cuts inference latency by 40%/);
      assert.match(enriched, /memory usage is still too high/);
      assert.equal(enriched.includes('evil()'), false);
    });
  });

  describe('extractMediaFromHtml & enrichSelectedTopicWithMedia', () => {
    it('extracts og:image, video source, and relative article images while skipping icons/avatars', () => {
      const html = `
        <html>
          <head>
            <meta property="og:image" content="https://cdn.example.com/cover.jpg" />
            <link rel="icon" href="/favicon.ico" />
          </head>
          <body>
            <article>
              <img src="/images/benchmark.png" width="800" />
              <img src="/images/tiny-icon.png" width="32" />
              <img src="https://cdn.example.com/avatar-user.jpg" />
              <video><source src="/videos/demo.mp4" type="video/mp4" /></video>
            </article>
          </body>
        </html>
      `;
      const media = radar.extractMediaFromHtml(html, 'https://blog.example.com/posts/ai-chip');
      assert.equal(media.length, 3);
      assert.deepEqual(media[0], { type: 'image', url: 'https://cdn.example.com/cover.jpg', label: '封面图' });
      assert.deepEqual(media[1], { type: 'video', url: 'https://blog.example.com/videos/demo.mp4', label: '原文视频' });
      assert.deepEqual(media[2], { type: 'image', url: 'https://blog.example.com/images/benchmark.png', label: '原文配图' });
    });

    it('collects Reddit preview image, article cover image, and links in enrichSelectedTopicWithMedia', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('reddit.com/r/OpenAI/comments/xyz.json')) {
          return {
            ok: true,
            json: async () => [
              {
                data: {
                  children: [
                    {
                      data: {
                        preview: { images: [{ source: { url: 'https://i.redd.it/demo-chart.png' } }] }
                      }
                    }
                  ]
                }
              },
              { data: { children: [] } }
            ]
          };
        }
        if (url === 'https://news.example.com/story') {
          return {
            ok: true,
            headers: { get: () => 'text/html' },
            text: async () => '<meta property="og:image" content="https://news.example.com/hero.jpg"><p>Story text</p>'
          };
        }
        return { ok: false };
      };

      const { mediaAssets } = await radar.enrichSelectedTopicWithMedia({
        source: 'Reddit r/OpenAI',
        titleEn: 'New benchmark chart',
        url: 'https://news.example.com/story',
        discussionUrl: 'https://www.reddit.com/r/OpenAI/comments/xyz'
      });

      assert.ok(mediaAssets.some((m) => m.type === 'image' && m.url === 'https://news.example.com/hero.jpg'));
      assert.ok(mediaAssets.some((m) => m.type === 'image' && m.url === 'https://i.redd.it/demo-chart.png'));
      assert.ok(mediaAssets.some((m) => m.type === 'link' && m.url === 'https://news.example.com/story'));
    });
  });
});

describe('background.js radar & topic drafting integration', () => {
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
            apiKey: 'sk-test',
            model: 'gpt-4o-mini',
            grokApiKey: 'xai-test-key',
            grokModel: 'grok-3-mini'
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

  it('fetches multi-source radar topics (including Grok), curates 5 topics, and strips middle dots', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('api.x.ai/v1/responses')) {
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              items: [
                {
                  title: 'OpenAI vs Anthropic enterprise pricing war',
                  url: 'https://x.com/tech/status/999',
                  snippet: 'Developers debating token costs after sudden discount.'
                }
              ]
            })
          })
        };
      }
      if (url.includes('hacker-news.firebaseio.com/v0/topstories.json')) {
        return { ok: true, json: async () => [101] };
      }
      if (url.includes('hacker-news.firebaseio.com/v0/item/101.json')) {
        return {
          ok: true,
          json: async () => ({
            id: 101,
            title: 'Nvidia unveils new inference chip',
            url: 'https://nvidia.example.com/chip',
            score: 180,
            descendants: 95,
            time: 1700000000
          })
        };
      }
      if (url.includes('reddit.com/r/')) {
        return { ok: true, json: async () => ({ data: { children: [] } }) };
      }
      if (url.includes('api.openai.com/v1/chat/completions')) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    topics: [
                      {
                        id: 'topic_1',
                        source: 'X (Grok)',
                        title_zh: 'OpenAI·Anthropic 企业定价开战',
                        title_en: 'OpenAI vs Anthropic enterprise pricing war',
                        summary_zh: '两家大厂针对 API·Token 定价展开新一轮价格战',
                        angle_zh: '降价背后是护城河焦虑·值得直接下判断',
                        recommended_mode: 'news_post',
                        url: 'https://x.com/tech/status/999',
                        discussion_url: 'https://x.com/tech/status/999',
                        raw_facts: 'Sudden API discount triggered enterprise debate.'
                      }
                    ]
                  })
                }
              }
            ]
          })
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    };

    const res = await bg.handleMessage({ type: 'FETCH_RADAR_TOPICS', force: true });
    assert.equal(res.topics.length, 1);
    assert.equal(res.topics[0].titleZh.includes('·'), false);
    assert.equal(res.topics[0].summaryZh.includes('·'), false);
    assert.equal(res.topics[0].angleZh.includes('·'), false);
    assert.equal(res.topics[0].recommendedMode, 'news_post');
    assert.ok(res.sourceStats.some((s) => s.source === 'X (Grok)' && s.count === 1));
    assert.ok(res.sourceStats.some((s) => s.source === 'Hacker News' && s.count === 1));
  });

  it('enriches selected topic and generates editorial draft via DRAFT_FROM_TOPIC', async () => {
    let seenPrompt = '';
    globalThis.fetch = async (url, opts) => {
      if (url.includes('api.openai.com/v1/chat/completions')) {
        const body = JSON.parse(opts.body);
        seenPrompt = body.messages[1].content;
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: '',
                    main_post: 'AI API pricing just hit a race to the bottom.\n\nWhen OpenAI and Anthropic slash enterprise token costs, the model itself stops being the moat.',
                    first_reply: 'Source: https://x.com/tech/status/999',
                    zh_summary: '模型定价触底说明单纯模型本身不再是护城河',
                    fact_check_note: ''
                  })
                }
              }
            ]
          })
        };
      }
      return { ok: false };
    };

    const draft = await bg.handleMessage({
      type: 'DRAFT_FROM_TOPIC',
      topic: {
        source: 'X (Grok)',
        titleEn: 'OpenAI vs Anthropic enterprise pricing war',
        url: 'https://x.com/tech/status/999',
        rawFacts: 'Sudden API discount triggered enterprise debate.'
      },
      postMode: 'news_post',
      userAngle: '重点戳破模型护城河幻觉'
    });

    assert.match(seenPrompt, /重点戳破模型护城河幻觉/);
    assert.match(seenPrompt, /https:\/\/x\.com\/tech\/status\/999/);
    assert.match(draft.mainPost, /race to the bottom/);
    assert.match(draft.firstReply, /https:\/\/x\.com\/tech\/status\/999/);
    assert.ok(draft.mediaAssets.some((m) => m.type === 'x_post' && m.url === 'https://x.com/tech/status/999'));
  });

  it('downloads media via DOWNLOAD_MEDIA and fetches base64 via FETCH_MEDIA_DATA_URL', async () => {
    let downloadOpts = null;
    globalThis.chrome.downloads = {
      download: (opts, cb) => {
        downloadOpts = opts;
        cb(42);
      }
    };

    const dlRes = await bg.handleMessage({
      type: 'DOWNLOAD_MEDIA',
      url: 'https://cdn.example.com/hero.png',
      mediaType: 'image'
    });
    assert.equal(dlRes.downloadId, 42);
    assert.match(dlRes.filename, /^x-helper-media\/x-media-\d+\.png$/);
    assert.equal(downloadOpts.url, 'https://cdn.example.com/hero.png');

    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer
    });

    const dataRes = await bg.handleMessage({
      type: 'FETCH_MEDIA_DATA_URL',
      url: 'https://cdn.example.com/hero.png'
    });
    assert.equal(dataRes.mimeType, 'image/png');
    assert.match(dataRes.dataUrl, /^data:image\/png;base64,/);
  });
});
