// Background service worker for X 地道双语助手

if (typeof importScripts === 'function' && !globalThis.XTR_CORE) {
  importScripts('lib/core.js');
}

const CORE =
  globalThis.XTR_CORE ||
  (typeof require === 'function' ? require('./lib/core.js') : null);

const {
  DEFAULT_SETTINGS,
  buildApiUrl,
  parseJsonSafely,
  stripImagesFromMessages,
  hasImageContent,
  buildTweetTranslationMessages,
  buildComposeDirectMessages,
  buildReplyCandidatesMessages
} = CORE;

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
    resolveImagesForLLM,
    _resetCacheForTest: () => {
      translationCache.clear();
      cacheLoaded = false;
    }
  };
}
