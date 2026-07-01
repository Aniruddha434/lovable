# Hosting Your Own Extension Backend On Vercel

The `dashboard/` folder is a Vercel-ready Next.js app. It gives you an admin dashboard and the public APIs the extension expects.

## What You Get

- Admin login at `/login`.
- License key generation.
- License status updates: `active`, `paused`, `revoked`.
- One-device binding per license key.
- Device reset.
- Public extension endpoints:
  - `POST /api/public/validate-license`
  - `POST /api/public/track-event`
  - `POST /api/public/upload-asset`

## Deploy To Vercel

1. Install Vercel CLI if needed: `npm i -g vercel`.
2. From the repo root, run `npm install`.
3. Run `vercel` and follow the prompts.
5. In Vercel, add KV Storage to the project.
6. In Vercel, add Blob Storage to the project.
7. Add environment variables:

```txt
ADMIN_PASSWORD=your-admin-password
ADMIN_SESSION_SECRET=random-long-secret
NEXT_PUBLIC_APP_URL=https://your-domain.vercel.app
SUPPORT_WHATSAPP_URL=
SUPPORT_CONTACT_URL=
SUPPORT_CONTACT_LABEL=Contact
```

8. Redeploy after adding storage and env variables.
9. Open `https://your-domain.vercel.app/login`.
10. Create license keys.

## Configure The Extension

From the extension root, run:

```bash
node scripts/configure-extension.mjs https://your-domain.vercel.app
```

This replaces `https://unlimitedprompts.lovable.app` in:

- `extension-config.js`
- `background.js`
- `license-gate.js`
- `manifest.json`

## Give The Extension To Users

Create a zip containing the extension files, but exclude these folders/files:

- `.git/`
- `dashboard/`
- `scripts/`
- `.env*`
- `HOSTING.md`
- `.gitignore`

Or run the included packaging script on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-extension.ps1
```

The zip will be created at:

```txt
dist/lovable-extension.zip
```

Chrome unpacked install steps for users:

1. Unzip the extension.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Click Load unpacked.
5. Select the unzipped extension folder.
6. Open `lovable.dev`.
7. Open the extension side panel and enter a license key.

## Important Limit

The included Vercel app does not create official Lovable API keys. It creates your own extension license keys. Stub endpoints under `/functions/v1/*` return `501` until you implement your own authorized integration.

Do not collect Lovable tokens, cookies, prompts, or project data without clear user consent and compliance with applicable terms.

## Local OpenAI-Compatible Endpoint

The `local-openai/` folder contains a local server for tools that accept an OpenAI-compatible base URL.

```bash
cd local-openai
npm install
copy .env.example .env
npm start
```

Use this in compatible CLIs:

```txt
Base URL: http://127.0.0.1:8787/v1
API key: local-dev-key
Model: claude-3-5-sonnet-latest
```

This endpoint uses your own `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. It does not use Lovable credentials.
