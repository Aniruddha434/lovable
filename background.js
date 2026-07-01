// Load tamper-hashes BEFORE tamper-guard so the hash map is on `self`
// before the guard reads it. Both must load before any license logic runs.
try { importScripts("tamper-hashes.js", "tamper-guard.js"); } catch (e) {
  console.warn("[Background] tamper-guard load failed:", e && e.message);
}

console.log("[Background] Maxx\'s Lovable service worker started");

// Run a tamper check at startup. If it trips, the guard wipes the license
// and sets mxx_tamper_locked; subsequent heartbeats short-circuit.
try {
  if (self.MxxTamperGuard && typeof self.MxxTamperGuard.run === "function") {
    self.MxxTamperGuard.run();
  }
} catch (e) {}

// ============================================================
// License heartbeat
// Polls /api/public/validate-license on a jittered ~5min schedule so admin-
// side changes (expiry, revoke, pause, time bumps) propagate to every device
// within minutes — without flooding the backend.
// ============================================================
const MXX_LICENSE_API = "https://lovable-black-ten.vercel.app/api/public/validate-license";
const MXX_HEARTBEAT_ALARM = "mxx-license-heartbeat";
const MXX_LICENSE_KEYS = [
  "mxx_license_key",
  "mxx_license_activated_at",
  "mxx_license_expires_at",
  "mxx_license_last_validated_at",
];

function mxxGetDeviceId() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["mxx_device_id"], function (res) {
      if (res.mxx_device_id) return resolve(res.mxx_device_id);
      var id = (crypto && crypto.randomUUID && crypto.randomUUID()) ||
        "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
      chrome.storage.local.set({ mxx_device_id: id }, function () { resolve(id); });
    });
  });
}

async function mxxHeartbeat() {
  try {
    var stored = await new Promise(function (r) {
      chrome.storage.local.get(MXX_LICENSE_KEYS, function (x) { r(x || {}); });
    });
    if (!stored.mxx_license_key) return; // nothing to check

    // Local-expiry short-circuit (no network).
    var exp = stored.mxx_license_expires_at ? Date.parse(stored.mxx_license_expires_at) : 0;
    if (exp && exp < Date.now()) {
      chrome.storage.local.remove(MXX_LICENSE_KEYS);
      return;
    }

    // Tamper check before every network call. If the guard locks, skip.
    try {
      if (self.MxxTamperGuard) {
        var ok = await self.MxxTamperGuard.run();
        if (ok === false) return;
      }
    } catch (e) {}

    var device_id = await mxxGetDeviceId();
    var fingerprint = (self.MxxTamperGuard && self.MxxTamperGuard.manifestFingerprint)
      ? self.MxxTamperGuard.manifestFingerprint()
      : { name: null, version: null };

    var resp = await fetch(MXX_LICENSE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: stored.mxx_license_key,
        device_id: device_id,
        manifest_name: fingerprint.name,
        manifest_version: fingerprint.version,
      }),
    });
    var body = {};
    try { body = await resp.json(); } catch (e) {}

    if (resp.ok && body && body.valid === true) {
      // Verify Ed25519 signature — forged or stale replies trip lockdown.
      if (self.MxxTamperGuard && self.MxxTamperGuard.verifyLicenseSignature) {
        var sigReason = await self.MxxTamperGuard.verifyLicenseSignature({
          key: body.key,
          device_id: device_id,
          expires_at: body.expires_at,
          activated_at: body.activated_at,
          issued_at: body.issued_at,
          status: "active",
          signature: body.signature,
        });
        if (sigReason && sigReason !== "missing_signature") {
          self.MxxTamperGuard.lockdown(sigReason);
          return;
        }
      }
      chrome.storage.local.set({
        mxx_license_expires_at: body.expires_at || stored.mxx_license_expires_at,
        mxx_license_activated_at: body.activated_at || stored.mxx_license_activated_at,
        mxx_license_last_validated_at: new Date().toISOString(),
      });
    } else if (resp.status === 403 || resp.status === 404) {
      // tamper_revoked / expired / revoked / paused / device_mismatch / not_found -> lock.
      if (body && body.reason === "tamper_revoked" && self.MxxTamperGuard) {
        self.MxxTamperGuard.lockdown("server_tamper_revoked");
      } else {
        chrome.storage.local.remove(MXX_LICENSE_KEYS);
      }
    }
    // Other failures (network, 5xx): trust local copy until next tick.
  } catch (e) {
    // Network/transient errors are non-fatal.
  }
}

function mxxScheduleHeartbeat() {
  try {
    if (!chrome.alarms || !chrome.alarms.create) return;
    // Random first-fire offset 1-6 min so 10k devices don't all hit on second 0.
    var firstDelayMin = 1 + Math.random() * 5;
    chrome.alarms.create(MXX_HEARTBEAT_ALARM, {
      delayInMinutes: firstDelayMin,
      periodInMinutes: 5,
    });
  } catch (e) {}
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm && alarm.name === MXX_HEARTBEAT_ALARM) mxxHeartbeat();
  });
}

mxxScheduleHeartbeat();
chrome.runtime.onInstalled.addListener(mxxScheduleHeartbeat);
chrome.runtime.onStartup.addListener(mxxScheduleHeartbeat);


function decodeJwtExpMs(token) {
  try {
    var parts = String(token || "").replace(/^Bearer\s+/i, "").trim().split(".");
    if (parts.length < 2) return 0;
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    var padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    var json = JSON.parse(atob(padded));
    return json.exp ? json.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

function normalizeJwtToken(token) {
  return String(token || "").replace(/^Bearer\s+/i, "").trim();
}

function pickBestJwtToken(candidates) {
  var best = "";
  var bestExp = 0;
  (candidates || []).forEach(function(item) {
    var t = normalizeJwtToken(item);
    if (!t || t.indexOf("eyJ") !== 0 || t.split(".").length !== 3) return;
    var exp = decodeJwtExpMs(t);
    if (!best || exp > bestExp) {
      best = t;
      bestExp = exp;
    }
  });
  return best;
}

function extractJwtTokensFromCookies(cookies) {
  var found = [];
  (cookies || []).forEach(function(cookie) {
    if (!cookie || !cookie.value) return;
    var value = String(cookie.value).replace(/^"|"$/g, "");
    if (value.indexOf("eyJ") === 0 && value.split(".").length === 3) {
      found.push(value);
    }
  });
  return found;
}

function projectIdFromUrl(url) {
  var m = String(url || "").match(/\/projects\/([0-9a-fA-F-]{36})/);
  return m ? m[1] : "";
}

var LOVABLE_TAB_URLS = ["*://lovable.dev/*", "*://*.lovable.dev/*"];

function findLovableProjectTab(callback) {
  chrome.storage.local.get(["lovable_projectId"], function (stored) {
    var storedPid = stored.lovable_projectId || "";
    chrome.windows.getCurrent(function (win) {
      chrome.tabs.query({ url: LOVABLE_TAB_URLS }, function (tabs) {
        var list = tabs || [];
        var activeProject = null;
        var storedMatch = null;
        var anyProject = null;
        var anyLovable = null;

        list.forEach(function (tab) {
          if (!tab || !tab.url || tab.url.indexOf("lovable.dev") === -1) return;
          if (!anyLovable) anyLovable = tab;
          var pid = projectIdFromUrl(tab.url);
          if (!pid) return;
          if (!anyProject) anyProject = tab;
          if (storedPid && pid === storedPid) storedMatch = tab;
          if (win && tab.windowId === win.id && tab.active) activeProject = tab;
        });

        callback(activeProject || storedMatch || anyProject || anyLovable || null);
      });
    });
  });
}

function tabPing(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, function (resp) {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(!!(resp && resp.ok));
    });
  });
}

var BRIDGE_INJECT_FILES = [
  
  "extension-config.js",
  "user-messages.js",
  "content-bridge.js"
];

function injectContentBridge(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: BRIDGE_INJECT_FILES
  });
}

function sendPromptOnTab(tabId, message, model) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, { action: "qlSendViaWs", message: message, model: model || "auto" }, function (resp) {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (resp && resp.ok) return resolve(resp);
      reject(new Error((resp && resp.error) || "Send failed"));
    });
  });
}

async function deliverPromptViaTab(message, model) {
  var tab = await new Promise(function (resolve) {
    findLovableProjectTab(resolve);
  });
  if (!tab || !tab.id) {
    throw new Error("Open your Lovable project on lovable.dev (project URL), then try again.");
  }
  if (!projectIdFromUrl(tab.url) && tab.url.indexOf("lovable.dev") === -1) {
    throw new Error("Open a lovable.dev project tab and refresh it after updating the extension.");
  }

  var tabId = tab.id;
  var alive = await tabPing(tabId);
  if (!alive) {
    try {
      await injectContentBridge(tabId);
      await new Promise(function (r) { setTimeout(r, 150); });
    } catch (e) {
      throw new Error("Could not attach to the Lovable tab. Refresh the project page and try again.");
    }
  }

  try {
    return await sendPromptOnTab(tabId, message, model);
  } catch (firstErr) {
    var errMsg = (firstErr && firstErr.message) || "";
    if (errMsg.indexOf("Receiving end") === -1 && errMsg.indexOf("Could not establish connection") === -1) {
      throw firstErr;
    }
    await injectContentBridge(tabId);
    await new Promise(function (r) { setTimeout(r, 200); });
    return await sendPromptOnTab(tabId, message, model);
  }
}

function collectLovableCookies(callback) {
  var domains = ["lovable.dev", ".lovable.dev"];
  var all = [];
  var pending = domains.length;
  if (!pending) return callback(all);
  domains.forEach(function(domain) {
    chrome.cookies.getAll({ domain: domain }, function(cookies) {
      if (cookies && cookies.length) all = all.concat(cookies);
      pending -= 1;
      if (pending === 0) callback(all);
    });
  });
}

function syncLovableAuth(tabUrl, hintProjectId, done) {
  collectLovableCookies(function(cookies) {
    var cookieToken = pickBestJwtToken(extractJwtTokensFromCookies(cookies));
    var projectId = projectIdFromUrl(tabUrl) || hintProjectId || "";
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function(stored) {
      var storedToken = normalizeJwtToken(stored.lovable_token || "");
      var token = storedToken;
      if (cookieToken && decodeJwtExpMs(cookieToken) >= decodeJwtExpMs(storedToken)) {
        token = cookieToken;
      }
      var updates = {};
      if (token) updates.lovable_token = token;
      if (projectId) updates.lovable_projectId = projectId;
      else if (stored.lovable_projectId) updates.lovable_projectId = stored.lovable_projectId;

      var finish = function(result) {
        if (typeof done === "function") done(result);
      };

      if (!Object.keys(updates).length) {
        finish({ ok: false, token: storedToken, projectId: stored.lovable_projectId || "" });
        return;
      }

      chrome.storage.local.set(updates, function() {
        finish({
          ok: !!token,
          token: updates.lovable_token || storedToken,
          projectId: updates.lovable_projectId || stored.lovable_projectId || "",
          fresh: decodeJwtExpMs(updates.lovable_token || storedToken) > Date.now() + 30000
        });
      });
    });
  });
}

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.status !== "complete" || !tab || !tab.url) return;
  if (tab.url.indexOf("lovable.dev") === -1) return;
  syncLovableAuth(tab.url, "", function() {
    try {
      chrome.tabs.sendMessage(tabId, { action: "requestTokenRefresh" }, function() {});
    } catch (e) {}
  });
});

function enableActionSidePanel() {
  try {
    chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true })
      .catch((err) => console.warn("[Background] sidePanel.setOptions:", err && err.message ? err.message : err));
  } catch (err) {
    console.warn("[Background] sidePanel.setOptions sync:", err && err.message ? err.message : err);
  }
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("[Background] sidePanel.setPanelBehavior:", err && err.message ? err.message : err));
  } catch (err) {
    console.warn("[Background] sidePanel.setPanelBehavior sync:", err && err.message ? err.message : err);
  }
}

function openMxxSidePanel(tab) {
  // Must be called synchronously inside a user gesture handler — no awaits before this point.
  if (!tab || !tab.id) return Promise.reject(new Error("Active tab not found."));
  enableActionSidePanel();
  var opener = (tab.windowId != null)
    ? chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId })
    : chrome.sidePanel.open({ tabId: tab.id });
  return opener.then(() => {
    chrome.storage.local.set({ ql_sidebar_mode: true });
    return { ok: true };
  });
}

enableActionSidePanel();
chrome.storage.local.set({ ql_sidebar_mode: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ ql_sidebar_mode: true });
  enableActionSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  enableActionSidePanel();
});

chrome.storage.local.get(["ql_sidebar_mode"], (res) => {
  if (res.ql_sidebar_mode !== true) {
    chrome.storage.local.set({ ql_sidebar_mode: true });
  }
  enableActionSidePanel();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ql_sidebar_mode) {
    enableActionSidePanel();
  }
  // Auto-push token to local OpenAI-compatible server whenever it changes
  if (area === "local" && (changes.lovable_token || changes.lovable_projectId)) {
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function(res) {
      var tok = res.lovable_token || "";
      var pid = res.lovable_projectId || "";
      if (!tok) return;
      var localPort = 8787;
      fetch("http://127.0.0.1:" + localPort + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tok, project_id: pid }),
      }).catch(function() {});
    });
  }
});

// Fallback in case setPanelBehavior didn't auto-open (e.g. policy / older Chrome).
// Called synchronously within the user gesture so chrome.sidePanel.open() is permitted.
chrome.action.onClicked.addListener((tab) => {
  openMxxSidePanel(tab).catch((err) => {
    console.error("[Background] action.onClicked sidePanel error:", err && err.message ? err.message : err);
  });
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "lovableSync") {
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function(stored) {
      const updates = {};
      if (msg.token) {
        var incoming = normalizeJwtToken(msg.token);
        var current = normalizeJwtToken(stored.lovable_token || "");
        if (incoming && (!current || decodeJwtExpMs(incoming) >= decodeJwtExpMs(current) - 5000)) {
          updates.lovable_token = incoming;
        }
      }
      if (msg.projectId) updates.lovable_projectId = msg.projectId;
      if (msg.browserSessionId) updates.lovable_browserSessionId = String(msg.browserSessionId).trim();
      if (Object.keys(updates).length) {
        chrome.storage.local.set(updates, function() {});
      }
    });
    return false;
  }

  if (msg && msg.action === "activateSidebar") {
    enableActionSidePanel();
    if (sender.tab && sender.tab.id) {
      openMxxSidePanel(sender.tab).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.warn("[Background] sidePanel.open deferred:", err.message);
        sendResponse({ ok: false, deferred: true, message: "Click the extension icon to open the side panel." });
      });
    } else {
      sendResponse({ ok: false, deferred: true, message: "Click the extension icon to open the side panel." });
    }
    return true;
  }

  if (msg && msg.action === "deactivateSidebar") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "openSidePanel") {
    if (sender.tab && sender.tab.id) {
      openMxxSidePanel(sender.tab).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.warn("[Background] openSidePanel deferred:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    } else {
      sendResponse({ ok: false, error: "No tab context" });
    }
    return true;
  }

  if (msg && msg.action === "proxyFetch") {
    (async () => {
      try {
        if (typeof MXX_DEBUG !== "undefined" && MXX_DEBUG) {
          console.log("[Background] proxyFetch ->", msg.url);
        }
        var opts = {
          method: msg.method || "POST",
          headers: msg.headers || {},
        };
        if (msg.body) opts.body = msg.body;
        var resp = await fetch(msg.url, opts);
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        if (!resp.ok && data && data.raw && typeof data.raw === "string") {
          var raw = data.raw.trim();
          if (/^error code: 502$/i.test(raw) || /^error code: 503$/i.test(raw)) {
            data.error_display = "Service is temporarily unavailable (gateway timeout). Try again in a few minutes.";
          } else if (raw.length > 120 && /<!DOCTYPE|<html|cloudflare|bad gateway/i.test(raw)) {
            data.error_display = "Service is temporarily unavailable. Try again in a few minutes.";
          }
        }
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      } catch (err) {
        console.error("[Background] proxyFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "Fetch failed in background" } });
      }
    })();
    return true;
  }

  if (msg && msg.action === "readCookies") {
    collectLovableCookies(function(cookies) {
      var tokens = extractJwtTokensFromCookies(cookies);
      var foundTokens = tokens.map(function(token, index) {
        return { token: token, cookieName: "scan-" + index, httpOnly: false };
      });
      sendResponse({ success: foundTokens.length > 0, tokens: foundTokens });
    });
    return true;
  }

  if (msg && msg.action === "syncLovableAuth") {
    syncLovableAuth(msg.tabUrl || "", msg.projectId || "", function(result) {
      sendResponse(result || { ok: false });
    });
    return true;
  }

  if (msg && msg.action === "getLovableCookies") {
    chrome.cookies.getAll({ domain: "lovable.dev" }, function (cookies) {
      var parts = [];
      if (cookies && cookies.length) {
        for (var i = 0; i < cookies.length; i++) {
          var c = cookies[i];
          if (c && c.name && typeof c.value === "string") {
            parts.push(c.name + "=" + c.value);
          }
        }
      }
      sendResponse({ ok: true, cookie: parts.join("; ") });
    });
    return true;
  }

  if (msg && msg.action === "sendPromptToLovable") {
    (async function () {
      try {
        await deliverPromptViaTab(msg.message || "", msg.model || "auto");
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Send failed" });
      }
    })();
    return true;
  }

  if (msg && msg.action === "downloadProject") {
    (async function () {
      try {
        var apiUrl = "https://lovable-api.com/projects/" + msg.projectId + "/source-code";
        var resp = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Authorization": "Bearer " + msg.token,
            "Accept": "application/json"
          }
        });
        if (!resp.ok) {
          sendResponse({ success: false, error: "API returned " + resp.status });
          return;
        }
        var data = await resp.json();
        sendResponse({ success: true, files: data.files || [] });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Download failed" });
      }
    })();
    return true;
  }

  if (msg && msg.action === "openTab") {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
    return true;
  }
});
