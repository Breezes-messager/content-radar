'use strict';

/**
 * AI 过滤客户端（OpenAI 兼容协议，默认指向 DeepSeek）
 * 职责：批量给候选内容打分 + 打标签 + 给理由，并统计 token / 成本。
 */

const { request } = require('./http');

/** 粗略 token 估算：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 3.5);
}

function buildMessages(batch, interests, feedback = null) {
  const lines = batch
    .map((it, i) => `${i}. 标题：${it.title}\n   作者：${it.author || '-'}\n   简介：${(it.desc || '').slice(0, 120) || '-'}`)
    .join('\n');

  const system = [
    '你是一个内容筛选助手。根据用户的兴趣描述，为每条内容打分并打标签。',
    '评分标准：10 = 完全命中兴趣核心；7-9 = 高度相关；4-6 = 沾边；1-3 = 基本无关；0 = 明确不想要。',
    '只输出 JSON，不要任何解释、不要 markdown 代码块。格式：',
    '{"results":[{"i":0,"score":8,"tags":["AI","大模型"],"reason":"一句话理由"}]}',
    '必须为每一条输入都输出一条结果，i 与输入序号一致。',
  ].join('\n');

  // 用户的赞/踩是最直接的偏好信号，优先于兴趣描述
  const feedbackBlock = [];
  if (feedback && (feedback.up.length || feedback.down.length)) {
    feedbackBlock.push('用户对历史内容的真实反馈（权重高于兴趣描述，请据此校准）：');
    if (feedback.up.length) {
      feedbackBlock.push(`- 点过赞（同类内容应给高分）：${feedback.up.map((f) => f.title).join(' / ')}`);
    }
    if (feedback.down.length) {
      feedbackBlock.push(`- 点过踩（同类内容应给低分）：${feedback.down.map((f) => f.title).join(' / ')}`);
    }
    feedbackBlock.push('注意：请归纳这些反馈背后的共同特征（题材、风格、作者类型），而不是只看字面标题。');
    feedbackBlock.push('');
  }

  const user = [
    ...feedbackBlock,
    `我的兴趣：${interests || '（未填写，请按“内容质量与信息密度”打分）'}`,
    '',
    '待评估内容：',
    lines,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

class AiClient {
  constructor(cfg) {
    this.cfg = cfg;
  }

  get ready() {
    return Boolean(this.cfg && this.cfg.enabled && this.cfg.apiKey && this.cfg.baseUrl && this.cfg.model);
  }

  async chat(messages, { temperature = 0.2, maxTokens = 1200, jsonMode = true, timeoutMs = 60000 } = {}) {
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: this.cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const res = await request(url, {
      method: 'POST',
      timeoutMs,
      retries: 1,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`AI 接口 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`AI 接口返回非 JSON: ${text.slice(0, 200)}`);
    }
    const usage = json.usage || {};
    const tokensIn = usage.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join('\n'));
    const tokensOut = usage.completion_tokens ?? estimateTokens(json.choices?.[0]?.message?.content || '');
    const priceIn = Number(this.cfg.priceIn) || 0;
    const priceOut = Number(this.cfg.priceOut) || 0;
    const cost = (tokensIn * priceIn + tokensOut * priceOut) / 1e6;
    return { content: json.choices?.[0]?.message?.content || '', tokensIn, tokensOut, cost, model: json.model || this.cfg.model };
  }

  /** 批量打分。返回 { results: Map<index, {score,tags,reason}>, usage } */
  async scoreBatch(batch, feedback = null) {
    const messages = buildMessages(batch, this.cfg.interests, feedback);
    const r = await this.chat(messages);
    const parsed = extractJson(r.content);
    const map = new Map();
    if (parsed && Array.isArray(parsed.results)) {
      for (const row of parsed.results) {
        const i = Number(row.i ?? row.index);
        if (!Number.isInteger(i)) continue;
        map.set(i, {
          score: Math.max(0, Math.min(10, Number(row.score) || 0)),
          tags: Array.isArray(row.tags) ? row.tags.slice(0, 4).map(String) : [],
          reason: String(row.reason || '').slice(0, 120),
        });
      }
    }
    return { results: map, usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost, model: r.model } };
  }

  async testConnection() {
    const r = await this.chat(
      [
        { role: 'system', content: '你是一个测试助手，只输出 JSON。' },
        { role: 'user', content: '输出 {"ok":true}' },
      ],
      { maxTokens: 32, timeoutMs: 20000 },
    );
    return { ok: true, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost, raw: r.content.slice(0, 80) };
  }

  /** 单条内容摘要（按需生成，结果由调用方缓存） */
  async summarize(item) {
    const messages = [
      {
        role: 'system',
        content:
          '你是内容摘要助手。用 2-3 句话概括这条内容的要点，中文，直接说重点，不要复述标题，不要客套话。',
      },
      {
        role: 'user',
        content: [
          `标题：${item.title}`,
          `作者：${item.author || '-'}`,
          `来源：${item.sourceName || '-'}`,
          `简介：${(item.desc || '（无简介，请仅根据标题推断，并注明是推断）').slice(0, 600)}`,
          '',
          '请概括。',
        ].join('\n'),
      },
    ];
    const r = await this.chat(messages, { jsonMode: false, maxTokens: 400 });
    return {
      summary: r.content.trim().slice(0, 400),
      usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost, model: r.model },
    };
  }

  /** 每日简报综述：把一批内容揉成一段话 */
  async digest(entries, { hours = 24 } = {}) {
    const list = entries
      .slice(0, 40)
      .map((it, i) => `${i + 1}. [${it.sourceName || ''}] ${it.title}（${it.author || '-'}）`)
      .join('\n');
    const messages = [
      {
        role: 'system',
        content: [
          '你是资讯简报编辑。根据给定条目写一份中文简报，结构固定：',
          '第一段：3-5 句话的整体综述，指出最值得关注的 2-3 件事和它们的共同线索。',
          '然后是「重点条目」小节：挑出最重要的 5-8 条，每条一行，格式 `- 标题 —— 一句话价值说明`。',
          '最后是「值得留意」小节：2-3 条可能被忽略但有意思的内容。',
          '不要编造条目里没有的信息。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `以下是我最近 ${hours} 小时筛选出的内容（共 ${entries.length} 条）：\n\n${list}`,
      },
    ];
    const r = await this.chat(messages, { jsonMode: false, maxTokens: 1600 });
    return {
      overview: r.content.trim(),
      usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost, model: r.model },
    };
  }

  /** 自由对话（前端右侧“新对话”面板用） */
  async ask(question, contextItems = [], feedback = null) {
    const ctx = contextItems
      .slice(0, 12)
      .map((it, i) => `${i + 1}. ${it.title}（${it.author || '-'}）`)
      .join('\n');

    const systemParts = ['你是一个资讯分析助手，回答简洁、直接、有信息量。'];
    if (feedback && (feedback.up.length || feedback.down.length)) {
      systemParts.push('', '已知这位用户的口味：');
      if (feedback.up.length) systemParts.push(`- 喜欢：${feedback.up.map((f) => f.title).join(' / ')}`);
      if (feedback.down.length) systemParts.push(`- 不喜欢：${feedback.down.map((f) => f.title).join(' / ')}`);
      systemParts.push('回答时可以据此偏向他关心的方向。');
    }

    const messages = [
      { role: 'system', content: systemParts.join('\n') },
      {
        role: 'user',
        content: ctx ? `以下是当前信息池中的内容：\n${ctx}\n\n问题：${question}` : question,
      },
    ];
    const r = await this.chat(messages, { jsonMode: false, maxTokens: 1500 });
    return { answer: r.content, usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost, model: r.model } };
  }
}

module.exports = { AiClient, estimateTokens, extractJson, buildMessages };
