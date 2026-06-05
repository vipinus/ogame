/**
 * OgameX CF tunnel path router — single ingress (ogame.anyfq.com → :9090)
 * fans out to:
 *   /ogamex/*    → sidecar HTTP  (127.0.0.1:28791)   panel + control API
 *   /ws          → sidecar WS    (127.0.0.1:28791)   same-port upgrade, keep /ws path
 *   /bundle/*    → bundle server (127.0.0.1:8765)    userscript download
 *
 * Reason for this layer: CF tunnel ingress (token-managed) routes by host,
 * not path. Pointing ogame.anyfq.com → this router lets us reuse one DNS
 * record + one ingress entry to serve every backend behind HTTPS via CF —
 * no self-signed certs, no per-port subdomains.
 */
import http from "node:http";
import net from "node:net";

// Don't die on socket EPIPE from half-closed client connections — CF
// closes idle tunnels eagerly and the proxy code writes to them.
process.on("uncaughtException", (e) => {
  if (e && (e.code === "EPIPE" || e.code === "ECONNRESET")) {
    console.warn("[router] swallowed socket error:", e.code);
    return;
  }
  console.error("[router] uncaughtException:", e);
});
process.on("unhandledRejection", (r) => console.error("[router] unhandledRejection:", r));

const PORT = 9090;
const TARGETS = {
  sidecar_http: { host: "127.0.0.1", port: 28791 },
  sidecar_ws:   { host: "127.0.0.1", port: 28791 },
  bundle:       { host: "127.0.0.1", port: 8765  },
  next:         { host: "127.0.0.1", port: 3002  },
};

function pickRoute(url) {
  if (url.startsWith("/ogamex/")) {
    return { target: TARGETS.sidecar_http, rewritePath: url };
  }
  // Bundle paths — accept either /bundle/* or /dl/* (the latter lets us
  // switch the canonical URL without colliding with a stale CF cache
  // entry for the old path).
  if (url.startsWith("/bundle/")) {
    return { target: TARGETS.bundle, rewritePath: url.slice("/bundle".length) || "/", isBundle: true };
  }
  if (url.startsWith("/dl/")) {
    return { target: TARGETS.bundle, rewritePath: url.slice("/dl".length) || "/", isBundle: true };
  }
  // v2 — anything else falls through to Next.js (ogame.anyfq.com/)
  return { target: TARGETS.next, rewritePath: url };
}

const server = http.createServer((req, res) => {
  const route = pickRoute(req.url ?? "/");
  if (!route) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("ogamex cf-router: unknown path. valid: /ogamex/*, /bundle/*, ws://.../ws\n");
    return;
  }
  const { target, rewritePath } = route;
  const headers = { ...req.headers };
  headers["host"] = `${target.host}:${target.port}`;
  const u = http.request({
    host: target.host, port: target.port, method: req.method,
    path: rewritePath, headers,
  }, (ur) => {
    // Force CF edge to NOT cache /bundle/* — the served file is mutated
    // in place when we re-bake versions or URLs. Without this, CF caches
    // the first response (often stale) for hours and userscript clients
    // never see updates even after @version bumps.
    const outHeaders = { ...ur.headers };
    if (route.isBundle) {
      outHeaders["cache-control"] = "no-store, no-cache, must-revalidate, max-age=0";
      outHeaders["pragma"] = "no-cache";
      outHeaders["expires"] = "0";
      // CF specific — bypass edge cache for this response.
      outHeaders["cdn-cache-control"] = "no-store";
    }
    res.writeHead(ur.statusCode ?? 502, outHeaders);
    ur.pipe(res);
  });
  u.on("error", (e) => {
    console.error(`[router] upstream ${target.host}:${target.port} error`, e.message);
    if (!res.headersSent) { res.statusCode = 502; res.end(`upstream error: ${e.message}`); }
  });
  req.pipe(u);
});

// WebSocket upgrade — only the /ws path; rewrite to "/" since the sidecar's
// ws server doesn't care about the path. Subprotocol (bearer.<token>)
// pass-through untouched.
server.on("upgrade", (req, clientSocket, head) => {
  if (req.url !== "/ws") {
    clientSocket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const t = TARGETS.sidecar_ws;
  const upstream = net.connect(t.port, t.host, () => {
    // Forward the original handshake with path rewritten to "/".
    const headerLines = [
      `GET /ws HTTP/1.1`,
      `Host: ${t.host}:${t.port}`,
    ];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host") continue;
      headerLines.push(`${k}: ${v}`);
    }
    upstream.write(headerLines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (e) => {
    console.error("[router] ws upstream error", e.message);
    clientSocket.destroy();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[router] listening on 0.0.0.0:${PORT}`);
  console.log(`[router] routes: /ogamex/* -> ${TARGETS.sidecar_http.host}:${TARGETS.sidecar_http.port}`);
  console.log(`[router]         /ws       -> ${TARGETS.sidecar_ws.host}:${TARGETS.sidecar_ws.port}  (WS upgrade, path -> /)`);
  console.log(`[router]         /bundle/* -> ${TARGETS.bundle.host}:${TARGETS.bundle.port}`);
});
