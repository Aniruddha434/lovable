import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { validateLicenseKey } from "../../../../lib/license";
import { addUpload } from "../../../../lib/store";

export async function POST(request) {
  const key = request.headers.get("x-license-key") || "";
  const deviceId = request.headers.get("x-device-id") || "";
  const fileName = request.headers.get("x-file-name") || "upload";
  const contentType = request.headers.get("content-type") || "application/octet-stream";

  const result = await validateLicenseKey(key, deviceId);
  if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 20 * 1024 * 1024) {
    return NextResponse.json({ ok: false, reason: "file_too_large" }, { status: 413 });
  }

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
  const blob = await put(`uploads/${result.license.key}/${Date.now()}-${safeName}`, bytes, {
    access: "public",
    contentType,
  });

  const upload = await addUpload({
    license_key: result.license.key,
    device_id: deviceId || null,
    file_name: safeName,
    file_type: contentType,
    file_size: bytes.byteLength,
    public_url: blob.url,
  });

  return NextResponse.json({ ok: true, file_id: upload.id, file_name: safeName, public_url: blob.url });
}
