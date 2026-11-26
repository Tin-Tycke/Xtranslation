// Content script for X (x.com / twitter.com)

(() => {
  if (window.__xTranslatorLoaded) return;
  window.__xTranslatorLoaded = true;

  const SETTINGS = {
    autoTranslate: false,
    showSlangNotes: true,
    defaultTone: 'casual'
  };

  // Track original Chinese drafts per editor element for easy undo
  const originalDrafts = new WeakMap();

  // Concurrency-limited queue for auto-translation
  const translateQueue = [];
  let activeRequests = 0;
  const MAX_CONCURRENT = 2;

  // Load initial settings
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
    if (res?.ok && res.data) {
      Object.assign(SETTINGS, res.data);
      updateFloatingPill();
      if (SETTINGS.autoTranslate) {
        observeVisibleTweets();
      }
    }
  });

  // Listen for settings changes from popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.autoTranslate) {
      SETTINGS.autoTranslate = Boolean(changes.autoTranslate.newValue);
      updateFloatingPill();
      if (SETTINGS.autoTranslate) {
        observeVisibleTweets();
      }
    }
    if (changes.showSlangNotes) {
      SETTINGS.showSlangNotes = Boolean(changes.showSlangNotes.newValue);
    }
    if (changes.defaultTone) {
      SETTINGS.defaultTone = changes.defaultTone.newValue || 'casual';
    }
  });

  // --- Utilities ---

  function extractTextWithEmojis(el) {
    if (!el) return '';
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
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

  function isMostlyChinese(text) {
    if (!text) return true;
    const stripped = text.replace(/https?:\/\/\S+|@\w+|#\w+|\s+/g, '');
    if (!stripped) return true;
    const cjkMatches = stripped.match(/[\u4e00-\u9fff]/g) || [];
    return cjkMatches.length / stripped.length > 0.4;
  }

  function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(text);
  }

  function getTweetAuthor(article) {
    if (!article) return '';
    const userLinks = article.querySelectorAll('div[data-testid="User-Name"] a[href^="/"]');
    for (const a of userLinks) {
      const href = a.getAttribute('href') || '';
      if (/^\/[A-Za-z0-9_]+$/.test(href)) {
        return '@' + href.slice(1);
      }
    }
    return '';
  }

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

  // --- Tweet Translation (EN -> ZH) ---

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

  function extractTweetContext(tweetTextEl, article) {
    const parts = [];
    const seen = new Set([extractTextWithEmojis(tweetTextEl)]);

    // 1. Quoted tweet inside the same article
    if (article) {
      article.querySelectorAll('[data-testid="tweetText"]').forEach((otherEl) => {
        if (otherEl === tweetTextEl) return;
        const txt = extractTextWithEmojis(otherEl);
        if (txt && !seen.has(txt)) {
          seen.add(txt);
          parts.push(`[引用的推文]: ${txt}`);
        }
      });
    }

    // 2. Preceding tweet on a /status/ thread page
    if (article && window.location.pathname.includes('/status/')) {
      const allTweets = Array.from(document.querySelectorAll('main article[data-testid="tweet"]'));
      const idx = allTweets.indexOf(article);
      if (idx > 0) {
        const prevArticle = allTweets[idx - 1];
        const prevTextEl = prevArticle.querySelector('[data-testid="tweetText"]');
        if (prevTextEl) {
          const prevTxt = extractTextWithEmojis(prevTextEl);
          if (prevTxt && !seen.has(prevTxt)) {
            seen.add(prevTxt);
            const prevAuthor = getTweetAuthor(prevArticle);
            parts.unshift(prevAuthor ? `[上级推文 ${prevAuthor}]: ${prevTxt}` : `[上级推文]: ${prevTxt}`);
          }
        }
      }
    }

    return parts.join('\n');
  }

  async function performTweetTranslation(tweetTextEl, btn, resultBox, force = false) {
    if (tweetTextEl.dataset.xtrState === 'loading') return;
    if (!force && tweetTextEl.dataset.xtrState === 'done') {
      // Toggle visibility
      const isHidden = resultBox.style.display === 'none';
      resultBox.style.display = isHidden ? 'block' : 'none';
      btn.textContent = isHidden ? '收起译文' : '查看译文';
      return;
    }

    const rawText = extractTextWithEmojis(tweetTextEl);
    if (!rawText) return;

    const article = tweetTextEl.closest('article[data-testid="tweet"]');
    const author = getTweetAuthor(article);
    const context = extractTweetContext(tweetTextEl, article);

    tweetTextEl.dataset.xtrState = 'loading';
    tweetTextEl.dataset.xtrRawText = rawText;
    btn.disabled = true;
    btn.textContent = '翻译中...';
    resultBox.style.display = 'none';

    try {
      const data = await sendMessageAsync({
        type: 'TRANSLATE_TWEET',
        text: rawText,
        author,
        context,
        force
      });

      resultBox.innerHTML = '';

      const transP = document.createElement('div');
      transP.className = 'xtr-trans-text';
      transP.textContent = data.translation;
      resultBox.appendChild(transP);

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
      btn.textContent = '收起译文';
      const reBtn = tweetTextEl.nextElementSibling?.querySelector('.xtr-retranslate-btn');
      if (reBtn) reBtn.style.display = 'inline-flex';
    } catch (err) {
      tweetTextEl.dataset.xtrState = 'error';
      resultBox.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'xtr-error-text';
      errDiv.textContent = `翻译失败: ${err.message}`;
      resultBox.appendChild(errDiv);
      resultBox.style.display = 'block';
      btn.textContent = '重试翻译';
    } finally {
      btn.disabled = false;
    }
  }

  function buildToneSelect(defaultValue) {
    const select = document.createElement('select');
    select.className = 'xtr-tone-select';
    select.title = '选择英文语气';
    [
      { value: 'casual', label: '日常美语' },
      { value: 'witty', label: '幽默玩梗' },
      { value: 'friendly', label: '友好热情' },
      { value: 'professional', label: '专业得体' }
    ].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.value;
      opt.textContent = t.label;
      if (t.value === defaultValue) opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }

  function renderCandidateCards(panel, candidates, { onUse, onClose }) {
    panel.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'xtr-candidates-header';
    const title = document.createElement('span');
    title.textContent = '选择地道美语表达：';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'xtr-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', onClose);
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

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

      card.addEventListener('click', () => onUse(c.en));
      panel.appendChild(card);
    });
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
    if (!rawText || isMostlyChinese(rawText)) {
      tweetTextEl.dataset.xtrEnhanced = 'skip';
      return;
    }

    tweetTextEl.dataset.xtrEnhanced = '1';
    tweetTextEl.dataset.xtrRawText = rawText;

    const container = document.createElement('div');
    container.className = 'xtr-tweet-container';
    // Prevent clicking the translation UI from opening the tweet detail page
    container.addEventListener('click', (e) => e.stopPropagation());

    const controls = document.createElement('div');
    controls.className = 'xtr-tweet-controls';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xtr-translate-btn';
    btn.textContent = '译为中文';

    const reBtn = document.createElement('button');
    reBtn.type = 'button';
    reBtn.className = 'xtr-retranslate-btn';
    reBtn.textContent = '↻';
    reBtn.title = '重新翻译';
    reBtn.style.display = 'none';

    const quickReplyBtn = document.createElement('button');
    quickReplyBtn.type = 'button';
    quickReplyBtn.className = 'xtr-quick-reply-btn';
    quickReplyBtn.textContent = '💬 帮我回';

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

    reBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      performTweetTranslation(tweetTextEl, btn, resultBox, true);
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
        input.placeholder = '可选：输入回复想法（留空则直接根据推文自动生成3条）';

        const toneSel = buildToneSelect(SETTINGS.defaultTone);
        const genBtn = document.createElement('button');
        genBtn.type = 'button';
        genBtn.className = 'xtr-compose-btn';
        genBtn.textContent = '⚡ 生成3条回复';

        const candPanel = document.createElement('div');
        candPanel.className = 'xtr-candidates-panel';
        candPanel.style.display = 'none';

        const runGen = async () => {
          const idea = input.value.trim();
          const article = tweetTextEl.closest('article[data-testid="tweet"]');
          const author = getTweetAuthor(article);
          const tweetContent = extractTextWithEmojis(tweetTextEl);
          const extraCtx = extractTweetContext(tweetTextEl, article);
          const mainLine = author ? `${author}: ${tweetContent}` : tweetContent;
          const context = extraCtx ? `${extraCtx}\n---\n[要回复的推文]: ${mainLine}` : mainLine;

          genBtn.disabled = true;
          genBtn.textContent = '生成中...';
          try {
            const candidates = await sendMessageAsync(
              idea
                ? {
                    type: 'TRANSLATE_COMPOSE_CANDIDATES',
                    text: idea,
                    context,
                    tone: toneSel.value
                  }
                : {
                    type: 'GENERATE_AUTO_REPLIES',
                    context,
                    tone: toneSel.value
                  }
            );
            renderCandidateCards(candPanel, candidates, {
              onUse: (en) => openReplyAndFill(article, en),
              onClose: () => (candPanel.style.display = 'none')
            });
            candPanel.style.display = 'block';
          } catch (err) {
            candPanel.innerHTML = `<div class="xtr-error-text">生成失败: ${err.message}</div>`;
            candPanel.style.display = 'block';
          } finally {
            genBtn.disabled = false;
            genBtn.textContent = '⚡ 生成3条回复';
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
        row.appendChild(toneSel);
        row.appendChild(genBtn);
        quickReplyBox.appendChild(row);
        quickReplyBox.appendChild(candPanel);
      }
      quickReplyBox.style.display = 'block';
      quickReplyBox.querySelector('.xtr-qr-input')?.focus();
    });

    controls.appendChild(btn);
    controls.appendChild(reBtn);
    controls.appendChild(quickReplyBtn);
    container.appendChild(controls);
    container.appendChild(resultBox);
    container.appendChild(quickReplyBox);

    tweetTextEl.insertAdjacentElement('afterend', container);

    if (SETTINGS.autoTranslate && tweetObserver) {
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

  // --- Compose / Reply Translation (ZH -> Authentic American English) ---

  function extractReplyContext(textbox) {
    const seen = new Set();
    const snippets = [];
    const pushSnippet = (author, txt) => {
      const clean = (txt || '').trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      snippets.push(author ? `${author}: ${clean}` : clean);
    };

    // 1. Inside a Reply or Quote Tweet Modal (div[role="dialog"])
    const dialog = textbox.closest('div[role="dialog"]');
    if (dialog) {
      dialog.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl) {
          pushSnippet(getTweetAuthor(article), extractTextWithEmojis(textEl));
        }
      });

      // Quote tweet card inside compose dialog (often rendered as div[role="link"] or nested card without article)
      dialog.querySelectorAll('[data-testid="tweetText"]').forEach((textEl) => {
        if (textbox.contains(textEl)) return;
        const card = textEl.closest('div[role="link"]') || textEl.closest('article');
        const authorEl = card?.querySelector('div[dir="ltr"] span');
        const author = authorEl && authorEl.textContent?.startsWith('@') ? authorEl.textContent.trim() : '';
        pushSnippet(author, extractTextWithEmojis(textEl));
      });

      if (snippets.length > 0) {
        return snippets.slice(-2).join('\n---\n');
      }
    }

    // 2. Inline reply on a tweet detail page (/status/...)
    if (window.location.pathname.includes('/status/')) {
      const allTweets = Array.from(document.querySelectorAll('main article[data-testid="tweet"]'));
      for (const article of allTweets) {
        if (article.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING) {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          if (textEl) {
            pushSnippet(getTweetAuthor(article), extractTextWithEmojis(textEl));
          }
        }
      }
      if (snippets.length > 0) {
        return snippets.slice(-2).join('\n---\n');
      }
    }

    // 3. Inline quote-tweet in home/profile compose area
    const composeContainer = textbox.closest('div[data-testid="primaryColumn"]') || textbox.parentElement?.parentElement?.parentElement;
    if (composeContainer) {
      const quoted = composeContainer.querySelector('div[role="link"] [data-testid="tweetText"]');
      if (quoted && !textbox.contains(quoted)) {
        pushSnippet('', extractTextWithEmojis(quoted));
      }
    }

    return snippets.slice(-2).join('\n---\n');
  }

  function replaceEditorText(textbox, newText) {
    textbox.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textbox);
    selection.removeAllRanges();
    selection.addRange(range);

    // Primary method: synthetic paste event (works reliably with Draft.js / Lexical on X)
    let pasted = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', newText);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      textbox.dispatchEvent(pasteEvent);
      pasted = true;
    } catch {
      pasted = false;
    }

    // Verify if text actually changed; if not, fallback to execCommand
    setTimeout(() => {
      const current = (textbox.innerText || '').trim();
      if (!pasted || current !== newText.trim()) {
        textbox.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, newText);
      }
    }, 30);
  }

  function enhanceComposeBox(textbox) {
    if (textbox.dataset.xtrComposeEnhanced === '1') return;
    // Find the outer compose wrapper that holds the toolbar
    const root =
      textbox.closest('div[data-testid="tweetTextarea_0_label"]')?.parentElement?.parentElement ||
      textbox.closest('div[role="dialog"]') ||
      textbox.closest('div[data-testid="inline_reply_offscreen"]')?.parentElement ||
      textbox.parentElement?.parentElement?.parentElement;

    if (!root) return;

    // Avoid duplicating bars for the same compose area
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

    const toneSelect = buildToneSelect(SETTINGS.defaultTone);

    const translateBtn = document.createElement('button');
    translateBtn.type = 'button';
    translateBtn.className = 'xtr-compose-btn';
    translateBtn.textContent = '✨ 译为地道美语';

    const candidatesBtn = document.createElement('button');
    candidatesBtn.type = 'button';
    candidatesBtn.className = 'xtr-candidates-btn';
    candidatesBtn.textContent = '🎯 3个候选';

    const autoReplyBtn = document.createElement('button');
    autoReplyBtn.type = 'button';
    autoReplyBtn.className = 'xtr-candidates-btn';
    autoReplyBtn.textContent = '💡 帮我想回复';

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'xtr-undo-btn';
    undoBtn.textContent = '↩ 恢复中文';
    undoBtn.style.display = 'none';

    const contextBadge = document.createElement('span');
    contextBadge.className = 'xtr-context-badge';

    const refreshContextBadge = () => {
      const ctx = extractReplyContext(textbox);
      if (ctx) {
        contextBadge.textContent = '🔗 已关联英文语境';
        contextBadge.title = `将结合以下英文语境进行翻译：\n${ctx.slice(0, 300)}`;
        contextBadge.style.display = 'inline-flex';
        autoReplyBtn.style.display = 'inline-flex';
      } else {
        contextBadge.style.display = 'none';
        autoReplyBtn.style.display = 'none';
      }
    };
    refreshContextBadge();

    const statusSpan = document.createElement('span');
    statusSpan.className = 'xtr-compose-status';

    const candidatesPanel = document.createElement('div');
    candidatesPanel.className = 'xtr-candidates-panel';
    candidatesPanel.style.display = 'none';

    function getSourceChinese() {
      const currentText = (textbox.innerText || '').trim();
      if (!currentText) return '';
      if (!hasChinese(currentText) && originalDrafts.has(textbox)) {
        return originalDrafts.get(textbox);
      }
      originalDrafts.set(textbox, currentText);
      return currentText;
    }

    async function handleComposeTranslate() {
      const sourceChinese = getSourceChinese();
      if (!sourceChinese) {
        statusSpan.textContent = '请先输入中文内容';
        setTimeout(() => (statusSpan.textContent = ''), 2000);
        return;
      }

      const context = extractReplyContext(textbox);
      refreshContextBadge();

      translateBtn.disabled = true;
      translateBtn.textContent = '润色翻译中...';
      statusSpan.textContent = '';

      try {
        const english = await sendMessageAsync({
          type: 'TRANSLATE_COMPOSE',
          text: sourceChinese,
          context,
          tone: toneSelect.value
        });

        replaceEditorText(textbox, english);
        undoBtn.style.display = 'inline-flex';
        statusSpan.textContent = '✓ 已替换';
        setTimeout(() => (statusSpan.textContent = ''), 2500);
      } catch (err) {
        statusSpan.textContent = `⚠ ${err.message}`;
      } finally {
        translateBtn.disabled = false;
        translateBtn.textContent = '✨ 译为地道美语';
      }
    }

    async function handleAutoReplyIdeas() {
      const context = extractReplyContext(textbox);
      refreshContextBadge();
      if (!context) {
        statusSpan.textContent = '当前不是回复/引用场景，请先输入中文想法';
        setTimeout(() => (statusSpan.textContent = ''), 2500);
        return;
      }

      const currentIdea = (textbox.innerText || '').trim();
      autoReplyBtn.disabled = true;
      autoReplyBtn.textContent = '构思回复中...';
      statusSpan.textContent = '';

      try {
        const candidates = await sendMessageAsync({
          type: 'GENERATE_AUTO_REPLIES',
          context,
          tone: toneSelect.value,
          idea: hasChinese(currentIdea) ? currentIdea : ''
        });
        renderCandidateCards(candidatesPanel, candidates, {
          onUse: (en) => {
            if (currentIdea && hasChinese(currentIdea)) {
              originalDrafts.set(textbox, currentIdea);
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
        autoReplyBtn.disabled = false;
        autoReplyBtn.textContent = '💡 帮我想回复';
      }
    }

    async function handleComposeCandidates() {
      const sourceChinese = getSourceChinese();
      const context = extractReplyContext(textbox);
      if (!sourceChinese) {
        if (context) {
          return handleAutoReplyIdeas();
        }
        statusSpan.textContent = '请先输入中文内容';
        setTimeout(() => (statusSpan.textContent = ''), 2000);
        return;
      }

      refreshContextBadge();

      candidatesBtn.disabled = true;
      candidatesBtn.textContent = '生成候选中...';
      statusSpan.textContent = '';

      try {
        const candidates = await sendMessageAsync({
          type: 'TRANSLATE_COMPOSE_CANDIDATES',
          text: sourceChinese,
          context,
          tone: toneSelect.value
        });
        renderCandidateCards(candidatesPanel, candidates, {
          onUse: (en) => {
            replaceEditorText(textbox, en);
            undoBtn.style.display = 'inline-flex';
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
        candidatesBtn.disabled = false;
        candidatesBtn.textContent = '🎯 3个候选';
      }
    }

    translateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleComposeTranslate();
    });

    candidatesBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleComposeCandidates();
    });

    autoReplyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleAutoReplyIdeas();
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

    // Shortcut: Alt + T inside the textbox
    textbox.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        e.stopPropagation();
        handleComposeTranslate();
      }
    });

    leftGroup.appendChild(toneSelect);
    leftGroup.appendChild(translateBtn);
    leftGroup.appendChild(candidatesBtn);
    leftGroup.appendChild(autoReplyBtn);
    leftGroup.appendChild(undoBtn);
    leftGroup.appendChild(contextBadge);
    leftGroup.appendChild(statusSpan);

    bar.appendChild(leftGroup);
    bar.appendChild(candidatesPanel);

    if (toolbar && toolbar.parentElement) {
      toolbar.parentElement.insertBefore(bar, toolbar);
    } else {
      anchor.appendChild(bar);
    }
  }

  // --- Floating Auto-Translate Pill (Draggable & Position-Persisted) ---

  let floatingPill = null;
  const PILL_POS_KEY = 'xtr_pill_pos_v1';

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

    // Restore saved position if available
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
    if (SETTINGS.autoTranslate) {
      floatingPill.textContent = '🌐 自动翻译: 开';
      floatingPill.classList.add('is-active');
    } else {
      floatingPill.textContent = '🌐 自动翻译: 关';
      floatingPill.classList.remove('is-active');
    }
  }

  // --- DOM Scanner & MutationObserver ---

  function scanPage() {
    ensureFloatingPill();

    // Scan new tweets
    document.querySelectorAll('[data-testid="tweetText"]:not([data-xtr-enhanced])').forEach((el) => {
      enhanceTweetText(el);
    });

    // Detect "Show more" / expanded tweets whose text changed after initial enhancement
    document.querySelectorAll('[data-testid="tweetText"][data-xtr-enhanced="1"]').forEach((el) => {
      if (el.dataset.xtrState === 'loading') return;
      const currentRaw = extractTextWithEmojis(el);
      if (currentRaw && el.dataset.xtrRawText && currentRaw !== el.dataset.xtrRawText) {
        el.dataset.xtrRawText = currentRaw;
        el.dataset.xtrState = '';
        const container = el.nextElementSibling;
        const btn = container?.querySelector('.xtr-translate-btn');
        const resultBox = container?.querySelector('.xtr-result-box');
        if (btn) btn.textContent = '原文已展开 · 重新翻译';
        if (SETTINGS.autoTranslate && btn && resultBox) {
          enqueueTranslation(() => performTweetTranslation(el, btn, resultBox, true));
        }
      }
    });

    // Scan compose/reply textboxes
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

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanPage);
  } else {
    scanPage();
  }
})();
