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

  const DEFAULT_RSS_FEEDS = [
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
    { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml' }
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

  function dedupeAndRankItems(items, limit = 26) {
    const seenUrls = new Set();
    const seenTitles = new Set();
    const out = [];

    const sorted = [...(items || [])].sort((a, b) => {
      // Boost Grok X items slightly for X-native freshness, then engagement score
      const scoreA = (a.score || 0) + (a.comments || 0) * 1.5 + (a.source?.startsWith('X (Grok)') ? 120 : 0);
      const scoreB = (b.score || 0) + (b.comments || 0) * 1.5 + (b.source?.startsWith('X (Grok)') ? 120 : 0);
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

  async function fetchHackerNewsItems(customFocus = '') {
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
      if (!isTechAiRelevant(it.title, customFocus)) continue;
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

  async function fetchRedditItems(subreddits = DEFAULT_SUBREDDITS, customFocus = '') {
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
          .filter((d) => sub !== 'technology' || isTechAiRelevant(d.title, customFocus))
          .map((d) => {
            const discussionUrl = d.permalink ? `https://www.reddit.com${d.permalink}` : '';
            const externalUrl = d.url && !d.is_self ? d.url : discussionUrl;
            return {
              id: `reddit_${d.id}`,
              source: `Reddit r/${sub}`,
              title: d.title,
              url: externalUrl,
              discussionUrl,
              score: d.score || 0,
              comments: d.num_comments || 0,
              publishedAt: (d.created_utc || 0) * 1000,
              snippet: (d.selftext || '').replace(/\s+/g, ' ').trim().slice(0, 320)
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
        const res = await safeFetch(feed.url, {}, 6500);
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRssItems(xml, feed.name, 6).filter((it) =>
          feed.name.includes('AI') || feed.name.includes('OpenAI') || isTechAiRelevant(`${it.title} ${it.snippet}`, customFocus)
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

  async function fetchAllRadarSources({ grokApiKey = '', grokModel = 'grok-3-mini', customFocus = '', parseJsonSafely } = {}) {
    const tasks = [
      { key: 'Hacker News', fn: () => fetchHackerNewsItems(customFocus) },
      { key: 'Reddit', fn: () => fetchRedditItems(DEFAULT_SUBREDDITS, customFocus) },
      { key: 'Tech RSS', fn: () => fetchRssFeedItems(DEFAULT_RSS_FEEDS, customFocus) }
    ];

    if (grokApiKey && grokApiKey.trim()) {
      tasks.unshift({
        key: 'X (Grok)',
        fn: () => fetchGrokXItems({ grokApiKey, grokModel, customFocus, parseJsonSafely })
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

  function buildTopicCurationMessages(items, { customFocus = '', glossary = '' } = {}) {
    const focusLine = customFocus && customFocus.trim()
      ? `\n用户特别关注的主题方向：${customFocus.trim()}（优先挑选强相关话题）。`
      : '';
    const glossaryLine = glossary && glossary.trim() ? `\n自定义术语参考：\n${glossary.trim()}` : '';

    const systemPrompt = `你是资深 X (Twitter) 英文科技 / 大公司 / AI 赛道内容主编。
你的任务是从下面真实抓取的多平台热点素材中，精挑细选出 **5 个最值得在 X 英文区发帖或写长文的高价值选题**。

筛选硬性标准：
1. **严格基于所给素材**：绝对不要编造素材里没有的新闻、数据或链接，必须直接保留原素材的真实 url 和 discussion_url。
2. **高讨论度与强观点空间**：优先选大公司战略变动、AI 模型/Agent 重大发布或翻车、定价/政策争议、开发者实战痛点；过滤掉无聊公关通稿和水帖。
3. **禁用间隔号**：所有中文输出严禁使用「·」或「•」，分隔用空格。
4. **载体建议**：
   - "news_post"：突发新闻、大公司动态、适合留白制造冲击力的短快评；
   - "long_article"：值得深度拆解商业逻辑、架构趋势或行业影响的深度长文；
   - "method_guide"：开源项目、工具工作流或工程方法论实战。${focusLine}${glossaryLine}

请严格返回如下 JSON（不要多余文字）：
{
  "topics": [
    {
      "id": "topic_1",
      "source": "来源名称（如 X (Grok) / Hacker News / Reddit r/LocalLLaMA / TechCrunch AI）",
      "title_zh": "一句锋利直白的中文选题标题（禁用间隔号）",
      "title_en": "Original English headline",
      "summary_zh": "1-2句核实事实摘要（只写素材里有的事实，禁用间隔号）",
      "angle_zh": "为什么值得在英文区写 + 最容易引发讨论的争议切入点（禁用间隔号）",
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
    decodeXmlEntities,
    parseRssItems,
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
    fetchGrokXItems,
    fetchAllRadarSources,
    buildTopicCurationMessages,
    enrichSelectedTopic,
    enrichSelectedTopicWithMedia
  };
});
