const PRESETS = {
  deepseek: {
    apiBaseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  openai: {
    apiBaseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  gemini: {
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash'
  },
  groq: {
    apiBaseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  }
};

const IMAGE_GEN_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1/images/generations',
    model: 'gpt-image-1'
  },
  grok: {
    baseUrl: 'https://api.x.ai/v1/images/generations',
    model: 'grok-2-image'
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1/images/generations',
    model: 'black-forest-labs/FLUX.1-schnell'
  }
};

const els = {
  targetRegion: document.getElementById('targetRegion'),
  autoTranslateRow: document.getElementById('autoTranslateRow'),
  showSlangNotesRow: document.getElementById('showSlangNotesRow'),
  provider: document.getElementById('provider'),
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  apiKey: document.getElementById('apiKey'),
  toggleKeyBtn: document.getElementById('toggleKeyBtn'),
  model: document.getElementById('model'),
  defaultTone: document.getElementById('defaultTone'),
  defaultLength: document.getElementById('defaultLength'),
  personaRole: document.getElementById('personaRole'),
  personaStyle: document.getElementById('personaStyle'),
  personaTopicsWrap: document.getElementById('personaTopicsWrap'),
  persona: document.getElementById('persona'),
  searchProvider: document.getElementById('searchProvider'),
  searchApiKey: document.getElementById('searchApiKey'),
  searchModel: document.getElementById('searchModel'),
  imageGenEnabled: document.getElementById('imageGenEnabled'),
  imageGenProvider: document.getElementById('imageGenProvider'),
  imageGenBaseUrl: document.getElementById('imageGenBaseUrl'),
  imageGenApiKey: document.getElementById('imageGenApiKey'),
  imageGenModel: document.getElementById('imageGenModel'),
  videoGenEnabled: document.getElementById('videoGenEnabled'),
  videoGenBaseUrl: document.getElementById('videoGenBaseUrl'),
  videoGenApiKey: document.getElementById('videoGenApiKey'),
  videoGenModel: document.getElementById('videoGenModel'),
  autoTranslate: document.getElementById('autoTranslate'),
  showSlangNotes: document.getElementById('showSlangNotes'),
  saveBtn: document.getElementById('saveBtn'),
  testBtn: document.getElementById('testBtn'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  status: document.getElementById('status'),
  opsReplies: document.getElementById('opsReplies'),
  opsQuotes: document.getElementById('opsQuotes'),
  opsPosts: document.getElementById('opsPosts'),
  opsUsage: document.getElementById('opsUsage'),
  opsHourly: document.getElementById('opsHourly'),
  opsPaceBadge: document.getElementById('opsPaceBadge'),
  opsResetBtn: document.getElementById('opsResetBtn')
};

els.toggleKeyBtn.addEventListener('click', () => {
  const isPwd = els.apiKey.type === 'password';
  els.apiKey.type = isPwd ? 'text' : 'password';
  els.toggleKeyBtn.textContent = isPwd ? '隐藏' : '显示';
});

function showStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

function syncRegionUI() {
  const isZh = els.targetRegion.value === 'zh';
  els.autoTranslateRow.style.opacity = isZh ? '0.45' : '1';
  els.showSlangNotesRow.style.opacity = isZh ? '0.45' : '1';
  els.autoTranslate.disabled = isZh;
  els.showSlangNotes.disabled = isZh;
}

els.targetRegion.addEventListener('change', syncRegionUI);

els.personaTopicsWrap?.addEventListener('click', (e) => {
  const chip = e.target.closest('.topic-chip');
  if (!chip) return;
  chip.classList.toggle('is-active');
});

function getSelectedPersonaTopics() {
  if (!els.personaTopicsWrap) return [];
  return Array.from(els.personaTopicsWrap.querySelectorAll('.topic-chip.is-active'))
    .map((el) => el.dataset.topic)
    .filter(Boolean);
}

function setSelectedPersonaTopics(topics) {
  if (!els.personaTopicsWrap) return;
  const set = new Set(Array.isArray(topics) ? topics : []);
  els.personaTopicsWrap.querySelectorAll('.topic-chip').forEach((el) => {
    el.classList.toggle('is-active', set.has(el.dataset.topic));
  });
}

function loadSettings() {
  chrome.storage.sync.get(
    {
      targetRegion: 'en',
      provider: 'deepseek',
      apiBaseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      defaultTone: 'mix',
      defaultLength: 'auto',
      personaRole: 'custom',
      personaStyle: 'default',
      personaTopics: [],
      persona: '',
      glossary: '',
      searchProvider: 'none',
      searchApiKey: '',
      searchModel: '',
      grokApiKey: '',
      grokModel: 'grok-3-mini',
      imageGenEnabled: false,
      imageGenProvider: 'openai',
      imageGenBaseUrl: 'https://api.openai.com/v1/images/generations',
      imageGenApiKey: '',
      imageGenModel: 'gpt-image-1',
      videoGenEnabled: false,
      videoGenBaseUrl: '',
      videoGenApiKey: '',
      videoGenModel: '',
      autoTranslate: false,
      showSlangNotes: true
    },
    (items) => {
      els.targetRegion.value = items.targetRegion === 'zh' ? 'zh' : 'en';
      els.provider.value = items.provider;
      els.apiBaseUrl.value = items.apiBaseUrl;
      els.apiKey.value = items.apiKey;
      els.model.value = items.model;
      els.defaultTone.value = items.defaultTone || 'mix';
      if (!els.defaultTone.value) els.defaultTone.value = 'mix';
      els.defaultLength.value = items.defaultLength || 'auto';
      if (!els.defaultLength.value) els.defaultLength.value = 'auto';
      els.personaRole.value = items.personaRole || 'custom';
      els.personaStyle.value = items.personaStyle || 'default';
      setSelectedPersonaTopics(items.personaTopics);
      els.persona.value = items.persona || '';
      const sp = items.searchProvider && items.searchProvider !== 'none'
        ? items.searchProvider
        : items.grokApiKey
          ? 'grok'
          : 'none';
      els.searchProvider.value = sp;
      els.searchApiKey.value = items.searchApiKey || (sp === 'grok' ? items.grokApiKey : '') || '';
      els.searchModel.value = items.searchModel || (sp === 'grok' ? items.grokModel : '') || '';
      els.imageGenEnabled.checked = Boolean(items.imageGenEnabled);
      els.imageGenProvider.value = items.imageGenProvider || 'openai';
      els.imageGenBaseUrl.value = items.imageGenBaseUrl || 'https://api.openai.com/v1/images/generations';
      els.imageGenApiKey.value = items.imageGenApiKey || '';
      els.imageGenModel.value = items.imageGenModel || 'gpt-image-1';
      els.videoGenEnabled.checked = Boolean(items.videoGenEnabled);
      els.videoGenBaseUrl.value = items.videoGenBaseUrl || '';
      els.videoGenApiKey.value = items.videoGenApiKey || '';
      els.videoGenModel.value = items.videoGenModel || '';
      els.autoTranslate.checked = Boolean(items.autoTranslate);
      els.showSlangNotes.checked = Boolean(items.showSlangNotes);
      syncRegionUI();
    }
  );
}

function saveSettings(silent = false) {
  return new Promise((resolve) => {
    const sp = els.searchProvider.value || 'none';
    const sKey = els.searchApiKey.value.trim();
    const sModel = els.searchModel.value.trim();
    const data = {
      targetRegion: els.targetRegion.value === 'zh' ? 'zh' : 'en',
      provider: els.provider.value,
      apiBaseUrl: els.apiBaseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim(),
      defaultTone: els.defaultTone.value,
      defaultLength: els.defaultLength.value,
      personaRole: els.personaRole.value,
      personaStyle: els.personaStyle.value,
      personaTopics: getSelectedPersonaTopics(),
      persona: els.persona.value,
      searchProvider: sp,
      searchApiKey: sKey,
      searchModel: sModel,
      grokApiKey: sp === 'grok' ? sKey : '',
      grokModel: sp === 'grok' ? sModel || 'grok-3-mini' : 'grok-3-mini',
      imageGenEnabled: els.imageGenEnabled.checked,
      imageGenProvider: els.imageGenProvider.value,
      imageGenBaseUrl: els.imageGenBaseUrl.value.trim(),
      imageGenApiKey: els.imageGenApiKey.value.trim(),
      imageGenModel: els.imageGenModel.value.trim(),
      videoGenEnabled: els.videoGenEnabled.checked,
      videoGenBaseUrl: els.videoGenBaseUrl.value.trim(),
      videoGenApiKey: els.videoGenApiKey.value.trim(),
      videoGenModel: els.videoGenModel.value.trim(),
      autoTranslate: els.autoTranslate.checked,
      showSlangNotes: els.showSlangNotes.checked
    };
    chrome.storage.sync.set(data, () => {
      if (!silent) {
        showStatus('✓ 设置已保存');
      }
      resolve();
    });
  });
}

els.imageGenProvider.addEventListener('change', () => {
  const preset = IMAGE_GEN_PRESETS[els.imageGenProvider.value];
  if (preset) {
    els.imageGenBaseUrl.value = preset.baseUrl;
    els.imageGenModel.value = preset.model;
  }
});

els.provider.addEventListener('change', () => {
  const preset = PRESETS[els.provider.value];
  if (preset) {
    els.apiBaseUrl.value = preset.apiBaseUrl;
    els.model.value = preset.model;
  }
});

els.saveBtn.addEventListener('click', () => {
  saveSettings(false);
});

els.testBtn.addEventListener('click', async () => {
  await saveSettings(true);
  showStatus('正在测试连接...');
  els.testBtn.disabled = true;

  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    els.testBtn.disabled = false;
    if (chrome.runtime.lastError) {
      showStatus(`连接失败: ${chrome.runtime.lastError.message}`, true);
      return;
    }
    if (res?.ok) {
      showStatus('✓ 连接成功！模型响应正常');
    } else {
      showStatus(`✗ ${res?.error || '连接失败'}`, true);
    }
  });
});

els.clearCacheBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (res) => {
    if (res?.ok) {
      showStatus('✓ 翻译缓存已清空');
    } else {
      showStatus('清空缓存失败', true);
    }
  });
});

function formatCompactTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function renderOpsStats(stats) {
  if (!stats) return;
  els.opsReplies.textContent = String(stats.repliesToday || 0);
  els.opsQuotes.textContent = String(stats.quotesToday || 0);
  els.opsPosts.textContent = String(stats.postsToday || 0);
  const calls = stats.apiCallsToday || 0;
  const totalTok = formatCompactTokens(stats.totalTokensToday || 0);
  const inTok = formatCompactTokens(stats.promptTokensToday || 0);
  const outTok = formatCompactTokens(stats.completionTokensToday || 0);
  if (els.opsUsage) {
    els.opsUsage.textContent = `调用 ${calls} 次｜Token ${totalTok}`;
    els.opsUsage.title = `输入 ${inTok} / 输出 ${outTok}`;
  }
  const pace = stats.pace || { level: 'safe', hourlyCount: 0, label: '节奏健康' };
  els.opsHourly.textContent = `近1h ${pace.hourlyCount}次`;
  const icon = pace.level === 'cooldown' ? '🔴' : pace.level === 'caution' ? '🟡' : '🟢';
  els.opsPaceBadge.textContent = `${icon} ${pace.label}`;
  els.opsPaceBadge.className = `ops-pace ${pace.level === 'safe' ? '' : pace.level}`.trim();
}

function loadOpsStats() {
  chrome.runtime.sendMessage({ type: 'GET_OPS_STATS' }, (res) => {
    if (res?.ok && res.data) {
      renderOpsStats(res.data);
    }
  });
}

els.opsResetBtn?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_OPS_STATS' }, (res) => {
    if (res?.ok && res.data) {
      renderOpsStats(res.data);
      showStatus('✓ 今日运营计数已重置');
    }
  });
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('is-active', p.id === `tab-${target}`));
  });
});

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadOpsStats();
});
