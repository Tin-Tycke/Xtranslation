const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.js');

describe('lib/core.js', () => {
  describe('buildApiUrl', () => {
    it('appends /chat/completions for standard /v1 base URLs', () => {
      assert.equal(
        core.buildApiUrl('https://api.deepseek.com/v1'),
        'https://api.deepseek.com/v1/chat/completions'
      );
      assert.equal(
        core.buildApiUrl('https://api.openai.com/v1/'),
        'https://api.openai.com/v1/chat/completions'
      );
    });

    it('auto-completes Gemini native base URL to OpenAI compatible path', () => {
      assert.equal(
        core.buildApiUrl('https://generativelanguage.googleapis.com'),
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      );
      assert.equal(
        core.buildApiUrl('https://generativelanguage.googleapis.com/v1beta'),
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      );
    });

    it('appends /v1/chat/completions when only domain is provided', () => {
      assert.equal(
        core.buildApiUrl('https://my-proxy.example.com'),
        'https://my-proxy.example.com/v1/chat/completions'
      );
    });

    it('keeps URL unchanged if already ending with /chat/completions', () => {
      const full = 'https://api.example.com/custom/chat/completions';
      assert.equal(core.buildApiUrl(full), full);
    });

    it('throws when baseUrl is empty', () => {
      assert.throws(() => core.buildApiUrl('   '), /API Base URL/);
    });
  });

  describe('parseJsonSafely', () => {
    it('parses fenced markdown JSON and embedded JSON objects', () => {
      assert.deepEqual(core.parseJsonSafely('```json\n{"a": 1}\n```'), { a: 1 });
      assert.deepEqual(core.parseJsonSafely('Here you go:\n{"ok": true}\nDone!'), { ok: true });
    });

    it('throws on unparseable content', () => {
      assert.throws(() => core.parseJsonSafely('not json at all'), /解析失败/);
    });
  });

  describe('multimodal content & vision fallback helpers', () => {
    it('returns plain string when no images are provided', () => {
      const content = core.buildMultimodalUserContent('Hello tweet', []);
      assert.equal(typeof content, 'string');
      assert.equal(content, 'Hello tweet');
    });

    it('builds OpenAI vision array capped at 4 images with alt hints', () => {
      const imgs = [1, 2, 3, 4, 5].map((n) => ({
        url: `https://pbs.twimg.com/media/img${n}.jpg`,
        alt: n === 1 ? 'Chart showing revenue drop' : ''
      }));
      const content = core.buildMultimodalUserContent('Look at this', imgs);
      assert.ok(Array.isArray(content));
      assert.equal(content.length, 5); // 1 text + 4 images
      assert.match(content[0].text, /Chart showing revenue drop/);
      assert.equal(content[1].type, 'image_url');
      assert.equal(content[1].image_url.url, 'https://pbs.twimg.com/media/img1.jpg');
    });

    it('detects image content and strips images cleanly for fallback', () => {
      const messages = [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: core.buildMultimodalUserContent('Analyze post', [
            { url: 'data:image/png;base64,abc', alt: 'Meme caption' }
          ])
        }
      ];
      assert.equal(core.hasImageContent(messages), true);

      const stripped = core.stripImagesFromMessages(messages);
      assert.equal(core.hasImageContent(stripped), false);
      assert.equal(typeof stripped[1].content, 'string');
      assert.match(stripped[1].content, /Meme caption/);
      assert.match(stripped[1].content, /不支持直接识图/);
    });
  });

  describe('prompt builders', () => {
    it('includes takeaway instruction and image context in tweet translation prompt', () => {
      const msgs = core.buildTweetTranslationMessages({
        text: 'We are so cooked lmao',
        author: '@dev',
        context: '[引用的推文]: Server is down',
        images: [{ url: 'data:image/jpeg;base64,xyz', alt: '500 error screenshot' }],
        showSlangNotes: true,
        glossary: 'cooked=凉透了'
      });
      assert.equal(msgs.length, 2);
      assert.match(msgs[0].content, /takeaway/);
      assert.match(msgs[0].content, /cooked=凉透了/);
      assert.ok(Array.isArray(msgs[1].content));
      assert.match(msgs[1].content[0].text, /500 error screenshot/);
    });

    it('includes contrarian stance, medium length, anti-AI rules, and continuation in reply candidates prompt', () => {
      const msgs = core.buildReplyCandidatesMessages({
        context: '@founder: AI will replace all junior devs by next year.',
        stance: 'contrarian',
        length: 'medium',
        continuation: {
          en: 'Everyone says this until prod breaks at 3am.',
          zh_back: '大家都这么说，直到凌晨三点线上崩了。',
          style: '犀利反驳'
        }
      });
      assert.match(msgs[0].content, /devil's advocate|blind spot/i);
      assert.match(msgs[0].content, /2–4 sentences/);
      assert.match(msgs[0].content, /Anti-AI Authenticity Rules/);
      assert.match(msgs[0].content, /post_takeaway/);
      assert.match(msgs[1].content, /Previous Reply \/ Selected Candidate to Continue From/);
      assert.match(msgs[1].content, /Everyone says this until prod breaks at 3am/);
    });

    it('normalizes legacy and unknown stance/length values safely', () => {
      assert.equal(core.normalizeStance('friendly'), 'friendly');
      assert.equal(core.normalizeStance('unknown_tone'), 'mix');
      assert.equal(core.normalizeLength('short'), 'short');
      assert.equal(core.normalizeLength('huge'), 'auto');
    });
  });

  describe('language detection', () => {
    it('correctly identifies mostly Chinese vs English tweets', () => {
      assert.equal(core.isMostlyChinese('今天天气真不错啊'), true);
      assert.equal(core.isMostlyChinese('This product launch is actually wild ngl'), false);
      assert.equal(core.hasChinese('Hello 世界'), true);
      assert.equal(core.hasChinese('Hello world'), false);
    });
  });

  describe('editorial post & article writer helpers', () => {
    it('sanitizes middle dots and bullet dots into spaces while preserving paragraph breaks', () => {
      const input = 'OpenAI·Google  ·  Anthropic\n\n• First point\nLine·two';
      assert.equal(
        core.sanitizeMiddleDots(input),
        'OpenAI Google Anthropic\n\n First point\nLine two'.trim()
      );
      assert.equal(core.sanitizeMiddleDots(input).includes('·'), false);
      assert.equal(core.sanitizeMiddleDots(input).includes('•'), false);
    });

    it('extracts unique URLs from source notes', () => {
      const urls = core.extractUrls('See https://openai.com/blog/test and https://openai.com/blog/test plus http://example.com/a');
      assert.deepEqual(urls, ['https://openai.com/blog/test', 'http://example.com/a']);
    });

    it('builds news_post prompt enforcing editorial constitution and first-reply link split', () => {
      const msgs = core.buildPostDraftMessages({
        source: 'OpenAI just cut API pricing by 50% https://openai.com/pricing',
        postMode: 'news_post'
      });
      assert.match(msgs[0].content, /Strict Factual Grounding/);
      assert.match(msgs[0].content, /First-Person Perspective/);
      assert.match(msgs[0].content, /No Middle Dots/);
      assert.match(msgs[0].content, /No Throat-Clearing Openers/);
      assert.match(msgs[0].content, /first_reply/);
      assert.match(msgs[0].content, /NEVER write "I plan to\.\.\."/);
      assert.match(msgs[1].content, /https:\/\/openai\.com\/pricing/);
    });

    it('builds long_article and method_guide prompts with mode-specific directives', () => {
      const articleMsgs = core.buildPostDraftMessages({
        source: 'Why Apple Intelligence is lagging behind cloud models.',
        postMode: 'long_article'
      });
      assert.match(articleMsgs[0].content, /LONG-FORM X POST \/ ARTICLE/);
      assert.match(articleMsgs[0].content, /concrete, specific real-world scenarios/);

      const methodMsgs = core.buildPostDraftMessages({
        source: 'My exact prompt review loop for shipping Chrome extensions.',
        postMode: 'method_guide'
      });
      assert.match(methodMsgs[0].content, /PRACTICAL METHOD \/ WORKFLOW GUIDE/);
      assert.match(methodMsgs[0].content, /COMPLETELY/);
    });
  });
});
