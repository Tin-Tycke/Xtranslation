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
    targetRegion: 'en',
    provider: 'deepseek',
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
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
    showSlangNotes: true,
    defaultTone: 'mix',
    defaultLength: 'auto',
    glossary: ''
  };

  function normalizeRegion(region) {
    return region === 'zh' ? 'zh' : 'en';
  }

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

  const ANTI_AI_STYLE_RULES = `Anti-AI & Native Slang Rules (CRITICAL):
- Sound like a real American human scrolling X on their phone, NOT an AI assistant, journalist, or LinkedIn influencer.
- Cut 30-40% of formal filler. Use short punchy sentences, casual fragments, real digits (42, 21M, $5B — NEVER spell out numbers), and natural contractions (don't, kinda, tbh, ngl, idk, lmao).
- Naturally sprinkle real X / American internet slang when it fits the vibe (e.g. ngl, tbh, cooked, wild, fumbled, copium, unhinged, lowkey, no cap, mid, L/W, rent free, hits different, yikes, bro, crazy how) — keep it effortless, never forced or cringey.
- NEVER use AI clichés or journalism filler: "Great point!", "This is so true!", "While I agree...", "It's worth noting...", "Here's the thing:", "Unpopular opinion:", "Hot take:", "facing a massive legal wall", "raises serious questions", "in a surprising turn", "delve", "nuanced", "tapestry", "double-edged sword", "game-changer", "It's not about X, it's about Y", "Not only X, but also Y".
- Avoid em-dash (—) spam, bullet lists, and unnecessary #hashtags.`;

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
    glossary = '',
    region = 'en'
  }) {
    const regionKey = normalizeRegion(region);
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
              ? ['幽默吐槽', '精准接梗', '简短抖机灵']
              : stanceKey === 'insight'
                ? ['实操补充', '深度观察', '精准追问']
                : ['简短自然', '轻松互动', '地道口语'];

    if (regionKey === 'zh') {
      const zhStanceMap = {
        mix: '给出 3 个截然不同的真实视角：第 1 条（挑刺/引战）直接指出主贴漏洞、反驳前提或抛出有争议的犀利判断（有锋芒但不人身攻击）；第 2 条（另类视角）换一个维度或二阶后果拆解；第 3 条（真实接梗）像真实刷 X 中文区的网友一样自然接话或调侃。',
        contrarian: '3 条全部站在反方/挑刺立场，直指逻辑盲区或现实打脸点，引发讨论但不谩骂。',
        alternative: '3 条全部给出意想不到的另类视角、反例或二阶影响，避免一味附和。',
        witty: '3 条全部采用自然克制的中文网感幽默或反讽吐槽，不油腻不尴尬。',
        insight: '3 条全部补充具体实操观察、行业真相或一针见血的追问，不说教。',
        casual: '3 条全部用轻松自然的中文口语互动，真诚不舔。',
        friendly: '真诚友好、自然拉近距离的中文口语。',
        professional: '清晰犀利、落到实际场景的专业中文表达，拒绝公关腔。'
      };
      const zhLengthMap = {
        auto: '长短自然搭配：至少 1 条简短利落（1 句话），至少 1 条稍微展开（2~4 句，讲清一个具体逻辑或反例）。',
        short: '全部简短有力，1~2 句以内。',
        medium: '全部写成 2~4 句的中长评，有具体例子或反驳逻辑，依然像真人发帖而非小作文。'
      };

      const zhSystemPrompt = `你是活跃在 X (Twitter) 中文科技 / AI / 互联网圈的资深真人用户。
你的任务：
1. 先通读主贴（含附图、截图、图表与引用上下文），用一句话提炼主贴真正想表达的核心观点或槽点（"post_takeaway"）。
2. 生成 3 条可直接发在 X 中文区的**简体中文**${hasIdea ? '回复/表达（融合用户的想法）' : '高质量回复'}。

立场策略：
${zhStanceMap[stanceKey] || zhStanceMap.mix}

篇幅策略：
${zhLengthMap[lengthKey] || zhLengthMap.auto}

去 AI 味与口语网感硬性要求：
- 彻底说人话！像刷 X 中文区的真人随手敲出来的短句，砍掉一切书面长定语和冗余修饰，数字直接用阿拉伯数字（如 42个、2100万）。
- 贴合语境自然穿插地道中文网络语/梗（如：绷不住、离大谱、太抽象了、纯纯、草台班子、画大饼、割韭菜、直接寄了、麻了、狠狠打脸、笑死、逆天、主打一个、属于是、省流、有一说一），自然不尴尬、不刻意堆砌。
- 严禁 AI 腔、翻译腔和铺垫词：绝不使用「说得太好了」「不可否认」「值得注意的是」「先说人话」「我把话说满」「一方面…另一方面…」「不是X，而是Y」「双刃剑」「赋能」「抓手」「引发广泛关注」。
- 严禁使用间隔号「·」或「•」，分隔用空格。
- 保留原帖中的关键英文专有名词（如 OpenAI、Agent、API 等）。${glossaryBlock}

请严格按以下 JSON 格式输出（不要多余文字）：
{
  "post_takeaway": "一句话点破主贴（含图）的核心观点或槽点（禁用间隔号）",
  "candidates": [
    { "style": "${styleLabels[0]}", "en": "可直接发布的中文回复 1", "zh_back": "" },
    { "style": "${styleLabels[1]}", "en": "可直接发布的中文回复 2", "zh_back": "" },
    { "style": "${styleLabels[2]}", "en": "可直接发布的中文回复 3", "zh_back": "" }
  ]
}`;

      let zhUserPrompt = '';
      if (context && context.trim()) {
        zhUserPrompt += `[主贴与上下文]:\n${context.trim()}`;
      }
      if (hasIdea) {
        zhUserPrompt += `${zhUserPrompt ? '\n\n' : ''}[用户的回复想法]:\n${idea.trim()}`;
      }
      zhUserPrompt += continuationBlock;

      return [
        { role: 'system', content: zhSystemPrompt },
        { role: 'user', content: buildMultimodalUserContent(zhUserPrompt, images) }
      ];
    }

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

  const RADAR_CHANNELS = [
    { value: 'ai_tech', label: '🤖 AI 科技' },
    { value: 'memes_fun', label: '😂 梗图娱乐' },
    { value: 'general_viral', label: '🌍 全网热议' },
    { value: 'all', label: '🔥 全领域混搭' }
  ];

  function normalizePostMode(mode) {
    if (POST_MODES.some((m) => m.value === mode)) return mode;
    return 'news_post';
  }

  function normalizeRadarChannel(channel) {
    if (RADAR_CHANNELS.some((c) => c.value === channel)) return channel;
    return 'ai_tech';
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
    glossary = '',
    region = 'en'
  }) {
    const regionKey = normalizeRegion(region);
    const mode = normalizePostMode(postMode);
    const glossaryBlock = formatGlossaryBlock(glossary);
    const continuationBlock = formatContinuationBlock(continuation);
    const detectedUrls = extractUrls(source);
    const effectiveLink = (sourceLink || '').trim() || detectedUrls[0] || '';

    if (regionKey === 'zh') {
      const zhModeDirectives = {
        news_post: `载体与篇幅（新闻快评短帖）：
- 写成简短锋利的中文 X 短帖（约 3~6 行短段落，段间留空行）。
- 开头先戳读者或直接下判断，绝不写成新闻报道或公关通稿，产品和公司名放在判断后面。
- 新闻类要留白，少信息堆砌，多震惊感与悬念。
- 主贴里不放链接，把原文链接放到 "first_reply"（首评）中。
- "title" 固定返回 ""。`,
        long_article: `载体与篇幅（深度长文）：
- 以中文长文为主载体，围绕大公司或 AI 事件写出硬核判断与争论点。
- 开头先戳读者或直接下判断，产品放判断后面；讲清到底有什么用、严重在哪。
- 不要整齐分点（禁止 1. 2. 3. 或项目符号列表）和并列排比，机制落到具体场景举例，段间留空行。
- 给出一个干练的中文标题（禁用间隔号）。
- 结尾用结论收束，不写「我打算……」式表态，绝对不用「你怎么看？欢迎评论区聊聊」这类互动式收尾。`,
        method_guide: `载体与篇幅（方法实战）：
- 方法类必须写全，不藏步骤、不故意留悬念，但严格基于用户提供的真实素材，不编造没做过的测试。
- 不要整齐分点和并列排比，把机制和做法落到具体场景举例，段间留空行。
- 给出一个干练的中文标题（禁用间隔号）。
- 结尾用结论收束，不写「我打算……」式表态，不用评论区互动式收尾。`
      };

      const zhSystemPrompt = `你是面向 X (Twitter) 中文科技 / 大公司 / AI 赛道的资深实战派作者。
你的任务是将用户提供的核实素材，改写成可直接发布在 X 中文区的高质量内容，必须严格遵守以下写作宪法（一字不违）：

总原则：
1. 只写真实核实过的内容，绝不编造个人实测体验，绝不编造任何数据或结论。
2. 强制第一人称视角，哪怕是新闻稿也要以「我的关注、我的使用、我的判断」来写，不写中立新闻通稿。
3. 严禁使用间隔号「·」或「•」，所有分隔一律用空格。

口气与观点：
4. 极致口语日常，砍掉一切书面长句和冗余废话，句子越短越狠，数字直接用阿拉伯数字（42个、2100万）。贴合语境自然穿插地道中文网络语（如：绷不住、离大谱、太抽象了、草台班子、画大饼、直接寄了、麻了、狠狠打脸、笑死、逆天、省流、割韭菜），像真人在 X 上吐槽或甩观点，绝不写成新闻稿或公众号。
5. 严禁任何铺垫表态式开场（「先说人话」「我把话说满」「说白了」「不吹不黑」这类开场一律不要），上来就摆内容。
6. 每篇必须有明确判断和争论点，话说满不留余地，产品放在判断后面；必须写清到底有什么用、严重在哪，不能只摆事实和数据。

结构排版：
7. 不要整齐分点和并列排比，机制落到具体场景举例；段间留空行；结尾用结论收束，不写「我打算……」式表态，文章不用评论区互动式收尾。

${zhModeDirectives[mode]}${glossaryBlock}

请严格返回如下 JSON（不要多余文字）：
{
  "title": "干练的中文标题（新闻快评留空字符串）",
  "main_post": "可直接发布的中文正文（段间留空行，禁用间隔号）",
  "first_reply": "首评内容（放原文链接，无链接可留空）",
  "zh_summary": "1句话核心判断核对（禁用间隔号）",
  "fact_check_note": "若素材缺少数据或实测细节，简短提示已严格避开编造；若无补充可留空"
}`;

      let zhUserPrompt = '';
      if (context && context.trim()) {
        zhUserPrompt += `[引用/参考上下文]:\n${context.trim()}\n\n`;
      }
      zhUserPrompt += `[已核实的真实素材/笔记]:\n${(source || '').trim()}`;
      if (effectiveLink) {
        zhUserPrompt += `\n\n[原文链接（新闻快评请放进 first_reply，不要放进 main_post）]:\n${effectiveLink}`;
      }
      zhUserPrompt += continuationBlock;

      return [
        { role: 'system', content: zhSystemPrompt },
        { role: 'user', content: buildMultimodalUserContent(zhUserPrompt, images) }
      ];
    }

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
4. **Voice & Tone**: Casual, punchy, everyday American X talk—NOT formal journalism or AI prose. Cut redundant filler, use short tight lines and real digits (42, 21M, $5B — never spell out numbers). Naturally weave in everyday X slang where it fits (ngl, tbh, wild, cooked, fumbled, unhinged, copium, lowkey, lmao, yikes, crazy how) without overdoing it. Zero AI clichés ("delve", "game-changer", "paradigm shift", "nuanced", "tapestry", "in today's rapidly evolving", "facing a massive legal wall", "It's not about X, it's about Y", "Not only X, but also Y", em-dash spam).
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

  function buildQuoteRemixMessages({
    context = '',
    idea = '',
    images = [],
    stance = 'mix',
    length = 'auto',
    continuation = null,
    glossary = '',
    region = 'en'
  }) {
    const regionKey = normalizeRegion(region);
    const stanceKey = normalizeStance(stance);
    const lengthKey = normalizeLength(length);
    const hasIdea = Boolean(idea && idea.trim());
    const glossaryBlock = formatGlossaryBlock(glossary);
    const continuationBlock = formatContinuationBlock(continuation);

    if (regionKey === 'zh') {
      const zhSystemPrompt = `你是活跃在 X (Twitter) 中文区的头部内容操盘手。
你的任务是针对下面这条要「引用转发（Quote Tweet）」的原帖（含附图/语境），写出 3 条发给**你自己粉丝看**的中文引用锐评${hasIdea ? '（融合用户的观点）' : ''}。

Quote Tweet 核心心法（和普通评论完全不同）：
- 你是在向**自己的时间线粉丝**点评/借势原帖，而不是在原帖评论区对着博主说话。
- 开头直接甩出你的判断或情绪钩子，把原帖当成你的论据或靶子，能让人忍不住点赞/转发/关注你。
- 3 个差异化角度：
  1.「借势定调」：顺着原帖拔高一层，给出更有穿透力的结论；
  2.「犀利拆台」：直指原帖盲区、反讽或现实打脸点，制造讨论度；
  3.「延展暴论」：由这件事推演一个狠一点的趋势判断或行业潜台词。
- 风格要求：极致口语日常、短句、自然穿插中文网络语（如 绷不住、离大谱、草台班子、太抽象了、直接寄了、省流），绝不 AI 腔，绝不使用铺垫开场，严禁间隔号「·」或「•」，数字用阿拉伯数字。${glossaryBlock}

请严格返回如下 JSON（不要多余文字）：
{
  "post_takeaway": "一句话点破原帖（含图）的核心观点或借势点（禁用间隔号）",
  "candidates": [
    { "style": "借势定调", "en": "可直接发布的中文引用锐评 1", "zh_back": "" },
    { "style": "犀利拆台", "en": "可直接发布的中文引用锐评 2", "zh_back": "" },
    { "style": "延展暴论", "en": "可直接发布的中文引用锐评 3", "zh_back": "" }
  ]
}`;

      let zhUserPrompt = `[要引用转发的原帖]:\n${(context || '').trim()}`;
      if (hasIdea) zhUserPrompt += `\n\n[用户的观点想法]:\n${idea.trim()}`;
      zhUserPrompt += continuationBlock;

      return [
        { role: 'system', content: zhSystemPrompt },
        { role: 'user', content: buildMultimodalUserContent(zhUserPrompt, images) }
      ];
    }

    const systemPrompt = `You are a sharp, high-growth American English X (Twitter) creator.
Your job is to write 3 distinct, viral-worthy Quote Tweet takes on the given post (including any images) addressed to **YOUR OWN followers**${hasIdea ? " incorporating the user's Chinese angle" : ''}.

Quote Tweet Rules (CRITICAL — different from a normal reply):
- Address YOUR timeline audience, NOT the OP directly. Use the quoted post as evidence, a foil, or a springboard for YOUR sharper thesis.
- 3 distinct angles:
  1. "借势定调" (Frame & Amplify): Reframe what the post actually means at a higher level with a punchy thesis.
  2. "犀利拆台" (Sharp Pushback): Expose the blind spot, irony, or reality check in the quoted post.
  3. "延展暴论" (Bold Takeaway): Drop a spicy, quotable second-order prediction or hot take that makes people bookmark/follow.
- Stance bias: ${STANCE_INSTRUCTIONS[stanceKey]}
- Length: ${LENGTH_INSTRUCTIONS[lengthKey]}
- ${ANTI_AI_STYLE_RULES}${glossaryBlock}

Return ONLY valid JSON:
{
  "post_takeaway": "一句话概括原帖的核心点与借势角度（禁用间隔号）",
  "candidates": [
    { "style": "借势定调", "en": "Quote tweet option 1", "zh_back": "中文回译" },
    { "style": "犀利拆台", "en": "Quote tweet option 2", "zh_back": "中文回译" },
    { "style": "延展暴论", "en": "Quote tweet option 3", "zh_back": "中文回译" }
  ]
}`;

    let userPrompt = `[Post Being Quote-Tweeted]:\n${(context || '').trim()}`;
    if (hasIdea) userPrompt += `\n\n[User's Angle (Chinese)]:\n${idea.trim()}`;
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
    RADAR_CHANNELS,
    STANCE_INSTRUCTIONS,
    LENGTH_INSTRUCTIONS,
    ANTI_AI_STYLE_RULES,
    normalizeRegion,
    normalizeStance,
    normalizeLength,
    normalizePostMode,
    normalizeRadarChannel,
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
    buildQuoteRemixMessages,
    buildPostDraftMessages
  };
});
