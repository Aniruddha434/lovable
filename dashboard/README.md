# Vercel Dashboard Backend

This app hosts the license dashboard and public APIs used by the Chrome extension.

## Deploy

1. Create a Vercel project from the `dashboard` folder.
2. Add Vercel KV Storage to the project.
3. Add Vercel Blob Storage to the project.
4. Set environment variables from `.env.example`.
5. Deploy.
6. Open `https://your-domain.vercel.app/login` and create license keys.

## Required Environment Variables

```txt
ADMIN_PASSWORD=your-admin-password
ADMIN_SESSION_SECRET=random-long-secret
NEXT_PUBLIC_APP_URL=https://your-domain.vercel.app
```

Optional support links:

```txt
SUPPORT_WHATSAPP_URL=https://...
SUPPORT_CONTACT_URL=https://...
SUPPORT_CONTACT_LABEL=Contact
```

Vercel automatically injects KV and Blob variables when storage is connected.

## API Endpoints

```txt
POST /api/public/validate-license
POST /api/public/track-event
POST /api/public/upload-asset
```

Compatibility stubs are included under `/functions/v1/*`. They return `501` until you implement your own authorized integration.
