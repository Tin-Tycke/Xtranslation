const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('content.js helpers & continuation state', () => {
  let content;
  let originalEnvFlag;
  let originalChrome;
  let originalDocument;

  beforeEach(() => {
    originalEnvFlag = globalThis.__XTR_TEST_ENV__;
    originalChrome = globalThis.chrome;
    originalDocument = globalThis.document;
    globalThis.__XTR_TEST_ENV__ = true;
    globalThis.chrome = {
      storage: {
        local: {
          set: () => {}
        }
      }
    };
    delete require.cache[require.resolve('../content.js')];
    content = require('../content.js');
    content.clearLastSelection();
  });

  afterEach(() => {
    globalThis.__XTR_TEST_ENV__ = originalEnvFlag;
    globalThis.chrome = originalChrome;
    globalThis.document = originalDocument;
  });

  describe('image URL filtering & extraction', () => {
    it('accepts tweet media/card/video thumbnails and rejects avatars/emojis', () => {
      assert.equal(content.isTweetContentImageUrl('https://pbs.twimg.com/media/Abc123?format=jpg'), true);
      assert.equal(content.isTweetContentImageUrl('https://pbs.twimg.com/card_img/12345/img'), true);
      assert.equal(content.isTweetContentImageUrl('https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img.jpg'), true);
      assert.equal(content.isTweetContentImageUrl('https://pbs.twimg.com/profile_images/999/avatar.jpg'), false);
      assert.equal(content.isTweetContentImageUrl('https://abs-0.twimg.com/emoji/v2/svg/1f480.svg'), false);
    });

    it('deduplicates images, strips generic "Image" alt, and caps at 4', () => {
      const mockImgs = [
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/1.jpg' : 'Image') },
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/1.jpg' : 'Duplicate') },
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/2.jpg' : 'Benchmark chart') },
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/profile_images/a.jpg' : 'Avatar') },
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/3.jpg' : '') },
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/4.jpg' : '') },
        { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/5.jpg' : '') }
      ];
      const fakeEl = { querySelectorAll: () => mockImgs };
      const imgs = content.extractImagesFromElement(fakeEl);
      assert.equal(imgs.length, 4);
      assert.deepEqual(imgs[0], { url: 'https://pbs.twimg.com/media/1.jpg', alt: '' });
      assert.deepEqual(imgs[1], { url: 'https://pbs.twimg.com/media/2.jpg', alt: 'Benchmark chart' });
    });
  });

  describe('tweet & reply context extraction', () => {
    it('extracts quoted tweet, link card, and images from an article', () => {
      const mainTweetTextEl = {
        childNodes: [{ nodeType: 3, textContent: 'This chart says everything.' }]
      };
      const quotedTweetTextEl = {
        childNodes: [{ nodeType: 3, textContent: 'Original claim about AI' }]
      };
      const fakeArticle = {
        querySelector: (sel) => {
          if (sel === '[data-testid="card.wrapper"]') {
            return { innerText: 'TechBlog — Why benchmarks lie' };
          }
          return null;
        },
        querySelectorAll: (sel) => {
          if (sel === '[data-testid="tweetText"]') return [mainTweetTextEl, quotedTweetTextEl];
          if (sel === 'img') {
            return [
              { getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/chart1.png' : 'Cost comparison') }
            ];
          }
          return [];
        }
      };

      const payload = content.extractTweetContextPayload(mainTweetTextEl, fakeArticle, '/home');
      assert.match(payload.context, /TechBlog — Why benchmarks lie/);
      assert.match(payload.context, /\[引用的推文\]: Original claim about AI/);
      assert.equal(payload.images.length, 1);
      assert.equal(payload.images[0].alt, 'Cost comparison');
    });

    it('extracts reply dialog context including author, text, and images', () => {
      const tweetTextEl = {
        childNodes: [{ nodeType: 3, textContent: 'Hot take: TypeScript is overrated.' }]
      };
      const fakeArticle = {
        querySelector: (sel) => (sel === '[data-testid="tweetText"]' ? tweetTextEl : null),
        querySelectorAll: (sel) => {
          if (sel === 'div[data-testid="User-Name"] a[href^="/"]') {
            return [{ getAttribute: () => '/dev_hot_take' }];
          }
          if (sel === 'img') {
            return [{ getAttribute: (k) => (k === 'src' ? 'https://pbs.twimg.com/media/ts.png' : 'Error stack') }];
          }
          return [];
        }
      };
      const fakeDialog = {
        querySelectorAll: (sel) => {
          if (sel === 'article[data-testid="tweet"]') return [fakeArticle];
          return [];
        }
      };
      const fakeTextbox = {
        closest: (sel) => (sel === 'div[role="dialog"]' ? fakeDialog : null),
        contains: () => false
      };

      const payload = content.extractReplyContextPayload(fakeTextbox, '/home');
      assert.match(payload.context, /@dev_hot_take: Hot take: TypeScript is overrated\./);
      assert.equal(payload.images.length, 1);
      assert.equal(payload.images[0].url, 'https://pbs.twimg.com/media/ts.png');
    });
  });

  describe('XSS-safe error rendering', () => {
    it('renders error text via textContent without interpreting HTML', () => {
      const appended = [];
      globalThis.document = {
        createElement: (tag) => ({ tagName: tag.toUpperCase(), className: '', textContent: '' })
      };
      const container = {
        innerHTML: 'old',
        appendChild: (node) => appended.push(node)
      };

      content.renderErrorMessage(container, '生成失败', new Error('<img src=x onerror=alert(1)>'));
      assert.equal(container.innerHTML, '');
      assert.equal(appended.length, 1);
      assert.equal(appended[0].className, 'xtr-error-text');
      assert.equal(appended[0].textContent, '生成失败: <img src=x onerror=alert(1)>');
    });
  });

  describe('continuation state', () => {
    it('records selected candidate, enables continuation, and clears cleanly', () => {
      assert.equal(content.getActiveContinuation(), null);

      content.recordSelectedCandidate({
        en: 'Honestly feels like a solution looking for a problem.',
        zh_back: '老实说像是在找问题来套方案。',
        style: '挑刺/引战'
      });

      const active = content.getActiveContinuation();
      assert.ok(active);
      assert.equal(active.en, 'Honestly feels like a solution looking for a problem.');
      assert.equal(active.style, '挑刺/引战');

      content.SESSION_STATE.continueEnabled = false;
      assert.equal(content.getActiveContinuation(), null);

      content.clearLastSelection();
      assert.equal(content.SESSION_STATE.lastSelection, null);
    });
  });

  describe('Draft.js paste comparison (prevents double-insert backspace bug)', () => {
    it('does NOT trigger fallback when Draft.js renders different blank-line newlines', () => {
      const expected = 'Line one.\n\nLine two.\n\nLine three.';
      const draftJsInnerText = 'Line one.\n\n\nLine two.\nLine three.\n';
      assert.equal(content.shouldFallbackAfterPaste(draftJsInnerText, expected), false);
    });

    it('triggers fallback only when paste actually failed to insert text', () => {
      assert.equal(content.shouldFallbackAfterPaste('', 'Line one.\n\nLine two.'), true);
      assert.equal(content.shouldFallbackAfterPaste('Old draft', 'New English post'), true);
    });

    it('never uses destructive execCommand insertText in content.js', () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
      assert.equal(src.includes("execCommand('insertText'"), false);
      assert.equal(src.includes('function appendEditorText('), true);
    });
  });
});
