// Optional AI Image & Video Generation Collaboration Module for X 地道双语助手

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.XTR_MEDIA_GEN = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
    },
    custom: {
      baseUrl: '',
      model: ''
    }
  };

  function buildVisualPromptMessages({ title = '', mainPost = '', kind = 'image' }) {
    const isVideo = kind === 'video';
    const systemPrompt = isVideo
      ? `You are an art director for a Tech / AI X (Twitter) publication.
Turn the given post into ONE concise, vivid 5-second video generation prompt (in English, under 70 words).
Rules:
- Clean cinematic editorial tech motion (e.g. subtle camera push-in, glowing server racks, abstract silicon wafer light, dramatic moody studio lighting).
- NO text overlays, NO watermarks, NO cluttered UI screenshots.
- Return ONLY the raw English video prompt, no quotes or explanation.`
      : `You are an editorial illustrator for a top Tech / AI publication (like The Verge / Wired / Stratechery).
Turn the given post into ONE concise, striking image generation prompt (in English, under 70 words).
Rules:
- High-contrast editorial illustration or clean minimalist 3D/photoreal visual metaphor representing the post's core tension.
- Strictly NO text, NO letters, NO logos, NO watermarks inside the image.
- 16:9 widescreen composition suitable for an X post header.
- Return ONLY the raw English image prompt, no quotes or explanation.`;

    const userPrompt = title
      ? `Title: ${title}\n\nPost:\n${mainPost}`
      : `Post:\n${mainPost}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt.slice(0, 1500) }
    ];
  }

  async function fetchWithTimeout(url, options, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`媒体生成超时 (${Math.round(timeoutMs / 1000)}s)`);
      }
      throw new Error(`媒体生成网络失败: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeImageGenUrl(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) throw new Error('请先在设置中填写生图 API URL');
    if (trimmed.endsWith('/images/generations')) return trimmed;
    if (trimmed.endsWith('/v1')) return `${trimmed}/images/generations`;
    return trimmed;
  }

  async function generateImageFromProvider({ baseUrl, apiKey, model, prompt, timeoutMs = 60000 }) {
    const url = normalizeImageGenUrl(baseUrl);
    const cleanKey = (apiKey || '').replace(/^Bearer\s+/i, '').trim();
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.)/i.test(url);
    if (!cleanKey && !isLocal) {
      throw new Error('请先在设置中填写生图 API Key');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`;

    const body = {
      model: model || 'gpt-image-1',
      prompt,
      n: 1
    };

    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      timeoutMs
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`生图请求失败 (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const item = data?.data?.[0] || data?.images?.[0] || data;
    if (item?.b64_json) {
      const dataUrl = `data:image/png;base64,${item.b64_json}`;
      return { url: dataUrl, dataUrl, prompt };
    }
    const imgUrl = item?.url || data?.url || '';
    if (!imgUrl) {
      throw new Error('生图接口未返回有效图片 URL 或 Base64');
    }
    return { url: imgUrl, dataUrl: '', prompt };
  }

  async function generateVideoFromProvider({
    baseUrl,
    apiKey,
    model,
    prompt,
    imageUrl = '',
    pollIntervalMs = 2500,
    maxPolls = 12,
    timeoutMs = 60000
  }) {
    const url = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('请先在设置中填写生视频 API URL');
    const cleanKey = (apiKey || '').replace(/^Bearer\s+/i, '').trim();
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.)/i.test(url);
    if (!cleanKey && !isLocal) {
      throw new Error('请先在设置中填写生视频 API Key');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`;

    const payload = {
      model: model || 'video-gen',
      prompt
    };
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      payload.image_url = imageUrl;
    }

    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      timeoutMs
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`生视频请求失败 (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const directUrl =
      data?.video_url ||
      data?.url ||
      data?.data?.[0]?.url ||
      data?.output?.video_url ||
      '';
    if (directUrl) {
      return { url: directUrl, prompt };
    }

    // Async polling support for standard task-based video APIs
    const taskId = data?.id || data?.task_id;
    const statusUrl = data?.status_url || (taskId ? `${url}/${taskId}` : '');
    if (!statusUrl) {
      throw new Error('生视频接口未返回视频链接或任务 ID');
    }

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const pollRes = await fetchWithTimeout(statusUrl, { method: 'GET', headers }, 15000);
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json().catch(() => null);
      const vidUrl =
        pollData?.video_url ||
        pollData?.url ||
        pollData?.data?.[0]?.url ||
        pollData?.output?.video_url ||
        '';
      if (vidUrl) {
        return { url: vidUrl, prompt };
      }
      const status = String(pollData?.status || '').toLowerCase();
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        throw new Error(`生视频任务失败: ${pollData?.error || status}`);
      }
    }

    throw new Error('生视频任务仍在排队中，请稍后重试或检查服务商面板');
  }

  return {
    IMAGE_GEN_PRESETS,
    buildVisualPromptMessages,
    normalizeImageGenUrl,
    generateImageFromProvider,
    generateVideoFromProvider
  };
});
