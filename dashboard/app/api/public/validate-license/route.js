import { NextResponse } from "next/server";
import { validateLicenseKey } from "../../../../lib/license";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}

  const result = await validateLicenseKey(body.key, body.device_id);
  if (!result.ok) {
    return NextResponse.json({ valid: false, reason: result.reason }, { status: result.status });
  }

  const license = result.license;
  return NextResponse.json({
    valid: true,
    key: license.key,
    activated_at: license.activated_at,
    expires_at: license.expires_at,
    issued_at: new Date().toISOString(),
    support: {
      whatsapp_url: process.env.SUPPORT_WHATSAPP_URL || null,
      contact_url: process.env.SUPPORT_CONTACT_URL || null,
      contact_label: process.env.SUPPORT_CONTACT_LABEL || "Contact",
    },
  });
}
