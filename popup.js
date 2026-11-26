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

const els = {
  provider: document.getElementById('provider'),
  apiBaseUrl: document.getElementById('apiBaseUrl'),
  apiKey: document.getElementById('apiKey'),
  toggleKeyBtn: document.getElementById('toggleKeyBtn'),
  model: document.getElementById('model'),
  defaultTone: document.getElementById('defaultTone'),
  defaultLength: document.getElementById('defaultLength'),
  glossary: document.getElementById('glossary'),
  grokApiKey: document.getElementById('grokApiKey'),
  grokModel: document.getElementById('grokModel'),
  autoTranslate: document.getElementById('autoTranslate'),
  showSlangNotes: document.getElementById('showSlangNotes'),
  saveBtn: document.getElementById('saveBtn'),
  testBtn: document.getElementById('testBtn'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  status: document.getElementById('status')
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

function loadSettings() {
  chrome.storage.sync.get(
    {
      provider: 'deepseek',
      apiBaseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      defaultTone: 'mix',
      defaultLength: 'auto',
      glossary: '',
      grokApiKey: '',
      grokModel: 'grok-3-mini',
      autoTranslate: false,
      showSlangNotes: true
    },
    (items) => {
      els.provider.value = items.provider;
      els.apiBaseUrl.value = items.apiBaseUrl;
      els.apiKey.value = items.apiKey;
      els.model.value = items.model;
      els.defaultTone.value = items.defaultTone || 'mix';
      if (!els.defaultTone.value) els.defaultTone.value = 'mix';
      els.defaultLength.value = items.defaultLength || 'auto';
      if (!els.defaultLength.value) els.defaultLength.value = 'auto';
      els.glossary.value = items.glossary || '';
      els.grokApiKey.value = items.grokApiKey || '';
      els.grokModel.value = items.grokModel || 'grok-3-mini';
      els.autoTranslate.checked = Boolean(items.autoTranslate);
      els.showSlangNotes.checked = Boolean(items.showSlangNotes);
    }
  );
}

function saveSettings(silent = false) {
  return new Promise((resolve) => {
    const data = {
      provider: els.provider.value,
      apiBaseUrl: els.apiBaseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim(),
      defaultTone: els.defaultTone.value,
      defaultLength: els.defaultLength.value,
      glossary: els.glossary.value,
      grokApiKey: els.grokApiKey.value.trim(),
      grokModel: els.grokModel.value.trim() || 'grok-3-mini',
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

document.addEventListener('DOMContentLoaded', loadSettings);
