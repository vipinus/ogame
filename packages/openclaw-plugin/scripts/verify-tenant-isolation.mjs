#!/usr/bin/env node
/**
 * verify-tenant-isolation.mjs — runtime smoke verifier for the multi-tenant
 * sidecar invariants documented in docs/architecture/multi-tenant.md.
 *
 * NOT a unit test. Connects to the LIVE europa sidecar + PG and asserts the
 * isolation contract holds. Run anytime after a sidecar deploy, or after any
 * commit touching sidecar/index.ts, sidecar/tenant_context.ts, or
 * sidecar/multitenant_managers.ts. Exit code 0 on full pass, 1 on any fail.
 *
 * Why each check exists
 * ---------------------
 *   1. PG row identity — v0.0.858: a debounced write captured the wrong
 *      tenant's snapshot because setTimeout fired after stateRef.current was
 *      swapped. The Icarus universe ended up overwriting Ceti's PG row.
 *      Watchdog: re-read both rows, assert player.name matches the
 *      expected tenant.
 *
 *   2. Planet count sanity — v0.0.858 follow-up: Ceti is a new account with
 *      ≤ a handful of planets. If the row reports 22, Icarus's planet list
 *      pasted onto Ceti's uid again. (Sprint 1 fixed the symptom; this
 *      check guards against regression.)
 *
 *   3. Expedition config file separation — v0.0.838→842 (per-uid expedition):
 *      each tenant's ogamex-expedition-<uid>.json is supposed to live next
 *      to the legacy ogamex-expedition.json (operator). Verifies the new
 *      file exists and is distinct.
 *
 *   4. Discord webhook prefix — v0.0.857 incidents involved per-tenant
 *      side-channels leaking across boundaries; check user_settings has
 *      independent webhook URLs (or both empty, both fine).
 *
 *   5. No journal TypeErrors in last 10 min — broad guardrail. Multi-tenant
 *      regressions often surface as ReferenceError / TypeError when a
 *      handler runs under wrong ALS context (e.g., expedition modal GET
 *      with out-of-scope authHeaders, v0.0.855).
 *
 * Usage
 * -----
 *   node packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs
 *   node packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs --help
 *
 * Runs from any host that has `ssh ddxs@europa` configured. All sidecar /
 * PG / journal queries are routed via ssh. Local file checks (Sprint 4
 * config separation) also routed via ssh because the files live on europa.
 */

import { execSync } from "node:child_process";
import { argv, exit, stdout, stderr, env } from "node:process";

// ---------------------------------------------------------------------------
// Constants — adjust via env vars if tenant uids / names differ from defaults
// ---------------------------------------------------------------------------

const ICARUS_UID = env.VERIFY_ICARUS_UID || "4baba0e2-17ab-4275-a8eb-d642ba8d969f";
const ICARUS_EXPECTED_NAME = env.VERIFY_ICARUS_NAME || "Commander Icarus";

const CETI_UID = env.VERIFY_CETI_UID || "eb990432-7e6d-43b1-91d8-93b951729e87";
const CETI_EXPECTED_NAME = env.VERIFY_CETI_NAME || "Commodore Ceti";
const CETI_MAX_PLANETS = 5;

const SSH_TARGET = env.SSH_TARGET || "ddxs@europa";
const PG_CMD = `PGPASSWORD=ogamex psql -h 127.0.0.1 -U ogamex -d ogamex -At -F '|'`;
// v0.0.862 follow-up — real expedition state files live under runtime/,
// not the workspace root. Filenames use the 8-char uid prefix (see
// expedition.ts:templatePathForUid + http_server.ts:expeditionStateFileForUid).
const WORKSPACE_DIR = "~/.openclaw/workspace/ogamex/runtime";

// Optional Discord webhook for FAIL alerts. Leave unset to disable.
const DISCORD_WEBHOOK_URL = env.VERIFY_DISCORD_WEBHOOK_URL || "";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  exit(0);
}

const QUIET = argv.includes("--quiet") || argv.includes("-q");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const isTTY = stdout.isTTY;
const C = {
  green: (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red:   (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  bold:  (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim:   (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  if (QUIET) return;
  console.log(`${C.green("[PASS]")} ${name}${detail ? ` — ${C.dim(detail)}` : ""}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  // FAIL lines always print, even in --quiet (cron needs the signal).
  console.log(`${C.red("[FAIL]")} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// SSH wrappers
// ---------------------------------------------------------------------------

function ssh(cmd) {
  // Single-quote-safe wrap: pass cmd as a single argv to `ssh ddxs@europa`
  // and let the remote sh interpret it.
  const buf = execSync(`ssh -o BatchMode=yes ${SSH_TARGET} ${shellEscape(cmd)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  return buf.toString();
}

function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function pgQuery(sql) {
  const cmd = `${PG_CMD} -c "${sql.replace(/"/g, '\\"')}"`;
  return ssh(cmd).trim();
}

// ---------------------------------------------------------------------------
// Check 1 — PG row identity
// ---------------------------------------------------------------------------

function checkPgRowIdentity() {
  const name = "pg-row-identity";
  let icarus, ceti;
  try {
    icarus = pgQuery(
      `SELECT json->'player'->>'name' FROM ogame_world_state WHERE user_id = '${ICARUS_UID}'`,
    );
    ceti = pgQuery(
      `SELECT json->'player'->>'name' FROM ogame_world_state WHERE user_id = '${CETI_UID}'`,
    );
  } catch (e) {
    fail(name, `query error: ${e.message}`);
    return;
  }

  const detail = `Icarus row → "${icarus}"; Ceti row → "${ceti}"`;
  if (icarus === ICARUS_EXPECTED_NAME && ceti === CETI_EXPECTED_NAME) {
    pass(name, detail);
  } else {
    fail(name, `expected Icarus="${ICARUS_EXPECTED_NAME}" Ceti="${CETI_EXPECTED_NAME}"; got ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Check 2 — planet count sanity
// ---------------------------------------------------------------------------

function checkPlanetCountSanity() {
  const name = "ceti-planet-count";
  let raw;
  try {
    // v0.0.862 follow-up — planets is JSONB OBJECT (planet_id → planet_obj),
    // not an array. json_array_length errors out; count keys instead.
    raw = pgQuery(
      `SELECT (SELECT count(*) FROM jsonb_object_keys(json->'planets')) FROM ogame_world_state WHERE user_id = '${CETI_UID}'`,
    );
  } catch (e) {
    fail(name, `query error: ${e.message}`);
    return;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    fail(name, `non-numeric planet count: "${raw}"`);
    return;
  }
  if (n <= CETI_MAX_PLANETS) {
    pass(name, `Ceti has ${n} planets (≤ ${CETI_MAX_PLANETS} guard)`);
  } else {
    fail(name, `Ceti has ${n} planets, expected ≤ ${CETI_MAX_PLANETS} (v0.0.858 pollution?)`);
  }
}

// ---------------------------------------------------------------------------
// Check 3 — expedition config file separation
// ---------------------------------------------------------------------------

function checkExpeditionConfigFiles() {
  const name = "expedition-config-separation";
  let listing;
  try {
    // List both files with size; "|| true" so missing file doesn't kill ssh.
    listing = ssh(
      `ls -la ${WORKSPACE_DIR}/ogamex-expedition.json ${WORKSPACE_DIR}/ogamex-expedition-${CETI_UID.slice(0, 8)}.json 2>&1 || true`,
    );
  } catch (e) {
    fail(name, `ssh error: ${e.message}`);
    return;
  }

  const lines = listing.split("\n").map((l) => l.trim()).filter(Boolean);
  const legacyLine = lines.find((l) => l.endsWith("ogamex-expedition.json"));
  const ctiLine    = lines.find((l) => l.endsWith(`ogamex-expedition-${CETI_UID.slice(0, 8)}.json`));

  if (!ctiLine) {
    fail(name, `missing per-uid file ogamex-expedition-${CETI_UID.slice(0, 8)}.json. ls output:\n${listing}`);
    return;
  }

  const detail = [
    legacyLine ? `legacy: ${legacyLine}` : "legacy: (absent — operator never used expedition?)",
    `ceti:   ${ctiLine}`,
  ].join("; ");
  pass(name, detail);
}

// ---------------------------------------------------------------------------
// Check 4 — Discord webhook prefix
// ---------------------------------------------------------------------------

function checkDiscordWebhooks() {
  const name = "discord-webhook-prefix";
  let raw;
  try {
    raw = pgQuery(
      `SELECT user_id, COALESCE(LEFT(discord_webhook_url, 40), '') FROM user_settings WHERE user_id IN ('${ICARUS_UID}', '${CETI_UID}') ORDER BY user_id`,
    );
  } catch (e) {
    fail(name, `query error: ${e.message}`);
    return;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) {
    pass(name, "no user_settings rows for either tenant (clean state)");
    return;
  }
  // Always pass — this check is informational; print prefixes so operator
  // can eyeball cross-tenant leak by hand.
  const summary = lines.map((l) => {
    const [uid, prefix] = l.split("|");
    const tag = uid === ICARUS_UID ? "icarus" : uid === CETI_UID ? "ceti" : "?";
    return `${tag}=${prefix || "(empty)"}`;
  }).join(", ");
  pass(name, summary);
}

// ---------------------------------------------------------------------------
// Check 5 — no journal TypeErrors / ReferenceErrors in last 10 min
// ---------------------------------------------------------------------------

function checkJournalErrors() {
  const name = "journal-no-typeerror-10min";
  let hits;
  try {
    hits = ssh(
      `journalctl --user --since '10 min ago' --no-pager 2>/dev/null | grep -E 'TypeError|ReferenceError' || true`,
    ).trim();
  } catch (e) {
    fail(name, `journalctl error: ${e.message}`);
    return;
  }
  if (!hits) {
    pass(name, "clean — 0 TypeError / ReferenceError lines");
    return;
  }
  const lineCount = hits.split("\n").length;
  fail(name, `${lineCount} error line(s) in last 10 min; first 3:\n${hits.split("\n").slice(0, 3).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sanity gate — refuse to run if ssh target unreachable. Avoids cron spam
// during europa reboot windows (5 ssh-error FAILs back-to-back).
// ---------------------------------------------------------------------------

function sanityGateSshReachable() {
  try {
    execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=3 ${SSH_TARGET} true`,
      { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 },
    );
    return true;
  } catch (e) {
    stderr.write(`[ERROR] ${SSH_TARGET} unreachable — abort\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discord webhook alert (optional, fire-and-forget)
// ---------------------------------------------------------------------------

async function postFailureWebhook(passed, total, failedNames) {
  if (!DISCORD_WEBHOOK_URL) return;
  const ts = new Date().toISOString();
  const body = {
    content: `🚨 ogamex tenant-isolation FAIL — ${passed}/${total} checks passed at ${ts}. Failed: ${failedNames.join(", ")}.`,
  };
  try {
    const resp = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Discord returns 204; httpbin returns 200. Don't enforce — just log.
    if (!resp.ok) {
      stderr.write(`webhook post non-2xx: ${resp.status} ${resp.statusText}\n`);
    }
  } catch (err) {
    stderr.write(`webhook post failed: ${err?.message || err}\n`);
  }
}

async function main() {
  if (!sanityGateSshReachable()) {
    exit(2);
  }

  if (!QUIET) {
    console.log(C.bold("tenant-isolation verifier"));
    console.log(C.dim(`  ssh target: ${SSH_TARGET}`));
    console.log(C.dim(`  tenants:    icarus=${ICARUS_UID}`));
    console.log(C.dim(`              ceti=${CETI_UID}`));
    console.log("");
  }

  checkPgRowIdentity();
  checkPlanetCountSanity();
  checkExpeditionConfigFiles();
  checkDiscordWebhooks();
  checkJournalErrors();

  if (!QUIET) console.log("");
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const failed = results.filter((r) => !r.ok);
  const summary = `tenant-isolation: ${passed}/${total} checks passed`;
  if (passed === total) {
    console.log(C.green(C.bold(summary)));
    exit(0);
  } else {
    console.log(C.red(C.bold(summary)));
    // Fire-and-forget webhook; never mask the exit code.
    await postFailureWebhook(passed, total, failed.map((r) => r.name));
    exit(1);
  }
}

function printHelp() {
  console.log(`verify-tenant-isolation.mjs — runtime sidecar isolation smoke verifier

USAGE
  node packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs [--quiet]
  node packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs --help

FLAGS
  --quiet, -q    Suppress per-check PASS lines and the header. Only the
                 final summary line plus any FAIL lines are printed. Use
                 from cron / systemd timer to keep the journal clean.
  --help, -h     Show this help.

ENV VARS (all optional; defaults match the operator's europa setup)
  VERIFY_ICARUS_UID            override Icarus tenant uid (default:
                               4baba0e2-17ab-4275-a8eb-d642ba8d969f)
  VERIFY_ICARUS_NAME           override expected Icarus player.name
                               (default: "Commander Icarus")
  VERIFY_CETI_UID              override Ceti tenant uid (default:
                               eb990432-7e6d-43b1-91d8-93b951729e87)
  VERIFY_CETI_NAME             override expected Ceti player.name
                               (default: "Commodore Ceti")
  SSH_TARGET                   override ssh user@host (default: ddxs@europa)
  VERIFY_DISCORD_WEBHOOK_URL   if set, POST a one-line FAIL summary to
                               this Discord-compatible webhook when any
                               check fails. Fire-and-forget; does NOT
                               mask the exit code on webhook error.

WHAT IT DOES
  Connects to europa via ssh and asserts the per-tenant invariants
  documented in docs/architecture/multi-tenant.md. Exits 0 on full pass,
  1 on any fail, 2 if the ssh target is unreachable (sanity gate).

CHECKS
  1. pg-row-identity            — Icarus / Ceti universe rows have the right
                                   player.name; no cross-tenant overwrite
                                   (v0.0.858 regression guard).
  2. ceti-planet-count          — Ceti's planet array is ≤ ${CETI_MAX_PLANETS} entries
                                   (a 22-planet Ceti = Icarus data pasted).
  3. expedition-config-separation — ogamex-expedition-<ceti-uid>.json exists
                                    in ${WORKSPACE_DIR}
                                    (v0.0.838→842 per-uid expedition).
  4. discord-webhook-prefix     — prints user_settings webhook prefixes for
                                   both tenants so cross-tenant leak is
                                   eyeballable; informational, always passes.
  5. journal-no-typeerror-10min — sidecar journal clean of TypeError /
                                   ReferenceError in the last 10 min
                                   (broad multi-tenant regression net).

REQUIREMENTS
  - \`ssh ddxs@europa\` configured and reachable (BatchMode — no prompts).
  - PG running on europa with PGPASSWORD=ogamex / db=ogamex.
  - User-level systemd journal accessible via journalctl --user.

EXIT
  0 — all checks passed
  1 — at least one [FAIL] line; see output for details
  2 — ssh target unreachable (sanity gate; safe-no-op for cron)
`);
}

main();
