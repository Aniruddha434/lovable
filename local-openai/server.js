import "dotenv/config";
import express from "express";
import { createServer } from "http";

const app = express();
app.use(express.json({ limit: "16mb" }));

// ── Config ─────────────────────────────────────────────────────────────────
const PORT          = Number(process.env.PORT || 8787);
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || "local-dev-key";

// ── In-memory token store (pushed from extension) ───────────────────────────
let lovableToken     = process.env.LOVABLE_TOKEN     || "";
let lovableProjectId = process.env.LOVABLE_PROJECT_ID || "";

// ── Lovable models ──────────────────────────────────────────────────────────
const LOVABLE_MODELS = [
  { id: "claude-sonnet-4-5",           label: "Claude Sonnet 4.5 (Lovable)"  },
  { id: "claude-3-7-sonnet-20250219",  label: "Claude 3.7 Sonnet (Lovable)"  },
  { id: "claude-3-5-sonnet-20241022",  label: "Claude 3.5 Sonnet (Lovable)"  },
  { id: "claude-3-5-haiku-20241022",   label: "Claude 3.5 Haiku (Lovable)"   },
  { id: "gpt-4o-2024-11-20",           label: "GPT-4o (Lovable)"             },
  { id: "auto",                         label: "Lovable Default"              },
];

// ── Auth ────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth  = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (LOCAL_API_KEY && auth !== LOCAL_API_KEY) {
    return res.status(401).json({
      error: { message: "Invalid local API key — set Authorization: Bearer " + LOCAL_API_KEY, type: "invalid_request_error" }
    });
  }
  next();
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => p.text || p.content || "").join("\n");
  return String(content || "");
}

function ulid() {
  const C = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = Date.now(), r = "";
  for (let i = 9; i >= 0; i--) { r = C[ts % 32] + r; ts = Math.floor(ts / 32); }
  for (let j = 0; j < 16; j++) r += C[Math.floor(Math.random() * 32)];
  return r;
}

function sseStart(res) {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
}

function sseSend(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function sseDone(res)       { res.write("data: [DONE]\n\n"); res.end(); }

function makeChunk(id, model, delta, finish_reason = null) {
  return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] };
}

// ── Lovable API chat ────────────────────────────────────────────────────────
async function lovableChat({ messages, model, stream, projectId, token, res }) {
  const tok = token || lovableToken;
  const pid = projectId || lovableProjectId;

  if (!tok) throw new Error("No Lovable token. Open lovable.dev in Chrome with the extension active, then POST /token or set LOVABLE_TOKEN in .env");
  if (!pid) throw new Error("No Lovable project ID. Open a project on lovable.dev first, or POST /token with project_id");

  // Extract last user message as the prompt
  const userMsgs = messages.filter(m => m.role === "user");
  const lastUser = userMsgs[userMsgs.length - 1];
  const prompt   = contentToString(lastUser?.content || "");

  const lovModel = model && model !== "auto" ? model : null;

  const payload = {
    id: "umsg_" + ulid(),
    message: prompt,
    files: [],
    selected_elements: [],
    chat_only: false,
    view: "editor",
    view_description: "",
    optimisticImageUrls: [],
    ai_message_id: "aimsg_" + ulid(),
    thread_id: "main",
    current_page: `/projects/${pid}`,
    current_viewport_width: 1280,
    current_viewport_height: 800,
    current_viewport_dpr: 1,
    model: lovModel,
  };

  const url = `https://api.lovable.dev/projects/${pid}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${tok}`,
      "content-type": "application/json",
      "origin": "https://lovable.dev",
      "referer": `https://lovable.dev/projects/${pid}`,
      "accept": "text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Lovable API ${resp.status}: ${text.slice(0, 200)}`);
  }

  const id    = `chatcmpl-${crypto.randomUUID()}`;
  const mname = lovModel || "lovable-default";

  if (!stream) {
    // collect full response
    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let buf = "", fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const evt = JSON.parse(raw);
          // Lovable SSE events: type="text_delta" or "content_block_delta"
          const delta = evt.delta?.text || evt.text || evt.content || "";
          if (delta) fullText += delta;
        } catch {}
      }
    }
    return {
      id, object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: mname,
      choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  // streaming
  sseStart(res);
  sseSend(res, makeChunk(id, mname, { role: "assistant", content: "" }));

  const reader = resp.body.getReader();
  const dec    = new TextDecoder();
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
      try {
        const evt   = JSON.parse(raw);
        const delta = evt.delta?.text || evt.text || evt.content || "";
        if (delta) sseSend(res, makeChunk(id, mname, { content: delta }));
      } catch {}
    }
  }

  sseSend(res, makeChunk(id, mname, {}, "stop"));
  sseDone(res);
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Health / status
app.get("/health", (_req, res) => res.json({
  ok: true,
  has_token: !!lovableToken,
  project_id: lovableProjectId || null,
  models: LOVABLE_MODELS.map(m => m.id),
}));
app.get("/v1/health", (_req, res) => res.json({ ok: true }));

// Token push — extension or user POSTs token here
// POST /token { token, project_id }
app.post("/token", (req, res) => {
  const tok = String(req.body.token || "").replace(/^Bearer\s+/i, "").trim();
  const pid = String(req.body.project_id || "").trim();
  if (tok) { lovableToken = tok; console.log("[token] Lovable token updated"); }
  if (pid) { lovableProjectId = pid; console.log("[token] Project ID:", pid); }
  res.json({ ok: true, has_token: !!lovableToken, project_id: lovableProjectId });
});

// GET current token status
app.get("/token", (_req, res) => res.json({
  has_token: !!lovableToken,
  token_preview: lovableToken ? lovableToken.slice(0, 12) + "..." : null,
  project_id: lovableProjectId || null,
}));

// Models
function modelsHandler(_req, res) {
  res.json({
    object: "list",
    data: LOVABLE_MODELS.map(m => ({
      id: m.id, object: "model", created: 1700000000, owned_by: "lovable",
    })),
  });
}
app.get("/v1/models", requireAuth, modelsHandler);
app.get("/models",    requireAuth, modelsHandler);

// Chat completions
async function chatHandler(req, res) {
  const model  = req.body.model || "auto";
  const stream = !!req.body.stream;
  try {
    const result = await lovableChat({ messages: req.body.messages || [], model, stream, res });
    if (!stream) res.json(result);
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
}
app.post("/v1/chat/completions", requireAuth, chatHandler);
app.post("/chat/completions",    requireAuth, chatHandler);

// Legacy completions
app.post("/v1/completions", requireAuth, async (req, res) => {
  const messages = [{ role: "user", content: req.body.prompt || "" }];
  try {
    const result = await lovableChat({ messages, model: req.body.model || "auto", stream: false, res });
    const text = result.choices?.[0]?.message?.content || "";
    res.json({ id: result.id, object: "text_completion", created: result.created, model: result.model, choices: [{ text, index: 0, finish_reason: "stop" }] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, "127.0.0.1", () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         Lovable Local OpenAI-Compatible Endpoint         ║
╚══════════════════════════════════════════════════════════╝

  Base URL  : http://127.0.0.1:${PORT}/v1
  API key   : ${LOCAL_API_KEY}
  Token     : ${lovableToken ? "✓ loaded from .env" : "✗ not set — push from extension or set LOVABLE_TOKEN"}
  Project   : ${lovableProjectId || "not set — open a project on lovable.dev"}

  Endpoints :
    GET  /health
    GET  /token                     ← check token status
    POST /token                     ← push token from extension
    GET  /v1/models
    POST /v1/chat/completions       ← streaming + non-streaming
    POST /v1/completions            ← legacy

  Claude Code CLI:
    set OPENAI_API_KEY=${LOCAL_API_KEY}
    set OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1
    claude --model claude-sonnet-4-5

  Codex CLI:
    set OPENAI_API_KEY=${LOCAL_API_KEY}
    set OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1
    codex

  Push token manually:
    curl -X POST http://127.0.0.1:${PORT}/token ^
      -H "Content-Type: application/json" ^
      -d "{\\"token\\":\\"YOUR_LOVABLE_TOKEN\\",\\"project_id\\":\\"YOUR_PROJECT_ID\\"}"
`);
});
