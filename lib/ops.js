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
      hourlyTimestamps: [],
      recentAuthors: []
    };
  }

  function normalizeOpsStats(raw, nowMs = Date.now()) {
    const today = getLocalDateKey(nowMs);
    if (!raw || typeof raw !== 'object' || raw.dateKey !== today) {
      // Carry over rolling 1-hour timestamps even across midnight
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
      hourlyTimestamps: Array.isArray(raw.hourlyTimestamps)
        ? raw.hourlyTimestamps.filter((ts) => typeof ts === 'number' && nowMs - ts >= 0 && nowMs - ts <= ONE_HOUR_MS)
        : [],
      recentAuthors: Array.isArray(raw.recentAuthors) ? raw.recentAuthors.slice(0, 30) : []
    };
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

  return {
    getLocalDateKey,
    createEmptyOpsStats,
    normalizeOpsStats,
    recordOpsAction,
    evaluatePaceSafety
  };
});
