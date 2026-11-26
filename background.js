// Background service worker for X 地道双语助手

const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  autoTranslate: false,
  showSlangNotes: true,
  defaultTone: 'casual',
  glossary: ''
};

// Persistent LRU cache for tweet translations (key -> { translation, slangNotes })
const CACHE_STORAGE_KEY = 'xtr_translation_cache_v1';
const MAX_CACHE_SIZE = 500;
const translationCache = new Map();
let cacheLoaded = false;
let saveCacheTimer = null;

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const res = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const entries = res?.[CACHE_STORAGE_KEY]?.entries;
    if (Array.isArray(entries)) {
      for (const [k, v] of entries) {
        if (typeof k === 'string' && v && typeof v.translation === 'string') {
          translationCache.set(k, v);
        }
      }
    }
  } catch {
    // ignore storage read error
  }
}

function scheduleSaveCache() {
  if (saveCacheTimer) clearTimeout(saveCacheTimer);
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      const entries = Array.from(translationCache.entries()).slice(-MAX_CACHE_SIZE);
      chrome.storage.local.set({ [CACHE_STORAGE_KEY]: { entries } });
    } catch {
      // ignore storage write error
    }
  }, 500);
}

async function getCached(key) {
  await ensureCacheLoaded();
  if (!translationCache.has(key)) return null;
  const val = translationCache.get(key);
  // Refresh LRU order
  translationCache.delete(key);
  translationCache.set(key, val);
  return val;
}

async function setCached(key, val) {
  await ensureCacheLoaded();
  if (translationCache.has(key)) {
    translationCache.delete(key);
  } else if (translationCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(key, val);
  scheduleSaveCache();
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function buildApiUrl(baseUrl) {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('请填写 API Base URL');
  }
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  // Google Gemini 原生地址自动补全 OpenAI 兼容路径
  if (trimmed === 'https://generativelanguage.googleapis.com' || trimmed === 'https://generativelanguage.googleapis.com/v1beta') {
    return 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  }
  try {
    const parsed = new URL(trimmed);
    // 如果只填了域名（如 https://api.xxx.com），默认补全 /v1/chat/completions
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${trimmed}/v1/chat/completions`;
    }
  } catch {
    // ignore URL parse error and fall through
  }
  return `${trimmed}/chat/completions`;
}

async function callLLM(messages, { temperature, jsonMode = false } = {}) {
  const settings = await getSettings();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.)/i.test(settings.apiBaseUrl || '');
  if (!settings.apiKey && !isLocal) {
    throw new Error('请先点击浏览器右上角插件图标，配置 API Key');
  }

  let url = buildApiUrl(settings.apiBaseUrl);
  const body = {
    model: settings.model || 'deepseek-chat',
    messages
  };

  if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  const cleanKey = (settings.apiKey || '').replace(/^Bearer\s+/i, '').trim();
  if (cleanKey) {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }

  const doFetch = (targetUrl, payload) =>
    fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

  let response;
  try {
    response = await doFetch(url, body);
  } catch (networkErr) {
    throw new Error(`网络请求失败 (${url}): ${networkErr.message}`);
  }

  // 如果 404 且路径是 /chat/completions（未含 /v1），自动回退尝试 /v1/chat/completions
  if (response.status === 404 && url.endsWith('/chat/completions') && !url.endsWith('/v1/chat/completions')) {
    const v1Url = url.replace(/\/chat\/completions$/, '/v1/chat/completions');
    const retryRes = await doFetch(v1Url, body).catch(() => null);
    if (retryRes && retryRes.ok) {
      url = v1Url;
      response = retryRes;
    }
  }

  // Fallback if provider doesn't support response_format: json_object or temperature
  if (!response.ok && response.status === 400) {
    let retried = false;
    if (jsonMode) {
      delete body.response_format;
      retried = true;
    }
    if ('temperature' in body) {
      delete body.temperature;
      retried = true;
    }
    if (retried) {
      response = await doFetch(url, body);
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`API 请求失败 (${response.status}) [${url}]: ${errText.slice(0, 220)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (!content) {
    throw new Error(`API 返回内容为空 [${url}]`);
  }
  return content.trim();
}

function parseJsonSafely(rawText) {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error('模型返回格式解析失败');
  }
}

function formatGlossaryBlock(glossaryRaw) {
  const lines = (glossaryRaw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) return '';
  return `\n\n用户自定义术语/固定译法表（请严格遵守）：\n${lines.slice(0, 50).join('\n')}`;
}

async function translateTweetToChinese(text, author = '', context = '', force = false) {
  const settings = await getSettings();
  const glossaryHash = (settings.glossary || '').trim();
  const ctxKey = (context || '').slice(0, 120);
  const cacheKey = `${settings.showSlangNotes ? '1' : '0'}:${glossaryHash}:${ctxKey}:${text}`;
  if (!force) {
    const cached = await getCached(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const glossaryBlock = formatGlossaryBlock(settings.glossary);

  const systemPrompt = `你是一个精通中美互联网文化、X (Twitter) 社区黑话、英语俚语 (slang)、俗语 (idioms)、技术/财经术语及反讽语境的资深双语专家。
你的任务是将目标英文推文精准、地道地翻译成简体中文。

准确性与地道性硬性要求：
1. **语义与事实零偏差**：严格忠于原推文的立场（赞同、质疑、反讽、调侃、陈述）、逻辑关系、否定词、数字、金额、百分比、版本号、代码与专有名词，绝不脑补原句没有的观点，也不漏译关键限定词。
2. **结合上下文消歧**：如果提供了「上下文（上级推文或被引用推文）」，请务必用它来准确判断目标推文里的代词指代（this / that / they / he）、省略语和梗，但**只翻译目标推文正文**，不要把上下文内容混入译文。
3. **俚语、俗语与网络黑话意译**：准确还原真实语境含义，绝不字面硬译：
   - 常见 X 黑话：fr(说真的)、ngl(老实说)、no cap(不吹不黑/认真的)、cooked(完蛋了/凉透了)、ratio(评论区被喷惨/点赞被反超)、based(太稳了/有格局)、mid(平庸/一般般)、iykyk(懂的都懂)、smh(无语)、lowkey(有点/暗自)、deadass(真不是开玩笑)、touch grass(出去透透气/别魔怔)、rent free(挥之不去)、delulu(异想天开/自我陶醉)、copium(精神胜利/强行挽尊)、fumbled(搞砸了/痛失好局)、hits different(感觉完全不一样)、say less(不用多说/安排)、unironically(说真的/不是反串)、valid(有道理/站得住脚)、L/W(败笔/赢麻了)。
   - 常见 X 表情语用：💀/😭 在调侃语境下通常表示「笑死/绷不住/社死」，🤡 表示「小丑/自打脸」，🚩 表示「危险信号/劝退」。
4. **保留要素**：@用户名、#标签、URL 保留原样；英文产品名、人名或业界惯用英文缩写（如 API, LLM, GPU, SaaS, B2B）按中文技术/社交习惯自然保留或附带常见译名。
5. ${settings.showSlangNotes ? '如果推文中确实包含容易误解的俚语、俗语、双关或反讽梗，请在 slang_notes 中用极简短的中文点明（最多 3 条，没有则返回 []）。' : '不需要输出俚语解释，slang_notes 固定返回 []。'}${glossaryBlock}

请严格按以下 JSON 格式输出（不要输出多余文字）：
{
  "translation": "准确且地道自然的中文翻译",
  "slang_notes": ["俚语/俗语：简短解释"]
}`;

  let userPrompt = '';
  if (context && context.trim()) {
    userPrompt += `[上下文参考（仅用于理解指代与语境，请勿翻译此部分）]:\n${context.trim()}\n\n`;
  }
  userPrompt += author
    ? `[目标推文 - 作者 ${author}]:\n${text}`
    : `[目标推文]:\n${text}`;

  const raw = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.2, jsonMode: true }
  );

  let parsed;
  try {
    parsed = parseJsonSafely(raw);
  } catch {
    parsed = { translation: raw, slang_notes: [] };
  }

  const result = {
    translation: parsed.translation || raw,
    slangNotes: Array.isArray(parsed.slang_notes) ? parsed.slang_notes.filter(Boolean) : []
  };

  await setCached(cacheKey, result);
  return result;
}

const TONE_INSTRUCTIONS = {
  casual: '自然地道的美式口语/Twitter日常风：像母语为美式英语的美国网友平时刷 X 时随手发的回复，自然使用常见美式口语表达（如 honestly, tbh, kinda, lowkey, makes sense 等，但不要过度堆砌黑话），简洁有力。',
  witty: '幽默玩梗/机智犀利风：地道美式幽默、带一点网感或轻松调侃（Twitter-native wit），自然贴合语境，不尴尬、不油腻。',
  friendly: '友好热情风：温暖、真诚、拉近距离的美式表达，适合赞美、鼓励、交朋友或感谢对方。',
  professional: '清晰专业风：得体、自然、有条理的美式英语，适合行业讨论、技术交流或商务互动，避免翻译腔和生硬的书面语。'
};

async function translateChineseToAmericanEnglish({ text, context = '', tone = 'casual' }) {
  const settings = await getSettings();
  const toneDesc = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.casual;
  const glossaryBlock = formatGlossaryBlock(settings.glossary);

  const systemPrompt = `You are a native American English speaker and active X (Twitter) user who is deeply fluent in Chinese nuances, internet slang, and implied subtext.
Your job is to translate the user's Chinese draft into accurate, natural, authentic American English for posting or replying on X.

Accuracy & Authenticity Rules:
1. **Faithful Meaning, Natural Expression**: Capture the user's exact stance (agreeing, disagreeing, questioning, joking, warning), numbers, facts, and nuances without adding claims the user didn't make or dropping key details. Never produce stiff "Chinglish" or textbook translations.
2. **Context Alignment**: If an English parent/quoted tweet is provided, match its exact topic, pronouns, references, and technical/domain terms so the reply reads seamlessly in the thread.
3. **Chinese Idioms & Slang**: Translate Chinese internet expressions by intent rather than word-for-word (e.g., 有一说一 -> ngl / to be fair, 踩坑 -> ran into this exact trap / learned this the hard way, 画大饼 -> empty promises / vaporware, 草台班子 -> duct-taped together / held together by duct tape, 真香 -> ended up loving it, 破防 -> hit hard / tilted).
4. **American X Style**: Use American spelling (color, realize, favorite), concise phrasing, and preserve @mentions, #hashtags, URLs, and emojis.
5. **Tone**: ${toneDesc}${glossaryBlock}

Return ONLY the final English text ready to post, with no quotes, no explanations, and no markdown formatting.`;

  let userPrompt = '';
  if (context && context.trim()) {
    userPrompt += `[English Context / Parent or Quoted Tweet]:\n${context.trim()}\n\n`;
  }
  userPrompt += `[User's Chinese Draft]:\n${text.trim()}`;

  const english = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.35, jsonMode: false }
  );

  // Strip accidental wrapping quotes
  return english.replace(/^["“]|["”]$/g, '').trim();
}

async function translateChineseToAmericanCandidates({ text, context = '', tone = 'casual' }) {
  const settings = await getSettings();
  const toneDesc = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.casual;
  const glossaryBlock = formatGlossaryBlock(settings.glossary);

  const systemPrompt = `You are a native American English speaker and active X (Twitter) user who is deeply fluent in Chinese nuances, internet slang, and implied subtext.
Your job is to turn the user's Chinese draft or brief reply idea into 3 distinct, accurate, authentic American English options suitable for posting or replying on X.

Guidelines:
1. **Semantic Accuracy First**: Preserve the user's exact intent, stance, facts, and numbers; never hallucinate extra claims. Avoid stiff "textbook" or "Chinglish" phrasing.
2. **Context Alignment**: If an English parent/quoted tweet is provided, align your options with that exact context (pronouns, topic, references, or technical terms).
3. **3 Distinct Styles**: Provide 3 varied options (1: concise & punchy, 2: natural & conversational, 3: idiomatic / expressive), all fitting the requested tone: ${toneDesc}
4. **Preserve Elements**: Keep @mentions, #hashtags, URLs, or emojis if present.${glossaryBlock}

Return ONLY valid JSON in this exact format:
{
  "candidates": [
    { "style": "简短利落", "en": "English option 1", "zh_back": "这句的准确中文回译（帮助用户确认语义与语气）" },
    { "style": "自然口语", "en": "English option 2", "zh_back": "这句的准确中文回译" },
    { "style": "地道网感", "en": "English option 3", "zh_back": "这句的准确中文回译" }
  ]
}`;

  let userPrompt = '';
  if (context && context.trim()) {
    userPrompt += `[English Context / Parent or Quoted Tweet]:\n${context.trim()}\n\n`;
  }
  userPrompt += `[User's Chinese Draft / Reply Idea]:\n${text.trim()}`;

  const raw = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.65, jsonMode: true }
  );

  const parsed = parseJsonSafely(raw);
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  if (list.length === 0) {
    throw new Error('未能生成候选表达，请重试');
  }
  return list
    .filter((item) => item && item.en)
    .slice(0, 3)
    .map((item) => ({
      style: item.style || '地道表达',
      en: String(item.en).replace(/^["“]|["”]$/g, '').trim(),
      zh_back: item.zh_back ? String(item.zh_back).trim() : ''
    }));
}

async function generateAutoReplyCandidates({ context, tone = 'casual', idea = '' }) {
  if (!context || !context.trim()) {
    throw new Error('未检测到原推文语境，请先输入回复想法或打开回复框');
  }
  const settings = await getSettings();
  const toneDesc = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.casual;
  const glossaryBlock = formatGlossaryBlock(settings.glossary);

  const hasIdea = Boolean(idea && idea.trim());
  const systemPrompt = `You are a native American English speaker and active X (Twitter) user.
Your job is to write 3 distinct, natural, engaging American English replies to the given X post${hasIdea ? " incorporating the user's brief Chinese idea" : ''}.

Guidelines:
1. **Context-Driven & Relevant**: Read the post carefully (its main point, humor, frustration, or question) and write replies that feel like a real American commenter genuinely engaging with it—never generic bot-like praise ("Great post!", "So true!").
2. **3 Distinct Angles**:
   - Option 1 ("共鸣/接梗"): Agree, relate, or play along naturally with the tweet's vibe.
   - Option 2 ("补充/追问"): Add a sharp observation, practical angle, or natural follow-up question.
   - Option 3 ("简短地道"): Ultra-concise, punchy Twitter-style reaction.
3. **Tone**: ${toneDesc}
4. **Natural Formatting**: Use American spelling, keep each reply concise (1-2 sentences max), and avoid hashtags unless truly natural.${glossaryBlock}

Return ONLY valid JSON in this exact format:
{
  "candidates": [
    { "style": "共鸣/接梗", "en": "Reply option 1", "zh_back": "中文翻译（方便确认语义）" },
    { "style": "补充/追问", "en": "Reply option 2", "zh_back": "中文翻译" },
    { "style": "简短地道", "en": "Reply option 3", "zh_back": "中文翻译" }
  ]
}`;

  let userPrompt = `[Target Post / Context to Reply To]:\n${context.trim()}`;
  if (hasIdea) {
    userPrompt += `\n\n[User's Reply Idea (Chinese)]:\n${idea.trim()}`;
  }

  const raw = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.7, jsonMode: true }
  );

  const parsed = parseJsonSafely(raw);
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  if (list.length === 0) {
    throw new Error('未能生成自动回复，请重试');
  }
  return list
    .filter((item) => item && item.en)
    .slice(0, 3)
    .map((item) => ({
      style: item.style || '推荐回复',
      en: String(item.en).replace(/^["“]|["”]$/g, '').trim(),
      zh_back: item.zh_back ? String(item.zh_back).trim() : ''
    }));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'TRANSLATE_TWEET') {
        const result = await translateTweetToChinese(
          message.text,
          message.author,
          message.context,
          Boolean(message.force)
        );
        sendResponse({ ok: true, data: result });
      } else if (message.type === 'TRANSLATE_COMPOSE') {
        const result = await translateChineseToAmericanEnglish({
          text: message.text,
          context: message.context,
          tone: message.tone
        });
        sendResponse({ ok: true, data: result });
      } else if (message.type === 'TRANSLATE_COMPOSE_CANDIDATES') {
        const result = await translateChineseToAmericanCandidates({
          text: message.text,
          context: message.context,
          tone: message.tone
        });
        sendResponse({ ok: true, data: result });
      } else if (message.type === 'GENERATE_AUTO_REPLIES') {
        const result = await generateAutoReplyCandidates({
          context: message.context,
          tone: message.tone,
          idea: message.idea
        });
        sendResponse({ ok: true, data: result });
      } else if (message.type === 'TEST_CONNECTION') {
        const reply = await callLLM(
          [
            { role: 'system', content: 'Reply with just "OK".' },
            { role: 'user', content: 'Ping' }
          ]
        );
        sendResponse({ ok: true, data: reply });
      } else if (message.type === 'CLEAR_CACHE') {
        translationCache.clear();
        await chrome.storage.local.remove(CACHE_STORAGE_KEY).catch(() => {});
        sendResponse({ ok: true });
      } else if (message.type === 'GET_SETTINGS') {
        const settings = await getSettings();
        sendResponse({ ok: true, data: settings });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true; // Keep message channel open for async response
});
