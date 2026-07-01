import "dotenv/config";
import express from "express";
import { createServer } from "http";

const app = express();
app.use(express.json({ limit: "16mb" }));

// ── Config ─────────────────────────────────────────────────────────────────
const PORT          = Number(process.env.PORT || 8787);
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || "local-dev-key";

// ── In-memory token store ───────────────────────────────────────────────────
let lovableToken     = process.env.LOVABLE_TOKEN      || "";
let lovableProjectId = process.env.LOVABLE_PROJECT_ID || "";

// ── Lovable models (all known models Lovable supports) ──────────────────────
const LOVABLE_MODELS = [
  { id: "claude-opus-4-8",                label: "Claude Opus 4"          },
  { id: "claude-sonnet-4-5-20250514",     label: "Claude Sonnet 4.5"     },
  { id: "claude-sonnet-4-20250514",       label: "Claude Sonnet 4"       },
  { id: "claude-3-7-sonnet-20250219",     label: "Claude 3.7 Sonnet"     },
  { id: "claude-3-5-sonnet-20241022",     label: "Claude 3.5 Sonnet"     },
  { id: "claude-3-5-haiku-20241022",      label: "Claude 3.5 Haiku"      },
  { id: "claude-3-opus-latest",           label: "Claude 3 Opus"         },
  { id: "gpt-4o",                         label: "GPT-4o"                },
  { id: "gpt-4o-2024-11-20",             label: "GPT-4o (Nov 2024)"     },
  { id: "gpt-4o-mini",                    label: "GPT-4o Mini"           },
  { id: "o3-mini",                        label: "o3 Mini"               },
  { id: "auto",                            label: "Lovable Default"       },
];

// ── Logging ─────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

function logReq(req, extra = "") {
  const model = req.body?.model || "auto";
  const msgCount = req.body?.messages?.length || 0;
  const stream = req.body?.stream ? "stream" : "sync";
  log(`📥 ${req.method} ${req.path} | model=${model} | msgs=${msgCount} | ${stream}${extra ? " | " + extra : ""}`);
}

function logErr(context, err) {
  log(`❌ [${context}] ${err.message || err}`);
}

function logOk(context, extra = "") {
  log(`✅ [${context}]${extra ? " " + extra : ""}`);
}

// ── Auth ────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (LOCAL_API_KEY && auth !== LOCAL_API_KEY) {
    log(`🔒 AUTH REJECTED | got="${auth.slice(0, 20)}..." expected="${LOCAL_API_KEY.slice(0, 20)}..."`);
    return res.status(401).json({
      error: { message: "Invalid API key. Use: " + LOCAL_API_KEY, type: "invalid_request_error", code: "invalid_api_key" }
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

// ── Lovable API ─────────────────────────────────────────────────────────────
async function lovableChat({ messages, model, stream, projectId, token, res }) {
  const tok = token || lovableToken;
  const pid = projectId || lovableProjectId;

  if (!tok) {
    const msg = "No Lovable token. Open lovable.dev in Chrome with extension, or POST /token";
    logErr("lovableChat", msg);
    throw new Error(msg);
  }
  if (!pid) {
    const msg = "No project ID. Open a Lovable project, or POST /token with project_id";
    logErr("lovableChat", msg);
    throw new Error(msg);
  }

  // Build prompt from messages
  const userMsgs = messages.filter(m => m.role === "user");
  const lastUser = userMsgs[userMsgs.length - 1];
  const prompt   = contentToString(lastUser?.content || "");

  // System messages become prefix
  const systemMsgs = messages.filter(m => m.role === "system");
  const systemText = systemMsgs.map(m => contentToString(m.content)).join("\n\n");
  const fullPrompt = systemText ? systemText + "\n\n" + prompt : prompt;

  const lovModel = model && model !== "auto" ? model : null;

  const payload = {
    id: "umsg_" + ulid(),
    message: fullPrompt,
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

  const url = `https://api.lovable.dev/projects/${pid}/chat`;
  log(`📤 LOVABLE API | POST ${url}`);
  log(`   model=${lovModel || "default"} | prompt=${fullPrompt.slice(0, 100)}...`);
  log(`   token=${tok.slice(0, 15)}... | project=${pid}`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${tok}`,
      "content-type": "application/json",
      "origin": "https://lovable.dev",
      "referer": `https://lovable.dev/projects/${pid}`,
      "accept": stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
  });

  log(`📨 LOVABLE RESPONSE | status=${resp.status} | content-type=${resp.headers.get("content-type") || "?"}`);

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    log(`❌ LOVABLE ERROR BODY: ${text.slice(0, 500)}`);
    throw new Error(`Lovable API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const id    = `chatcmpl-${crypto.randomUUID()}`;
  const mname = lovModel || "lovable-default";

  // Read the response body as text/stream
  const reader = resp.body.getReader();
  const dec    = new TextDecoder();
  let buf = "", fullText = "", chunkCount = 0;

  if (stream) {
    sseStart(res);
    sseSend(res, makeChunk(id, mname, { role: "assistant", content: "" }));
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const raw = dec.decode(value, { stream: true });
    buf += raw;

    // Log raw data for debugging (first few chunks)
    if (chunkCount < 3) {
      log(`   📦 RAW CHUNK #${chunkCount}: ${raw.slice(0, 200).replace(/\n/g, "\\n")}`);
    }

    const lines = buf.split("\n");
    buf = lines.pop();

    for (const line of lines) {
      // Try SSE format
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          const delta = evt.delta?.text || evt.text || evt.content ||
                       evt.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            if (stream) sseSend(res, makeChunk(id, mname, { content: delta }));
          }
        } catch {}
        continue;
      }

      // Try plain JSON line
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) {
        try {
          const obj = JSON.parse(trimmed);
          const delta = obj.delta?.text || obj.text || obj.content ||
                       obj.choices?.[0]?.delta?.content || obj.message || "";
          if (delta) {
            fullText += delta;
            if (stream) sseSend(res, makeChunk(id, mname, { content: delta }));
          }
        } catch {}
        continue;
      }

      // Plain text fallback
      if (trimmed && !trimmed.startsWith("event:") && !trimmed.startsWith(":")) {
        fullText += trimmed + "\n";
        if (stream) sseSend(res, makeChunk(id, mname, { content: trimmed + "\n" }));
      }
    }
    chunkCount++;
  }

  // Process remaining buffer
  if (buf.trim()) {
    fullText += buf.trim();
    if (stream) sseSend(res, makeChunk(id, mname, { content: buf.trim() }));
  }

  log(`   📝 TOTAL OUTPUT: ${fullText.length} chars | ${chunkCount} chunks`);

  if (stream) {
    sseSend(res, makeChunk(id, mname, {}, "stop"));
    sseDone(res);
    logOk("stream", `${fullText.length} chars sent`);
    return null; // already sent
  }

  logOk("chat", `${fullText.length} chars`);
  return {
    id, object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: mname,
    choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Health
app.get("/health", (_req, res) => {
  log("📋 GET /health");
  res.json({
    ok: true,
    has_token: !!lovableToken,
    token_preview: lovableToken ? lovableToken.slice(0, 15) + "..." : null,
    project_id: lovableProjectId || null,
    models: LOVABLE_MODELS.map(m => m.id),
  });
});
app.get("/v1/health", (_req, res) => res.json({ ok: true }));

// Token management
app.post("/token", (req, res) => {
  const tok = String(req.body.token || "").replace(/^Bearer\s+/i, "").trim();
  const pid = String(req.body.project_id || "").trim();
  if (tok) { lovableToken = tok; log(`🔑 TOKEN UPDATED | ${tok.slice(0, 15)}...`); }
  if (pid) { lovableProjectId = pid; log(`📁 PROJECT ID: ${pid}`); }
  res.json({ ok: true, has_token: !!lovableToken, project_id: lovableProjectId });
});

app.get("/token", (_req, res) => {
  log("📋 GET /token");
  res.json({
    has_token: !!lovableToken,
    token_preview: lovableToken ? lovableToken.slice(0, 15) + "..." : null,
    project_id: lovableProjectId || null,
  });
});

// Models
function modelsHandler(_req, res) {
  log("📋 GET /models");
  res.json({
    object: "list",
    data: LOVABLE_MODELS.map(m => ({
      id: m.id, object: "model", created: 1700000000, owned_by: "lovable",
    })),
  });
}
app.get("/v1/models",     requireAuth, modelsHandler);
app.get("/models",        requireAuth, modelsHandler);
app.get("/v1/models/:id", requireAuth, (req, res) => {
  const m = LOVABLE_MODELS.find(x => x.id === req.params.id);
  if (!m) {
    log(`⚠️ Model not in list: ${req.params.id} — passing through anyway`);
    return res.json({ id: req.params.id, object: "model", created: 1700000000, owned_by: "lovable" });
  }
  res.json({ id: m.id, object: "model", created: 1700000000, owned_by: "lovable" });
});

// Chat completions
async function chatHandler(req, res) {
  logReq(req);
  const model  = req.body.model || "auto";
  const stream = !!req.body.stream;
  try {
    const result = await lovableChat({ messages: req.body.messages || [], model, stream, res });
    if (!stream && result) res.json(result);
  } catch (err) {
    logErr("chatHandler", err);
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
}
app.post("/v1/chat/completions", requireAuth, chatHandler);
app.post("/chat/completions",    requireAuth, chatHandler);

// Legacy completions
app.post("/v1/completions", requireAuth, async (req, res) => {
  logReq(req, "legacy");
  const messages = [{ role: "user", content: req.body.prompt || "" }];
  try {
    const result = await lovableChat({ messages, model: req.body.model || "auto", stream: false, res });
    const text = result?.choices?.[0]?.message?.content || "";
    res.json({ id: result.id, object: "text_completion", created: result.created, model: result.model, choices: [{ text, index: 0, finish_reason: "stop" }] });
  } catch (err) {
    logErr("completions", err);
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

// Responses API (Codex CLI)
app.post("/v1/responses", requireAuth, async (req, res) => {
  const model  = req.body.model || "auto";
  const stream = !!req.body.stream;
  log(`📥 POST /v1/responses | model=${model} | stream=${stream}`);

  let messages = [];
  if (req.body.instructions) messages.push({ role: "system", content: req.body.instructions });
  if (req.body.input) {
    if (typeof req.body.input === "string") {
      messages.push({ role: "user", content: req.body.input });
    } else if (Array.isArray(req.body.input)) {
      for (const item of req.body.input) {
        if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
        if (item.role && item.content) { messages.push(item); continue; }
        if (item.type === "message" && item.content) {
          const text = Array.isArray(item.content)
            ? item.content.map(c => c.text || "").join("\n")
            : String(item.content);
          messages.push({ role: item.role || "user", content: text });
        }
      }
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "" });

  try {
    if (stream) {
      const id = `resp_${crypto.randomUUID()}`;
      sseStart(res);
      sseSend(res, { type: "response.created", response: { id, status: "in_progress" } });
      sseSend(res, { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: `msg_${crypto.randomUUID()}` } });
      sseSend(res, { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });

      // Collect via lovableChat non-stream then emit
      const result = await lovableChat({ messages, model, stream: false, res: null });
      const text = result?.choices?.[0]?.message?.content || "";

      // send as delta chunks
      const chunkSize = 20;
      for (let i = 0; i < text.length; i += chunkSize) {
        sseSend(res, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text.slice(i, i + chunkSize) });
      }

      sseSend(res, { type: "response.output_text.done", output_index: 0, content_index: 0, text });
      sseSend(res, { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
      sseSend(res, { type: "response.completed", response: { id, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 0, output_tokens: text.length } } });
      sseDone(res);
      logOk("responses-stream", `${text.length} chars`);
    } else {
      const result = await lovableChat({ messages, model, stream: false, res: null });
      const text = result?.choices?.[0]?.message?.content || "";
      const id = `resp_${crypto.randomUUID()}`;
      res.json({
        id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 0, output_tokens: text.length, total_tokens: text.length },
      });
      logOk("responses", `${text.length} chars`);
    }
  } catch (err) {
    logErr("responses", err);
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

// Catch-all for unknown routes
app.all("*", (req, res) => {
  log(`⚠️ UNKNOWN ROUTE: ${req.method} ${req.path}`);
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}`, type: "invalid_request_error" } });
});

// ── Start ────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, "127.0.0.1", () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Lovable Local OpenAI-Compatible Endpoint (v2)         ║
╚═══════════════════════════════════════════════════════════╝

  URL     : http://127.0.0.1:${PORT}/v1
  API key : ${LOCAL_API_KEY}
  Token   : ${lovableToken ? "loaded (" + lovableToken.slice(0, 15) + "...)" : "NOT SET — open lovable.dev with extension"}
  Project : ${lovableProjectId || "NOT SET"}

  Models  : ${LOVABLE_MODELS.map(m => m.id).join(", ")}

  ─── Usage ───────────────────────────────────────────────

  Claude Code:
    $env:OPENAI_BASE_URL="http://127.0.0.1:${PORT}/v1"
    $env:OPENAI_API_KEY="${LOCAL_API_KEY}"
    claude --model claude-opus-4-8

  Codex CLI:
    $env:OPENAI_BASE_URL="http://127.0.0.1:${PORT}/v1"
    $env:OPENAI_API_KEY="${LOCAL_API_KEY}"
    codex --model claude-opus-4-8

  Push token:
    POST http://127.0.0.1:${PORT}/token
    { "token": "YOUR_TOKEN", "project_id": "YOUR_PROJECT_ID" }

  ─── Logs below ──────────────────────────────────────────
`);
});
