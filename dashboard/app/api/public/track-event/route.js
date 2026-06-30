import { NextResponse } from "next/server";
import { validateLicenseKey } from "../../../../lib/license";
import { addEvent } from "../../../../lib/store";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  const key = body.key || body.license_key;
  const result = await validateLicenseKey(key, body.device_id);
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });

  await addEvent({
    license_key: result.license.key,
    device_id: body.device_id || null,
    event_type: String(body.event_type || "unknown"),
    metadata: body.metadata || null,
    file_size_bytes: body.file_size_bytes || null,
    file_type: body.file_type || null,
  });
  return NextResponse.json({ ok: true });
}
