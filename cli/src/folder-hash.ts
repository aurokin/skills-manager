// Local reproduction of the `skills` CLI's skillFolderHash (ADR 0014, phase 2):
// the review model may claim "attested" origin only when the installed
// directory's current hash matches the lock's skillFolderHash.
//
// The CLI records the hash in two formats (verified against its bundled source
// and against the real lock on this machine — see the phase-2 PR):
// - github installs (the common path): the GIT TREE SHA of the skill's folder
//   in the upstream repo, taken from GitHub's tree API — 40 hex chars. If the
//   local copy is byte-identical to that folder, the git tree-object hash of
//   the local directory equals it (validated: 11/13 real lock records match,
//   the other 2 are genuinely-modified installs).
// - clone-fallback installs: the CLI's own sha256 over sorted relative paths +
//   file contents (its computeSkillFolderHash) — 64 hex chars.
// Everything here is read-only and never throws: hash failure means "cannot
// attest", not an error.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function sha1(...parts: (Buffer | string)[]): Buffer {
  const h = createHash("sha1");
  for (const p of parts) h.update(p);
  return h.digest();
}

interface TreeEntry {
  /** Git object mode: "40000" tree, "100644"/"100755" blob, "120000" symlink. */
  mode: string;
  name: string;
  sha: Buffer;
}

/** Git tree-entry order: raw name bytes, with tree names compared as name+"/". */
function sortKey(e: TreeEntry): Buffer {
  return Buffer.from(e.mode === "40000" ? `${e.name}/` : e.name, "utf8");
}

/** Hash one directory level as a git tree object; undefined = empty (git tracks no empty dirs). */
function hashTree(dir: string): Buffer | undefined {
  const entries: TreeEntry[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue; // never part of a git tree
    const abs = path.join(dir, e.name);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      entries.push({ mode: "120000", name: e.name, sha: sha1(`blob ${Buffer.byteLength(target)}\0`, target) });
    } else if (st.isDirectory()) {
      const sha = hashTree(abs);
      if (sha) entries.push({ mode: "40000", name: e.name, sha });
    } else if (st.isFile()) {
      const content = fs.readFileSync(abs);
      const mode = (st.mode & 0o111) !== 0 ? "100755" : "100644";
      entries.push({ mode, name: e.name, sha: sha1(`blob ${content.length}\0`, content) });
    }
    // Sockets/FIFOs etc.: git cannot represent them; skip like git does.
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const payload = Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, "utf8"), e.sha]));
  return sha1(`tree ${payload.length}\0`, payload);
}

/** Git tree-object SHA-1 of a directory's content, or undefined (empty/unreadable). */
export function gitTreeHash(dir: string): string | undefined {
  try {
    return hashTree(dir)?.toString("hex");
  } catch {
    return undefined;
  }
}

/**
 * The `skills` CLI's computeSkillFolderHash: sha256 over each file's
 * relative path then content, files sorted by relative path (localeCompare),
 * skipping .git and node_modules directories. Symlinks are skipped (the CLI
 * collects Dirent.isFile() entries only).
 */
export function skillsCliFolderHash(dir: string): string | undefined {
  try {
    const files: { rel: string; abs: string }[] = [];
    const collect = (cur: string) => {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const abs = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          collect(abs);
        } else if (e.isFile()) {
          files.push({ rel: path.relative(dir, abs).split(path.sep).join("/"), abs });
        }
      }
    };
    collect(dir);
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    const h = createHash("sha256");
    for (const f of files) {
      h.update(f.rel);
      h.update(fs.readFileSync(f.abs));
    }
    return h.digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Verify a directory's current content against a lock skillFolderHash,
 * dispatching on the recorded format: 40 hex = git tree SHA, 64 hex = CLI
 * sha256. Three outcomes, because "cannot check" must never read as
 * "modified": the CLI itself writes an empty skillFolderHash when it could
 * not record one (and skips such entries in its own update check), and local
 * hashing can fail on an unreadable or empty directory.
 */
export type FolderHashVerdict = "match" | "mismatch" | "unverifiable";

export function verifySkillFolderHash(dir: string, lockHash: string): FolderHashVerdict {
  let computed: string | undefined;
  if (/^[0-9a-f]{40}$/.test(lockHash)) computed = gitTreeHash(dir);
  else if (/^[0-9a-f]{64}$/.test(lockHash)) computed = skillsCliFolderHash(dir);
  else return "unverifiable"; // includes the CLI's empty-string "no hash" records
  if (computed === undefined) return "unverifiable";
  return computed === lockHash ? "match" : "mismatch";
}
