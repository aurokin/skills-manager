// Read-only .skill-lock.json loader (ADR 0014, phase 1): installation evidence,
// not desired state. Three loud states — loaded / missing / degraded — and
// per-record skip for forward-compat. Never throws, never writes the lock.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { skillLockPath } from "../src/env";
import { loadSkillLock } from "../src/skill-lock";
import { makeSandbox, type Sandbox } from "./util";

const FIXTURE = path.join(import.meta.dir, "fixtures", "skill-lock.v3.json");

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

/** Write raw text to the sandbox's ~/.agents/.skill-lock.json. */
function writeLock(text: string): void {
  const file = skillLockPath(sb.env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("loadSkillLock", () => {
  test("loads the committed v3 fixture keyed per skill name", () => {
    writeLock(fs.readFileSync(FIXTURE, "utf8"));
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("loaded");
    expect(lock.skipped).toBeUndefined();
    expect(Object.keys(lock.entries).sort()).toEqual(["github", "openai-docs", "pdf", "terminal-control"]);
    const openaiDocs = lock.entries["openai-docs"];
    expect(openaiDocs?.source).toBe("openai/skills");
    expect(openaiDocs?.sourceType).toBe("github");
    expect(openaiDocs?.sourceUrl).toBe("https://github.com/openai/skills.git");
    expect(openaiDocs?.skillPath).toBe("skills/.curated/openai-docs/SKILL.md");
    expect(openaiDocs?.skillFolderHash).toBe("4a774545829d91404b3615f8f71011a1ed857e92");
    expect(openaiDocs?.installedAt).toBe("2026-04-19T20:58:52.764Z");
    expect(openaiDocs?.updatedAt).toBe("2026-06-09T02:58:28.950Z");
  });

  test("entries is a null-prototype lookup: inherited keys miss", () => {
    writeLock(fs.readFileSync(FIXTURE, "utf8"));
    const lock = loadSkillLock(sb.env);
    // Fed arbitrary inventory names in phase 2; "constructor"/"toString" must not resolve.
    expect(lock.entries["constructor"]).toBeUndefined();
    expect(lock.entries["toString"]).toBeUndefined();
  });

  test("lock-silent skill lookup returns undefined (the --full-depth case)", () => {
    writeLock(fs.readFileSync(FIXTURE, "utf8"));
    const lock = loadSkillLock(sb.env);
    // diffwarden is installed via --full-depth: on disk, but absent from the lock.
    expect(lock.entries["diffwarden"]).toBeUndefined();
  });

  test("missing lock file is the expected silent case, not an error", () => {
    const lock = loadSkillLock(sb.env); // nothing written
    expect(lock.status).toBe("missing");
    expect(Object.keys(lock.entries)).toHaveLength(0);
    expect(lock.reason).toBeUndefined();
  });

  test("truncated JSON degrades loudly with a reason", () => {
    const full = fs.readFileSync(FIXTURE, "utf8");
    writeLock(full.slice(0, full.indexOf("skillFolderHash") + 20)); // cut mid-string
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("degraded");
    expect(lock.reason).toContain("invalid JSON");
    expect(Object.keys(lock.entries)).toHaveLength(0);
  });

  test("empty file degrades (invalid JSON), never throws", () => {
    writeLock("");
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("degraded");
    expect(lock.reason).toContain("invalid JSON");
  });

  test("wrong/unsupported version degrades with a reason", () => {
    writeLock(JSON.stringify({ version: 2, skills: {} }));
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("degraded");
    expect(lock.reason).toContain("version");
    expect(Object.keys(lock.entries)).toHaveLength(0);
  });

  test("an array skills collection degrades, not loads-empty", () => {
    writeLock(JSON.stringify({ version: 3, skills: [] }));
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("degraded");
    expect(lock.reason).toContain("skills");
    expect(Object.keys(lock.entries)).toHaveLength(0);
  });

  test("a record missing skillFolderHash is skipped; the rest stay usable", () => {
    const good = {
      source: "openai/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/openai/skills.git",
      skillPath: "skills/.curated/pdf/SKILL.md",
      skillFolderHash: "deadbeef",
      installedAt: "2026-04-19T20:58:53.015Z",
      updatedAt: "2026-04-19T20:58:53.015Z",
    };
    const { skillFolderHash, ...missingHash } = good;
    writeLock(JSON.stringify({ version: 3, skills: { pdf: good, broken: missingHash } }));
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("loaded");
    expect(lock.entries["pdf"]).toBeDefined();
    expect(lock.entries["broken"]).toBeUndefined();
    expect(lock.skipped).toEqual(["broken"]);
  });

  test("unknown extra fields in a record are tolerated (forward-compat)", () => {
    const rec = {
      source: "openai/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/openai/skills.git",
      skillPath: "skills/.curated/pdf/SKILL.md",
      skillFolderHash: "deadbeef",
      installedAt: "2026-04-19T20:58:53.015Z",
      updatedAt: "2026-04-19T20:58:53.015Z",
      futureField: { nested: true },
    };
    writeLock(JSON.stringify({ version: 3, skills: { pdf: rec } }));
    const lock = loadSkillLock(sb.env);
    expect(lock.status).toBe("loaded");
    expect(lock.entries["pdf"]?.source).toBe("openai/skills");
    expect((lock.entries["pdf"] as Record<string, unknown>).futureField).toBeUndefined();
  });
});
