import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { Strategy } from "@ogamex/shared";

/**
 * StrategyManager — git-backed CRUD for the Strategy document (M6.1).
 *
 * Each mutation produces a new git commit titled "v${version}: ${reason}",
 * so we get a free audit trail and the ability to roll back to any prior
 * version by replaying its file content as a NEW commit on top.
 *
 * Git is invoked via `node:child_process.spawnSync` — no npm git library —
 * because every target machine has the `git` CLI on PATH.
 */

export interface StrategyManagerOptions {
  /** Path to the git-tracked directory. Tests use a tmp dir; prod uses ~/.openclaw/workspace/ogamex-strategy. */
  repoDir: string;
  /** Filename inside repoDir. Default "strategy.json". */
  filename?: string;
  /** Initial strategy if repo is empty / file doesn't exist. */
  defaultStrategy: Strategy;
}

export interface HistoryEntry {
  version: number;
  updated_at: number;
  reason: string;
  by: Strategy["updated_by"];
}

export class StrategyManager {
  private readonly repoDir: string;
  private readonly filename: string;
  private readonly defaultStrategy: Strategy;

  constructor(opts: StrategyManagerOptions) {
    this.repoDir = opts.repoDir;
    this.filename = opts.filename ?? "strategy.json";
    this.defaultStrategy = opts.defaultStrategy;
  }

  /** Initialize the repo if not already a git repo + write defaultStrategy. Idempotent. */
  init(): void {
    if (fs.existsSync(path.join(this.repoDir, ".git"))) {
      // Already a git repo. Idempotent no-op.
      return;
    }
    fs.mkdirSync(this.repoDir, { recursive: true });
    // `--initial-branch` requires git >= 2.28. Fall back for older systems.
    try {
      this.git(["init", "--initial-branch=main"]);
    } catch {
      this.git(["init"]);
    }
    // Pin a local committer identity so commits don't fall through to global git config
    // (which may be unset on CI / fresh machines and would error on commit).
    this.git(["config", "user.email", "ogamex@local"]);
    this.git(["config", "user.name", "OgameX"]);
    // Disable GPG signing locally — global gpgsign=true would otherwise block commits.
    this.git(["config", "commit.gpgSign", "false"]);

    const filePath = path.join(this.repoDir, this.filename);
    fs.writeFileSync(filePath, JSON.stringify(this.defaultStrategy, null, 2), "utf-8");
    this.git(["add", this.filename]);
    this.git(["commit", "-m", `v${this.defaultStrategy.version}: bootstrap`]);
  }

  /** Returns current Strategy from disk. Throws if file missing. */
  load(): Strategy {
    const filePath = path.join(this.repoDir, this.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`StrategyManager.load: ${filePath} missing — call init() first`);
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Strategy;
  }

  /** Apply a JSON patch (deep merge into Strategy); bump version; commit to git. */
  applyPatch(patch: Record<string, unknown>, reason: string, by: Strategy["updated_by"]): Strategy {
    const current = this.load();
    const merged = deepMerge(current as unknown as Record<string, unknown>, patch) as unknown as Strategy;
    const next: Strategy = {
      ...merged,
      version: current.version + 1,
      updated_at: Date.now(),
      updated_by: by,
      reason,
    };
    this.writeAndCommit(next, `v${next.version}: ${reason}`);
    return next;
  }

  /** Roll back to a specific version by replaying its content as a new commit. */
  rollback(version: number): Strategy {
    // Find commit whose subject starts with "vN:" (anchored to avoid v1 matching v10).
    const grep = `^v${version}: `;
    const res = this.git(["log", `--grep=${grep}`, "--format=%H", "-n", "1"]);
    const hash = res.stdout.trim();
    if (hash === "") {
      throw new Error(`version not found: ${version}`);
    }
    // Read that commit's strategy.json content.
    const show = this.git(["show", `${hash}:${this.filename}`]);
    const historical = JSON.parse(show.stdout) as Strategy;

    const current = this.load();
    const next: Strategy = {
      ...historical,
      version: current.version + 1,
      updated_at: Date.now(),
      updated_by: "user-discord",
      reason: `rollback to v${version}`,
    };
    this.writeAndCommit(next, `v${next.version}: rollback to v${version}`);
    return next;
  }

  /** Walk git log. Newest first. */
  history(): HistoryEntry[] {
    // %H = hash, %ct = commit time (sec), %s = subject. Separated by tab (%x09).
    const res = this.git(["log", "--format=%H%x09%ct%x09%s"]);
    const out = res.stdout.trim();
    if (out === "") return [];
    const lines = out.split("\n");
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const hash = parts[0]!;
      const ctSec = parts[1]!;
      // Subject may itself contain ": " — join the remainder.
      const subject = parts.slice(2).join("\t");
      const m = /^v(\d+):\s*(.*)$/.exec(subject);
      if (m === null) continue;
      const version = Number.parseInt(m[1]!, 10);
      const reason = m[2]!;
      // Read updated_by from the file at that commit.
      const show = this.git(["show", `${hash}:${this.filename}`]);
      let by: Strategy["updated_by"] = "userscript-bootstrap";
      try {
        const s = JSON.parse(show.stdout) as Strategy;
        by = s.updated_by;
      } catch {
        // Corrupt or missing — keep default.
      }
      entries.push({
        version,
        updated_at: Number.parseInt(ctSec, 10) * 1000,
        reason,
        by,
      });
    }
    return entries;
  }

  // --- internals -----------------------------------------------------------

  private writeAndCommit(next: Strategy, message: string): void {
    const filePath = path.join(this.repoDir, this.filename);
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf-8");
    this.git(["add", this.filename]);
    this.git(["commit", "-m", message]);
  }

  /**
   * Run `git <args>` inside repoDir synchronously. Throws on non-zero status.
   * Returned shape includes stdout/stderr for callers that need to inspect output.
   * The `.catch` style chain in init() is implemented manually via try/catch wrappers
   * elsewhere — this helper just throws on failure.
   */
  private git(args: string[]): { stdout: string; stderr: string } {
    const res = spawnSync("git", args, { cwd: this.repoDir, encoding: "utf-8" });
    if (res.error) {
      throw new Error(`git ${args.join(" ")} failed to spawn: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} exited ${res.status}: ${res.stderr ?? ""}`.trim(),
      );
    }
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }
}

// --- helpers ---------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive merge: for each key in patch, if both sides are plain objects
 * recurse; otherwise overwrite. Arrays are replaced (not concatenated).
 */
function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const tv = out[key];
    if (isPlainObject(pv) && isPlainObject(tv)) {
      out[key] = deepMerge(tv, pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}
