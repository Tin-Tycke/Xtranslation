// Shared pure core logic for X 地道双语助手 (used by background.js, content.js, and tests)

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XTR_CORE = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_SETTINGS = {
    provider: 'deepseek',
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    grokApiKey: '',
    grokModel: 'grok-3-mini',
    autoTranslate: false,
    showSlangNotes: true,
    defaultTone: 'mix',
    defaultLength: 'auto',
    glossary: ''
  };

  const STANCE_OPTIONS = [
    { value: 'mix', label: '智能混搭' },
    { value: 'contrarian', label: '挑刺引战' },
    { value: 'alternative', label: '另类视角' },
    { value: 'witty', label: '幽默玩梗' },
    { value: 'insight', label: '深度补充' },
    { value: 'casual', label: '日常友好' }
  ];

  const LENGTH_OPTIONS = [
    { value: 'auto', label: '长短适中' },
    { value: 'short', label: '短评' },
    { value: 'medium', label: '中长评' }
  ];

  // Keep backwards compatibility with old tone values ('friendly', 'professional')
  const STANCE_INSTRUCTIONS = {
    mix: 'Give 3 genuinely different angles: Option 1 ("挑刺/引战") challenges the OP\'s premise, points out a blind spot, or drops a spicy contrarian take that sparks replies (sharp, not toxic); Option 2 ("另类视角") reframes the topic from an unexpected angle or real-world second-order effect; Option 3 ("真实接梗") reacts naturally like a human on X with wit or grounded relatability.',
    contrarian: 'All 3 options should push back, play devil\'s advocate, or expose a blind spot/irony in the OP\'s claim to spark genuine debate on X. Vary the heat: (1) sharp one-liner pushback, (2) reasoned counter-argument exposing the flaw, (3) dry sarcastic flip of the OP\'s logic. Be incisive and human, never abusive or robotic.',
    alternative: 'All 3 options should offer a fresh alternative perspective, counter-example, or second-order consequence the OP missed. Avoid agreeing blindly. Vary from (1) crisp reframe, (2) concrete real-world nuance, (3) thought-provoking question that shifts the frame.',
    witty: 'All 3 options should use dry American humor, Twitter-native wit, or playful roasting that fits the exact post/image without feeling forced or try-hard.',
    insight: 'All 3 options should add grounded, specific insight, practical experience, or a sharp follow-up question that makes readers stop and think. Avoid textbook lecturing.',
    casual: 'All 3 options should sound like a relaxed, friendly native American X user chiming in naturally—warm, conversational, and authentic.',
    friendly: 'Warm, genuine, approachable American X tone—friendly without sounding sycophantic.',
    professional: 'Clear, sharp, grounded American English suitable for industry or tech discussions on X, zero corporate buzzwords.'
  };

  const LENGTH_INSTRUCTIONS = {
    auto: 'Mix lengths naturally: at least one option should be punchy and short (1 sentence), and at least one option should be substantive and slightly longer (2–4 sentences, ~140–270 chars) when unpacking an argument or alternative take.',
    short: 'Keep every option punchy and short: 1–2 brief sentences max (roughly under 140 characters).',
    medium: 'Write substantive, conversational medium-length replies: 2–4 sentences (roughly 150–275 characters) with room for a concrete reason, analogy, or pushback—still natural X style, never an essay.'
  };

  const ANTI_AI_STYLE_RULES = `Anti-AI Authenticity Rules (CRITICAL):
- Sound like a real American human scrolling X, NOT an AI assistant or LinkedIn influencer.
- NEVER use AI cliché openers or filler: "Great point!", "This is so true!", "Spot on!", "While I agree...", "It's worth noting...", "Here's the thing:", "Unpopular opinion:", "Hot take:", "Let's be real:", "To be fair, both sides...".
- NEVER use overused AI vocabulary or symmetrical templates: "delve", "nuanced", "tapestry", "double-edged sword", "game-changer", "testament", "underscore", "It's not about X, it's about Y", "Not only X, but also Y".
- Avoid em-dash (—) spam, bullet lists, and unnecessary #hashtags.
- Natural X phrasing is encouraged: contractions (don't, kinda, tbh, ngl, idk), occasional casual sentence fragments, concrete specifics tied directly to what's in the post or image, and real human friction/opinion.`;

  function normalizeStance(stance) {
    if (!stance) return 'mix';
    if (STANCE_INSTRUCTIONS[stance]) return stance;
    return 'mix';
  }

  function normalizeLength(length) {
    if (!length) return 'auto';
    if (LENGTH_INSTRUCTIONS[length]) return length;
    return 'auto';
  }

  function buildApiUrl(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
      throw new Error('请填写 API Base URL');
    }
    if (trimmed.endsWith('/chat/completions')) {
      return trimmed;
    }
    if (
      trimmed === 'https://generativelanguage.googleapis.com' ||
      trimmed === 'https://generativelanguage.googleapis.com/v1beta'
    ) {
      return 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    }
    try {
      const parsed = new URL(trimmed);
      if (!parsed.pathname || parsed.pathname === '/') {
        return `${trimmed}/v1/chat/completions`;
      }
    } catch {
      // ignore URL parse error and fall through
    }
    return `${trimmed}/chat/completions`;
  }

  function parseJsonSafely(rawText) {
    const cleaned = String(rawText || '')
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

  function formatImageMetaHint(images) {
    if (!Array.isArray(images) || images.length === 0) return '';
    const lines = images.slice(0, 4).map((img, i) => {
      const alt = (img?.alt || '').trim();
      return alt ? `- 图片 ${i + 1} 描述(Alt): ${alt}` : `- 图片 ${i + 1}: (已附原图，请结合画面文字/表情包/图表内容分析)`;
    });
    return `\n\n[主贴附图信息]:\n${lines.join('\n')}`;
  }

  function buildMultimodalUserContent(textPrompt, images = []) {
    const validImages = Array.isArray(images)
      ? images.filter((img) => img && typeof img.url === 'string' && img.url.trim()).slice(0, 4)
      : [];
    const textWithHint = `${textPrompt}${formatImageMetaHint(validImages)}`;
    if (validImages.length === 0) {
      return textWithHint;
    }
    return [
      { type: 'text', text: textWithHint },
      ...validImages.map((img) => ({
        type: 'image_url',
        image_url: { url: img.url }
      }))
    ];
  }

  function stripImagesFromMessages(messages) {
    return (messages || []).map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const textParts = msg.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text);
      const imageCount = msg.content.filter((part) => part && part.type === 'image_url').length;
      let merged = textParts.join('\n').trim();
      if (imageCount > 0) {
        merged += `\n(注：原推文包含 ${imageCount} 张图片，当前模型不支持直接识图，请根据正文与已有 Alt 描述作答)`;
      }
      return { ...msg, content: merged };
    });
  }

  function hasImageContent(messages) {
    return (messages || []).some(
      (msg) => Array.isArray(msg.content) && msg.content.some((p) => p && p.type === 'image_url')
    );
  }

  function isMostlyChinese(text) {
    if (!text) return true;
    const stripped = text.replace(/https?:\/\/\S+|@\w+|#\w+|\s+/g, '');
    if (!stripped) return true;
    const cjkMatches = stripped.match(/[\u4e00-\u9fff]/g) || [];
    return cjkMatches.length / stripped.length > 0.4;
  }

  function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(text || '');
  }

  function formatContinuationBlock(continuation) {
    if (!continuation || !continuation.en) return '';
    const prevEn = String(continuation.en).trim();
    if (!prevEn) return '';
    const prevZh = continuation.zh_back ? ` (${String(continuation.zh_back).trim()})` : '';
    const prevStyle = continuation.style ? ` [Style: ${continuation.style}]` : '';
    return `\n\n[User's Previous Reply / Selected Candidate to Continue From]${prevStyle}:\n${prevEn}${prevZh}\nInstruction: Continue naturally from this previous reply (same voice, coherent follow-up point, thread continuation, or doubling down—do NOT repeat it verbatim).`;
  }

  function buildTweetTranslationMessages({ text, author = '', context = '', images = [], showSlangNotes = true, glossary = '' }) {
    const glossaryBlock = formatGlossaryBlock(glossary);
    const systemPrompt = `你是一个精通中美互联网文化、X (Twitter) 社区黑话、英语俚语 (slang)、俗语 (idioms)、技术/财经术语及反讽语境的资深双语专家。
你的任务是将目标英文推文精准、地道地翻译成简体中文，并用一句话点破主贴真正想传达的核心观点或潜台词（结合图文）。

准确性与地道性硬性要求：
1. **语义与事实零偏差**：严格忠于原推文的立场（赞同、质疑、反讽、调侃、陈述）、逻辑关系、否定词、数字、金额、百分比、版本号、代码与专有名词，绝不脑补原句没有的观点。
2. **结合上下文与图片**：如果提供了上下文或附图，务必结合图片里的文字、表情包/梗图、数据图表或上级推文来消歧和提炼主贴意图；但 translation 字段**只翻译目标推文正文**。
3. **俚语、俗语与网络黑话意译**：准确还原真实语境含义（如 fr, ngl, no cap, cooked, ratio, based, mid, iykyk, smh, lowkey, deadass, touch grass, rent free, delulu, copium, fumbled, hits different, say less, L/W 等），绝不字面硬译。
4. **核心观点提炼 (takeaway)**：用极简短的一句中文总结「这条主贴（含图）真正想表达什么观点/情绪/槽点」，帮助用户快速决定怎么回应；如果正文很直白且无图无潜台词，可返回空字符串 ""。
5. **保留要素**：@用户名、#标签、URL 及业界常见英文缩写（API, LLM, GPU, SaaS 等）自然保留。
6. ${showSlangNotes ? '如果推文中包含容易误解的俚语、俗语、双关或反讽梗，请在 slang_notes 中极简点明（最多 3 条，没有则返回 []）。' : '不需要输出俚语解释，slang_notes 固定返回 []。'}${glossaryBlock}

请严格按以下 JSON 格式输出（不要输出多余文字）：
{
  "translation": "准确且地道自然的中文翻译",
  "takeaway": "一句话点破主贴核心观点/图文潜台词（无潜台词可留空）",
  "slang_notes": ["俚语/俗语：简短解释"]
}`;

    let userPrompt = '';
    if (context && context.trim()) {
      userPrompt += `[上下文参考（仅用于理解指代与语境，请勿翻译此部分）]:\n${context.trim()}\n\n`;
    }
    userPrompt += author ? `[目标推文 - 作者 ${author}]:\n${text}` : `[目标推文]:\n${text}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildMultimodalUserContent(userPrompt, images) }
    ];
  }

  function buildComposeDirectMessages({ text, context = '', images = [], stance = 'mix', length = 'auto', continuation = null, glossary = '' }) {
    const stanceKey = normalizeStance(stance);
    const lengthKey = normalizeLength(length);
    const glossaryBlock = formatGlossaryBlock(glossary);
    const continuationBlock = formatContinuationBlock(continuation);

    const systemPrompt = `You are a native American English speaker and active X (Twitter) user who is deeply fluent in Chinese nuances, internet slang, and implied subtext.
Your job is to translate/adapt the user's Chinese draft into accurate, natural, authentic American English for posting or replying on X.

Rules:
1. **Faithful Meaning, Natural Expression**: Capture the user's exact stance (pushback, sarcasm, agreement, nuance, question), facts, and edge without diluting their point or producing stiff "Chinglish".
2. **Context & Image Alignment**: If an English parent/quoted tweet or image is provided, align directly with its claim, visual details, pronouns, and domain terms.
3. **Chinese Idioms & Slang**: Translate by intent (e.g., 有一说一 -> ngl / honestly, 踩坑 -> learned this the hard way, 画大饼 -> vaporware / empty hype, 草台班子 -> held together by duct tape, 破防 -> tilted / hit a nerve).
4. **Tone / Stance**: ${STANCE_INSTRUCTIONS[stanceKey]}
5. **Length**: ${LENGTH_INSTRUCTIONS[lengthKey]}
6. ${ANTI_AI_STYLE_RULES}${glossaryBlock}

Return ONLY the final English text ready to post, with no quotes, no explanations, and no markdown formatting.`;

    let userPrompt = '';
    if (context && context.trim()) {
      userPrompt += `[English Context / Main Post]:\n${context.trim()}\n\n`;
    }
    userPrompt += `[User's Chinese Draft]:\n${text.trim()}${continuationBlock}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildMultimodalUserContent(userPrompt, images) }
    ];
  }

  function buildReplyCandidatesMessages({
    context = '',
    idea = '',
    images = [],
    stance = 'mix',
    length = 'auto',
    continuation = null,
    glossary = ''
  }) {
    const stanceKey = normalizeStance(stance);
    const lengthKey = normalizeLength(length);
    const hasIdea = Boolean(idea && idea.trim());
    const glossaryBlock = formatGlossaryBlock(glossary);
    const continuationBlock = formatContinuationBlock(continuation);

    const styleLabels =
      stanceKey === 'mix'
        ? ['挑刺/引战', '另类视角', '真实接梗']
        : stanceKey === 'contrarian'
          ? ['犀利反驳', '直击漏洞', '反讽反转']
          : stanceKey === 'alternative'
            ? ['换个角度', '二阶效应', '反向追问']
            : stanceKey === 'witty'
              ? ['美式吐槽', '精准接梗', '简短幽默']
              : stanceKey === 'insight'
                ? ['实操补充', '深度观察', '精准追问']
                : ['简短自然', '轻松互动', '地道口语'];

    const systemPrompt = `You are a sharp, native American English speaker who actively posts and debates on X (Twitter).
Your job:
1. First, read the main post (including any attached images/memes/screenshots/charts and quoted context) and distill what the OP is *really* trying to say or imply in 1 concise Chinese sentence ("post_takeaway").
2. Then write 3 distinct, genuinely human American English ${hasIdea ? "versions turning the user's Chinese idea into X-ready posts/replies" : 'replies to the main post'}.

Stance & Angle Strategy:
${STANCE_INSTRUCTIONS[stanceKey]}

Length Strategy:
${LENGTH_INSTRUCTIONS[lengthKey]}

${ANTI_AI_STYLE_RULES}
- Preserve @mentions, #hashtags, or URLs if the user included them.${glossaryBlock}

Return ONLY valid JSON in this exact format:
{
  "post_takeaway": "一句话概括主贴（含图）真正想传达的核心观点或槽点",
  "candidates": [
    { "style": "${styleLabels[0]}", "en": "English option 1", "zh_back": "中文回译（帮助确认语义与语气锋芒）" },
    { "style": "${styleLabels[1]}", "en": "English option 2", "zh_back": "中文回译" },
    { "style": "${styleLabels[2]}", "en": "English option 3", "zh_back": "中文回译" }
  ]
}`;

    let userPrompt = '';
    if (context && context.trim()) {
      userPrompt += `[Main Post & Thread Context]:\n${context.trim()}`;
    }
    if (hasIdea) {
      userPrompt += `${userPrompt ? '\n\n' : ''}[User's Chinese Idea / Draft]:\n${idea.trim()}`;
    }
    userPrompt += continuationBlock;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildMultimodalUserContent(userPrompt, images) }
    ];
  }

  const POST_MODES = [
    { value: 'news_post', label: '📰 新闻快评' },
    { value: 'long_article', label: '📝 深度长文' },
    { value: 'method_guide', label: '🛠️ 方法实战' }
  ];

  function normalizePostMode(mode) {
    if (POST_MODES.some((m) => m.value === mode)) return mode;
    return 'news_post';
  }

  function sanitizeMiddleDots(text) {
    if (!text) return '';
    return String(text)
      .replace(/[·•]/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
      .join('\n')
      .trim();
  }

  function extractUrls(text) {
    if (!text) return [];
    const matches = String(text).match(/https?:\/\/[^\s<>"')]+/gi) || [];
    return Array.from(new Set(matches));
  }

  function buildPostDraftMessages({
    source = '',
    postMode = 'news_post',
    sourceLink = '',
    context = '',
    images = [],
    continuation = null,
    glossary = ''
  }) {
    const mode = normalizePostMode(postMode);
    const glossaryBlock = formatGlossaryBlock(glossary);
    const continuationBlock = formatContinuationBlock(continuation);
    const detectedUrls = extractUrls(source);
    const effectiveLink = (sourceLink || '').trim() || detectedUrls[0] || '';

    const modeDirectives = {
      news_post: `Carrier & Format (NEWS POST):
- Write a SHORT, punchy English X post (roughly 3–6 crisp short lines, separated by blank lines).
- Do NOT write like a news report or press release. Poke the reader or drop your sharp verdict on line 1, then put the company/product AFTER the judgment.
- Leave strategic whitespace and tension: less info dump, more shock, stakes, and curiosity.
- Do NOT put any URL inside "main_post". Put the source link (and at most 1 short natural line of context) into "first_reply".
- Set "title" to "".`,
      long_article: `Carrier & Format (LONG-FORM X POST / ARTICLE):
- Write a substantive, punchy English X Article / long-form post covering Big Tech / AI.
- Open with a sharp verdict or direct poke at the reader's assumption; put the product/company AFTER your judgment.
- Explain the real mechanism by walking through concrete, specific real-world scenarios—NEVER use neat numbered lists (1. 2. 3.), bullet lists, or symmetrical parallel sentences.
- Keep paragraphs short (1–3 sentences each) with a blank line between every paragraph.
- Provide a crisp, punchy English "title" (no middle dots).
- End with a decisive, grounded conclusion. NEVER end with "I plan to..." / "I'm going to..." and NEVER end with engagement-bait questions ("What do you think?", "Drop a comment below").`,
      method_guide: `Carrier & Format (PRACTICAL METHOD / WORKFLOW GUIDE):
- Write the method/workflow out COMPLETELY based on the user's provided material—do NOT hide steps or leave artificial cliffhangers.
- Anchor every step/mechanism in concrete real-world usage scenarios rather than abstract theory.
- Still avoid neat AI bullet lists, numbered list symmetry, or parallel triplets—flow naturally in short paragraphs with blank lines between them.
- Provide a crisp English "title" (no middle dots).
- End with a decisive conclusion—NEVER end with "I plan to..." and NEVER end with comment-bait questions.`
    };

    const systemPrompt = `You are a sharp, opinionated English-language Tech / Big Tech / AI writer on X (Twitter).
Your job is to turn the user's verified notes/source material into an X-ready English post or article that strictly obeys the editorial constitution below.

EDITORIAL CONSTITUTION (NON-NEGOTIABLE):
1. **Strict Factual Grounding**: ONLY use verified facts, numbers, quotes, and details present in the user's source material or attached context/images. NEVER fabricate hands-on testing ("I tried this for 2 hours..."), NEVER invent metrics, revenue, benchmarks, or unverified claims.
2. **First-Person Perspective**: Write in first person ("I", "my")—from my observation, my usage, my judgment—even when covering Big Tech or AI news. Never sound like a neutral journalist or press release.
3. **No Middle Dots**: NEVER use the middle dot character "·" or bullet "•" anywhere in your output (English or Chinese). Use spaces instead.
4. **Voice & Tone**: Plain, sharp, direct American English. Short sentences. Zero AI clichés ("delve", "game-changer", "paradigm shift", "nuanced", "tapestry", "in today's rapidly evolving", "It's not about X, it's about Y", "Not only X, but also Y", em-dash spam).
5. **No Throat-Clearing Openers**: NEVER start with meta-openers like "Let me be blunt", "Here's the plain truth", "Hot take:", "Unpopular opinion:", "I'm calling it now", "Let's cut through the noise". Start cold with the actual hook or judgment on line 1.
6. **Sharp Judgment & Stakes**: Every piece MUST have a clear verdict and a debatable point. Commit fully—no hedging ("might", "could potentially", "remains to be seen", "both sides"). Put the product/company AFTER the judgment. Always spell out what it's actually useful for or where the real damage/stakes lie—never just dump facts or numbers.
7. **Structure & Ending**: No neat bullet lists or parallel triplets. Blank line between every paragraph. End with a crisp conclusion—NEVER write "I plan to..." / "I'm going to..." and NEVER end with comment-section bait ("What do you think?").

${modeDirectives[mode]}${glossaryBlock}

Return ONLY valid JSON in this exact format:
{
  "title": "Crisp English title (for long_article / method_guide; empty string for news_post)",
  "main_post": "Ready-to-post English content with blank lines between paragraphs",
  "first_reply": "First reply holding the link/source if applicable (otherwise empty string)",
  "zh_summary": "1-2句中文核对（说明核心判断与角度，禁用间隔号）",
  "fact_check_note": "若素材未提供具体实测或数据，简短说明已严格避开编造；若无补充可留空"
}`;

    let userPrompt = '';
    if (context && context.trim()) {
      userPrompt += `[Quoted / Reference Context]:\n${context.trim()}\n\n`;
    }
    userPrompt += `[User's Verified Source Material / Notes]:\n${(source || '').trim()}`;
    if (effectiveLink) {
      userPrompt += `\n\n[Source Link (place in first_reply for news_post, not main_post)]:\n${effectiveLink}`;
    }
    userPrompt += continuationBlock;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildMultimodalUserContent(userPrompt, images) }
    ];
  }

  return {
    DEFAULT_SETTINGS,
    STANCE_OPTIONS,
    LENGTH_OPTIONS,
    POST_MODES,
    STANCE_INSTRUCTIONS,
    LENGTH_INSTRUCTIONS,
    ANTI_AI_STYLE_RULES,
    normalizeStance,
    normalizeLength,
    normalizePostMode,
    sanitizeMiddleDots,
    extractUrls,
    buildApiUrl,
    parseJsonSafely,
    formatGlossaryBlock,
    formatImageMetaHint,
    buildMultimodalUserContent,
    stripImagesFromMessages,
    hasImageContent,
    isMostlyChinese,
    hasChinese,
    formatContinuationBlock,
    buildTweetTranslationMessages,
    buildComposeDirectMessages,
    buildReplyCandidatesMessages,
    buildPostDraftMessages
  };
});
