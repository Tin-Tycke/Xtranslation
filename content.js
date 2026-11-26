// Content script for X (x.com / twitter.com)

(function () {
  const CORE =
    (typeof globalThis !== 'undefined' && globalThis.XTR_CORE) ||
    (typeof require === 'function' ? require('./lib/core.js') : null);

  const {
    STANCE_OPTIONS,
    LENGTH_OPTIONS,
    POST_MODES,
    isMostlyChinese,
    hasChinese,
    normalizeStance,
    normalizeLength,
    normalizePostMode
  } = CORE;

  const SETTINGS = {
    targetRegion: 'en',
    imageGenEnabled: false,
    videoGenEnabled: false,
    autoTranslate: false,
    showSlangNotes: true,
    defaultTone: 'mix',
    defaultLength: 'auto'
  };

  function isChineseRegion() {
    return SETTINGS.targetRegion === 'zh';
  }

  const SESSION_STATE_KEY = 'xtr_session_state_v1';
  const PILL_POS_KEY = 'xtr_pill_pos_v1';

  const SESSION_STATE = {
    lastStance: 'mix',
    lastLength: 'auto',
    lastPostMode: 'news_post',
    lastSelection: null, // { en, zh_back, style, timestamp }
    continueEnabled: false
  };

  const sessionSyncListeners = new Set();
  const originalDrafts = new WeakMap();
  const translateQueue = [];
  let activeRequests = 0;
  const MAX_CONCURRENT = 2;

  function persistSessionState() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [SESSION_STATE_KEY]: { ...SESSION_STATE } });
    }
    for (const fn of sessionSyncListeners) {
      try {
        fn();
      } catch {
        // ignore detached listener errors
      }
    }
  }

  function recordSelectedCandidate(candidate) {
    if (!candidate || !candidate.en) return;
    SESSION_STATE.lastSelection = {
      en: String(candidate.en).trim(),
      zh_back: candidate.zh_back ? String(candidate.zh_back).trim() : '',
      style: candidate.style || '',
      timestamp: Date.now()
    };
    SESSION_STATE.continueEnabled = true;
    persistSessionState();
  }

  function clearLastSelection() {
    SESSION_STATE.lastSelection = null;
    SESSION_STATE.continueEnabled = false;
    persistSessionState();
  }

  function getActiveContinuation() {
    if (SESSION_STATE.continueEnabled && SESSION_STATE.lastSelection?.en) {
      return SESSION_STATE.lastSelection;
    }
    return null;
  }

  // --- DOM & Context Extraction Utilities ---

  function extractTextWithEmojis(el) {
    if (!el) return '';
    let out = '';
    const nodes = el.childNodes || [];
    for (const node of nodes) {
      if (node.nodeType === 3) {
        out += node.textContent || '';
      } else if (node.nodeType === 1) {
        if (node.tagName === 'IMG' && node.alt) {
          out += node.alt;
        } else if (node.tagName === 'BR') {
          out += '\n';
        } else {
          out += extractTextWithEmojis(node);
        }
      }
    }
    return out.trim();
  }

  function isTweetContentImageUrl(src) {
    if (!src || typeof src !== 'string') return false;
    if (src.includes('profile_images') || src.includes('/emoji/') || src.includes('abs-0.twimg.com')) {
      return false;
    }
    return (
      src.includes('pbs.twimg.com/media') ||
      src.includes('pbs.twimg.com/card_img') ||
      src.includes('pbs.twimg.com/ext_tw_video_thumb') ||
      src.includes('pbs.twimg.com/amplify_video_thumb')
    );
  }

  function extractImagesFromElement(el, limit = 4) {
    if (!el || typeof el.querySelectorAll !== 'function') return [];
    const seen = new Set();
    const images = [];
    const imgs = el.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.getAttribute?.('src') || img.src || '';
      if (!isTweetContentImageUrl(src)) continue;
      if (seen.has(src)) continue;
      seen.add(src);
      const rawAlt = (img.getAttribute?.('alt') || img.alt || '').trim();
      const alt = rawAlt && rawAlt.toLowerCase() !== 'image' ? rawAlt : '';
      images.push({ url: src, alt });
      if (images.length >= limit) break;
    }
    return images;
  }

  function extractCardText(el) {
    if (!el || typeof el.querySelector !== 'function') return '';
    const card = el.querySelector('[data-testid="card.wrapper"]');
    if (!card) return '';
    const txt = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
    return txt ? txt.slice(0, 260) : '';
  }

  function getTweetAuthor(article) {
    if (!article || typeof article.querySelectorAll !== 'function') return '';
    const userLinks = article.querySelectorAll('div[data-testid="User-Name"] a[href^="/"]');
    for (const a of userLinks) {
      const href = a.getAttribute('href') || '';
      if (/^\/[A-Za-z0-9_]+$/.test(href)) {
        return '@' + href.slice(1);
      }
    }
    return '';
  }

  function extractTweetContextPayload(tweetTextEl, article, pathname = '') {
    const parts = [];
    const seen = new Set([extractTextWithEmojis(tweetTextEl)]);
    const images = article ? extractImagesFromElement(article, 4) : [];

    // 1. Link card / preview inside the same article
    const cardText = extractCardText(article);
    if (cardText && !seen.has(cardText)) {
      seen.add(cardText);
      parts.push(`[附带链接/卡片]: ${cardText}`);
    }

    // 2. Quoted tweet inside the same article
    if (article && typeof article.querySelectorAll === 'function') {
      article.querySelectorAll('[data-testid="tweetText"]').forEach((otherEl) => {
        if (otherEl === tweetTextEl) return;
        const txt = extractTextWithEmojis(otherEl);
        if (txt && !seen.has(txt)) {
          seen.add(txt);
          parts.push(`[引用的推文]: ${txt}`);
        }
      });
    }

    // 3. Up to 2 preceding tweets on a /status/ thread page
    const currentPath = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
    if (article && currentPath.includes('/status/') && typeof document !== 'undefined') {
      const allTweets = Array.from(document.querySelectorAll('main article[data-testid="tweet"]'));
      const idx = allTweets.indexOf(article);
      if (idx > 0) {
        const start = Math.max(0, idx - 2);
        const threadSnippets = [];
        for (let i = start; i < idx; i++) {
          const prevArticle = allTweets[i];
          const prevTextEl = prevArticle.querySelector('[data-testid="tweetText"]');
          if (prevTextEl) {
            const prevTxt = extractTextWithEmojis(prevTextEl);
            if (prevTxt && !seen.has(prevTxt)) {
              seen.add(prevTxt);
              const prevAuthor = getTweetAuthor(prevArticle);
              threadSnippets.push(prevAuthor ? `[上级推文 ${prevAuthor}]: ${prevTxt}` : `[上级推文]: ${prevTxt}`);
            }
          }
        }
        if (threadSnippets.length > 0) {
          parts.unshift(...threadSnippets);
        }
      }
    }

    return { context: parts.join('\n'), images };
  }

  function extractReplyContextPayload(textbox, pathname = '') {
    const seen = new Set();
    const snippets = [];
    const seenImg = new Set();
    const images = [];

    const pushSnippet = (author, txt) => {
      const clean = (txt || '').trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      snippets.push(author ? `${author}: ${clean}` : clean);
    };

    const pushImages = (el) => {
      for (const img of extractImagesFromElement(el, 4)) {
        if (!seenImg.has(img.url) && images.length < 4) {
          seenImg.add(img.url);
          images.push(img);
        }
      }
    };

    // 1. Inside a Reply or Quote Tweet Modal (div[role="dialog"])
    const dialog = textbox?.closest?.('div[role="dialog"]');
    if (dialog) {
      dialog.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl) {
          pushSnippet(getTweetAuthor(article), extractTextWithEmojis(textEl));
        }
        const card = extractCardText(article);
        if (card) pushSnippet('[卡片]', card);
        pushImages(article);
      });

      dialog.querySelectorAll('[data-testid="tweetText"]').forEach((textEl) => {
        if (textbox.contains?.(textEl)) return;
        const card = textEl.closest?.('div[role="link"]') || textEl.closest?.('article');
        const authorEl = card?.querySelector?.('div[dir="ltr"] span');
        const author = authorEl && authorEl.textContent?.startsWith('@') ? authorEl.textContent.trim() : '';
        pushSnippet(author, extractTextWithEmojis(textEl));
        if (card) pushImages(card);
      });

      if (snippets.length > 0 || images.length > 0) {
        return { context: snippets.slice(-3).join('\n---\n'), images };
      }
    }

    // 2. Inline reply on a tweet detail page (/status/...)
    const currentPath = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
    if (currentPath.includes('/status/') && typeof document !== 'undefined') {
      const allTweets = Array.from(document.querySelectorAll('main article[data-testid="tweet"]'));
      const preceding = [];
      for (const article of allTweets) {
        if (article.compareDocumentPosition(textbox) & 4 /* DOCUMENT_POSITION_FOLLOWING */) {
          preceding.push(article);
        }
      }
      const recent = preceding.slice(-3);
      for (const article of recent) {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl) {
          pushSnippet(getTweetAuthor(article), extractTextWithEmojis(textEl));
        }
        const card = extractCardText(article);
        if (card) pushSnippet('[卡片]', card);
      }
      if (recent.length > 0) {
        pushImages(recent[recent.length - 1]);
      }
      if (snippets.length > 0 || images.length > 0) {
        return { context: snippets.join('\n---\n'), images };
      }
    }

    // 3. Inline quote-tweet in home/profile compose area
    const composeContainer =
      textbox?.closest?.('div[data-testid="primaryColumn"]') ||
      textbox?.parentElement?.parentElement?.parentElement;
    if (composeContainer && typeof composeContainer.querySelector === 'function') {
      const quotedCard = composeContainer.querySelector('div[role="link"]');
      const quoted = quotedCard?.querySelector?.('[data-testid="tweetText"]');
      if (quoted && !textbox.contains?.(quoted)) {
        pushSnippet('', extractTextWithEmojis(quoted));
        pushImages(quotedCard);
      }
    }

    return { context: snippets.slice(-3).join('\n---\n'), images };
  }

  function normalizeComparableText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function shouldFallbackAfterPaste(currentEditorText, expectedText) {
    const cur = normalizeComparableText(currentEditorText);
    const exp = normalizeComparableText(expectedText);
    if (!exp) return false;
    return cur !== exp;
  }

  function renderErrorMessage(container, prefix, err) {
    container.innerHTML = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'xtr-error-text';
    errDiv.textContent = `${prefix}: ${err?.message || String(err)}`;
    container.appendChild(errDiv);
  }

  // Export testable helpers in Node test environment
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      extractTextWithEmojis,
      isTweetContentImageUrl,
      extractImagesFromElement,
      extractCardText,
      getTweetAuthor,
      extractTweetContextPayload,
      extractReplyContextPayload,
      normalizeComparableText,
      shouldFallbackAfterPaste,
      renderErrorMessage,
      recordSelectedCandidate,
      clearLastSelection,
      getActiveContinuation,
      SESSION_STATE
    };
  }

  // Stop here when running in unit tests without full browser runtime
  if (typeof window === 'undefined' || typeof document === 'undefined' || globalThis.__XTR_TEST_ENV__) {
    return;
  }

  if (window.__xTranslatorLoaded) return;
  window.__xTranslatorLoaded = true;

  // --- Bootstrap Settings & Session State ---

  function sendMessageAsync(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('未收到后台响应'));
            return;
          }
          if (!response.ok) {
            reject(new Error(response.error || '请求失败'));
            return;
          }
          resolve(response.data);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function applyRegionVisibility() {
    const zh = isChineseRegion();
    if (floatingPill) {
      floatingPill.style.display = zh ? 'none' : '';
    }
    document.querySelectorAll('.xtr-translate-btn').forEach((el) => {
      el.style.display = zh ? 'none' : '';
    });
    document.querySelectorAll('.xtr-direct-btn').forEach((el) => {
      if (zh) el.style.display = 'none';
    });
    if (zh) {
      document.querySelectorAll('[data-testid="tweetText"][data-xtr-enhanced="skip"]').forEach((el) => {
        delete el.dataset.xtrEnhanced;
      });
      scanPage();
    }
  }

  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
    if (res?.ok && res.data) {
      Object.assign(SETTINGS, res.data);
      updateFloatingPill();
      applyRegionVisibility();
      if (!isChineseRegion() && SETTINGS.autoTranslate) {
        observeVisibleTweets();
      }
    }
  });

  chrome.storage.local.get(SESSION_STATE_KEY, (res) => {
    const saved = res?.[SESSION_STATE_KEY];
    if (saved) {
      if (saved.lastStance) SESSION_STATE.lastStance = normalizeStance(saved.lastStance);
      if (saved.lastLength) SESSION_STATE.lastLength = normalizeLength(saved.lastLength);
      if (saved.lastPostMode) SESSION_STATE.lastPostMode = normalizePostMode(saved.lastPostMode);
      if (saved.lastSelection && saved.lastSelection.en) {
        SESSION_STATE.lastSelection = saved.lastSelection;
        SESSION_STATE.continueEnabled = Boolean(saved.continueEnabled);
      }
      for (const fn of sessionSyncListeners) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.targetRegion) {
      SETTINGS.targetRegion = changes.targetRegion.newValue === 'zh' ? 'zh' : 'en';
      updateFloatingPill();
      applyRegionVisibility();
      if (!isChineseRegion() && SETTINGS.autoTranslate) {
        observeVisibleTweets();
      }
    }
    if (changes.autoTranslate) {
      SETTINGS.autoTranslate = Boolean(changes.autoTranslate.newValue);
      updateFloatingPill();
      if (!isChineseRegion() && SETTINGS.autoTranslate) {
        observeVisibleTweets();
      }
    }
    if (changes.showSlangNotes) {
      SETTINGS.showSlangNotes = Boolean(changes.showSlangNotes.newValue);
    }
    if (changes.defaultTone) {
      SETTINGS.defaultTone = normalizeStance(changes.defaultTone.newValue);
    }
    if (changes.defaultLength) {
      SETTINGS.defaultLength = normalizeLength(changes.defaultLength.newValue);
    }
    if (changes.imageGenEnabled) {
      SETTINGS.imageGenEnabled = Boolean(changes.imageGenEnabled.newValue);
    }
    if (changes.videoGenEnabled) {
      SETTINGS.videoGenEnabled = Boolean(changes.videoGenEnabled.newValue);
    }
  });

  // --- Shared UI Builders ---

  function buildStanceSelect() {
    const select = document.createElement('select');
    select.className = 'xtr-tone-select';
    select.title = '选择回复立场/风格（自动记住上次选择）';
    STANCE_OPTIONS.forEach((optItem) => {
      const opt = document.createElement('option');
      opt.value = optItem.value;
      opt.textContent = optItem.label;
      if (optItem.value === SESSION_STATE.lastStance) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      SESSION_STATE.lastStance = normalizeStance(select.value);
      persistSessionState();
    });
    return select;
  }

  function buildLengthSelect() {
    const select = document.createElement('select');
    select.className = 'xtr-length-select';
    select.title = '选择回复篇幅（自动记住上次选择）';
    LENGTH_OPTIONS.forEach((optItem) => {
      const opt = document.createElement('option');
      opt.value = optItem.value;
      opt.textContent = optItem.label;
      if (optItem.value === SESSION_STATE.lastLength) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      SESSION_STATE.lastLength = normalizeLength(select.value);
      persistSessionState();
    });
    return select;
  }

  function buildContinueChip() {
    const chip = document.createElement('span');
    chip.className = 'xtr-continue-chip';

    const label = document.createElement('span');
    label.textContent = '🔗 延续上条';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'xtr-continue-clear';
    clearBtn.textContent = '×';
    clearBtn.title = '清除上次候选记忆';
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearLastSelection();
    });

    chip.appendChild(label);
    chip.appendChild(clearBtn);

    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!SESSION_STATE.lastSelection) return;
      SESSION_STATE.continueEnabled = !SESSION_STATE.continueEnabled;
      persistSessionState();
    });

    const sync = () => {
      const sel = SESSION_STATE.lastSelection;
      if (!sel || !sel.en) {
        chip.style.display = 'none';
        return;
      }
      chip.style.display = 'inline-flex';
      chip.classList.toggle('is-active', Boolean(SESSION_STATE.continueEnabled));
      const preview = sel.en.length > 70 ? sel.en.slice(0, 70) + '…' : sel.en;
      chip.title = SESSION_STATE.continueEnabled
        ? `已开启延续上条（点击关闭）：\n「${preview}」`
        : `点击开启延续上次选中的句子：\n「${preview}」`;
    };

    sync();
    return { chip, sync };
  }

  function renderCandidateCards(panel, payload, { onUse, onClose }) {
    panel.innerHTML = '';
    const candidates = Array.isArray(payload) ? payload : payload?.candidates || [];
    const postTakeaway = !Array.isArray(payload) ? payload?.postTakeaway : '';
    const visionFallback = !Array.isArray(payload) ? Boolean(payload?.visionFallback) : false;

    const header = document.createElement('div');
    header.className = 'xtr-candidates-header';
    const title = document.createElement('span');
    if (visionFallback) {
      title.textContent = '选择回复（当前模型不支持识图，已按文本分析）：';
    } else if (isChineseRegion()) {
      title.textContent = '选择中文回复（选中后可延续）：';
    } else {
      title.textContent = '选择地道美语表达（选中后可延续）：';
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'xtr-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', onClose);
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    if (postTakeaway) {
      const takeawayDiv = document.createElement('div');
      takeawayDiv.className = 'xtr-takeaway-box';
      takeawayDiv.textContent = `🎯 主贴意图：${postTakeaway}`;
      panel.appendChild(takeawayDiv);
    }

    candidates.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'xtr-candidate-card';

      const meta = document.createElement('div');
      meta.className = 'xtr-candidate-meta';
      const badge = document.createElement('span');
      badge.className = 'xtr-candidate-style';
      badge.textContent = c.style;

      const actions = document.createElement('div');
      actions.className = 'xtr-candidate-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'xtr-mini-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        recordSelectedCandidate(c);
        navigator.clipboard?.writeText(c.en).then(() => {
          copyBtn.textContent = '已复制';
          setTimeout(() => (copyBtn.textContent = '复制'), 1500);
        });
      });

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'xtr-mini-btn is-primary';
      useBtn.textContent = '填入';
      useBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        recordSelectedCandidate(c);
        onUse(c.en);
      });

      actions.appendChild(copyBtn);
      actions.appendChild(useBtn);
      meta.appendChild(badge);
      meta.appendChild(actions);

      const enText = document.createElement('div');
      enText.className = 'xtr-candidate-en';
      enText.textContent = c.en;

      card.appendChild(meta);
      card.appendChild(enText);

      if (c.zh_back) {
        const zhBack = document.createElement('div');
        zhBack.className = 'xtr-candidate-zh';
        zhBack.textContent = `回译：${c.zh_back}`;
        card.appendChild(zhBack);
      }

      card.addEventListener('click', () => {
        recordSelectedCandidate(c);
        onUse(c.en);
      });
      panel.appendChild(card);
    });
  }

  // --- Tweet Translation (EN -> ZH + Takeaway + Slang) ---

  function enqueueTranslation(taskFn) {
    translateQueue.push(taskFn);
    processQueue();
  }

  function processQueue() {
    while (activeRequests < MAX_CONCURRENT && translateQueue.length > 0) {
      const task = translateQueue.shift();
      activeRequests++;
      Promise.resolve()
        .then(task)
        .finally(() => {
          activeRequests--;
          processQueue();
        });
    }
  }

  async function performTweetTranslation(tweetTextEl, btn, resultBox, force = false) {
    if (tweetTextEl.dataset.xtrState === 'loading') return;
    if (!force && tweetTextEl.dataset.xtrState === 'done') {
      const isHidden = resultBox.style.display === 'none';
      resultBox.style.display = isHidden ? 'block' : 'none';
      btn.textContent = isHidden ? '收起' : '译';
      return;
    }

    const rawText = extractTextWithEmojis(tweetTextEl);
    if (!rawText) return;

    const article = tweetTextEl.closest('article[data-testid="tweet"]');
    const author = getTweetAuthor(article);
    const { context, images } = extractTweetContextPayload(tweetTextEl, article);

    tweetTextEl.dataset.xtrState = 'loading';
    tweetTextEl.dataset.xtrRawText = rawText;
    btn.disabled = true;
    btn.textContent = '译中...';
    resultBox.style.display = 'none';

    try {
      const data = await sendMessageAsync({
        type: 'TRANSLATE_TWEET',
        text: rawText,
        author,
        context,
        images,
        force
      });

      resultBox.innerHTML = '';

      const headerRow = document.createElement('div');
      headerRow.className = 'xtr-result-header';

      const transP = document.createElement('div');
      transP.className = 'xtr-trans-text';
      transP.textContent = data.translation;

      const reBtn = document.createElement('button');
      reBtn.type = 'button';
      reBtn.className = 'xtr-retranslate-btn';
      reBtn.textContent = '↻';
      reBtn.title = '重新翻译';
      reBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        performTweetTranslation(tweetTextEl, btn, resultBox, true);
      });

      headerRow.appendChild(transP);
      headerRow.appendChild(reBtn);
      resultBox.appendChild(headerRow);

      if (data.takeaway) {
        const takeawayDiv = document.createElement('div');
        takeawayDiv.className = 'xtr-takeaway-box';
        takeawayDiv.textContent = `🎯 核心意图：${data.takeaway}`;
        resultBox.appendChild(takeawayDiv);
      }

      if (SETTINGS.showSlangNotes && data.slangNotes && data.slangNotes.length > 0) {
        const notesDiv = document.createElement('div');
        notesDiv.className = 'xtr-slang-notes';
        for (const note of data.slangNotes) {
          const item = document.createElement('div');
          item.className = 'xtr-slang-item';
          item.textContent = `💡 ${note}`;
          notesDiv.appendChild(item);
        }
        resultBox.appendChild(notesDiv);
      }

      resultBox.style.display = 'block';
      tweetTextEl.dataset.xtrState = 'done';
      btn.textContent = '收起';
    } catch (err) {
      tweetTextEl.dataset.xtrState = 'error';
      renderErrorMessage(resultBox, '翻译失败', err);
      resultBox.style.display = 'block';
      btn.textContent = '重试';
    } finally {
      btn.disabled = false;
    }
  }

  function openReplyAndFill(article, englishText) {
    if (!article) return;
    const replyBtn = article.querySelector('[data-testid="reply"]');
    if (replyBtn) {
      replyBtn.click();
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      const dialogBox =
        document.querySelector('div[role="dialog"] div[data-testid^="tweetTextarea_"][contenteditable="true"]') ||
        document.querySelector('div[data-testid^="tweetTextarea_"][contenteditable="true"]');
      if (dialogBox) {
        clearInterval(timer);
        replaceEditorText(dialogBox, englishText);
      } else if (attempts > 20) {
        clearInterval(timer);
      }
    }, 100);
  }

  function enhanceTweetText(tweetTextEl) {
    if (tweetTextEl.dataset.xtrEnhanced === '1') return;
    const rawText = extractTextWithEmojis(tweetTextEl);
    if (!rawText || (!isChineseRegion() && isMostlyChinese(rawText))) {
      tweetTextEl.dataset.xtrEnhanced = 'skip';
      return;
    }

    tweetTextEl.dataset.xtrEnhanced = '1';
    tweetTextEl.dataset.xtrRawText = rawText;

    const container = document.createElement('div');
    container.className = 'xtr-tweet-container';
    container.addEventListener('click', (e) => e.stopPropagation());

    const controls = document.createElement('div');
    controls.className = 'xtr-tweet-controls';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xtr-translate-btn';
    btn.textContent = '译';
    btn.title = '翻译为地道中文并提炼主贴意图';
    if (isChineseRegion()) {
      btn.style.display = 'none';
    }

    const quickReplyBtn = document.createElement('button');
    quickReplyBtn.type = 'button';
    quickReplyBtn.className = 'xtr-quick-reply-btn';
    quickReplyBtn.textContent = '回';
    quickReplyBtn.title = isChineseRegion() ? '结合主贴图文生成多角度中文回复' : '结合主贴图文生成多角度英文回复';

    const resultBox = document.createElement('div');
    resultBox.className = 'xtr-result-box';
    resultBox.style.display = 'none';

    const quickReplyBox = document.createElement('div');
    quickReplyBox.className = 'xtr-quick-reply-box';
    quickReplyBox.style.display = 'none';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isRetry = tweetTextEl.dataset.xtrState === 'error';
      performTweetTranslation(tweetTextEl, btn, resultBox, isRetry);
    });

    quickReplyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const showing = quickReplyBox.style.display !== 'none';
      if (showing) {
        quickReplyBox.style.display = 'none';
        return;
      }
      if (!quickReplyBox.dataset.built) {
        quickReplyBox.dataset.built = '1';
        const row = document.createElement('div');
        row.className = 'xtr-qr-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'xtr-qr-input';
        input.placeholder = '输入回复想法（留空则直接根据主贴图文生成）';

        const stanceSel = buildStanceSelect();
        const lengthSel = buildLengthSelect();
        const { chip: continueChip, sync: syncContinue } = buildContinueChip();

        const genBtn = document.createElement('button');
        genBtn.type = 'button';
        genBtn.className = 'xtr-compose-btn';
        genBtn.textContent = '⚡ 生成';

        const candPanel = document.createElement('div');
        candPanel.className = 'xtr-candidates-panel';
        candPanel.style.display = 'none';

        sessionSyncListeners.add(() => {
          stanceSel.value = SESSION_STATE.lastStance;
          lengthSel.value = SESSION_STATE.lastLength;
          syncContinue();
        });

        const runGen = async () => {
          const idea = input.value.trim();
          const article = tweetTextEl.closest('article[data-testid="tweet"]');
          const author = getTweetAuthor(article);
          const tweetContent = extractTextWithEmojis(tweetTextEl);
          const { context: extraCtx, images } = extractTweetContextPayload(tweetTextEl, article);
          const mainLine = author ? `${author}: ${tweetContent}` : tweetContent;
          const context = extraCtx ? `${extraCtx}\n---\n[要回复的主贴]: ${mainLine}` : mainLine;
          const continuation = getActiveContinuation();

          genBtn.disabled = true;
          genBtn.textContent = '生成中...';
          try {
            const payload = await sendMessageAsync({
              type: idea ? 'TRANSLATE_COMPOSE_CANDIDATES' : 'GENERATE_AUTO_REPLIES',
              text: idea,
              idea,
              context,
              images,
              stance: stanceSel.value,
              length: lengthSel.value,
              continuation
            });
            renderCandidateCards(candPanel, payload, {
              onUse: (en) => openReplyAndFill(article, en),
              onClose: () => (candPanel.style.display = 'none')
            });
            candPanel.style.display = 'block';
          } catch (err) {
            renderErrorMessage(candPanel, '生成失败', err);
            candPanel.style.display = 'block';
          } finally {
            genBtn.disabled = false;
            genBtn.textContent = '⚡ 生成';
          }
        };

        genBtn.addEventListener('click', runGen);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            runGen();
          }
        });

        row.appendChild(input);
        row.appendChild(stanceSel);
        row.appendChild(lengthSel);
        row.appendChild(genBtn);
        row.appendChild(continueChip);
        quickReplyBox.appendChild(row);
        quickReplyBox.appendChild(candPanel);
      }
      quickReplyBox.style.display = 'block';
      quickReplyBox.querySelector('.xtr-qr-input')?.focus();
    });

    controls.appendChild(btn);
    controls.appendChild(quickReplyBtn);
    container.appendChild(controls);
    container.appendChild(resultBox);
    container.appendChild(quickReplyBox);

    tweetTextEl.insertAdjacentElement('afterend', container);

    if (!isChineseRegion() && SETTINGS.autoTranslate && tweetObserver) {
      tweetObserver.observe(tweetTextEl);
    }
  }

  const tweetObserver = new IntersectionObserver(
    (entries) => {
      if (!SETTINGS.autoTranslate) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const tweetTextEl = entry.target;
        tweetObserver.unobserve(tweetTextEl);
        if (tweetTextEl.dataset.xtrState === 'done' || tweetTextEl.dataset.xtrState === 'loading') {
          continue;
        }
        const container = tweetTextEl.nextElementSibling;
        if (!container || !container.classList.contains('xtr-tweet-container')) continue;
        const btn = container.querySelector('.xtr-translate-btn');
        const resultBox = container.querySelector('.xtr-result-box');
        if (btn && resultBox) {
          enqueueTranslation(() => performTweetTranslation(tweetTextEl, btn, resultBox));
        }
      }
    },
    { rootMargin: '120px 0px' }
  );

  function observeVisibleTweets() {
    document.querySelectorAll('[data-testid="tweetText"][data-xtr-enhanced="1"]').forEach((el) => {
      if (!el.dataset.xtrState) {
        tweetObserver.observe(el);
      }
    });
  }

  // --- Streamlined Compose / Reply Bar ---

  function dispatchSyntheticPaste(textbox, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      textbox.dispatchEvent(pasteEvent);
      return dt;
    } catch {
      return null;
    }
  }

  function replaceEditorText(textbox, newText) {
    textbox.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textbox);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    // Wait briefly so Draft.js syncs its internal SelectionState to "select all" before pasting
    setTimeout(() => {
      textbox.focus();
      const dt = dispatchSyntheticPaste(textbox, newText);

      // Only if editor is still completely empty, try Draft.js-friendly beforeinput (NEVER use execCommand insertText which corrupts Draft.js link entities & breaks Backspace)
      setTimeout(() => {
        if (!normalizeComparableText(textbox.innerText || '') && dt && typeof InputEvent === 'function') {
          try {
            textbox.dispatchEvent(
              new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertFromPaste',
                data: newText,
                dataTransfer: dt
              })
            );
          } catch {
            // ignore
          }
        }
      }, 90);
    }, 30);
  }

  function appendEditorText(textbox, textToAppend) {
    textbox.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textbox);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    setTimeout(() => {
      textbox.focus();
      dispatchSyntheticPaste(textbox, textToAppend);
    }, 30);
  }

  function enhanceComposeBox(textbox) {
    if (textbox.dataset.xtrComposeEnhanced === '1') return;
    const root =
      textbox.closest('div[data-testid="tweetTextarea_0_label"]')?.parentElement?.parentElement ||
      textbox.closest('div[role="dialog"]') ||
      textbox.closest('div[data-testid="inline_reply_offscreen"]')?.parentElement ||
      textbox.parentElement?.parentElement?.parentElement;

    if (!root) return;

    const toolbar =
      textbox.closest('div[role="dialog"]')?.querySelector('[data-testid="toolBar"]') ||
      textbox.closest('main')?.querySelector('[data-testid="toolBar"]') ||
      root.querySelector('[data-testid="toolBar"]');

    const anchor = toolbar ? toolbar.parentElement : textbox.closest('div[data-testid^="tweetTextarea_"]')?.parentElement;
    if (!anchor || anchor.querySelector('.xtr-compose-bar')) return;

    textbox.dataset.xtrComposeEnhanced = '1';

    const bar = document.createElement('div');
    bar.className = 'xtr-compose-bar';
    bar.addEventListener('click', (e) => e.stopPropagation());

    const leftGroup = document.createElement('div');
    leftGroup.className = 'xtr-compose-left';

    const stanceSelect = buildStanceSelect();
    const lengthSelect = buildLengthSelect();

    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'xtr-compose-btn';
    mainBtn.textContent = '⚡ 生成回复';

    const directBtn = document.createElement('button');
    directBtn.type = 'button';
    directBtn.className = 'xtr-direct-btn';
    directBtn.textContent = '直译';
    directBtn.title = '一键将中文直译替换为地道美语 (快捷键 Alt + T)';

    const { chip: continueChip, sync: syncContinue } = buildContinueChip();

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'xtr-undo-btn';
    undoBtn.textContent = '↩ 恢复';
    undoBtn.style.display = 'none';

    const contextBadge = document.createElement('span');
    contextBadge.className = 'xtr-context-badge';

    const statusSpan = document.createElement('span');
    statusSpan.className = 'xtr-compose-status';

    const candidatesPanel = document.createElement('div');
    candidatesPanel.className = 'xtr-candidates-panel';
    candidatesPanel.style.display = 'none';

    const refreshDynamicUI = () => {
      const { context, images } = extractReplyContextPayload(textbox);
      const currentText = (textbox.innerText || '').trim();
      const hasDraft = Boolean(currentText && hasChinese(currentText));

      if (!mainBtn.disabled) {
        mainBtn.textContent = hasDraft ? (isChineseRegion() ? '✨ 润色3选' : '✨ 生成3选') : '⚡ 生成回复';
      }
      directBtn.style.display = !isChineseRegion() && (hasDraft || originalDrafts.has(textbox)) ? 'inline-flex' : 'none';

      if (images.length > 0) {
        contextBadge.textContent = `🖼️+${images.length}图`;
        contextBadge.title = `已关联主贴图文语境（含 ${images.length} 张图）：\n${(context || '').slice(0, 240)}`;
        contextBadge.style.display = 'inline-flex';
      } else if (context) {
        contextBadge.textContent = '🔗 语境';
        contextBadge.title = `已关联主贴语境：\n${context.slice(0, 260)}`;
        contextBadge.style.display = 'inline-flex';
      } else {
        contextBadge.style.display = 'none';
      }
    };

    refreshDynamicUI();
    textbox.addEventListener('input', refreshDynamicUI);
    textbox.addEventListener('focus', refreshDynamicUI);

    sessionSyncListeners.add(() => {
      stanceSelect.value = SESSION_STATE.lastStance;
      lengthSelect.value = SESSION_STATE.lastLength;
      syncContinue();
    });

    function getSourceChinese() {
      const currentText = (textbox.innerText || '').trim();
      if (!currentText) return '';
      if (!hasChinese(currentText) && originalDrafts.has(textbox)) {
        return originalDrafts.get(textbox);
      }
      originalDrafts.set(textbox, currentText);
      return currentText;
    }

    async function handleDirectTranslate() {
      const sourceChinese = getSourceChinese();
      if (!sourceChinese) {
        statusSpan.textContent = '请先输入中文';
        setTimeout(() => (statusSpan.textContent = ''), 2000);
        return;
      }

      const { context, images } = extractReplyContextPayload(textbox);
      refreshDynamicUI();

      directBtn.disabled = true;
      directBtn.textContent = '译中...';
      statusSpan.textContent = '';

      try {
        const english = await sendMessageAsync({
          type: 'TRANSLATE_COMPOSE',
          text: sourceChinese,
          context,
          images,
          stance: stanceSelect.value,
          length: lengthSelect.value,
          continuation: getActiveContinuation()
        });

        replaceEditorText(textbox, english);
        recordSelectedCandidate({ en: english, zh_back: sourceChinese, style: '直译' });
        undoBtn.style.display = 'inline-flex';
        statusSpan.textContent = '✓ 已替换';
        setTimeout(() => (statusSpan.textContent = ''), 2200);
      } catch (err) {
        statusSpan.textContent = `⚠ ${err.message}`;
      } finally {
        directBtn.disabled = false;
        directBtn.textContent = '直译';
        refreshDynamicUI();
      }
    }

    async function handleSmartGenerate() {
      const currentText = (textbox.innerText || '').trim();
      const hasDraft = Boolean(currentText && hasChinese(currentText));
      const sourceChinese = hasDraft ? getSourceChinese() : '';
      const { context, images } = extractReplyContextPayload(textbox);
      const continuation = getActiveContinuation();

      if (!sourceChinese && !context && images.length === 0 && !continuation) {
        statusSpan.textContent = '请先输入中文想法或打开回复框';
        setTimeout(() => (statusSpan.textContent = ''), 2200);
        return;
      }

      refreshDynamicUI();
      mainBtn.disabled = true;
      mainBtn.textContent = '生成中...';
      statusSpan.textContent = '';

      try {
        const payload = await sendMessageAsync({
          type: sourceChinese ? 'TRANSLATE_COMPOSE_CANDIDATES' : 'GENERATE_AUTO_REPLIES',
          text: sourceChinese,
          idea: sourceChinese,
          context,
          images,
          stance: stanceSelect.value,
          length: lengthSelect.value,
          continuation
        });

        renderCandidateCards(candidatesPanel, payload, {
          onUse: (en) => {
            if (sourceChinese) {
              originalDrafts.set(textbox, sourceChinese);
              undoBtn.style.display = 'inline-flex';
            }
            replaceEditorText(textbox, en);
            statusSpan.textContent = '✓ 已填入';
            setTimeout(() => (statusSpan.textContent = ''), 2000);
          },
          onClose: () => {
            candidatesPanel.style.display = 'none';
          }
        });
        candidatesPanel.style.display = 'block';
      } catch (err) {
        statusSpan.textContent = `⚠ ${err.message}`;
      } finally {
        mainBtn.disabled = false;
        refreshDynamicUI();
      }
    }

    mainBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSmartGenerate();
    });

    directBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDirectTranslate();
    });

    undoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const saved = originalDrafts.get(textbox);
      if (saved) {
        replaceEditorText(textbox, saved);
        undoBtn.style.display = 'none';
      }
    });

    textbox.addEventListener('keydown', (e) => {
      if (!isChineseRegion() && e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        e.stopPropagation();
        handleDirectTranslate();
      }
    });

    const writerToggleBtn = document.createElement('button');
    writerToggleBtn.type = 'button';
    writerToggleBtn.className = 'xtr-writer-toggle-btn';
    writerToggleBtn.textContent = '✍️ 写帖';
    writerToggleBtn.title = '面向英文科技/AI区生成新闻快评、深度长文或方法实战帖';

    const writerPanel = document.createElement('div');
    writerPanel.className = 'xtr-writer-panel';
    writerPanel.style.display = 'none';

    const buildWriterPanel = () => {
      if (writerPanel.dataset.built === '1') return;
      writerPanel.dataset.built = '1';

      const topRow = document.createElement('div');
      topRow.className = 'xtr-writer-top';

      const tabGroup = document.createElement('div');
      tabGroup.className = 'xtr-writer-tabs';

      const radarTabBtn = document.createElement('button');
      radarTabBtn.type = 'button';
      radarTabBtn.className = 'xtr-tab-btn is-active';
      radarTabBtn.textContent = '📡 找热点';

      const manualTabBtn = document.createElement('button');
      manualTabBtn.type = 'button';
      manualTabBtn.className = 'xtr-tab-btn';
      manualTabBtn.textContent = '✍️ 贴素材';

      tabGroup.appendChild(radarTabBtn);
      tabGroup.appendChild(manualTabBtn);

      const closeWriterBtn = document.createElement('button');
      closeWriterBtn.type = 'button';
      closeWriterBtn.className = 'xtr-close-btn';
      closeWriterBtn.textContent = '×';
      closeWriterBtn.addEventListener('click', () => {
        writerPanel.style.display = 'none';
        writerToggleBtn.classList.remove('is-active');
      });

      topRow.appendChild(tabGroup);
      topRow.appendChild(closeWriterBtn);

      const modesWrap = document.createElement('div');
      modesWrap.className = 'xtr-writer-modes';
      const modeBtns = new Map();

      POST_MODES.forEach((m) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'xtr-mode-pill';
        pill.textContent = m.label;
        pill.classList.toggle('is-active', SESSION_STATE.lastPostMode === m.value);
        pill.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          SESSION_STATE.lastPostMode = m.value;
          persistSessionState();
        });
        modeBtns.set(m.value, pill);
        modesWrap.appendChild(pill);
      });

      // --- Tab 1: Radar View ---
      const radarView = document.createElement('div');
      radarView.className = 'xtr-radar-view';

      const radarControls = document.createElement('div');
      radarControls.className = 'xtr-writer-bottom';

      const focusInput = document.createElement('input');
      focusInput.type = 'text';
      focusInput.className = 'xtr-writer-link';
      focusInput.placeholder = '可选筛选方向（如 OpenAI / Agent / Apple，留空抓全网 AI 大事）';

      const fetchRadarBtn = document.createElement('button');
      fetchRadarBtn.type = 'button';
      fetchRadarBtn.className = 'xtr-compose-btn';
      fetchRadarBtn.textContent = '🔄 拉取热点';

      radarControls.appendChild(focusInput);
      radarControls.appendChild(fetchRadarBtn);

      const radarMeta = document.createElement('div');
      radarMeta.className = 'xtr-writer-note';
      radarMeta.style.display = 'none';

      const radarList = document.createElement('div');
      radarList.className = 'xtr-radar-list';

      radarView.appendChild(radarControls);
      radarView.appendChild(radarMeta);
      radarView.appendChild(radarList);

      // --- Tab 2: Manual Source View ---
      const manualView = document.createElement('div');
      manualView.className = 'xtr-manual-view';
      manualView.style.display = 'none';

      const sourceArea = document.createElement('textarea');
      sourceArea.className = 'xtr-writer-textarea';
      sourceArea.placeholder =
        '贴入已核实的事实/大公司动态/AI观察笔记（留空则直接读取上方输入框内容；严禁编造数据与体验）';

      const bottomRow = document.createElement('div');
      bottomRow.className = 'xtr-writer-bottom';

      const linkInput = document.createElement('input');
      linkInput.type = 'text';
      linkInput.className = 'xtr-writer-link';
      linkInput.placeholder = '可选：原文链接（新闻快评自动拆到首评）';

      const genPostBtn = document.createElement('button');
      genPostBtn.type = 'button';
      genPostBtn.className = 'xtr-compose-btn';
      genPostBtn.textContent = '⚡ 生成成稿';

      bottomRow.appendChild(linkInput);
      bottomRow.appendChild(genPostBtn);
      manualView.appendChild(sourceArea);
      manualView.appendChild(bottomRow);

      const resultWrap = document.createElement('div');
      resultWrap.className = 'xtr-writer-result';
      resultWrap.style.display = 'none';

      const switchTab = (tab) => {
        const isRadar = tab === 'radar';
        radarTabBtn.classList.toggle('is-active', isRadar);
        manualTabBtn.classList.toggle('is-active', !isRadar);
        radarView.style.display = isRadar ? 'flex' : 'none';
        manualView.style.display = isRadar ? 'none' : 'flex';
      };

      radarTabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchTab('radar');
      });

      manualTabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchTab('manual');
      });

      sessionSyncListeners.add(() => {
        modeBtns.forEach((pill, val) => {
          pill.classList.toggle('is-active', SESSION_STATE.lastPostMode === val);
        });
      });

      const renderDraftResult = (draft) => {
        resultWrap.innerHTML = '';

        if (draft.zhSummary) {
          const sumDiv = document.createElement('div');
          sumDiv.className = 'xtr-takeaway-box';
          sumDiv.textContent = `🎯 核心判断：${draft.zhSummary}`;
          resultWrap.appendChild(sumDiv);
        }

        const mainBlock = document.createElement('div');
        mainBlock.className = 'xtr-writer-block';

        const mainMeta = document.createElement('div');
        mainMeta.className = 'xtr-candidate-meta';

        const fullText = draft.title ? `${draft.title}\n\n${draft.mainPost}` : draft.mainPost;
        const charCount = fullText.length;

        const mainLabel = document.createElement('span');
        mainLabel.className = 'xtr-candidate-style';
        mainLabel.textContent = draft.title
          ? `主贴 / 长文 (${charCount} 字符) ${draft.title}`
          : `主贴成稿 (${charCount} 字符)`;

        const mainActions = document.createElement('div');
        mainActions.className = 'xtr-candidate-actions';

        const copyMainBtn = document.createElement('button');
        copyMainBtn.type = 'button';
        copyMainBtn.className = 'xtr-mini-btn';
        copyMainBtn.textContent = '复制';
        copyMainBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          recordSelectedCandidate({ en: draft.mainPost, zh_back: draft.zhSummary, style: '成稿' });
          navigator.clipboard?.writeText(fullText).then(() => {
            copyMainBtn.textContent = '已复制';
            setTimeout(() => (copyMainBtn.textContent = '复制'), 1500);
          });
        });

        const fillMainBtn = document.createElement('button');
        fillMainBtn.type = 'button';
        fillMainBtn.className = 'xtr-mini-btn is-primary';
        fillMainBtn.textContent = '填入主贴';
        fillMainBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const prevText = (textbox.innerText || '').trim();
          if (prevText && hasChinese(prevText)) {
            originalDrafts.set(textbox, prevText);
            undoBtn.style.display = 'inline-flex';
          }
          replaceEditorText(textbox, fullText);
          recordSelectedCandidate({ en: draft.mainPost, zh_back: draft.zhSummary, style: '成稿' });
          statusSpan.textContent = '✓ 已填入成稿';
          setTimeout(() => (statusSpan.textContent = ''), 2200);
        });

        mainActions.appendChild(copyMainBtn);
        mainActions.appendChild(fillMainBtn);
        mainMeta.appendChild(mainLabel);
        mainMeta.appendChild(mainActions);

        const mainBody = document.createElement('div');
        mainBody.className = 'xtr-writer-body';
        mainBody.textContent = draft.mainPost;

        mainBlock.appendChild(mainMeta);
        mainBlock.appendChild(mainBody);
        resultWrap.appendChild(mainBlock);

        if (draft.firstReply) {
          const replyBlock = document.createElement('div');
          replyBlock.className = 'xtr-writer-block is-first-reply';

          const replyMeta = document.createElement('div');
          replyMeta.className = 'xtr-candidate-meta';

          const replyLabel = document.createElement('span');
          replyLabel.className = 'xtr-candidate-style';
          replyLabel.textContent = '首评（放链接）';

          const copyReplyBtn = document.createElement('button');
          copyReplyBtn.type = 'button';
          copyReplyBtn.className = 'xtr-mini-btn';
          copyReplyBtn.textContent = '复制首评';
          copyReplyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(draft.firstReply).then(() => {
              copyReplyBtn.textContent = '已复制';
              setTimeout(() => (copyReplyBtn.textContent = '复制首评'), 1500);
            });
          });

          replyMeta.appendChild(replyLabel);
          replyMeta.appendChild(copyReplyBtn);

          const replyBody = document.createElement('div');
          replyBody.className = 'xtr-writer-body';
          replyBody.textContent = draft.firstReply;

          replyBlock.appendChild(replyMeta);
          replyBlock.appendChild(replyBody);
          resultWrap.appendChild(replyBlock);
        }

        if (draft.factCheckNote) {
          const noteDiv = document.createElement('div');
          noteDiv.className = 'xtr-writer-note';
          noteDiv.textContent = `📌 事实核对提示：${draft.factCheckNote}`;
          resultWrap.appendChild(noteDiv);
        }

        const attachImageDataUrlDirect = (dataUrl, mimeType, filename) => {
          const base64 = dataUrl.split(',')[1] || '';
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const file = new File([bytes], filename, { type: mimeType });
          const dt = new DataTransfer();
          dt.items.add(file);

          const scope = textbox.closest('div[role="dialog"]') || root || document;
          const fileInput = scope.querySelector('input[data-testid="fileInput"]');
          if (fileInput) {
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            textbox.focus();
            const pasteEvent = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: dt
            });
            textbox.dispatchEvent(pasteEvent);
          }
        };

        const attachImageToComposer = async (imgUrl, btnEl) => {
          btnEl.disabled = true;
          const prevLabel = btnEl.textContent;
          btnEl.textContent = '附图中...';
          try {
            if (imgUrl.startsWith('data:')) {
              const mimeMatch = imgUrl.match(/^data:([^;]+);base64,/);
              const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
              attachImageDataUrlDirect(imgUrl, mimeType, `x-ai-img-${Date.now()}.png`);
            } else {
              const { dataUrl, mimeType, filename } = await sendMessageAsync({
                type: 'FETCH_MEDIA_DATA_URL',
                url: imgUrl
              });
              attachImageDataUrlDirect(dataUrl, mimeType, filename);
            }
            btnEl.textContent = '✓ 已附';
            setTimeout(() => (btnEl.textContent = prevLabel), 1800);
          } catch (err) {
            statusSpan.textContent = `⚠ ${err.message}`;
            btnEl.textContent = prevLabel;
          } finally {
            btnEl.disabled = false;
          }
        };

        const appendLinkToComposer = (url) => {
          const current = (textbox.innerText || '').trim();
          if (current.includes(url)) {
            statusSpan.textContent = '文末已包含该链接';
            setTimeout(() => (statusSpan.textContent = ''), 1800);
            return;
          }
          if (!current) {
            replaceEditorText(textbox, url);
          } else {
            appendEditorText(textbox, `\n\n${url}`);
          }
          statusSpan.textContent = '✓ 已追加到文末';
          setTimeout(() => (statusSpan.textContent = ''), 1800);
        };

        const hasOptionalMediaGen = Boolean(SETTINGS.imageGenEnabled || SETTINGS.videoGenEnabled);
        const mediaAssetsList = Array.isArray(draft.mediaAssets) ? [...draft.mediaAssets] : [];

        if (mediaAssetsList.length > 0 || hasOptionalMediaGen) {
          const mediaStrip = document.createElement('div');
          mediaStrip.className = 'xtr-media-strip';

          const mediaHeaderRow = document.createElement('div');
          mediaHeaderRow.className = 'xtr-candidate-meta';

          const mediaHeader = document.createElement('span');
          mediaHeader.className = 'xtr-media-header';
          mediaHeader.textContent = '🖼️ 配图 / 视频 / 结尾素材';
          mediaHeaderRow.appendChild(mediaHeader);

          const grid = document.createElement('div');
          grid.className = 'xtr-media-grid';

          const linksBox = document.createElement('div');
          linksBox.style.display = 'flex';
          linksBox.style.flexDirection = 'column';
          linksBox.style.gap = '6px';

          const addImageCard = (asset) => {
            const card = document.createElement('div');
            card.className = 'xtr-media-thumb-card';

            const img = document.createElement('img');
            img.src = asset.url;
            img.alt = asset.label || '配图';
            img.className = 'xtr-media-thumb';
            img.loading = 'lazy';
            img.addEventListener('error', () => {
              card.style.display = 'none';
            });

            const btns = document.createElement('div');
            btns.className = 'xtr-media-card-btns';

            const dlBtn = document.createElement('button');
            dlBtn.type = 'button';
            dlBtn.className = 'xtr-mini-btn';
            dlBtn.textContent = '⬇️ 下载';
            dlBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              dlBtn.disabled = true;
              try {
                if (asset.url.startsWith('data:')) {
                  const a = document.createElement('a');
                  a.href = asset.url;
                  a.download = `x-ai-image-${Date.now()}.png`;
                  a.click();
                } else {
                  await sendMessageAsync({ type: 'DOWNLOAD_MEDIA', url: asset.url, mediaType: 'image' });
                }
                dlBtn.textContent = '✓ 已下';
                setTimeout(() => (dlBtn.textContent = '⬇️ 下载'), 1600);
              } catch (err) {
                statusSpan.textContent = `⚠ ${err.message}`;
              } finally {
                dlBtn.disabled = false;
              }
            });

            const attachBtn = document.createElement('button');
            attachBtn.type = 'button';
            attachBtn.className = 'xtr-mini-btn is-primary';
            attachBtn.textContent = '📎 附到发帖';
            attachBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              attachImageToComposer(asset.url, attachBtn);
            });

            btns.appendChild(dlBtn);
            btns.appendChild(attachBtn);
            card.appendChild(img);
            card.appendChild(btns);
            grid.appendChild(card);
          };

          const addOtherRow = (asset) => {
            const row = document.createElement('div');
            row.className = 'xtr-media-link-row';

            const info = document.createElement('span');
            info.className = 'xtr-media-link-label';
            const icon = asset.type === 'video' ? '🎬' : asset.type === 'x_post' ? '𝕏' : '🔗';
            const shortUrl = asset.url.length > 44 ? asset.url.slice(0, 44) + '…' : asset.url;
            info.textContent = `${icon} ${asset.label || '链接'} ${shortUrl}`;
            info.title = asset.url;

            const acts = document.createElement('div');
            acts.className = 'xtr-candidate-actions';

            if (asset.type === 'video') {
              const dlVidBtn = document.createElement('button');
              dlVidBtn.type = 'button';
              dlVidBtn.className = 'xtr-mini-btn';
              dlVidBtn.textContent = '⬇️ 下载';
              dlVidBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                dlVidBtn.disabled = true;
                try {
                  await sendMessageAsync({ type: 'DOWNLOAD_MEDIA', url: asset.url, mediaType: 'video' });
                  dlVidBtn.textContent = '✓ 已下';
                  setTimeout(() => (dlVidBtn.textContent = '⬇️ 下载'), 1600);
                } catch (err) {
                  statusSpan.textContent = `⚠ ${err.message}`;
                } finally {
                  dlVidBtn.disabled = false;
                }
              });
              acts.appendChild(dlVidBtn);
            }

            const appendBtn = document.createElement('button');
            appendBtn.type = 'button';
            appendBtn.className = 'xtr-mini-btn is-primary';
            appendBtn.textContent = '放文末';
            appendBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              appendLinkToComposer(asset.url);
            });

            const copyUrlBtn = document.createElement('button');
            copyUrlBtn.type = 'button';
            copyUrlBtn.className = 'xtr-mini-btn';
            copyUrlBtn.textContent = '复制';
            copyUrlBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(asset.url).then(() => {
                copyUrlBtn.textContent = '已复制';
                setTimeout(() => (copyUrlBtn.textContent = '复制'), 1400);
              });
            });

            acts.appendChild(appendBtn);
            acts.appendChild(copyUrlBtn);
            row.appendChild(info);
            row.appendChild(acts);
            linksBox.appendChild(row);
          };

          if (hasOptionalMediaGen) {
            const genActions = document.createElement('div');
            genActions.className = 'xtr-candidate-actions';

            if (SETTINGS.imageGenEnabled) {
              const aiImgBtn = document.createElement('button');
              aiImgBtn.type = 'button';
              aiImgBtn.className = 'xtr-mini-btn';
              aiImgBtn.textContent = '🎨 AI 配图';
              aiImgBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                aiImgBtn.disabled = true;
                aiImgBtn.textContent = '生图中...';
                try {
                  const res = await sendMessageAsync({
                    type: 'GENERATE_AI_IMAGE',
                    title: draft.title || '',
                    mainPost: draft.mainPost || ''
                  });
                  const newImg = { type: 'image', url: res.dataUrl || res.url, label: 'AI 配图' };
                  mediaAssetsList.unshift(newImg);
                  addImageCard(newImg);
                  statusSpan.textContent = '✓ AI 配图已生成';
                  setTimeout(() => (statusSpan.textContent = ''), 2200);
                } catch (err) {
                  statusSpan.textContent = `⚠ ${err.message}`;
                } finally {
                  aiImgBtn.disabled = false;
                  aiImgBtn.textContent = '🎨 AI 配图';
                }
              });
              genActions.appendChild(aiImgBtn);
            }

            if (SETTINGS.videoGenEnabled) {
              const aiVidBtn = document.createElement('button');
              aiVidBtn.type = 'button';
              aiVidBtn.className = 'xtr-mini-btn';
              aiVidBtn.textContent = '🎬 AI 配视频';
              aiVidBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                aiVidBtn.disabled = true;
                aiVidBtn.textContent = '生视频中...';
                try {
                  const refImg = mediaAssetsList.find((m) => m.type === 'image' && /^https?:\/\//i.test(m.url));
                  const res = await sendMessageAsync({
                    type: 'GENERATE_AI_VIDEO',
                    title: draft.title || '',
                    mainPost: draft.mainPost || '',
                    imageUrl: refImg?.url || ''
                  });
                  const newVid = { type: 'video', url: res.url, label: 'AI 配视频' };
                  mediaAssetsList.unshift(newVid);
                  addOtherRow(newVid);
                  statusSpan.textContent = '✓ AI 配视频已生成';
                  setTimeout(() => (statusSpan.textContent = ''), 2200);
                } catch (err) {
                  statusSpan.textContent = `⚠ ${err.message}`;
                } finally {
                  aiVidBtn.disabled = false;
                  aiVidBtn.textContent = '🎬 AI 配视频';
                }
              });
              genActions.appendChild(aiVidBtn);
            }

            mediaHeaderRow.appendChild(genActions);
          }

          mediaStrip.appendChild(mediaHeaderRow);

          mediaAssetsList.filter((m) => m.type === 'image').forEach(addImageCard);
          mediaAssetsList.filter((m) => m.type !== 'image').forEach(addOtherRow);

          mediaStrip.appendChild(grid);
          mediaStrip.appendChild(linksBox);
          resultWrap.appendChild(mediaStrip);
        }

        resultWrap.style.display = 'flex';
      };

      const renderRadarTopics = (data) => {
        radarList.innerHTML = '';
        const stats = (data?.sourceStats || [])
          .filter((s) => s.count > 0)
          .map((s) => `${s.source}(${s.count})`)
          .join('  ');
        if (stats) {
          radarMeta.textContent = `已扫描热点源：${stats}`;
          radarMeta.style.display = 'block';
        }

        const modeLabelMap = {
          news_post: '推荐：新闻快评',
          long_article: '推荐：深度长文',
          method_guide: '推荐：方法实战'
        };

        (data?.topics || []).forEach((topic) => {
          const card = document.createElement('div');
          card.className = 'xtr-radar-card';

          const meta = document.createElement('div');
          meta.className = 'xtr-candidate-meta';

          const leftMeta = document.createElement('div');
          leftMeta.className = 'xtr-radar-badges';

          const srcBadge = document.createElement('span');
          srcBadge.className = 'xtr-candidate-style';
          srcBadge.textContent = topic.source;

          const modeBadge = document.createElement('span');
          modeBadge.className = 'xtr-radar-mode-tag';
          modeBadge.textContent = modeLabelMap[topic.recommendedMode] || '推荐：新闻快评';

          leftMeta.appendChild(srcBadge);
          leftMeta.appendChild(modeBadge);
          meta.appendChild(leftMeta);

          if (topic.url && /^https?:\/\//i.test(topic.url)) {
            const extLink = document.createElement('a');
            extLink.href = topic.url;
            extLink.target = '_blank';
            extLink.rel = 'noopener noreferrer';
            extLink.className = 'xtr-radar-ext-link';
            extLink.textContent = '原文 ↗';
            meta.appendChild(extLink);
          }

          const titleEl = document.createElement('div');
          titleEl.className = 'xtr-radar-title';
          titleEl.textContent = topic.titleZh || topic.titleEn;

          const sumEl = document.createElement('div');
          sumEl.className = 'xtr-radar-summary';
          sumEl.textContent = topic.summaryZh;

          const angleEl = document.createElement('div');
          angleEl.className = 'xtr-radar-angle';
          angleEl.textContent = topic.angleZh ? `🔥 切入点：${topic.angleZh}` : '';

          const actionRow = document.createElement('div');
          actionRow.className = 'xtr-writer-bottom';

          const angleInput = document.createElement('input');
          angleInput.type = 'text';
          angleInput.className = 'xtr-writer-link';
          angleInput.placeholder = '可选：补一句你的判断或观点';

          const draftBtn = document.createElement('button');
          draftBtn.type = 'button';
          draftBtn.className = 'xtr-mini-btn is-primary';
          draftBtn.textContent = '⚡ 选这个补满';

          draftBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            draftBtn.disabled = true;
            draftBtn.textContent = '深挖写作中...';
            try {
              const draft = await sendMessageAsync({
                type: 'DRAFT_FROM_TOPIC',
                topic,
                postMode: SESSION_STATE.lastPostMode || topic.recommendedMode,
                userAngle: angleInput.value.trim(),
                continuation: getActiveContinuation()
              });
              renderDraftResult(draft);
            } catch (err) {
              renderErrorMessage(resultWrap, '补满成稿失败', err);
              resultWrap.style.display = 'flex';
            } finally {
              draftBtn.disabled = false;
              draftBtn.textContent = '⚡ 选这个补满';
            }
          });

          actionRow.appendChild(angleInput);
          actionRow.appendChild(draftBtn);

          card.appendChild(meta);
          card.appendChild(titleEl);
          if (topic.summaryZh) card.appendChild(sumEl);
          if (topic.angleZh) card.appendChild(angleEl);
          card.appendChild(actionRow);
          radarList.appendChild(card);
        });
      };

      const runRadarFetch = async (force = false) => {
        fetchRadarBtn.disabled = true;
        fetchRadarBtn.textContent = '扫描热点中...';
        try {
          const data = await sendMessageAsync({
            type: 'FETCH_RADAR_TOPICS',
            focus: focusInput.value.trim(),
            force
          });
          renderRadarTopics(data);
        } catch (err) {
          renderErrorMessage(radarList, '热点拉取失败', err);
        } finally {
          fetchRadarBtn.disabled = false;
          fetchRadarBtn.textContent = '🔄 刷新热点';
        }
      };

      fetchRadarBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        runRadarFetch(true);
      });

      focusInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          runRadarFetch(true);
        }
      });

      genPostBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rawSource = sourceArea.value.trim() || (textbox.innerText || '').trim();
        const { context, images } = extractReplyContextPayload(textbox);
        if (!rawSource && !context && images.length === 0) {
          renderErrorMessage(resultWrap, '提示', new Error('请先输入核实过的素材、新闻要点或笔记'));
          resultWrap.style.display = 'flex';
          return;
        }

        genPostBtn.disabled = true;
        genPostBtn.textContent = '写作中...';
        try {
          const draft = await sendMessageAsync({
            type: 'GENERATE_POST_DRAFT',
            source: rawSource,
            postMode: SESSION_STATE.lastPostMode,
            sourceLink: linkInput.value.trim(),
            context,
            images,
            continuation: getActiveContinuation()
          });
          renderDraftResult(draft);
        } catch (err) {
          renderErrorMessage(resultWrap, '生成失败', err);
          resultWrap.style.display = 'flex';
        } finally {
          genPostBtn.disabled = false;
          genPostBtn.textContent = '⚡ 生成成稿';
        }
      });

      writerPanel.appendChild(topRow);
      writerPanel.appendChild(modesWrap);
      writerPanel.appendChild(radarView);
      writerPanel.appendChild(manualView);
      writerPanel.appendChild(resultWrap);
    };

    writerToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      buildWriterPanel();
      const showing = writerPanel.style.display !== 'none';
      writerPanel.style.display = showing ? 'none' : 'flex';
      writerToggleBtn.classList.toggle('is-active', !showing);
      if (!showing) {
        writerPanel.querySelector('.xtr-writer-textarea')?.focus();
      }
    });

    leftGroup.appendChild(stanceSelect);
    leftGroup.appendChild(lengthSelect);
    leftGroup.appendChild(mainBtn);
    leftGroup.appendChild(directBtn);
    leftGroup.appendChild(writerToggleBtn);
    leftGroup.appendChild(continueChip);
    leftGroup.appendChild(undoBtn);
    leftGroup.appendChild(contextBadge);
    leftGroup.appendChild(statusSpan);

    bar.appendChild(leftGroup);
    bar.appendChild(candidatesPanel);
    bar.appendChild(writerPanel);

    if (toolbar && toolbar.parentElement) {
      toolbar.parentElement.insertBefore(bar, toolbar);
    } else {
      anchor.appendChild(bar);
    }
  }

  // --- Floating Auto-Translate Pill ---

  let floatingPill = null;

  function clampPillPosition(left, top, el) {
    const w = el.offsetWidth || 120;
    const h = el.offsetHeight || 34;
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    return {
      left: Math.min(Math.max(8, left), maxL),
      top: Math.min(Math.max(8, top), maxT)
    };
  }

  function applyPillPosition(left, top) {
    if (!floatingPill) return;
    const clamped = clampPillPosition(left, top, floatingPill);
    floatingPill.style.left = `${clamped.left}px`;
    floatingPill.style.top = `${clamped.top}px`;
    floatingPill.style.right = 'auto';
    floatingPill.style.bottom = 'auto';
  }

  function ensureFloatingPill() {
    if (floatingPill) return floatingPill;
    floatingPill = document.createElement('button');
    floatingPill.type = 'button';
    floatingPill.className = 'xtr-floating-pill';
    floatingPill.title = '点击切换自动翻译，按住可拖拽移动位置';

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    floatingPill.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = floatingPill.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      floatingPill.classList.add('is-dragging');
      floatingPill.setPointerCapture?.(e.pointerId);
    });

    floatingPill.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 4) {
        moved = true;
      }
      if (moved) {
        applyPillPosition(origLeft + dx, origTop + dy);
      }
    });

    const finishDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      floatingPill.classList.remove('is-dragging');
      if (floatingPill.hasPointerCapture?.(e.pointerId)) {
        floatingPill.releasePointerCapture(e.pointerId);
      }
      if (moved) {
        const rect = floatingPill.getBoundingClientRect();
        chrome.storage.local.set({ [PILL_POS_KEY]: { left: rect.left, top: rect.top } });
      }
    };

    floatingPill.addEventListener('pointerup', finishDrag);
    floatingPill.addEventListener('pointercancel', finishDrag);

    floatingPill.addEventListener('click', (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
        return;
      }
      const next = !SETTINGS.autoTranslate;
      SETTINGS.autoTranslate = next;
      chrome.storage.sync.set({ autoTranslate: next });
      updateFloatingPill();
      if (next) {
        observeVisibleTweets();
      }
    });

    document.body.appendChild(floatingPill);
    updateFloatingPill();

    chrome.storage.local.get(PILL_POS_KEY, (res) => {
      const pos = res?.[PILL_POS_KEY];
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        applyPillPosition(pos.left, pos.top);
      }
    });

    window.addEventListener('resize', () => {
      if (!floatingPill || !floatingPill.style.left) return;
      const rect = floatingPill.getBoundingClientRect();
      applyPillPosition(rect.left, rect.top);
    });

    return floatingPill;
  }

  function updateFloatingPill() {
    if (!floatingPill) return;
    if (isChineseRegion()) {
      floatingPill.style.display = 'none';
      return;
    }
    floatingPill.style.display = '';
    if (SETTINGS.autoTranslate) {
      floatingPill.textContent = '🌐 自动译: 开';
      floatingPill.classList.add('is-active');
    } else {
      floatingPill.textContent = '🌐 自动译: 关';
      floatingPill.classList.remove('is-active');
    }
  }

  // --- DOM Scanner & MutationObserver ---

  function scanPage() {
    ensureFloatingPill();

    document.querySelectorAll('[data-testid="tweetText"]:not([data-xtr-enhanced])').forEach((el) => {
      enhanceTweetText(el);
    });

    document.querySelectorAll('[data-testid="tweetText"][data-xtr-enhanced="1"]').forEach((el) => {
      if (el.dataset.xtrState === 'loading') return;
      const currentRaw = extractTextWithEmojis(el);
      if (currentRaw && el.dataset.xtrRawText && currentRaw !== el.dataset.xtrRawText) {
        el.dataset.xtrRawText = currentRaw;
        el.dataset.xtrState = '';
        const container = el.nextElementSibling;
        const btn = container?.querySelector('.xtr-translate-btn');
        const resultBox = container?.querySelector('.xtr-result-box');
        if (btn) btn.textContent = '重译';
        if (SETTINGS.autoTranslate && btn && resultBox) {
          enqueueTranslation(() => performTweetTranslation(el, btn, resultBox, true));
        }
      }
    });

    document
      .querySelectorAll('div[data-testid^="tweetTextarea_"][contenteditable="true"]:not([data-xtr-compose-enhanced])')
      .forEach((el) => {
        enhanceComposeBox(el);
      });
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanPage();
    });
  }

  const domObserver = new MutationObserver(() => {
    scheduleScan();
  });

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanPage);
  } else {
    scanPage();
  }
})();
