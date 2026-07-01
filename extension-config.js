// =================================================================
// Maxx's Lovable — Extension Configuration
// All keys live on our own Lovable backend. No third-party powerkits
// or gringow hosts; this build talks only to MXX_API_BASE.
// =================================================================
(function () {
  function _f(n, v) {
    try { Object.defineProperty(window, n, { configurable: false, writable: false, value: v }); } catch (e) {}
  }

  // Our Lovable backend (TanStack server routes under /api/public/*).
  var API_BASE = "https://lovable-black-ten.vercel.app";

  _f("EXTENSION_NAME", "Maxx's Lovable");
  _f("EXTENSION_VERSION", "1.2.0");
  _f("DEFAULT_LICENSE_USER_NAME", "Maxx's Lovable User");

  // Single source of truth for all backend calls.
  _f("MXX_API_BASE", API_BASE);
  _f("MXX_VALIDATE_URL", API_BASE + "/api/public/validate-license");
  _f("MXX_UPLOAD_URL", API_BASE + "/api/public/upload-asset");
  _f("MXX_TRACK_URL", API_BASE + "/api/public/track-event");

  _f("SEND_STRATEGY", "websocket");
  _f("MXX_DEBUG", false);
})();

function extensionVersionShort() {
  return typeof EXTENSION_VERSION !== "undefined" ? String(EXTENSION_VERSION) : "0.0.0";
}

function extensionFooterBadge() {
  var name = typeof EXTENSION_NAME !== "undefined" ? String(EXTENSION_NAME) : "Maxx's Lovable";
  return name + " • v" + extensionVersionShort();
}

function normalizeLicenseUserName(name) {
  var n = String(name || "").trim();
  if (!n || n.toLowerCase() === "test" || n.toLowerCase() === "user") {
    return typeof DEFAULT_LICENSE_USER_NAME !== "undefined" ? DEFAULT_LICENSE_USER_NAME : "Maxx's Lovable User";
  }
  return n;
}

function mxxLicenseSessionStorage(sessionId, userName) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["mxx_license_key"], function (res) {
      resolve({
        ql_license_valid: true,
        ql_license_key: res.mxx_license_key || "",
        ql_session_id: sessionId,
        ql_user_name: normalizeLicenseUserName(userName),
        ql_activated_at: new Date().toISOString(),
      });
    });
  });
}

// Back-compat shims — kept only so other modules don't crash before being
// migrated; they intentionally do nothing useful.
function powerkitsApiHeaders(extra) { return Object.assign({}, extra || {}); }
function gringowApiHeaders(extra) { return Object.assign({}, extra || {}); }
function powerkitsInternalSessionStorage() { return {}; }
function gringowInternalSessionStorage() { return {}; }
function pkPageStorageGet(suffix) {
  try { return localStorage.getItem("mxx_" + suffix) || ""; } catch (e) { return ""; }
}
function pkPageStorageSet(suffix, value) {
  try { localStorage.setItem("mxx_" + suffix, value); } catch (e) {}
}

// =================================================================
// Send / Upload telemetry — fire-and-forget POST to our backend.
// Called from content.js and sidepanel.js whenever the user clicks Send
// or uploads an asset. Never blocks the user action.
// =================================================================
function mxxTrackEvent(eventType, extra) {
  try {
    chrome.storage.local.get(["mxx_license_key", "mxx_device_id"], function (res) {
      var key = res.mxx_license_key || "";
      if (!key) return; // no key, nothing to attribute
      var body = Object.assign(
        {
          key: key,
          event_type: eventType,
          device_id: res.mxx_device_id || null,
        },
        extra || {},
      );
      try {
        fetch(typeof MXX_TRACK_URL !== "undefined" ? MXX_TRACK_URL : "", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    });
  } catch (e) {}
}

// =================================================================
// Asset upload — POST raw file body to our Lovable backend. The
// server stores it in our private bucket and returns a long-lived
// signed URL that we attach to the user prompt.
// =================================================================
async function mxxUploadAsset(file) {
  var url = typeof MXX_UPLOAD_URL !== "undefined" ? MXX_UPLOAD_URL : "";
  var stored = await new Promise(function (resolve) {
    chrome.storage.local.get(["mxx_license_key", "mxx_device_id"], resolve);
  });
  var key = stored.mxx_license_key || "";
  if (!key) throw new Error("No license key — activate the extension first.");

  var resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "x-license-key": key,
      "x-device-id": stored.mxx_device_id || "",
      "x-file-name": file.name || "upload",
    },
    body: file,
  });
  var body = {};
  try { body = await resp.json(); } catch (e) {}
  if (!resp.ok || !body.ok) {
    var reason = (body && body.reason) || ("http_" + resp.status);
    mxxTrackEvent("upload_failed", { metadata: { reason: reason, name: file.name } });
    throw new Error("Upload failed: " + reason);
  }
  mxxTrackEvent("upload", {
    file_size_bytes: file.size || 0,
    file_type: file.type || "application/octet-stream",
    metadata: { name: file.name, file_id: body.file_id },
  });
  return { file_id: body.file_id, file_name: body.file_name, public_url: body.public_url };
}
