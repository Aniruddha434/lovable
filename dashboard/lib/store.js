// Simple in-memory store for dashboard
// Data persists during server runtime; use dashboard to manage licenses

let licenses = {};
let events = [];
let uploads = [];

const MAX_EVENTS = 200;
const MAX_UPLOADS = 200;

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
  return licenses[normalized] || null;
}

export async function saveLicense(license) {
  const key = String(license.key || "").trim().toUpperCase();
  const item = { ...license, key, updated_at: new Date().toISOString() };
  licenses[key] = item;
  return item;
}

export async function listLicenses() {
  return Object.values(licenses).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

export async function createLicense({ owner = "", expires_at = "", status = "active" }) {
  let key = makeLicenseKey();
  while (await getLicense(key)) key = makeLicenseKey();
  const now = new Date().toISOString();
  return saveLicense({ key, owner, status, device_id: null, activated_at: null, expires_at: expires_at || null, created_at: now });
}

export async function deleteLicense(key) {
  const normalized = String(key || "").trim().toUpperCase();
  delete licenses[normalized];
}

export async function addEvent(event) {
  const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...event };
  events.unshift(item);
  events = events.slice(0, MAX_EVENTS);
  return item;
}

export async function listEvents(limit = 50) {
  return events.slice(0, Math.max(0, limit));
}

export async function addUpload(upload) {
  const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...upload };
  uploads.unshift(item);
  uploads = uploads.slice(0, MAX_UPLOADS);
  return item;
}

export async function listUploads(limit = 50) {
  return uploads.slice(0, Math.max(0, limit));
}
