// Fast-forward git-backed roots before `plan`/`apply` so they place what was
// merged upstream, not whatever happens to be checked out. Strictly ff-only:
// never merge, rebase, reset or stash. Any unsafe or unreachable root is
// skipped with a reason and read as-is; pulling never fails the verb.

import * as fs from "node:fs";
import type { GitResult, SkmEnv } from "./env";
import { loadConfiguredRoots } from "./machine-config";
import type { Root } from "./types";

export interface RootPull {
  root: string;
  path: string;
  status: "updated" | "current" | "skipped";
  /** Short SHAs before/after a fast-forward (status "updated"). */
  from?: string;
  to?: string;
  /** Commits fast-forwarded (status "updated"). */
  commits?: number;
  /** Why the root was left as-is (status "skipped"). */
  reason?: string;
}

type Git = (args: string[]) => GitResult;

const NOT_GIT = "not a git checkout";

/** Pull every root in the machine config; [] when the env has no git runner. */
export function pullConfiguredRoots(env: SkmEnv): RootPull[] {
  if (!env.git) return [];
  return pullRoots(env, loadConfiguredRoots(env));
}

/** Fast-forward each root; roots sharing one checkout are pulled once. */
export function pullRoots(env: SkmEnv, roots: Root[]): RootPull[] {
  const runGit = env.git;
  if (!runGit) return [];
  const byCheckout = new Map<string, Omit<RootPull, "root" | "path">>();
  return roots.map((r) => {
    const base = { root: r.name, path: r.path };
    if (!fs.existsSync(r.path)) return { ...base, status: "skipped", reason: "missing on disk" };
    const git: Git = (args) => runGit(r.path, args);
    const top = git(["rev-parse", "--show-toplevel"]);
    if (!top.ok) return { ...base, status: "skipped", reason: NOT_GIT };
    const key = top.stdout.trim();
    let result = byCheckout.get(key);
    if (!result) {
      result = pullCheckout(git);
      byCheckout.set(key, result);
    }
    return { ...base, ...result };
  });
}

function pullCheckout(git: Git): Omit<RootPull, "root" | "path"> {
  const skip = (reason: string) => ({ status: "skipped" as const, reason });
  const out = (args: string[]) => {
    const r = git(args);
    return r.ok ? r.stdout.trim() : undefined;
  };

  const branch = out(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!branch) return skip("detached HEAD");
  const remote = out(["config", `branch.${branch}.remote`]);
  if (!remote || !out(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) {
    return skip(`branch '${branch}' has no upstream`);
  }
  const remoteHead = out(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]);
  if (!remoteHead) {
    return skip(`default branch of '${remote}' unknown (run \`git remote set-head ${remote} --auto\`)`);
  }
  const defaultBranch = remoteHead.slice(remote.length + 1);
  if (branch !== defaultBranch) return skip(`on branch '${branch}', not default '${defaultBranch}'`);
  if (out(["status", "--porcelain", "--untracked-files=no"])) return skip("uncommitted changes");

  const fetch = git(["fetch", "--quiet", remote]);
  if (!fetch.ok) return skip(`fetch from '${remote}' failed; using local contents (${firstLine(fetch.stderr)})`);

  const counts = out(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  const [ahead, behind] = (counts ?? "").split(/\s+/).map(Number);
  if (ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) {
    return skip("could not compare with upstream");
  }
  if (ahead > 0) return skip(`${ahead} local commit(s) not on upstream`);
  if (behind === 0) return { status: "current" };

  const from = out(["rev-parse", "--short", "HEAD"]);
  const merge = git(["merge", "--ff-only", "--quiet", "@{u}"]);
  if (!merge.ok) return skip(`fast-forward failed (${firstLine(merge.stderr)})`);
  const to = out(["rev-parse", "--short", "HEAD"]);
  return { status: "updated", from, to, commits: behind };
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] || "unknown error";
}

/** Human lines for the root pulls; empty when nothing was pulled. */
export function renderRootPulls(pulls: RootPull[]): string[] {
  return pulls.map((p) => {
    const name = p.root.padEnd(20);
    switch (p.status) {
      case "updated":
        return `  ↓ root ${name} updated ${p.from}..${p.to} (${p.commits} commit(s))`;
      case "current":
        return `  · root ${name} already current`;
      default:
        // A plain-folder root is expected, not a warning.
        return p.reason === NOT_GIT
          ? `  · root ${name} ${NOT_GIT}; read as-is`
          : `  ! root ${name} not updated: ${p.reason}`;
    }
  });
}
