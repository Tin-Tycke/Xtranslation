// Pure local daily ops tracker & anti-spam pace guard for X 地道双语助手

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XTR_OPS = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ONE_HOUR_MS = 60 * 60 * 1000;

  function getLocalDateKey(nowMs = Date.now()) {
    const d = new Date(nowMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function createEmptyOpsStats(nowMs = Date.now()) {
    return {
      dateKey: getLocalDateKey(nowMs),
      repliesToday: 0,
      quotesToday: 0,
      postsToday: 0,
      apiCallsToday: 0,
      promptTokensToday: 0,
      completionTokensToday: 0,
      totalTokensToday: 0,
      hourlyTimestamps: [],
      recentAuthors: []
    };
  }

  function normalizeOpsStats(raw, nowMs = Date.now()) {
    const today = getLocalDateKey(nowMs);
    if (!raw || typeof raw !== 'object' || raw.dateKey !== today) {
      const prevHourly = Array.isArray(raw?.hourlyTimestamps)
        ? raw.hourlyTimestamps.filter((ts) => typeof ts === 'number' && nowMs - ts >= 0 && nowMs - ts <= ONE_HOUR_MS)
        : [];
      return {
        ...createEmptyOpsStats(nowMs),
        hourlyTimestamps: prevHourly
      };
    }
    return {
      dateKey: today,
      repliesToday: Number(raw.repliesToday) || 0,
      quotesToday: Number(raw.quotesToday) || 0,
      postsToday: Number(raw.postsToday) || 0,
      apiCallsToday: Number(raw.apiCallsToday) || 0,
      promptTokensToday: Number(raw.promptTokensToday) || 0,
      completionTokensToday: Number(raw.completionTokensToday) || 0,
      totalTokensToday: Number(raw.totalTokensToday) || 0,
      hourlyTimestamps: Array.isArray(raw.hourlyTimestamps)
        ? raw.hourlyTimestamps.filter((ts) => typeof ts === 'number' && nowMs - ts >= 0 && nowMs - ts <= ONE_HOUR_MS)
        : [],
      recentAuthors: Array.isArray(raw.recentAuthors) ? raw.recentAuthors.slice(0, 30) : []
    };
  }

  function recordTokenUsage(rawStats, usage = null, { fallbackInputChars = 0, fallbackOutputChars = 0 } = {}, nowMs = Date.now()) {
    const next = normalizeOpsStats(rawStats, nowMs);
    next.apiCallsToday += 1;

    const pTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens);
    const cTokens = Number(usage?.completion_tokens ?? usage?.output_tokens);
    const tTokens = Number(usage?.total_tokens);

    const promptDelta = Number.isFinite(pTokens) && pTokens >= 0
      ? Math.round(pTokens)
      : Math.ceil(Math.max(0, fallbackInputChars) / 3);
    const completionDelta = Number.isFinite(cTokens) && cTokens >= 0
      ? Math.round(cTokens)
      : Math.ceil(Math.max(0, fallbackOutputChars) / 3);
    const totalDelta = Number.isFinite(tTokens) && tTokens > 0
      ? Math.round(tTokens)
      : promptDelta + completionDelta;

    next.promptTokensToday += promptDelta;
    next.completionTokensToday += completionDelta;
    next.totalTokensToday += totalDelta;
    return next;
  }

  function formatTokenCount(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
  }

  function recordOpsAction(rawStats, { kind = 'reply', author = '' } = {}, nowMs = Date.now()) {
    const next = normalizeOpsStats(rawStats, nowMs);
    if (kind === 'quote') {
      next.quotesToday += 1;
    } else if (kind === 'post') {
      next.postsToday += 1;
    } else {
      next.repliesToday += 1;
    }
    next.hourlyTimestamps = [...next.hourlyTimestamps, nowMs].slice(-100);

    const cleanAuthor = String(author || '').trim();
    if (cleanAuthor && !next.recentAuthors.includes(cleanAuthor)) {
      next.recentAuthors = [cleanAuthor, ...next.recentAuthors].slice(0, 30);
    }
    return next;
  }

  function evaluatePaceSafety(rawStats, nowMs = Date.now()) {
    const stats = normalizeOpsStats(rawStats, nowMs);
    const hourlyCount = stats.hourlyTimestamps.length;
    if (hourlyCount >= 20) {
      return {
        level: 'cooldown',
        hourlyCount,
        label: '建议休息防风控',
        warning: `近 1 小时已互动 ${hourlyCount} 次，建议暂停 15 分钟防限流`
      };
    }
    if (hourlyCount >= 12) {
      return {
        level: 'caution',
        hourlyCount,
        label: '频率偏高 建议放缓',
        warning: `近 1 小时已互动 ${hourlyCount} 次，适当放慢节奏更稳`
      };
    }
    return {
      level: 'safe',
      hourlyCount,
      label: '节奏健康',
      warning: ''
    };
  }

  const MAX_DRAFTS = 50;

  function normalizeDrafts(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((d) => d && typeof d === 'object' && typeof d.mainPost === 'string' && d.mainPost.trim())
      .slice(0, MAX_DRAFTS);
  }

  function addDraftItem(existingList, draft, nowMs = Date.now()) {
    const cleanMain = String(draft?.mainPost || '').trim();
    if (!cleanMain) {
      throw new Error('草稿内容不能为空');
    }
    const list = normalizeDrafts(existingList);
    const item = {
      id: draft.id || `draft_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      title: String(draft.title || '').trim(),
      mainPost: cleanMain,
      firstReply: String(draft.firstReply || '').trim(),
      zhSummary: String(draft.zhSummary || '').trim(),
      factCheckNote: String(draft.factCheckNote || '').trim(),
      postMode: String(draft.postMode || 'news_post'),
      kindLabel: String(draft.kindLabel || '成稿'),
      mediaAssets: Array.isArray(draft.mediaAssets) ? draft.mediaAssets.slice(0, 6) : [],
      createdAt: Number(draft.createdAt) || nowMs
    };
    // Deduplicate identical mainPost so repeated clicks don't spam the box
    const filtered = list.filter((d) => d.mainPost !== cleanMain);
    return [item, ...filtered].slice(0, MAX_DRAFTS);
  }

  function removeDraftItem(existingList, id) {
    return normalizeDrafts(existingList).filter((d) => d.id !== id);
  }

  return {
    getLocalDateKey,
    createEmptyOpsStats,
    normalizeOpsStats,
    recordOpsAction,
    recordTokenUsage,
    formatTokenCount,
    evaluatePaceSafety,
    normalizeDrafts,
    addDraftItem,
    removeDraftItem
  };
});
