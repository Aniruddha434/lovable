import { getLicense, saveLicense } from "./store";

export async function validateLicenseKey(key, deviceId) {
  const license = await getLicense(key);
  if (!license) return { ok: false, status: 404, reason: "not_found" };
  if (license.status === "revoked") return { ok: false, status: 403, reason: "revoked" };
  if (license.status === "paused") return { ok: false, status: 403, reason: "paused" };

  const expiresAt = license.expires_at ? Date.parse(license.expires_at) : 0;
  if (expiresAt && expiresAt < Date.now()) return { ok: false, status: 403, reason: "expired" };

  const incomingDevice = String(deviceId || "").trim();
  if (license.device_id && incomingDevice && license.device_id !== incomingDevice) {
    return { ok: false, status: 403, reason: "device_mismatch" };
  }

  const patch = { ...license };
  if (incomingDevice && !patch.device_id) patch.device_id = incomingDevice;
  if (!patch.activated_at) patch.activated_at = new Date().toISOString();
  const saved = await saveLicense(patch);

  return {
    ok: true,
    license: saved,
  };
}
