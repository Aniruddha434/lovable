import "dotenv/config";
import express from "express";
import { createServer } from "http";

const app = express();
app.use(express.json({ limit: "16mb" }));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = Number(process.env.PORT || 8787);
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || "local-dev-key";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-3-5-sonnet-latest";

const ANTHROPIC_MODELS = [
  { id: "claude-3-5-sonnet-latest",    ctx: 200000 },
  { id: "claude-3-7-sonnet-latest",    ctx: 200000 },
  { id: "claude-sonnet-4-20250514",    ctx: 200000 },
  { id: "claude-3-5-haiku-latest",     ctx: 200000 },
  { id: "claude-3-opus-latest",        ctx: 200000 },
];

const OPENAI_MODELS = [
  { id: "gpt-4o",       ctx: 128000 },
  { id: "gpt-4o-mini",  ctx: 128000 },
  { id: "gpt-4-turbo",  ctx: 128000 },
  { id: "o1",           ctx: 200000 },
  { id: "o1-mini",      ctx: 128000 },
  { id: "o3-mini",      ctx: 200000 },
  { id: "codex-mini-latest", ctx: 200000 },
];

const ALL_MODELS = [...ANTHROPIC_MODELS, ...OPENAI_MODELS];

function isAnthropicModel(model) {
  return String(model || "").startsWith("claude");
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth  = req.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (LOCAL_API_KEY && token !== LOCAL_API_KEY) {
    return res.status(401).json({
      error: { message: "Invalid local API key", type: "invalid_request_error", code: "invalid_api_key" }
    });
  }
  next();
}

// ── Message helpers ───────────────────────────────────────────────────────────
function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p => {
      if (typeof p === "string") return p;
      if (p.type === "text") return p.text || "";
      if (p.type === "image_url") return "[image]";
      return "";
    }).join("\n");
  }
  return "";
}

function toAnthropicMessages(messages) {
  const systemParts = [];
  const chat = [];
  for (const msg of messages || []) {
    if (msg.role === "system") {
      systemParts.push(contentToString(msg.content));
      continue;
    }
    // tool / function results become user messages
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = contentToString(msg.content);
    // collapse consecutive same-role messages (Anthropic requires alternating)
    if (chat.length && chat[chat.length - 1].role === role) {
      chat[chat.length - 1].content += "\n" + content;
    } else {
      chat.push({ role, content });
    }
  }
  if (!chat.length) chat.push({ role: "user", content: "" });
  return { system: systemParts.join("\n\n"), messages: chat };
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseStart(res) {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

function makeChunk({ id, model, delta, finish_reason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

// ── Anthropic streaming ───────────────────────────────────────────────────────
async function streamAnthropic(body, res) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const model     = body.model || DEFAULT_MODEL;
  const converted = toAnthropicMessages(body.messages || []);
  const id        = `chatcmpl-${crypto.randomUUID()}`;

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system:     converted.system || undefined,
      messages:   converted.messages,
      max_tokens: body.max_tokens || 8096,
      temperature: body.temperature ?? 1,
      stream: true,
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Anthropic HTTP ${upstream.status}`);
  }

  sseStart(res);
  // role chunk
  sseSend(res, makeChunk({ id, model, delta: { role: "assistant", content: "" } }));

  const reader = upstream.body.getReader();
  const dec    = new TextDecoder();
  let buf      = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        sseSend(res, makeChunk({ id, model, delta: { content: evt.delta.text } }));
      }
      if (evt.type === "message_delta" && evt.delta?.stop_reason) {
        sseSend(res, makeChunk({ id, model, delta: {}, finish_reason: "stop" }));
      }
    }
  }
  sseDone(res);
}

// ── Anthropic non-streaming ───────────────────────────────────────────────────
async function callAnthropic(body) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const model     = body.model || DEFAULT_MODEL;
  const converted = toAnthropicMessages(body.messages || []);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system:     converted.system || undefined,
      messages:   converted.messages,
      max_tokens: body.max_tokens || 8096,
      temperature: body.temperature ?? 1,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${resp.status}`);
  const content = (data.content || []).map(p => p.text || "").join("");
  const id = data.id || `chatcmpl-${crypto.randomUUID()}`;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    usage: {
      prompt_tokens:     data.usage?.input_tokens  || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens:     (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

// ── OpenAI streaming proxy ────────────────────────────────────────────────────
async function streamOpenAI(body, res) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set in .env");
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI HTTP ${upstream.status}`);
  }

  sseStart(res);
  const reader = upstream.body.getReader();
  const dec    = new TextDecoder();
  let buf      = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") { sseDone(res); return; }
      res.write(`data: ${raw}\n\n`);
    }
  }
  sseDone(res);
}

// ── OpenAI non-streaming proxy ────────────────────────────────────────────────
async function callOpenAI(body) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set in .env");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ ...body, stream: false }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${resp.status}`);
  return data;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health
app.get("/health",      (_req, res) => res.json({ ok: true, models: ALL_MODELS.map(m => m.id) }));
app.get("/v1/health",   (_req, res) => res.json({ ok: true }));

// Models list — both /v1/models and /models
function modelsResponse(_req, res) {
  res.json({
    object: "list",
    data: ALL_MODELS.map(m => ({
      id: m.id,
      object: "model",
      created: 1700000000,
      owned_by: isAnthropicModel(m.id) ? "anthropic" : "openai",
      context_window: m.ctx,
      capabilities: { chat_completions: true, streaming: true },
    })),
  });
}
app.get("/v1/models",     requireAuth, modelsResponse);
app.get("/models",        requireAuth, modelsResponse);
app.get("/v1/models/:id", requireAuth, (req, res) => {
  const m = ALL_MODELS.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: { message: "Model not found", type: "invalid_request_error" } });
  res.json({ id: m.id, object: "model", created: 1700000000, owned_by: isAnthropicModel(m.id) ? "anthropic" : "openai" });
});

// Chat completions — core endpoint, both /v1/chat/completions and /chat/completions
async function chatCompletionsHandler(req, res) {
  const model   = req.body.model || DEFAULT_MODEL;
  const stream  = !!req.body.stream;
  const isAnt   = isAnthropicModel(model);

  try {
    if (stream) {
      if (isAnt) return await streamAnthropic({ ...req.body, model }, res);
      return await streamOpenAI({ ...req.body, model }, res);
    } else {
      const data = isAnt
        ? await callAnthropic({ ...req.body, model })
        : await callOpenAI({ ...req.body, model });
      return res.json(data);
    }
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    return res.status(500).json({
      error: { message: err.message || "Proxy error", type: "server_error" }
    });
  }
}
app.post("/v1/chat/completions", requireAuth, chatCompletionsHandler);
app.post("/chat/completions",    requireAuth, chatCompletionsHandler);

// Completions (legacy, used by some tools)
app.post("/v1/completions", requireAuth, async (req, res) => {
  const prompt = req.body.prompt || "";
  const model  = req.body.model || DEFAULT_MODEL;
  const asChat = { ...req.body, model, messages: [{ role: "user", content: prompt }] };
  delete asChat.prompt;
  try {
    const data = isAnthropicModel(model)
      ? await callAnthropic(asChat)
      : await callOpenAI({ ...asChat, stream: false });
    const text = data.choices?.[0]?.message?.content || "";
    res.json({
      id: data.id || `cmpl-${crypto.randomUUID()}`,
      object: "text_completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ text, index: 0, finish_reason: "stop" }],
      usage: data.usage || {},
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

// Embeddings stub (Claude Code/Codex sometimes checks this)
app.post("/v1/embeddings", requireAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(501).json({ error: { message: "OPENAI_API_KEY not set for embeddings", type: "invalid_request_error" } });
  }
  try {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

// OpenAI Responses API (used by Codex CLI)
app.post("/v1/responses", requireAuth, async (req, res) => {
  const model  = req.body.model || DEFAULT_MODEL;
  const stream = !!req.body.stream;
  // convert Responses API format to chat completions
  let messages = [];
  if (req.body.system)   messages.push({ role: "system", content: req.body.system });
  if (req.body.input) {
    if (typeof req.body.input === "string") {
      messages.push({ role: "user", content: req.body.input });
    } else if (Array.isArray(req.body.input)) {
      for (const item of req.body.input) {
        if (item.role && item.content) messages.push(item);
        else if (item.type === "message") messages.push({ role: item.role || "user", content: item.content });
      }
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "" });

  const chatBody = { model, messages, max_tokens: req.body.max_output_tokens || 8096, stream };

  try {
    if (stream) {
      sseStart(res);
      const id = `resp-${crypto.randomUUID()}`;
      // header event
      sseSend(res, { type: "response.created", response: { id, object: "realtime.response", status: "in_progress" } });
      sseSend(res, { type: "response.output_item.added", item: { type: "message", role: "assistant" } });
      sseSend(res, { type: "response.content_part.added", part: { type: "output_text", text: "" } });

      // stream through anthropic/openai and relay as Responses events
      let fullText = "";
      const isAnt = isAnthropicModel(model);
      if (isAnt) {
        if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env");
        const converted = toAnthropicMessages(messages);
        const upstream = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, system: converted.system || undefined, messages: converted.messages, max_tokens: chatBody.max_tokens, stream: true }),
        });
        if (!upstream.ok) { const e = await upstream.json().catch(() => ({})); throw new Error(e?.error?.message || `Anthropic HTTP ${upstream.status}`); }
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let evt; try { evt = JSON.parse(raw); } catch { continue; }
            if (evt.type === "content_block_delta" && evt.delta?.text) {
              fullText += evt.delta.text;
              sseSend(res, { type: "response.output_text.delta", delta: evt.delta.text });
            }
          }
        }
      } else {
        if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set in .env");
        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ ...chatBody, stream: true }),
        });
        if (!upstream.ok) { const e = await upstream.json().catch(() => ({})); throw new Error(e?.error?.message || `OpenAI HTTP ${upstream.status}`); }
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let chunk; try { chunk = JSON.parse(raw); } catch { continue; }
            const delta = chunk.choices?.[0]?.delta?.content || "";
            if (delta) { fullText += delta; sseSend(res, { type: "response.output_text.delta", delta }); }
          }
        }
      }

      sseSend(res, { type: "response.output_text.done", text: fullText });
      sseSend(res, { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: fullText }] } });
      sseSend(res, { type: "response.completed", response: { id, object: "realtime.response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: fullText }] }] } });
      sseDone(res);
    } else {
      const data = isAnthropicModel(model)
        ? await callAnthropic(chatBody)
        : await callOpenAI({ ...chatBody, stream: false });
      const text = data.choices?.[0]?.message?.content || "";
      const id = `resp-${crypto.randomUUID()}`;
      res.json({
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: data.usage || {},
      });
    }
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nOpenAI-compatible local endpoint running\n`);
  console.log(`  Base URL  : http://127.0.0.1:${PORT}/v1`);
  console.log(`  API key   : ${LOCAL_API_KEY}`);
  console.log(`  Default   : ${DEFAULT_MODEL}`);
  console.log(`\nSupported endpoints:`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions   (streaming + non-streaming)`);
  console.log(`  POST /v1/completions        (legacy)`);
  console.log(`  POST /v1/embeddings         (proxied to OpenAI)`);
  console.log(`  POST /v1/responses          (Codex CLI Responses API)`);
  console.log(`\nClaude Code CLI:`);
  console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} ANTHROPIC_API_KEY=${LOCAL_API_KEY} claude`);
  console.log(`\nCodex CLI:`);
  console.log(`  OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1 OPENAI_API_KEY=${LOCAL_API_KEY} codex`);
  console.log(`\nOpenAI CLI:`);
  console.log(`  OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1 OPENAI_API_KEY=${LOCAL_API_KEY} openai chat.completions.create ...`);
  console.log(`\nAmazon Q / Continue / Cursor / Cline:`);
  console.log(`  Base URL : http://127.0.0.1:${PORT}/v1`);
  console.log(`  API Key  : ${LOCAL_API_KEY}\n`);
});
