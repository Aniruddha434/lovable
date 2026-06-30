import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = Number(process.env.PORT || 8787);
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || "local-dev-key";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-3-5-sonnet-latest";

const MODELS = [
  "claude-3-5-sonnet-latest",
  "claude-3-7-sonnet-latest",
  "claude-sonnet-4-20250514",
  "gpt-4o",
  "gpt-4o-mini",
  "o3-mini",
];

function requireAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (LOCAL_API_KEY && token !== LOCAL_API_KEY) {
    return res.status(401).json({ error: { message: "Invalid local API key", type: "invalid_request_error" } });
  }
  next();
}

function textFromMessages(messages) {
  return (messages || []).map((m) => {
    if (typeof m.content === "string") return `${m.role}: ${m.content}`;
    if (Array.isArray(m.content)) {
      return `${m.role}: ` + m.content.map((part) => part.text || "").join("\n");
    }
    return "";
  }).filter(Boolean).join("\n");
}

function toAnthropicMessages(messages) {
  const system = [];
  const chat = [];
  for (const msg of messages || []) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") system.push(msg.content);
      continue;
    }
    chat.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: typeof msg.content === "string" ? msg.content : textFromMessages([msg]),
    });
  }
  return { system: system.join("\n\n"), messages: chat.length ? chat : [{ role: "user", content: "" }] };
}

function openAiResponse({ id, model, content }) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

async function callAnthropic(body) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = body.model || DEFAULT_MODEL;
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
      system: converted.system || undefined,
      messages: converted.messages,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${resp.status}`);
  const content = (data.content || []).map((part) => part.text || "").join("\n");
  return openAiResponse({ id: data.id || `chatcmpl_${crypto.randomUUID()}`, model, content });
}

async function callOpenAI(body) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ ...body, model: body.model || DEFAULT_MODEL, stream: false }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${resp.status}`);
  return data;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/v1/models", requireAuth, (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: id.startsWith("claude") ? "anthropic" : "openai" })),
  });
});

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  try {
    if (req.body.stream) {
      return res.status(400).json({ error: { message: "Streaming is not implemented in this local server yet", type: "invalid_request_error" } });
    }
    const model = req.body.model || DEFAULT_MODEL;
    const data = model.startsWith("claude") ? await callAnthropic({ ...req.body, model }) : await callOpenAI({ ...req.body, model });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message || "Local endpoint failed", type: "server_error" } });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenAI-compatible local endpoint: http://127.0.0.1:${PORT}/v1`);
});
