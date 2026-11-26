// Background service worker for X 地道双语助手

if (typeof importScripts === 'function') {
  if (!globalThis.XTR_CORE) importScripts('lib/core.js');
  if (!globalThis.XTR_RADAR) importScripts('lib/radar.js');
}

const CORE =
  globalThis.XTR_CORE ||
  (typeof require === 'function' ? require('./lib/core.js') : null);

const RADAR =
  globalThis.XTR_RADAR ||
  (typeof require === 'function' ? require('./lib/radar.js') : null);

const {
  DEFAULT_SETTINGS,
  buildApiUrl,
  parseJsonSafely,
  stripImagesFromMessages,
  hasImageContent,
  sanitizeMiddleDots,
  normalizePostMode,
  extractUrls,
  buildTweetTranslationMessages,
  buildComposeDirectMessages,
  buildReplyCandidatesMessages,
  buildPostDraftMessages
} = CORE;

const {
  fetchAllRadarSources,
  buildTopicCurationMessages,
  fetchArticleDetails,
  enrichSelectedTopicWithMedia
} = RADAR;

// Persistent LRU cache for tweet translations (key -> { translation, takeaway, slangNotes })
const CACHE_STORAGE_KEY = 'xtr_translation_cache_v2';
const MAX_CACHE_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB safety cap per image
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageAsDataUrl(url, timeoutMs = 6000) {
  if (!url || url.startsWith('data:')) return url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = (res.headers?.get?.('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
      return null;
    }
    return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveImagesForLLM(images = []) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const limited = images.filter((img) => img && img.url).slice(0, 4);
  const resolved = await Promise.all(
    limited.map(async (img) => {
      const dataUrl = await fetchImageAsDataUrl(img.url);
      if (dataUrl) {
        return { url: dataUrl, alt: img.alt || '' };
      }
      return { url: img.url, alt: img.alt || '' };
    })
  );
  return resolved;
}

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s)，请检查网络或切换模型`);
    }
    throw new Error(`网络请求失败 (${url}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function callLLM(messages, { temperature, jsonMode = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
    fetchWithTimeout(
      targetUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      },
      timeoutMs
    );

  let visionFallback = false;
  let response = await doFetch(url, body);

  // If 404 on /chat/completions without /v1, retry with /v1/chat/completions
  if (response.status === 404 && url.endsWith('/chat/completions') && !url.endsWith('/v1/chat/completions')) {
    const v1Url = url.replace(/\/chat\/completions$/, '/v1/chat/completions');
    const retryRes = await doFetch(v1Url, body).catch(() => null);
    if (retryRes && retryRes.ok) {
      url = v1Url;
      response = retryRes;
    }
  }

  // Smart vision fallback: if messages include images and model rejects payload (400/415/422), strip images & retry
  if (!response.ok && [400, 415, 422].includes(response.status) && hasImageContent(body.messages)) {
    body.messages = stripImagesFromMessages(body.messages);
    visionFallback = true;
    response = await doFetch(url, body);
  }

  // Fallback if provider doesn't support response_format: json_object or temperature
  if (!response.ok && response.status === 400) {
    let retried = false;
    if (jsonMode && 'response_format' in body) {
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
    if (response.status === 429) {
      throw new Error('API 请求过于频繁 (429)，请稍后再试');
    }
    const errText = await response.text().catch(() => '');
    throw new Error(`API 请求失败 (${response.status}) [${url}]: ${errText.slice(0, 220)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (!content) {
    throw new Error(`API 返回内容为空 [${url}]`);
  }
  return { content: content.trim(), visionFallback };
}

async function translateTweetToChinese(text, author = '', context = '', force = false, images = []) {
  const settings = await getSettings();
  const glossaryHash = (settings.glossary || '').trim();
  const ctxKey = (context || '').slice(0, 120);
  const imgKey = Array.isArray(images) ? images.map((i) => i?.url || '').join('|').slice(0, 160) : '';
  const cacheKey = `${settings.showSlangNotes ? '1' : '0'}:${glossaryHash}:${ctxKey}:${imgKey}:${text}`;
  if (!force) {
    const cached = await getCached(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const resolvedImages = await resolveImagesForLLM(images);
  const messages = buildTweetTranslationMessages({
    text,
    author,
    context,
    images: resolvedImages,
    showSlangNotes: settings.showSlangNotes,
    glossary: settings.glossary
  });

  const { content: raw, visionFallback } = await callLLM(messages, { temperature: 0.2, jsonMode: true });

  let parsed;
  try {
    parsed = parseJsonSafely(raw);
  } catch {
    parsed = { translation: raw, takeaway: '', slang_notes: [] };
  }

  const result = {
    translation: parsed.translation || raw,
    takeaway: typeof parsed.takeaway === 'string' ? parsed.takeaway.trim() : '',
    slangNotes: Array.isArray(parsed.slang_notes) ? parsed.slang_notes.filter(Boolean) : [],
    visionFallback
  };

  await setCached(cacheKey, result);
  return result;
}

async function translateChineseToAmericanEnglish({
  text,
  context = '',
  images = [],
  stance,
  tone,
  length = 'auto',
  continuation = null
}) {
  const settings = await getSettings();
  const resolvedImages = await resolveImagesForLLM(images);
  const messages = buildComposeDirectMessages({
    text,
    context,
    images: resolvedImages,
    stance: stance || tone || settings.defaultTone,
    length: length || settings.defaultLength,
    continuation,
    glossary: settings.glossary
  });

  const { content: english } = await callLLM(messages, { temperature: 0.4, jsonMode: false });
  return english.replace(/^["“]|["”]$/g, '').trim();
}

async function generateReplyCandidates({
  context = '',
  idea = '',
  images = [],
  stance,
  tone,
  length = 'auto',
  continuation = null
}) {
  if ((!context || !context.trim()) && (!idea || !idea.trim()) && (!images || images.length === 0)) {
    throw new Error('未检测到原推文语境，请先输入中文想法或打开回复框');
  }

  const settings = await getSettings();
  const resolvedImages = await resolveImagesForLLM(images);
  const messages = buildReplyCandidatesMessages({
    context,
    idea,
    images: resolvedImages,
    stance: stance || tone || settings.defaultTone,
    length: length || settings.defaultLength,
    continuation,
    glossary: settings.glossary
  });

  const { content: raw, visionFallback } = await callLLM(messages, { temperature: 0.72, jsonMode: true });
  const parsed = parseJsonSafely(raw);
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  if (list.length === 0) {
    throw new Error('未能生成候选表达，请重试');
  }

  const candidates = list
    .filter((item) => item && item.en)
    .slice(0, 3)
    .map((item) => ({
      style: item.style || '推荐表达',
      en: String(item.en).replace(/^["“]|["”]$/g, '').trim(),
      zh_back: item.zh_back ? String(item.zh_back).trim() : ''
    }));

  return {
    postTakeaway: typeof parsed?.post_takeaway === 'string' ? parsed.post_takeaway.trim() : '',
    candidates,
    visionFallback
  };
}

async function generatePostDraft({
  source = '',
  postMode = 'news_post',
  sourceLink = '',
  context = '',
  images = [],
  continuation = null,
  mediaAssets = null
}) {
  if ((!source || !source.trim()) && (!context || !context.trim()) && (!images || images.length === 0)) {
    throw new Error('请先输入真实素材、新闻要点或笔记');
  }

  const effectiveLink = (sourceLink || '').trim() || extractUrls(source)[0] || '';
  let resolvedMediaAssets = Array.isArray(mediaAssets) ? mediaAssets : [];
  if (resolvedMediaAssets.length === 0 && effectiveLink) {
    const details = await fetchArticleDetails(effectiveLink).catch(() => ({ excerpt: '', media: [] }));
    resolvedMediaAssets = [...(details.media || [])];
    if (!resolvedMediaAssets.some((m) => m.url === effectiveLink)) {
      const isX = /(?:x\.com|twitter\.com)\//i.test(effectiveLink);
      resolvedMediaAssets.push({ type: isX ? 'x_post' : 'link', url: effectiveLink, label: isX ? '原 X 帖子' : '原文链接' });
    }
  }

  const settings = await getSettings();
  const resolvedImages = await resolveImagesForLLM(images);
  const messages = buildPostDraftMessages({
    source,
    postMode,
    sourceLink: effectiveLink,
    context,
    images: resolvedImages,
    continuation,
    glossary: settings.glossary
  });

  const { content: raw, visionFallback } = await callLLM(messages, { temperature: 0.65, jsonMode: true });
  const parsed = parseJsonSafely(raw);
  const mainPost = sanitizeMiddleDots(parsed?.main_post || '');
  if (!mainPost) {
    throw new Error('未能生成成稿内容，请重试');
  }

  return {
    title: sanitizeMiddleDots(parsed?.title || ''),
    mainPost,
    firstReply: sanitizeMiddleDots(parsed?.first_reply || ''),
    zhSummary: sanitizeMiddleDots(parsed?.zh_summary || ''),
    factCheckNote: sanitizeMiddleDots(parsed?.fact_check_note || ''),
    postMode,
    mediaAssets: resolvedMediaAssets,
    visionFallback
  };
}

// Radar topics short-lived cache (15 minutes)
const RADAR_CACHE_TTL_MS = 15 * 60 * 1000;
const radarCache = new Map();

async function fetchRadarTopics({ focus = '', force = false } = {}) {
  const settings = await getSettings();
  const focusKey = (focus || '').trim().toLowerCase();
  const cacheKey = `${settings.grokApiKey ? 'g1' : 'g0'}:${focusKey}`;
  const cached = radarCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < RADAR_CACHE_TTL_MS) {
    return cached;
  }

  const { items, sourceStats } = await fetchAllRadarSources({
    grokApiKey: settings.grokApiKey,
    grokModel: settings.grokModel || 'grok-3-mini',
    customFocus: focus,
    parseJsonSafely
  });

  if (!items || items.length === 0) {
    throw new Error('未能从热点源拉取到内容，请检查网络连接后重试');
  }

  const messages = buildTopicCurationMessages(items, {
    customFocus: focus,
    glossary: settings.glossary
  });

  const { content: raw } = await callLLM(messages, { temperature: 0.35, jsonMode: true });
  const parsed = parseJsonSafely(raw);
  const rawTopics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  if (rawTopics.length === 0) {
    throw new Error('未能从抓取素材中筛选出推荐选题，请重试');
  }

  const topics = rawTopics
    .filter((t) => t && (t.title_zh || t.title_en))
    .slice(0, 5)
    .map((t, idx) => ({
      id: t.id || `topic_${idx + 1}`,
      source: sanitizeMiddleDots(t.source || 'Tech Radar'),
      titleZh: sanitizeMiddleDots(t.title_zh || t.title_en || ''),
      titleEn: sanitizeMiddleDots(t.title_en || ''),
      summaryZh: sanitizeMiddleDots(t.summary_zh || ''),
      angleZh: sanitizeMiddleDots(t.angle_zh || ''),
      recommendedMode: normalizePostMode(t.recommended_mode),
      url: String(t.url || '').trim(),
      discussionUrl: String(t.discussion_url || '').trim(),
      rawFacts: String(t.raw_facts || '').trim()
    }));

  const result = {
    topics,
    sourceStats,
    fetchedAt: Date.now()
  };
  radarCache.set(cacheKey, result);
  return result;
}

async function draftFromSelectedTopic({
  topic,
  postMode,
  userAngle = '',
  continuation = null
}) {
  if (!topic || (!topic.titleEn && !topic.titleZh && !topic.rawFacts)) {
    throw new Error('请选择一个有效的推荐选题');
  }

  const { enrichedText, mediaAssets } = await enrichSelectedTopicWithMedia(topic);
  let sourceText = enrichedText;
  if (userAngle && userAngle.trim()) {
    sourceText += `\n\n[User's Own Angle / Extra Judgment to Incorporate]:\n${userAngle.trim()}`;
  }

  const effectiveMode = normalizePostMode(postMode || topic.recommendedMode || 'news_post');
  const sourceLink = topic.url || topic.discussionUrl || '';

  return generatePostDraft({
    source: sourceText,
    postMode: effectiveMode,
    sourceLink,
    continuation,
    mediaAssets
  });
}

function buildSafeDownloadFilename(url, type = 'image') {
  let ext = type === 'video' ? 'mp4' : 'jpg';
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) ext = match[1].toLowerCase();
  } catch {
    // keep default ext
  }
  const stamp = Date.now();
  return `x-helper-media/x-media-${stamp}.${ext}`;
}

async function downloadMediaAsset(url, type = 'image') {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('无效的媒体链接');
  }
  if (!chrome.downloads?.download) {
    throw new Error('当前环境不支持下载 API，请刷新扩展权限后重试');
  }
  const filename = buildSafeDownloadFilename(url, type);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve({ downloadId, filename });
    });
  });
}

async function fetchMediaAsDataUrlForAttach(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('无效的图片链接');
  }
  const dataUrl = await fetchImageAsDataUrl(url, 8000);
  if (!dataUrl) {
    throw new Error('图片拉取失败或超过 2MB 限制，请直接点击「下载」后手动上传');
  }
  const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  return {
    dataUrl,
    mimeType,
    filename: `x-media-${Date.now()}.${ext}`
  };
}

async function handleMessage(message) {
  if (message.type === 'TRANSLATE_TWEET') {
    return translateTweetToChinese(
      message.text,
      message.author,
      message.context,
      Boolean(message.force),
      message.images || []
    );
  }
  if (message.type === 'TRANSLATE_COMPOSE') {
    return translateChineseToAmericanEnglish({
      text: message.text,
      context: message.context,
      images: message.images || [],
      stance: message.stance,
      tone: message.tone,
      length: message.length,
      continuation: message.continuation || null
    });
  }
  if (message.type === 'TRANSLATE_COMPOSE_CANDIDATES') {
    return generateReplyCandidates({
      context: message.context,
      idea: message.text || message.idea || '',
      images: message.images || [],
      stance: message.stance,
      tone: message.tone,
      length: message.length,
      continuation: message.continuation || null
    });
  }
  if (message.type === 'GENERATE_AUTO_REPLIES') {
    return generateReplyCandidates({
      context: message.context,
      idea: message.idea || '',
      images: message.images || [],
      stance: message.stance,
      tone: message.tone,
      length: message.length,
      continuation: message.continuation || null
    });
  }
  if (message.type === 'GENERATE_POST_DRAFT') {
    return generatePostDraft({
      source: message.source || '',
      postMode: message.postMode || 'news_post',
      sourceLink: message.sourceLink || '',
      context: message.context || '',
      images: message.images || [],
      continuation: message.continuation || null
    });
  }
  if (message.type === 'FETCH_RADAR_TOPICS') {
    return fetchRadarTopics({
      focus: message.focus || '',
      force: Boolean(message.force)
    });
  }
  if (message.type === 'DRAFT_FROM_TOPIC') {
    return draftFromSelectedTopic({
      topic: message.topic,
      postMode: message.postMode,
      userAngle: message.userAngle || '',
      continuation: message.continuation || null
    });
  }
  if (message.type === 'DOWNLOAD_MEDIA') {
    return downloadMediaAsset(message.url, message.mediaType || 'image');
  }
  if (message.type === 'FETCH_MEDIA_DATA_URL') {
    return fetchMediaAsDataUrlForAttach(message.url);
  }
  if (message.type === 'TEST_CONNECTION') {
    const { content } = await callLLM([
      { role: 'system', content: 'Reply with just "OK".' },
      { role: 'user', content: 'Ping' }
    ]);
    return content;
  }
  if (message.type === 'CLEAR_CACHE') {
    translationCache.clear();
    await chrome.storage.local.remove(CACHE_STORAGE_KEY).catch(() => {});
    return true;
  }
  if (message.type === 'GET_SETTINGS') {
    return getSettings();
  }
  throw new Error('Unknown message type');
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // Keep message channel open for async response
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    handleMessage,
    callLLM,
    translateTweetToChinese,
    translateChineseToAmericanEnglish,
    generateReplyCandidates,
    generatePostDraft,
    fetchRadarTopics,
    draftFromSelectedTopic,
    resolveImagesForLLM,
    _resetCacheForTest: () => {
      translationCache.clear();
      radarCache.clear();
      cacheLoaded = false;
    }
  };
}
