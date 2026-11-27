// Multi-source Tech / Big Tech / AI Topic Radar & Enrichment for X 地道双语助手

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XTR_RADAR = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_SUBREDDITS = ['LocalLLaMA', 'OpenAI', 'MachineLearning', 'artificial', 'technology'];

  const MEME_ENT_SUBREDDITS = ['memes', 'dankmemes', 'me_irl', 'ProgrammerHumor', 'interestingasfuck', 'popculturechat', 'movies'];

  const GENERAL_VIRAL_SUBREDDITS = ['worldnews', 'news', 'todayilearned', 'Damnthatsinteresting', 'mildlyinteresting', 'business'];

  const MEME_ENT_RSS_FEEDS = [
    { name: 'The Verge Entertainment', url: 'https://www.theverge.com/rss/entertainment/index.xml', category: 'entertainment' },
    { name: 'Variety', url: 'https://variety.com/feed/', category: 'entertainment' }
  ];

  const GENERAL_VIRAL_RSS_FEEDS = [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'general_news' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'general_news' }
  ];

  const DEFAULT_RSS_FEEDS = [
    // 快讯媒体
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', category: 'news_media' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', category: 'news_media' },
    { name: 'Ars Technica AI', url: 'https://arstechnica.com/ai/feed/', category: 'news_media' },
    { name: 'The Decoder', url: 'https://the-decoder.com/feed/', category: 'news_media' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', category: 'news_media' },
    // 实验室官方一手
    { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', category: 'official_labs' },
    { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', category: 'official_labs' },
    // 通讯聚合捡漏
    { name: 'Import AI', url: 'https://importai.substack.com/feed', category: 'newsletters' },
    { name: "Ben's Bites", url: 'https://www.bensbites.com/feed', category: 'newsletters' }
  ];

  const DEFAULT_HTML_NEWS_SOURCES = [
    { name: 'Anthropic', url: 'https://www.anthropic.com/news', pathPrefix: '/news/', category: 'official_labs' },
    { name: 'Meta AI', url: 'https://ai.meta.com/blog/', pathPrefix: '/blog/', category: 'official_labs' },
    { name: 'Mistral', url: 'https://mistral.ai/news', pathPrefix: '/news/', category: 'official_labs' },
    { name: 'xAI', url: 'https://x.ai/news', pathPrefix: '/news/', category: 'official_labs' },
    { name: 'TLDR AI', url: 'https://tldr.tech/ai', pathPrefix: '/ai/', category: 'newsletters' },
    { name: 'The Rundown AI', url: 'https://www.therundown.ai/', pathPrefix: '/p/', category: 'newsletters' }
  ];

  const TECH_AI_KEYWORDS = [
    'ai', 'llm', 'gpt', 'claude', 'anthropic', 'openai', 'gemini', 'deepmind', 'grok', 'xai',
    'deepseek', 'llama', 'mistral', 'qwen', 'agent', 'mcp', 'cursor', 'copilot', 'coding',
    'apple', 'google', 'meta', 'microsoft', 'nvidia', 'amazon', 'tesla', 'bytedance',
    'chip', 'gpu', 'tpu', 'cuda', 'model', 'benchmark', 'reasoning', 'inference', 'open source',
    'open-source', 'weights', 'fine-tune', 'rag', 'multimodal', 'voice', 'video', 'sora',
    'startup', 'layoff', 'antitrust', 'regulation', 'api', 'pricing', 'token', 'context window',
    'github', 'developer', 'browser', 'search', 'robotics', 'humanoid'
  ];

  function decodeXmlEntities(str) {
    return String(str || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseRssItems(xmlText, sourceName, limit = 8) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    const items = [];
    const entryMatches = xmlText.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];

    for (const block of entryMatches) {
      const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const linkHrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      const linkTagMatch = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
      const descMatch = block.match(/<(?:description|summary|content)\b[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i);
      const dateMatch = block.match(/<(?:pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);

      const title = decodeXmlEntities(titleMatch?.[1] || '');
      const rawLink = linkHrefMatch?.[1] || linkTagMatch?.[1] || '';
      const url = decodeXmlEntities(rawLink).trim();
      const snippet = decodeXmlEntities(descMatch?.[1] || '').slice(0, 320);
      const publishedAt = dateMatch ? Date.parse(decodeXmlEntities(dateMatch[1])) || 0 : 0;

      if (!title || !url || !/^https?:\/\//i.test(url)) continue;
      items.push({
        id: `rss_${items.length}_${url.slice(-20)}`,
        source: sourceName,
        title,
        url,
        discussionUrl: '',
        score: 60,
        comments: 0,
        publishedAt,
        snippet
      });
      if (items.length >= limit) break;
    }

    return items;
  }

  function isTechAiRelevant(text, customFocus = '') {
    const hay = String(text || '').toLowerCase();
    if (!hay) return false;
    if (customFocus && customFocus.trim()) {
      const focusTokens = customFocus
        .toLowerCase()
        .split(/[\s,，/]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
      if (focusTokens.some((tok) => hay.includes(tok))) {
        return true;
      }
    }
    return TECH_AI_KEYWORDS.some((kw) => {
      if (kw.length <= 3) {
        return new RegExp(`\\b${kw}\\b`, 'i').test(hay);
      }
      return hay.includes(kw);
    });
  }

  function normalizeTitleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .trim()
      .slice(0, 72);
  }

  function parseHtmlNewsLinks(html, baseUrl, sourceName, { pathPrefix = '', category = 'official_labs', limit = 4 } = {}) {
    if (!html || typeof html !== 'string') return [];
    const seen = new Set();
    const items = [];
    const anchorRegex = /<a\b[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = anchorRegex.exec(html)) !== null && items.length < limit) {
      const rawHref = m[1];
      const rawText = decodeXmlEntities(m[2]).replace(/\s+/g, ' ').trim();
      if (!rawText || rawText.length < 14 || rawText.length > 220) continue;

      let fullUrl = '';
      try {
        const parsed = new URL(rawHref, baseUrl);
        if (!/^https?:$/i.test(parsed.protocol)) continue;
        if (pathPrefix && !parsed.pathname.startsWith(pathPrefix)) continue;
        if (pathPrefix && parsed.pathname.replace(/\/+$/, '') === pathPrefix.replace(/\/+$/, '')) continue;
        fullUrl = parsed.href;
      } catch {
        continue;
      }

      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      items.push({
        id: `html_${items.length}_${fullUrl.slice(-20)}`,
        source: sourceName,
        category,
        title: rawText,
        url: fullUrl,
        discussionUrl: '',
        score: category === 'official_labs' ? 85 : 55,
        comments: 0,
        publishedAt: Date.now(),
        snippet: ''
      });
    }

    return items;
  }

  function dedupeAndRankItems(items, limit = 30) {
    const seenUrls = new Set();
    const seenTitles = new Set();
    const out = [];

    const sorted = [...(items || [])].sort((a, b) => {
      const boostA = (a.source?.startsWith('X (Grok)') ? 120 : 0) + (a.category === 'official_labs' ? 45 : 0);
      const boostB = (b.source?.startsWith('X (Grok)') ? 120 : 0) + (b.category === 'official_labs' ? 45 : 0);
      const scoreA = (a.score || 0) + (a.comments || 0) * 1.5 + boostA;
      const scoreB = (b.score || 0) + (b.comments || 0) * 1.5 + boostB;
      return scoreB - scoreA;
    });

    for (const item of sorted) {
      if (!item || !item.title) continue;
      const cleanUrl = (item.url || '').split('#')[0].replace(/\/+$/, '');
      const titleKey = normalizeTitleKey(item.title);
      if (cleanUrl && seenUrls.has(cleanUrl)) continue;
      if (titleKey && seenTitles.has(titleKey)) continue;
      if (cleanUrl) seenUrls.add(cleanUrl);
      if (titleKey) seenTitles.add(titleKey);
      out.push(item);
      if (out.length >= limit) break;
    }

    return out;
  }

  function stripHtmlToExcerpt(html, maxLen = 2200) {
    if (!html || typeof html !== 'string') return '';
    return html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  async function safeFetch(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHackerNewsItems(customFocus = '', { filterAiOnly = true } = {}) {
    const res = await safeFetch('https://hacker-news.firebaseio.com/v0/topstories.json', {}, 6000);
    if (!res.ok) return [];
    const ids = await res.json();
    if (!Array.isArray(ids)) return [];

    const topIds = ids.slice(0, 32);
    const results = await Promise.allSettled(
      topIds.map(async (id) => {
        const r = await safeFetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {}, 5000);
        if (!r.ok) return null;
        return r.json();
      })
    );

    const items = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const it = r.value;
      if (!it.title || (it.score || 0) < 35) continue;
      if (filterAiOnly && !isTechAiRelevant(it.title, customFocus)) continue;
      const discussionUrl = `https://news.ycombinator.com/item?id=${it.id}`;
      items.push({
        id: `hn_${it.id}`,
        source: 'Hacker News',
        title: it.title,
        url: it.url || discussionUrl,
        discussionUrl,
        score: it.score || 0,
        comments: it.descendants || 0,
        publishedAt: (it.time || 0) * 1000,
        snippet: ''
      });
    }
    return items.slice(0, 12);
  }

  async function fetchRedditItems(subreddits = DEFAULT_SUBREDDITS, customFocus = '', { filterTechSub = true } = {}) {
    const results = await Promise.allSettled(
      subreddits.map(async (sub) => {
        const url = `https://www.reddit.com/r/${sub}/hot.json?limit=8&raw_json=1`;
        const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, 6500);
        if (!res.ok) return [];
        const data = await res.json();
        const children = data?.data?.children || [];
        return children
          .map((c) => c?.data)
          .filter((d) => d && !d.stickied && d.title && (d.score || 0) >= 20)
          .filter((d) => !filterTechSub || sub !== 'technology' || isTechAiRelevant(d.title, customFocus))
          .map((d) => {
            const discussionUrl = d.permalink ? `https://www.reddit.com${d.permalink}` : '';
            const externalUrl = d.url && !d.is_self ? d.url : discussionUrl;
            const hasVisual = Boolean(d.preview?.images?.[0]?.source?.url || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(externalUrl));
            return {
              id: `reddit_${d.id}`,
              source: `Reddit r/${sub}`,
              title: d.title,
              url: externalUrl,
              discussionUrl,
              score: d.score || 0,
              comments: d.num_comments || 0,
              publishedAt: (d.created_utc || 0) * 1000,
              snippet: `${hasVisual ? '[含原图/梗图] ' : ''}${(d.selftext || '').replace(/\s+/g, ' ').trim()}`.slice(0, 320)
            };
          });
      })
    );

    const merged = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        merged.push(...r.value);
      }
    }
    return merged;
  }

  async function fetchRssFeedItems(feeds = DEFAULT_RSS_FEEDS, customFocus = '') {
    const results = await Promise.allSettled(
      feeds.map(async (feed) => {
        const res = await safeFetch(feed.url, {}, 5500);
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRssItems(xml, feed.name, 5)
          .map((it) => ({
            ...it,
            category: feed.category || 'news_media',
            score: feed.category === 'official_labs' ? 85 : 60
          }))
          .filter(
            (it) =>
              feed.category === 'official_labs' ||
              feed.category === 'newsletters' ||
              feed.name.includes('AI') ||
              feed.name.includes('Decoder') ||
              isTechAiRelevant(`${it.title} ${it.snippet}`, customFocus)
          );
      })
    );

    const merged = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        merged.push(...r.value);
      }
    }
    return merged;
  }

  async function fetchHtmlNewsSources(sources = DEFAULT_HTML_NEWS_SOURCES, customFocus = '') {
    const results = await Promise.allSettled(
      sources.map(async (src) => {
        const res = await safeFetch(src.url, {}, 5500);
        if (!res.ok) return [];
        const html = await res.text();
        return parseHtmlNewsLinks(html, src.url, src.name, {
          pathPrefix: src.pathPrefix,
          category: src.category,
          limit: 4
        }).filter(
          (it) =>
            src.category === 'official_labs' ||
            src.category === 'newsletters' ||
            isTechAiRelevant(it.title, customFocus)
        );
      })
    );

    const merged = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        merged.push(...r.value);
      }
    }
    return merged;
  }

  function extractGrokText(data) {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
      return data.output_text.trim();
    }
    if (Array.isArray(data?.output)) {
      const parts = [];
      for (const item of data.output) {
        if (Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (typeof c?.text === 'string') parts.push(c.text);
          }
        }
      }
      if (parts.length > 0) return parts.join('\n').trim();
    }
    const chatContent = data?.choices?.[0]?.message?.content;
    return typeof chatContent === 'string' ? chatContent.trim() : '';
  }

  async function fetchGrokXItems({ grokApiKey, grokModel = 'grok-3-mini', customFocus = '', parseJsonSafely }) {
    const cleanKey = (grokApiKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!cleanKey) return [];

    const focusNote = customFocus && customFocus.trim() ? ` Focus especially on: ${customFocus.trim()}.` : '';
    const prompt = `Search X (Twitter) and tech news from the last 24-48 hours for the 6 most talked-about, controversial, or high-impact English AI, Big Tech (OpenAI, Anthropic, Google, Apple, Meta, Nvidia, Microsoft, xAI), or developer tool stories.${focusNote}
Return ONLY valid JSON:
{
  "items": [
    {
      "title": "Short factual English headline",
      "url": "Verified source or X post URL (must be real)",
      "snippet": "2-3 concrete verified facts and what people on X are arguing about"
    }
  ]
}`;

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cleanKey}`
    };

    // Primary: xAI Responses API with native x_search + web_search tools
    let res = await safeFetch(
      'https://api.x.ai/v1/responses',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: grokModel || 'grok-3-mini',
          tools: [{ type: 'x_search' }, { type: 'web_search' }],
          input: [{ role: 'user', content: prompt }]
        })
      },
      25000
    ).catch(() => null);

    // Fallback: xAI chat/completions with live search_parameters
    if (!res || !res.ok) {
      res = await safeFetch(
        'https://api.x.ai/v1/chat/completions',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: grokModel || 'grok-3-mini',
            messages: [{ role: 'user', content: prompt }],
            search_parameters: { mode: 'on', sources: [{ type: 'x' }, { type: 'web' }] }
          })
        },
        25000
      ).catch(() => null);
    }

    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const rawText = extractGrokText(data);
    if (!rawText) return [];

    let parsed;
    try {
      parsed = parseJsonSafely ? parseJsonSafely(rawText) : JSON.parse(rawText);
    } catch {
      return [];
    }

    const list = Array.isArray(parsed?.items) ? parsed.items : [];
    return list
      .filter((it) => it && it.title && it.url && /^https?:\/\//i.test(it.url))
      .slice(0, 8)
      .map((it, idx) => ({
        id: `grok_${idx}_${Date.now()}`,
        source: 'X (Grok)',
        title: String(it.title).trim(),
        url: String(it.url).trim(),
        discussionUrl: String(it.url).trim(),
        score: 100,
        comments: 50,
        publishedAt: Date.now(),
        snippet: String(it.snippet || '').trim().slice(0, 380)
      }));
  }

  async function fetchTavilyItems({ apiKey, customFocus = '' }) {
    const cleanKey = (apiKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!cleanKey) return [];
    const query = customFocus && customFocus.trim()
      ? `${customFocus.trim()} AI tech news latest`
      : 'AI LLM OpenAI Anthropic Google Meta Nvidia breaking news';
    const res = await safeFetch(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: cleanKey,
          query,
          topic: 'news',
          search_depth: 'basic',
          max_results: 8,
          days: 2
        })
      },
      12000
    ).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.results) ? data.results : [];
    return list
      .filter((it) => it && it.title && it.url && /^https?:\/\//i.test(it.url))
      .slice(0, 8)
      .map((it, idx) => ({
        id: `tavily_${idx}_${Date.now()}`,
        source: 'Tavily Search',
        category: 'search_api',
        title: String(it.title).trim(),
        url: String(it.url).trim(),
        discussionUrl: '',
        score: 95,
        comments: 0,
        publishedAt: Date.now(),
        snippet: String(it.content || '').trim().slice(0, 360)
      }));
  }

  async function fetchPerplexityItems({ apiKey, model = 'sonar', customFocus = '', parseJsonSafely }) {
    const cleanKey = (apiKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!cleanKey) return [];
    const focusNote = customFocus && customFocus.trim() ? ` Focus on: ${customFocus.trim()}.` : '';
    const res = await safeFetch(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cleanKey}`
        },
        body: JSON.stringify({
          model: model || 'sonar',
          messages: [
            {
              role: 'user',
              content: `Find the 6 most important AI and Big Tech news stories from the past 48 hours.${focusNote} Return ONLY JSON: {"items":[{"title":"...","url":"https://...","snippet":"2 concrete facts"}]}`
            }
          ]
        })
      },
      20000
    ).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const rawText = data?.choices?.[0]?.message?.content || '';
    if (!rawText) return [];
    let parsed;
    try {
      parsed = parseJsonSafely ? parseJsonSafely(rawText) : JSON.parse(rawText);
    } catch {
      return [];
    }
    const list = Array.isArray(parsed?.items) ? parsed.items : [];
    return list
      .filter((it) => it && it.title && it.url && /^https?:\/\//i.test(it.url))
      .slice(0, 8)
      .map((it, idx) => ({
        id: `pplx_${idx}_${Date.now()}`,
        source: 'Perplexity Sonar',
        category: 'search_api',
        title: String(it.title).trim(),
        url: String(it.url).trim(),
        discussionUrl: '',
        score: 95,
        comments: 0,
        publishedAt: Date.now(),
        snippet: String(it.snippet || '').trim().slice(0, 360)
      }));
  }

  async function fetchExaItems({ apiKey, customFocus = '' }) {
    const cleanKey = (apiKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!cleanKey) return [];
    const query = customFocus && customFocus.trim()
      ? `${customFocus.trim()} AI technology announcement`
      : 'latest major AI model launch OpenAI Anthropic Google DeepMind Meta';
    const startDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const res = await safeFetch(
      'https://api.exa.ai/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cleanKey
        },
        body: JSON.stringify({
          query,
          numResults: 8,
          startPublishedDate: startDate,
          type: 'auto',
          contents: { text: { maxCharacters: 360 } }
        })
      },
      12000
    ).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.results) ? data.results : [];
    return list
      .filter((it) => it && it.title && it.url && /^https?:\/\//i.test(it.url))
      .slice(0, 8)
      .map((it, idx) => ({
        id: `exa_${idx}_${Date.now()}`,
        source: 'Exa Search',
        category: 'search_api',
        title: String(it.title).trim(),
        url: String(it.url).trim(),
        discussionUrl: '',
        score: 92,
        comments: 0,
        publishedAt: Date.now(),
        snippet: String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 360)
      }));
  }

  async function fetchAllRadarSources({
    channel = 'ai_tech',
    searchProvider = 'none',
    searchApiKey = '',
    searchModel = '',
    grokApiKey = '',
    grokModel = 'grok-3-mini',
    customFocus = '',
    parseJsonSafely
  } = {}) {
    const ch = channel || 'ai_tech';
    let tasks = [];
    const channelQueryHint =
      ch === 'memes_fun'
        ? `${customFocus || ''} viral memes pop culture entertainment funny trending`.trim()
        : ch === 'general_viral'
          ? `${customFocus || ''} breaking world business culture viral trending news`.trim()
          : ch === 'all'
            ? `${customFocus || ''} AI tech viral memes entertainment breaking news`.trim()
            : customFocus;

    if (ch === 'memes_fun') {
      tasks = [
        { key: '梗图/娱乐 Reddit', fn: () => fetchRedditItems(MEME_ENT_SUBREDDITS, customFocus, { filterTechSub: false }) },
        { key: '娱乐快讯 RSS', fn: () => fetchRssFeedItems(MEME_ENT_RSS_FEEDS, customFocus) }
      ];
    } else if (ch === 'general_viral') {
      tasks = [
        { key: 'Hacker News', fn: () => fetchHackerNewsItems(customFocus, { filterAiOnly: false }) },
        { key: '全网热议 Reddit', fn: () => fetchRedditItems(GENERAL_VIRAL_SUBREDDITS, customFocus, { filterTechSub: false }) },
        { key: '综合快讯 RSS', fn: () => fetchRssFeedItems(GENERAL_VIRAL_RSS_FEEDS, customFocus) }
      ];
    } else if (ch === 'all') {
      tasks = [
        { key: 'Hacker News', fn: () => fetchHackerNewsItems(customFocus, { filterAiOnly: false }) },
        { key: 'AI/科技 Reddit', fn: () => fetchRedditItems(DEFAULT_SUBREDDITS.slice(0, 3), customFocus) },
        { key: '梗图/娱乐 Reddit', fn: () => fetchRedditItems(MEME_ENT_SUBREDDITS.slice(0, 4), customFocus, { filterTechSub: false }) },
        { key: '全网热议 Reddit', fn: () => fetchRedditItems(GENERAL_VIRAL_SUBREDDITS.slice(0, 3), customFocus, { filterTechSub: false }) },
        { key: '快讯 & 官博 RSS', fn: () => fetchRssFeedItems([...DEFAULT_RSS_FEEDS.slice(0, 6), ...MEME_ENT_RSS_FEEDS, ...GENERAL_VIRAL_RSS_FEEDS.slice(0, 1)], customFocus) },
        { key: '实验室 & 通讯', fn: () => fetchHtmlNewsSources(DEFAULT_HTML_NEWS_SOURCES, customFocus) }
      ];
    } else {
      tasks = [
        { key: 'Hacker News', fn: () => fetchHackerNewsItems(customFocus, { filterAiOnly: true }) },
        { key: 'Reddit', fn: () => fetchRedditItems(DEFAULT_SUBREDDITS, customFocus) },
        { key: '快讯 & 官博 RSS', fn: () => fetchRssFeedItems(DEFAULT_RSS_FEEDS, customFocus) },
        { key: '实验室 & 通讯', fn: () => fetchHtmlNewsSources(DEFAULT_HTML_NEWS_SOURCES, customFocus) }
      ];
    }

    // Resolve optional search API provider (backwards-compatible with legacy grokApiKey)
    const effectiveProvider =
      searchProvider && searchProvider !== 'none'
        ? searchProvider
        : grokApiKey && grokApiKey.trim()
          ? 'grok'
          : 'none';
    const effectiveKey = (searchApiKey || '').trim() || (effectiveProvider === 'grok' ? (grokApiKey || '').trim() : '');

    if (effectiveProvider === 'grok' && effectiveKey) {
      tasks.unshift({
        key: 'X (Grok)',
        fn: () =>
          fetchGrokXItems({
            grokApiKey: effectiveKey,
            grokModel: searchModel || grokModel || 'grok-3-mini',
            customFocus: channelQueryHint,
            parseJsonSafely
          })
      });
    } else if (effectiveProvider === 'tavily' && effectiveKey) {
      tasks.unshift({
        key: 'Tavily',
        fn: () => fetchTavilyItems({ apiKey: effectiveKey, customFocus: channelQueryHint })
      });
    } else if (effectiveProvider === 'perplexity' && effectiveKey) {
      tasks.unshift({
        key: 'Perplexity',
        fn: () =>
          fetchPerplexityItems({
            apiKey: effectiveKey,
            model: searchModel || 'sonar',
            customFocus: channelQueryHint,
            parseJsonSafely
          })
      });
    } else if (effectiveProvider === 'exa' && effectiveKey) {
      tasks.unshift({
        key: 'Exa',
        fn: () => fetchExaItems({ apiKey: effectiveKey, customFocus: channelQueryHint })
      });
    }

    const settled = await Promise.allSettled(tasks.map((t) => t.fn()));
    const allItems = [];
    const sourceStats = [];

    settled.forEach((res, idx) => {
      const name = tasks[idx].key;
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        allItems.push(...res.value);
        sourceStats.push({ source: name, count: res.value.length, ok: true });
      } else {
        sourceStats.push({ source: name, count: 0, ok: false });
      }
    });

    return {
      items: dedupeAndRankItems(allItems, 26),
      sourceStats
    };
  }

  function buildTopicCurationMessages(items, { customFocus = '', glossary = '', persona = '', region = 'en', channel = 'ai_tech' } = {}) {
    const isZh = region === 'zh';
    const channelDomainMap = {
      ai_tech: '科技 / 大公司 / AI 赛道',
      memes_fun: '热门梗图 / 娱乐八卦 / 幽默吐槽赛道',
      general_viral: '全网社会热议 / 商业奇闻 / 突发大事赛道',
      all: '跨领域热门内容（AI 科技 + 热门梗图娱乐 + 全网大事混搭）'
    };
    const domainDesc = channelDomainMap[channel] || channelDomainMap.ai_tech;
    const audienceLabel = `${isZh ? 'X (Twitter) 中文' : 'X (Twitter) 英文'}${domainDesc}`;
    const selectionCriteria =
      channel === 'memes_fun'
        ? '优先选自带原图/梗图、反差感强、娱乐性强、最容易引发网友哈哈大笑或吐槽转发的爆款素材。'
        : channel === 'general_viral'
          ? '优先选争议性大、反转强、普通人一秒就能共鸣或吵起来的全球热点、商业奇闻与社会议题。'
          : channel === 'all'
            ? '故意做多元化混搭：5 条选题里同时包含 AI/科技大事、热门梗图/娱乐、以及全网社会热议，让用户有不同口味可选。'
            : '优先选大公司战略变动、AI 模型/Agent 重大发布或翻车、定价/政策争议、开发者实战痛点；过滤掉无聊公关通稿和水帖。';
    const angleHint = isZh
      ? '为什么值得在中文区写 + 最容易引发讨论的争议切入点（禁用间隔号）'
      : '为什么值得在英文区写 + 最容易引发讨论的争议切入点（禁用间隔号）';
    const focusLine = customFocus && customFocus.trim()
      ? `\n用户特别关注的主题方向：${customFocus.trim()}（优先挑选强相关话题）。`
      : '';
    const personaLine = persona && persona.trim()
      ? `\n账号个人 IP / 身份人设（请优先挑选契合该人设调性的选题，并围绕该视角给切入点）：\n${persona.trim().slice(0, 600)}`
      : '';
    const glossaryLine = glossary && glossary.trim() ? `\n自定义术语参考：\n${glossary.trim()}` : '';

    const systemPrompt = `你是资深 ${audienceLabel} 内容主编。
你的任务是从下面真实抓取的多平台热点素材中，精挑细选出 **5 个最值得在 ${isZh ? 'X 中文区' : 'X 英文区'} 发帖或写长文的高价值选题**。

筛选硬性标准：
1. **严格基于所给素材**：绝对不要编造素材里没有的新闻、数据或链接，必须直接保留原素材的真实 url 和 discussion_url。
2. **高讨论度与强观点空间**：${selectionCriteria}
3. **禁用间隔号**：所有中文输出严禁使用「·」或「•」，分隔用空格。
4. **载体建议**：
   - "news_post"：突发新闻、热门梗图吐槽、适合留白制造冲击力的短快评；
   - "long_article"：值得深度拆解逻辑、趋势或行业影响的深度长文；
   - "method_guide"：开源项目、工具工作流或方法论实战。${focusLine}${personaLine}${glossaryLine}

请严格返回如下 JSON（不要多余文字）：
{
  "topics": [
    {
      "id": "topic_1",
      "source": "来源名称（如 X (Grok) / Hacker News / Reddit r/LocalLLaMA / TechCrunch AI）",
      "title_zh": "一句锋利直白的中文选题标题（禁用间隔号）",
      "title_en": "Original English headline",
      "summary_zh": "1-2句核实事实摘要（只写素材里有的事实，禁用间隔号）",
      "angle_zh": "${angleHint}",
      "recommended_mode": "news_post",
      "url": "原素材的真实链接",
      "discussion_url": "讨论区链接（如 Reddit/HN 帖子链接，没有则留空字符串）",
      "raw_facts": "保留素材中已核实的关键事实/数字/细节（英文或双语）"
    }
  ]
}`;

    const serialized = (items || [])
      .map((it, i) => {
        const meta = [];
        if (it.score) meta.push(`score:${it.score}`);
        if (it.comments) meta.push(`comments:${it.comments}`);
        return `[#${i + 1}] (${it.source}${meta.length ? ' ' + meta.join(' ') : ''})
Title: ${it.title}
URL: ${it.url}${it.discussionUrl && it.discussionUrl !== it.url ? `\nDiscussion: ${it.discussionUrl}` : ''}${it.snippet ? `\nSnippet: ${it.snippet}` : ''}`;
      })
      .join('\n\n');

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[最新抓取的真实热点素材列表]:\n\n${serialized}` }
    ];
  }

  function resolveAbsoluteUrl(rawUrl, baseUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const cleaned = decodeXmlEntities(rawUrl).trim();
    if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('javascript:')) return '';
    try {
      return new URL(cleaned, baseUrl).href;
    } catch {
      return /^https?:\/\//i.test(cleaned) ? cleaned : '';
    }
  }

  function isUsefulImageUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    const lower = url.toLowerCase();
    if (
      lower.includes('.svg') ||
      lower.includes('.ico') ||
      lower.includes('favicon') ||
      lower.includes('avatar') ||
      lower.includes('profile_images') ||
      lower.includes('/emoji/') ||
      lower.includes('sprite') ||
      lower.includes('pixel') ||
      lower.includes('1x1') ||
      lower.includes('doubleclick') ||
      lower.includes('analytics')
    ) {
      return false;
    }
    return true;
  }

  function extractMetaContent(html, propName) {
    const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
      'i'
    );
    return html.match(re1)?.[1] || html.match(re2)?.[1] || '';
  }

  function extractMediaFromHtml(html, baseUrl, limit = 5) {
    if (!html || typeof html !== 'string') return [];
    const seen = new Set();
    const assets = [];

    const pushAsset = (type, rawUrl, label) => {
      if (assets.length >= limit) return;
      const url = resolveAbsoluteUrl(rawUrl, baseUrl);
      if (!url || seen.has(url)) return;
      if (type === 'image' && !isUsefulImageUrl(url)) return;
      seen.add(url);
      assets.push({ type, url, label });
    };

    // 1. OpenGraph / Twitter Card cover images & videos
    const ogImg = extractMetaContent(html, 'og:image') || extractMetaContent(html, 'og:image:secure_url');
    if (ogImg) pushAsset('image', ogImg, '封面图');
    const twImg = extractMetaContent(html, 'twitter:image') || extractMetaContent(html, 'twitter:image:src');
    if (twImg) pushAsset('image', twImg, '配图');

    const ogVid = extractMetaContent(html, 'og:video:secure_url') || extractMetaContent(html, 'og:video') || extractMetaContent(html, 'twitter:player:stream');
    if (ogVid) pushAsset('video', ogVid, '原文视频');

    // 2. HTML5 <video><source src="...">
    const videoSrcRegex = /<(?:video|source)\b[^>]+src=["']([^"']+\.(?:mp4|webm|mov)(?:\?[^"']*)?)["']/gi;
    let vm;
    while ((vm = videoSrcRegex.exec(html)) !== null && assets.length < limit) {
      pushAsset('video', vm[1], '原文视频');
    }

    // 3. Inline <img> tags (preferring <article>/<main> if present)
    const bodyScope =
      html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ||
      html;
    const imgRegex = /<img\b[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi;
    let im;
    while ((im = imgRegex.exec(bodyScope)) !== null && assets.length < limit) {
      const tag = im[0];
      const wMatch = tag.match(/\bwidth=["']?(\d+)/i);
      if (wMatch && Number(wMatch[1]) > 0 && Number(wMatch[1]) < 120) continue;
      pushAsset('image', im[1], '原文配图');
    }

    return assets;
  }

  async function fetchRedditDetails(discussionUrl, limit = 6) {
    if (!discussionUrl || !discussionUrl.includes('reddit.com/r/')) {
      return { comments: [], media: [] };
    }
    const jsonUrl = `${discussionUrl.replace(/\/+$/, '')}.json?limit=12&sort=top&raw_json=1`;
    const res = await safeFetch(jsonUrl, { headers: { Accept: 'application/json' } }, 6000).catch(() => null);
    if (!res || !res.ok) return { comments: [], media: [] };
    const data = await res.json().catch(() => null);

    const postData = data?.[0]?.data?.children?.[0]?.data;
    const media = [];
    if (postData) {
      const redditVid = postData?.media?.reddit_video?.fallback_url || postData?.secure_media?.reddit_video?.fallback_url;
      if (redditVid) {
        media.push({ type: 'video', url: redditVid, label: 'Reddit 视频' });
      }
      const previewUrl = postData?.preview?.images?.[0]?.source?.url;
      if (previewUrl && isUsefulImageUrl(previewUrl)) {
        media.push({ type: 'image', url: previewUrl, label: 'Reddit 原图' });
      } else if (postData.url_overridden_by_dest && /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(postData.url_overridden_by_dest)) {
        media.push({ type: 'image', url: postData.url_overridden_by_dest, label: 'Reddit 原图' });
      }
    }

    const commentChildren = data?.[1]?.data?.children || [];
    const comments = commentChildren
      .map((c) => c?.data)
      .filter((d) => d && d.body && d.body !== '[deleted]' && d.body !== '[removed]')
      .slice(0, limit)
      .map((d) => `[Reddit +${d.score || 0}]: ${String(d.body).replace(/\s+/g, ' ').trim().slice(0, 260)}`);

    return { comments, media };
  }

  async function fetchHackerNewsComments(discussionUrl, limit = 6) {
    const match = String(discussionUrl || '').match(/item\?id=(\d+)/);
    if (!match) return [];
    const itemRes = await safeFetch(`https://hacker-news.firebaseio.com/v0/item/${match[1]}.json`, {}, 5000).catch(() => null);
    if (!itemRes || !itemRes.ok) return [];
    const item = await itemRes.json().catch(() => null);
    const kids = Array.isArray(item?.kids) ? item.kids.slice(0, limit) : [];
    if (kids.length === 0) return [];

    const settled = await Promise.allSettled(
      kids.map(async (kid) => {
        const r = await safeFetch(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`, {}, 4500);
        if (!r.ok) return null;
        return r.json();
      })
    );

    return settled
      .filter((r) => r.status === 'fulfilled' && r.value && r.value.text && !r.value.deleted)
      .map((r) => `[HN comment]: ${decodeXmlEntities(r.value.text).slice(0, 260)}`);
  }

  async function fetchArticleDetails(url) {
    if (!url || !/^https?:\/\//i.test(url)) return { excerpt: '', media: [] };
    if (/(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(url)) {
      return { excerpt: '', media: [{ type: 'x_post', url, label: '原 X 帖子' }] };
    }
    if (/\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url)) {
      return { excerpt: '', media: [{ type: 'image', url, label: '原图' }] };
    }
    if (/\.(?:mp4|webm|mov)(?:\?|$)/i.test(url)) {
      return { excerpt: '', media: [{ type: 'video', url, label: '原视频' }] };
    }
    if (url.includes('x.com/') || url.includes('twitter.com/') || url.includes('reddit.com/') || url.includes('news.ycombinator.com/')) {
      return { excerpt: '', media: [] };
    }
    const res = await safeFetch(url, {}, 5500).catch(() => null);
    if (!res || !res.ok) return { excerpt: '', media: [] };
    const ct = (res.headers?.get?.('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('text/plain')) return { excerpt: '', media: [] };
    const html = await res.text().catch(() => '');
    return {
      excerpt: stripHtmlToExcerpt(html, 2000),
      media: extractMediaFromHtml(html, url, 5)
    };
  }

  function dedupeMediaAssets(list, limit = 6) {
    const seen = new Set();
    const out = [];
    for (const item of list || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function enrichSelectedTopicWithMedia(topic) {
    if (!topic) return { enrichedText: '', mediaAssets: [] };
    const discussionUrl = topic.discussionUrl || topic.discussion_url || '';
    const mainUrl = topic.url || '';

    const [redditDetails, hnComments, articleDetails] = await Promise.all([
      fetchRedditDetails(discussionUrl, 6),
      fetchHackerNewsComments(discussionUrl, 6),
      fetchArticleDetails(mainUrl)
    ]);

    const blocks = [];
    if (topic.titleEn || topic.title_en) {
      blocks.push(`Headline: ${topic.titleEn || topic.title_en}`);
    }
    if (topic.source) {
      blocks.push(`Source: ${topic.source}`);
    }
    if (topic.rawFacts || topic.raw_facts) {
      blocks.push(`Verified Facts:\n${topic.rawFacts || topic.raw_facts}`);
    } else if (topic.summaryZh || topic.summary_zh) {
      blocks.push(`Summary:\n${topic.summaryZh || topic.summary_zh}`);
    }
    if (topic.angleZh || topic.angle_zh) {
      blocks.push(`Debate / Angle Hint:\n${topic.angleZh || topic.angle_zh}`);
    }
    if (articleDetails.excerpt) {
      blocks.push(`Verified Article Excerpt:\n${articleDetails.excerpt}`);
    }
    const comments = [...redditDetails.comments, ...hnComments];
    if (comments.length > 0) {
      blocks.push(`Real Community Reactions & Skepticism (for debate context, do not fabricate personal testing):\n${comments.join('\n')}`);
    }

    const rawMedia = [...articleDetails.media, ...redditDetails.media];
    if (mainUrl && /^https?:\/\//i.test(mainUrl) && !rawMedia.some((m) => m.url === mainUrl)) {
      const isX = /(?:x\.com|twitter\.com)\//i.test(mainUrl);
      rawMedia.push({ type: isX ? 'x_post' : 'link', url: mainUrl, label: isX ? '原 X 帖子' : '原文链接' });
    }
    if (discussionUrl && discussionUrl !== mainUrl && /^https?:\/\//i.test(discussionUrl)) {
      rawMedia.push({ type: 'link', url: discussionUrl, label: '讨论原帖' });
    }

    return {
      enrichedText: blocks.join('\n\n'),
      mediaAssets: dedupeMediaAssets(rawMedia, 6)
    };
  }

  async function enrichSelectedTopic(topic) {
    const { enrichedText } = await enrichSelectedTopicWithMedia(topic);
    return enrichedText;
  }

  return {
    DEFAULT_SUBREDDITS,
    DEFAULT_RSS_FEEDS,
    DEFAULT_HTML_NEWS_SOURCES,
    decodeXmlEntities,
    parseRssItems,
    parseHtmlNewsLinks,
    isTechAiRelevant,
    dedupeAndRankItems,
    stripHtmlToExcerpt,
    resolveAbsoluteUrl,
    isUsefulImageUrl,
    extractMediaFromHtml,
    fetchArticleDetails,
    fetchHackerNewsItems,
    fetchRedditItems,
    fetchRssFeedItems,
    fetchHtmlNewsSources,
    fetchGrokXItems,
    fetchTavilyItems,
    fetchPerplexityItems,
    fetchExaItems,
    fetchAllRadarSources,
    buildTopicCurationMessages,
    enrichSelectedTopic,
    enrichSelectedTopicWithMedia
  };
});
