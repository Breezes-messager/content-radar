'use strict';

/**
 * AI 链路测试：用本地 mock 的 OpenAI 兼容服务验证，不消耗真实额度。
 * 运行：node --test test/ai.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AiClient, buildMessages } = require('../src/ai');

/** 起一个临时的 OpenAI 兼容接口 */
function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let parsed = null;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        parsed = {};
      }
      handler(parsed, res, req);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const okReply = (content, usage = { prompt_tokens: 100, completion_tokens: 50 }) => (_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content } }], usage }));
};

const cfg = (port, over = {}) => ({
  enabled: true,
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: 'sk-test',
  model: 'mock-model',
  minScore: 6,
  interests: '只看 AI 技术内容',
  priceIn: 2,
  priceOut: 8,
  ...over,
});

const sample = [
  { title: '大模型推理优化', author: 'A', desc: '讲 vLLM' },
  { title: '家常菜做法', author: 'B', desc: '红烧肉' },
];

test('未配置时不 ready', () => {
  assert.equal(new AiClient({ enabled: false, apiKey: '' }).ready, false);
  assert.equal(new AiClient({ enabled: true, apiKey: 'sk-x', baseUrl: 'http://x', model: 'm' }).ready, true);
});

test('scoreBatch 解析打分、标签与理由，并按 token 计算成本', async (t) => {
  const { server, port } = await startMock(
    okReply(
      JSON.stringify({
        results: [
          { i: 0, score: 9, tags: ['AI', '推理'], reason: '高度相关' },
          { i: 1, score: 2, tags: ['生活'], reason: '与兴趣无关' },
        ],
      }),
    ),
  );
  t.after(() => server.close());

  const client = new AiClient(cfg(port));
  const { results, usage } = await client.scoreBatch(sample);

  assert.equal(results.get(0).score, 9);
  assert.deepEqual(results.get(0).tags, ['AI', '推理']);
  assert.equal(results.get(1).score, 2);
  assert.equal(usage.model, 'mock-model');
  // (100 * 2 + 50 * 8) / 1e6 = 0.0006 元
  assert.ok(Math.abs(usage.cost - 0.0006) < 1e-9, `成本应约 0.0006，实际 ${usage.cost}`);
});

test('分数被裁剪到 0-10，缺失结果不报错', async (t) => {
  const { server, port } = await startMock(okReply(JSON.stringify({ results: [{ i: 0, score: 99 }] })));
  t.after(() => server.close());

  const { results } = await new AiClient(cfg(port)).scoreBatch(sample);
  assert.equal(results.get(0).score, 10, '超范围分数应被裁剪');
  assert.equal(results.has(1), false, '缺失的条目应忽略而不是崩溃');
});

test('模型返回非 JSON 时降级为空结果，不抛异常', async (t) => {
  const { server, port } = await startMock(okReply('抱歉，我无法完成这个请求。'));
  t.after(() => server.close());

  const { results } = await new AiClient(cfg(port)).scoreBatch(sample);
  assert.equal(results.size, 0);
});

test('接口报错时抛出可读错误', async (t) => {
  const { server, port } = await startMock((_, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  t.after(() => server.close());

  await assert.rejects(() => new AiClient(cfg(port)).scoreBatch(sample), /HTTP 401/);
});

test('testConnection 返回模型与成本', async (t) => {
  const { server, port } = await startMock(okReply('{"ok":true}', { prompt_tokens: 10, completion_tokens: 5 }));
  t.after(() => server.close());

  const r = await new AiClient(cfg(port)).testConnection();
  assert.equal(r.ok, true);
  assert.equal(r.model, 'mock-model');
  assert.ok(r.cost > 0);
});

test('ask 把信息池上下文带进 prompt', async (t) => {
  let seen = '';
  const { server, port } = await startMock((body, res) => {
    seen = body.messages.map((m) => m.content).join('\n');
    okReply('这是回答')(body, res);
  });
  t.after(() => server.close());

  const r = await new AiClient(cfg(port)).ask('最近有什么进展？', [{ title: '某条内容', author: '某UP' }]);
  assert.equal(r.answer, '这是回答');
  assert.match(seen, /某条内容/, 'prompt 应包含信息池标题');
  assert.match(seen, /最近有什么进展？/, 'prompt 应包含用户问题');
});

test('buildMessages 在未填兴趣时给出兜底提示', () => {
  const msgs = buildMessages(sample, '');
  assert.match(msgs[1].content, /未填写/);
  assert.match(msgs[1].content, /大模型推理优化/);
});
