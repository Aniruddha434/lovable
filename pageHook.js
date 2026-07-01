(function () {
  var DEBUG = false;
  try { DEBUG = !!(window.localStorage && window.localStorage.getItem("ql_debug") === "1"); } catch (e) {}
  var log = DEBUG ? console.log.bind(console) : function () {};
  if (DEBUG) log("[MasterLovableHook] Iniciando v3.8.6 (debug)");

  window.__qlLastMessage = "";
  window.__qlFixTimer = null;

  let bypassActive = false;
  let capturedToken = null;
  let capturedProjectId = null;
  let wsConnections = [];

  // ---------------------------------------------------------------------------
  // Inbound bridge: send a payload through one of the captured WebSockets
  // ---------------------------------------------------------------------------
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) {
      return;
    }

    if (event.data.type === "qlBypassState") {
      bypassActive = !!event.data.active;
      return;
    }

    if (event.data.type !== "lovableSendViaWs") {
      return;
    }

    const openConnections = wsConnections.filter(
      conn => conn.ws.readyState === WebSocket.OPEN
    );

    if (!openConnections.length) {
      console.warn("[MasterLovableHook] Nenhum WS aberto para injeção");
      window.postMessage({
        type: "lovableWsSendResult",
        success: false,
        error: "Nenhuma conexão WebSocket ativa"
      }, "*");
      return;
    }

    const lastConnection = openConnections[openConnections.length - 1];
    try {
      const payload = typeof event.data.payload === "string"
        ? event.data.payload
        : JSON.stringify(event.data.payload);
      lastConnection.origSend(payload);
      log("[MasterLovableHook] WS INJECT →", payload.slice(0, 300));
      window.postMessage({ type: "lovableWsSendResult", success: true }, "*");
    } catch (err) {
      console.warn("[MasterLovableHook] WS inject erro:", err);
      window.postMessage({
        type: "lovableWsSendResult",
        success: false,
        error: err.message
      }, "*");
    }
  });

  // ---------------------------------------------------------------------------
  // Project id helpers
  // ---------------------------------------------------------------------------
  function getProjectIdFromPath() {
    try {
      const match = window.location.pathname.match(/projects\/([0-9a-fA-F-]{36})/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function getProjectIdFromUrl(url) {
    try {
      const match = String(url).match(/projects\/([0-9a-fA-F-]{36})/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Token capture + reporting
  // ---------------------------------------------------------------------------
  function reportToken(rawAuth, projectIdArg, force = false) {
    const projectId = projectIdArg || getProjectIdFromPath();
    const token = typeof rawAuth === "string"
      ? rawAuth.replace(/^Bearer\s+/i, "").trim()
      : null;

    let changed = false;
    if (token && token !== capturedToken) {
      capturedToken = token;
      changed = true;
    }
    if (projectId && projectId !== capturedProjectId) {
      capturedProjectId = projectId;
      changed = true;
    }

    if (!changed && !force) {
      return;
    }

    log("[MasterLovableHook] ✅ Token capturado!", capturedToken || "null");
    log("[MasterLovableHook] ProjectId:", capturedProjectId);
    window.postMessage({
      type: "lovableTokenFound",
      token: capturedToken,
      projectId: capturedProjectId
    }, window.location.origin);
  }

  // On-demand token request from the rest of the extension
  window.addEventListener("message", event => {
    if (event.source !== window) {
      return;
    }
    if (!event.data || event.data.type !== "lovableRequestToken") {
      return;
    }
    reportToken(capturedToken, getProjectIdFromPath() || capturedProjectId, true);
  });

  // ---------------------------------------------------------------------------
  // fetch() hook: capture Authorization header + inject fix_error intent
  // ---------------------------------------------------------------------------
  (function hookFetch() {
    try {
      const originalFetch = window.fetch;
      window.fetch = async function (...args) {
        // --- token capture ---
        try {
          let url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          let init = args[1] || {};
          let auth = null;

          const isRequest = args[0] instanceof Request;
          if (isRequest) {
            url = args[0].url || url;
            auth = args[0].headers && typeof args[0].headers.get === "function"
              ? args[0].headers.get("Authorization") || args[0].headers.get("authorization")
              : null;
          }
          if (init.headers) {
            if (init.headers instanceof Headers) {
              auth = init.headers.get("Authorization");
            } else if (typeof init.headers === "object") {
              auth = init.headers.Authorization || init.headers.authorization;
            }
          }

          const projectId = getProjectIdFromUrl(url);
          if (auth && auth.startsWith("Bearer ")) {
            reportToken(auth.slice(7), projectId);
          }
        } catch (e) {}

        // --- fix_error injection ---
        try {
          const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          const isRequest = args[0] instanceof Request;
          const method = (isRequest
            ? args[0].method || "GET"
            : (args[1] || {}).method || "GET").toUpperCase();

          const isLovablePost = url && method === "POST" && (
            url.includes("api.lovable.dev") ||
            url.includes("api.lovable.app") ||
            url.includes("lovable-api.com") ||
            url.includes("lovable.dev")
          );

          if (isLovablePost) {
            if (isRequest) {
              try {
                const originalRequest = args[0];
                const cloned = originalRequest.clone();
                const text = await cloned.text();
                if (text) {
                  const body = JSON.parse(text);
                  if (bypassActive && body && typeof body.message === "string" && body.message.length > 0) {
                    const buildState = window.__qlBuildState;
                    const eventId = buildState && buildState.eventId ? buildState.eventId : "";
                    const errorMessage = buildState && buildState.errorMessage
                      ? buildState.errorMessage
                      : "src/App.tsx(1,7): error TS2322: Type 'number' is not assignable to type 'string'.";

                    body.intent = "fix_error";
                    body.contains_error = true;
                    body.error_source = "build_errors";
                    body.error_ids = eventId ? [eventId] : [];
                    body.message_intent_metadata = {
                      fix_error_metadata: {
                        errors: [{
                          error_type: "build",
                          error_message: errorMessage,
                          build_event_id: eventId
                        }]
                      }
                    };

                    const newRequest = new Request(originalRequest.url, {
                      method: originalRequest.method,
                      headers: originalRequest.headers,
                      body: JSON.stringify(body),
                      mode: originalRequest.mode,
                      credentials: originalRequest.credentials,
                      cache: originalRequest.cache,
                      redirect: originalRequest.redirect
                    });
                    args = [newRequest];

                    window.__qlLastMessage = body.message || "";
                    if (window.__qlFixTimer) {
                      clearInterval(window.__qlFixTimer);
                    }
                    let ticks = 0;
                    window.__qlFixTimer = setInterval(function () {
                      ticks++;
                      if (!window.__qlLastMessage || ticks > 100) {
                        clearInterval(window.__qlFixTimer);
                        return;
                      }
                      document.querySelectorAll("div.special-message").forEach(function (el) {
                        if (el.textContent.trim() === "Fix errors") {
                          el.textContent = window.__qlLastMessage;
                        }
                      });
                    }, 100);
                    log("[MasterLovableHook] 💉 fix_error injetado (Request) evId:", eventId || "NENHUM", "| msg:", body.message.slice(0, 60));
                  }
                }
              } catch (e) {
                console.warn("[MasterLovableHook] erro bypass Request:", e);
              }
            } else {
              const init = args[1] || {};
              const rawBody = init.body;
              if (rawBody && typeof rawBody === "string") {
                try {
                  const body = JSON.parse(rawBody);
                  if (bypassActive && body && typeof body.message === "string" && body.message.length > 0) {
                    const buildState = window.__qlBuildState;
                    const eventId = buildState && buildState.eventId ? buildState.eventId : "";
                    const errorMessage = buildState && buildState.errorMessage
                      ? buildState.errorMessage
                      : "src/App.tsx(1,7): error TS2322: Type 'number' is not assignable to type 'string'.";

                    body.intent = "fix_error";
                    body.contains_error = true;
                    body.error_source = "build_errors";
                    body.error_ids = eventId ? [eventId] : [];
                    body.message_intent_metadata = {
                      fix_error_metadata: {
                        errors: [{
                          error_type: "build",
                          error_message: errorMessage,
                          build_event_id: eventId
                        }]
                      }
                    };

                    args = [args[0], Object.assign({}, init, { body: JSON.stringify(body) })];

                    window.__qlLastMessage = body.message || "";
                    if (window.__qlFixTimer) {
                      clearInterval(window.__qlFixTimer);
                    }
                    let ticks = 0;
                    window.__qlFixTimer = setInterval(function () {
                      ticks++;
                      if (!window.__qlLastMessage || ticks > 100) {
                        clearInterval(window.__qlFixTimer);
                        return;
                      }
                      document.querySelectorAll("div.special-message").forEach(function (el) {
                        if (el.textContent.trim() === "Fix errors") {
                          el.textContent = window.__qlLastMessage;
                        }
                      });
                    }, 100);
                    log("[MasterLovableHook] 💉 fix_error injetado evId:", eventId || "NENHUM", "| msg:", body.message.slice(0, 60));
                  }
                } catch (e) {
                  console.warn("[MasterLovableHook] erro bypass opts:", e);
                }
              }
            }
          }
        } catch (e) {}

        return originalFetch.apply(this, args);
      };
    } catch (e) {
      console.warn("[MasterLovableHook] erro fetch", e);
    }
  })();

  // ---------------------------------------------------------------------------
  // XMLHttpRequest hook: capture Authorization header
  // ---------------------------------------------------------------------------
  (function hookXhr() {
    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function (method, url) {
        this._lovable_url = url;
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name && name.toLowerCase() === "authorization" && value && value.startsWith("Bearer ")) {
          reportToken(value.slice(7), getProjectIdFromUrl(this._lovable_url));
        }
        return originalSetRequestHeader.apply(this, arguments);
      };
    } catch (e) {
      console.warn("[MasterLovableHook] erro xhr", e);
    }
  })();

  // ---------------------------------------------------------------------------
  // Poll for project id changes (SPA navigation)
  // ---------------------------------------------------------------------------
  setInterval(() => {
    const projectId = getProjectIdFromPath();
    if (projectId && projectId !== capturedProjectId) {
      capturedProjectId = projectId;
      window.postMessage({
        type: "lovableTokenFound",
        token: capturedToken,
        projectId: projectId
      }, window.location.origin);
    }
  }, 5000);

  // ---------------------------------------------------------------------------
  // WebSocket hook: register connections, inject fix_error, capture build ids
  // ---------------------------------------------------------------------------
  log("[MasterLovableHook] wrapWS: window.WebSocket =", typeof window.WebSocket);

  (function hookWebSocket() {
    try {
      const NativeWebSocket = window.WebSocket;

      function WrappedWebSocket(url, protocols) {
        const ws = protocols ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
        const urlStr = String(url);
        const origSend = ws.send.bind(ws);
        const safeUrl = urlStr
          .replace(/token=[^&]+/g, "token=***")
          .replace(/key=[^&]+/g, "key=***");

        log("[MasterLovableHook] WS conectando →", safeUrl);

        const isTracked = urlStr.includes("lovable") ||
          urlStr.includes("trajectory") ||
          urlStr.includes("supabase") ||
          urlStr.includes("convex");

        if (isTracked) {
          wsConnections = wsConnections.filter(conn => conn.ws.readyState !== WebSocket.CLOSED);
          wsConnections.push({ ws: ws, origSend: origSend });
          window.postMessage({ type: "lovableWsConnected", url: safeUrl }, "*");
        }

        // Outgoing message interception
        ws.send = function (data) {
          try {
            const preview = typeof data === "string" ? data.slice(0, 800) : "[binary]";
            log("[MasterLovableHook] WS SEND [" + safeUrl.slice(0, 60) + "] →", preview);

            if (bypassActive && typeof data === "string" && data.length > 2) {
              try {
                const parsed = JSON.parse(data);
                if (parsed && typeof parsed.message === "string" && parsed.message.length > 0) {
                  parsed.intent = "fix_error";
                  parsed.message_intent_metadata = { fix_error_metadata: { errors: [] } };
                  data = JSON.stringify(parsed);
                  log("[MasterLovableHook] 💉 fix_error injetado (WS):", parsed.message.slice(0, 80));
                } else if (parsed && parsed.type === "Mutation" && parsed.args) {
                  const arg = Array.isArray(parsed.args) ? parsed.args[0] : parsed.args;
                  if (arg && typeof arg.message === "string" && arg.message.length > 0) {
                    arg.intent = "fix_error";
                    arg.message_intent_metadata = { fix_error_metadata: { errors: [] } };
                    if (Array.isArray(parsed.args)) {
                      parsed.args[0] = arg;
                    } else {
                      parsed.args = arg;
                    }
                    data = JSON.stringify(parsed);
                    log("[MasterLovableHook] 💉 fix_error injetado (WS Convex):", arg.message.slice(0, 80));
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}

          return origSend(data);
        };

        // Incoming message: capture build_event_id when a typecheck error occurs
        ws.addEventListener("message", event => {
          try {
            const preview = typeof event.data === "string" ? event.data.slice(0, 300) : "[binary]";
            log("[MasterLovableHook] WS RECV [" + safeUrl.slice(0, 60) + "] ←", preview);
            if (typeof event.data === "string") {
              window.postMessage({ type: "lovableWsMessage", data: event.data }, window.location.origin);
            }

            if (typeof event.data === "string" && event.data.includes("#bld:") && event.data.includes("hasError")) {
              try {
                const parsed = JSON.parse(event.data);
                if (parsed && parsed.type === "trajectory" && parsed.event && parsed.event.id && parsed.event.payload) {
                  const eventId = parsed.event.id.value || "";
                  const build = parsed.event.payload.build;
                  if (eventId.includes("#bld:") && build && build.buildErrors && build.buildErrors.typecheck && build.buildErrors.typecheck.hasError) {
                    const output = build.buildErrors.typecheck.output || "";
                    if (output) {
                      const firstLine = output.trim().split("\n")[0];
                      window.__qlBuildState = { eventId: eventId, errorMessage: firstLine };
                      log("[MasterLovableHook] 📐 build_event_id capturado:", eventId, "|", firstLine.slice(0, 80));
                    }
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
        });

        return ws;
      }

      try {
        Object.defineProperty(window, "WebSocket", {
          value: WrappedWebSocket,
          writable: true,
          configurable: true
        });
      } catch (e) {
        window.WebSocket = WrappedWebSocket;
      }

      WrappedWebSocket.prototype = NativeWebSocket.prototype;
      WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
      WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
      WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;

      if (window.WebSocket !== WrappedWebSocket) {
        console.warn("[MasterLovableHook] ⚠️ WebSocket NÃO substituído — propriedade bloqueada!");
      } else {
        log("[MasterLovableHook] ✅ WebSocket substituído com sucesso");
      }
    } catch (e) {
      console.warn("[MasterLovableHook] erro ws wrap", e);
    }
  })();
})();
