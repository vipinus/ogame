/**
 * M8.5 — Renders a DebugBuffer snapshot as a self-contained HTML5 document
 * served by `/ogamex/v1/debug`. No template engine: string concatenation with
 * strict HTML escaping on every interpolated field. The page is operator-only
 * (no auth), so XSS prevention here matters — directive.reason and event
 * payloads originate from userscript-supplied data and must never reach the
 * browser unescaped.
 */
import type {
  DebugDirectiveEntry,
  DebugEventEntry,
} from "./debug_buffer.js";

/** Escape the five XML/HTML metacharacters. Order matters: `&` first. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTs(ts: number): string {
  return `<span class="ts">${escapeHtml(new Date(ts).toISOString())}</span>`;
}

function renderDirectiveRow(e: DebugDirectiveEntry): string {
  const d = e.directive;
  const stateCls = e.state === "completed" ? "state-completed" : "state-dispatched";
  const resultCell =
    e.state === "completed"
      ? `<pre>${escapeHtml(safeStringify(e.result))}</pre>`
      : "";
  return (
    "<tr>" +
    `<td>${fmtTs(e.ts)}</td>` +
    `<td>${escapeHtml(d.source)}</td>` +
    `<td>${escapeHtml(d.action)}</td>` +
    `<td class="${stateCls}">${escapeHtml(e.state)}</td>` +
    `<td>${escapeHtml(d.reason)}</td>` +
    `<td>${resultCell}</td>` +
    "</tr>"
  );
}

function renderEventRow(e: DebugEventEntry): string {
  // Drop the `type` field from the payload pre — it's already in its own
  // column, and the duplication is noise when scanning the page.
  const { type, ...rest } = e.msg as { type: string } & Record<string, unknown>;
  const payload = Object.keys(rest).length > 0 ? safeStringify(rest) : "";
  return (
    "<tr>" +
    `<td>${fmtTs(e.ts)}</td>` +
    `<td>${escapeHtml(type)}</td>` +
    `<td><pre>${escapeHtml(payload)}</pre></td>` +
    "</tr>"
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    // Circular or non-serialisable payloads (shouldn't happen on the wire,
    // but UpstreamMsg.result is typed `unknown` — defend against it anyway).
    return String(v);
  }
}

export function renderDebugHtml(snap: {
  directives: DebugDirectiveEntry[];
  events: DebugEventEntry[];
}): string {
  const directiveRows = snap.directives.map(renderDirectiveRow).join("");
  const eventRows = snap.events.map(renderEventRow).join("");
  const generated = escapeHtml(new Date().toISOString());

  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    "<title>OgameX debug</title>\n" +
    "<style>\n" +
    "  body { font-family: -apple-system, sans-serif; max-width: 1200px; margin: 1em auto; padding: 0 1em; }\n" +
    "  h1 { font-size: 1.5em; }\n" +
    "  table { border-collapse: collapse; width: 100%; font-size: 0.85em; margin-bottom: 2em; }\n" +
    "  th, td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }\n" +
    "  th { background: #f4f4f4; }\n" +
    "  .ts { font-family: monospace; color: #666; white-space: nowrap; }\n" +
    "  .state-dispatched { color: #999; }\n" +
    "  .state-completed { color: #080; }\n" +
    "  pre { background: #f8f8f8; padding: 4px; margin: 0; white-space: pre-wrap; font-size: 0.85em; }\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "<h1>OgameX debug</h1>\n" +
    `<p>Generated: <code>${generated}</code></p>\n` +
    `<h2>Recent directives (${snap.directives.length})</h2>\n` +
    "<table>\n" +
    "<tr><th>Time</th><th>Source</th><th>Action</th><th>State</th><th>Reason</th><th>Result</th></tr>\n" +
    directiveRows +
    "\n</table>\n" +
    `<h2>Recent events (${snap.events.length})</h2>\n` +
    "<table>\n" +
    "<tr><th>Time</th><th>Type</th><th>Payload</th></tr>\n" +
    eventRows +
    "\n</table>\n" +
    "</body>\n" +
    "</html>\n"
  );
}
