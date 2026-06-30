import { kv } from "@vercel/kv";

const LICENSE_SET = "licenses";
const EVENTS_LIST = "events";
const UPLOADS_LIST = "uploads";

export function licenseKeyId(key) {
  return `license:${String(key || "").trim().toUpperCase()}`;
}

export function makeLicenseKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part()}-${part()}-${part()}-${part()}`;
}

export async function getLicense(key) {
  const normalized = String(key || "").trim().toUpperCase();
  if (!normalized) return null;
  return kv.get(licenseKeyId(normalized));
}

export async function saveLicense(license) {
  const key = String(license.key || "").trim().toUpperCase();
  const item = { ...license, key, updated_at: new Date().toISOString() };
  await kv.set(licenseKeyId(key), item);
  await kv.sadd(LICENSE_SET, key);
  return item;
}

export async function listLicenses() {
  const keys = await kv.smembers(LICENSE_SET);
  const items = await Promise.all((keys || []).map((key) => getLicense(key)));
  return items.filter(Boolean).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

export async function createLicense({ owner = "", expires_at = "", status = "active" }) {
  let key = makeLicenseKey();
  while (await getLicense(key)) key = makeLicenseKey();
  const now = new Date().toISOString();
  return saveLicense({ key, owner, status, device_id: null, activated_at: null, expires_at: expires_at || null, created_at: now });
}

export async function deleteLicense(key) {
  const normalized = String(key || "").trim().toUpperCase();
  await kv.del(licenseKeyId(normalized));
  await kv.srem(LICENSE_SET, normalized);
}

export async function addEvent(event) {
  const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...event };
  await kv.lpush(EVENTS_LIST, item);
  await kv.ltrim(EVENTS_LIST, 0, 199);
  return item;
}

export async function listEvents(limit = 50) {
  return kv.lrange(EVENTS_LIST, 0, Math.max(0, limit - 1));
}

export async function addUpload(upload) {
  const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...upload };
  await kv.lpush(UPLOADS_LIST, item);
  await kv.ltrim(UPLOADS_LIST, 0, 199);
  return item;
}

export async function listUploads(limit = 50) {
  return kv.lrange(UPLOADS_LIST, 0, Math.max(0, limit - 1));
}
