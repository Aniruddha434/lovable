# Local OpenAI-Compatible Endpoint

This local server exposes an OpenAI-compatible API for tools that accept a custom base URL.

It uses your own provider API keys:

- Anthropic for `claude-*` models.
- OpenAI for `gpt-*` and `o*` models.

It does not use Lovable tokens or extension cookies.

## Setup

```bash
cd local-openai
npm install
copy .env.example .env
npm start
```

Edit `.env`:

```txt
PORT=8787
LOCAL_API_KEY=local-dev-key
DEFAULT_MODEL=claude-3-5-sonnet-latest
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

## OpenAI-Compatible Clients

Use:

```txt
Base URL: http://127.0.0.1:8787/v1
API key: local-dev-key
Model: claude-3-5-sonnet-latest
```

Example curl:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-latest","messages":[{"role":"user","content":"Say hi"}]}'
```

## Claude Code

Claude Code primarily uses Anthropic-compatible settings, not OpenAI-compatible settings. For OpenAI-compatible CLIs, use the `/v1` base URL above. For Claude Code specifically, prefer direct Anthropic credentials unless your installed version supports custom OpenAI-compatible base URLs.
