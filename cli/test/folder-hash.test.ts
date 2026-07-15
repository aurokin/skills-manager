// skillFolderHash reproduction (ADR 0014, phase 2). Golden hashes below were
// produced by real git (`git add -A && git write-tree` over the identical
// fixture trees), so gitTreeHash is pinned to git's tree-object algorithm —
// not to this implementation. The sha256 golden pins the `skills` CLI's
// computeSkillFolderHash shape (sorted relative paths + contents).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gitTreeHash, skillsCliFolderHash, verifySkillFolderHash } from "../src/folder-hash";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "folder-hash-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** The full golden fixture: regular file, executable, nested dir, symlink,
 *  empty dir (git tracks none), and a .git dir (never part of a tree). */
function makeGoldenTree(): string {
  const dir = path.join(base, "tree");
  fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
  fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(path.join(dir, "run.sh"), 0o755);
  fs.writeFileSync(path.join(dir, "nested", "inner.md"), "inner content\n");
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "junk\n");
  fs.symlinkSync("a.txt", path.join(dir, "link"));
  return dir;
}

const GOLDEN_TREE_SHA = "86348fb74857e9d74ee09ee870bef77d9237e099";
const GOLDEN_SHA256 = "92964396bc7887bfb9cb5d4eceeabea2f9b6a3d039d665b493ff3ec17648ecaa";

describe("gitTreeHash", () => {
  test("matches git write-tree on the golden fixture (modes, symlink, .git and empty dirs skipped)", () => {
    expect(gitTreeHash(makeGoldenTree())).toBe(GOLDEN_TREE_SHA);
  });

  test("matches git write-tree on a nested subtree and a single-file tree", () => {
    const dir = makeGoldenTree();
    expect(gitTreeHash(path.join(dir, "nested"))).toBe("df71313343e1b3462f2c85a06fbe01fb96d5352f");
    const one = path.join(base, "one");
    fs.mkdirSync(one);
    fs.writeFileSync(path.join(one, "a.txt"), "hello\n");
    expect(gitTreeHash(one)).toBe("2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1");
  });

  test("orders directories with git's trailing-slash rule (ab.txt before ab/)", () => {
    // '.' (0x2E) sorts before '/' (0x2F): git orders aa, ab.txt, ab/ — a plain
    // name sort would put the ab dir before ab.txt and change the hash.
    const dir = path.join(base, "sort");
    fs.mkdirSync(path.join(dir, "ab"), { recursive: true });
    fs.writeFileSync(path.join(dir, "aa"), "x\n");
    fs.writeFileSync(path.join(dir, "ab.txt"), "y\n");
    fs.writeFileSync(path.join(dir, "ab", "f"), "z\n");
    expect(gitTreeHash(dir)).toBe("e257dfe67b9c22dc34f6a624c386142f45a04db6");
  });

  test("executable mode keys on the owner bit only, like git", () => {
    // Goldens from real git: chmod 655 (group/other exec, no owner) indexes
    // as 100644 — identical tree to a plain 644 file; chmod 744 is 100755.
    const dir = path.join(base, "modes");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    fs.chmodSync(path.join(dir, "a.txt"), 0o655);
    expect(gitTreeHash(dir)).toBe("2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1");
    fs.chmodSync(path.join(dir, "a.txt"), 0o744);
    expect(gitTreeHash(dir)).toBe("b1f73f0b3612cbe7a31f1f22deff31d6919993ea");
  });

  test("NFD filenames verify against the NFC upstream tree only where the FS equates them", () => {
    // Golden from real git (core.precomposeUnicode): a tree holding the NFC
    // form of "cafe\u0301.md" with content "accented\n". A decomposing
    // filesystem hands the file back with an NFD name; the fallback must
    // still attest it \u2014 but only because the FS resolves both spellings to
    // the same file.
    const NFC_GOLDEN = "6e2c262ed81b1e63d32c85095c5747cd1160d517";
    const nfdName = "cafe\u0301.md"; // explicitly decomposed, as HFS+ readdir returns it
    const dir = path.join(base, "uni");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, nfdName), "accented\n");
    // Does this filesystem equate the two spellings? (macOS APFS/HFS+: yes;
    // byte-preserving filesystems like ext4: no \u2014 there the NFD bytes are a
    // real rename and the fallback must refuse to launder it into a match.)
    const equates = (() => {
      try {
        return fs.lstatSync(path.join(dir, nfdName.normalize("NFC"))).ino === fs.lstatSync(path.join(dir, nfdName)).ino;
      } catch {
        return false;
      }
    })();
    if (equates) {
      expect(gitTreeHash(dir, { nfcNames: true })).toBe(NFC_GOLDEN);
      expect(verifySkillFolderHash(dir, NFC_GOLDEN)).toBe("match");
    } else {
      expect(gitTreeHash(dir, { nfcNames: true })).toBeUndefined();
      expect(verifySkillFolderHash(dir, NFC_GOLDEN)).toBe("mismatch");
    }
    // Tampered content still fails through both passes.
    fs.appendFileSync(path.join(dir, nfdName), "tampered\n");
    expect(verifySkillFolderHash(dir, NFC_GOLDEN)).toBe("mismatch");
  });

  test("content changes the hash; empty or missing dirs hash to undefined", () => {
    const dir = makeGoldenTree();
    fs.appendFileSync(path.join(dir, "a.txt"), "tampered\n");
    expect(gitTreeHash(dir)).not.toBe(GOLDEN_TREE_SHA);
    expect(gitTreeHash(path.join(dir, "empty"))).toBeUndefined();
    expect(gitTreeHash(path.join(base, "does-not-exist"))).toBeUndefined();
  });
});

describe("skillsCliFolderHash", () => {
  test("reproduces the CLI's sha256 over sorted relative paths + contents", () => {
    // Symlinks and .git are excluded from the CLI's collection, so the golden
    // covers a.txt, nested/inner.md, run.sh only.
    expect(skillsCliFolderHash(makeGoldenTree())).toBe(GOLDEN_SHA256);
  });
});

describe("verifySkillFolderHash", () => {
  test("dispatches on hash format: match and mismatch per algorithm", () => {
    const dir = makeGoldenTree();
    expect(verifySkillFolderHash(dir, GOLDEN_TREE_SHA)).toBe("match");
    expect(verifySkillFolderHash(dir, GOLDEN_SHA256)).toBe("match");
    expect(verifySkillFolderHash(dir, "a".repeat(40))).toBe("mismatch");
    expect(verifySkillFolderHash(dir, "b".repeat(64))).toBe("mismatch");
  });

  test("cannot-check is unverifiable, never a mismatch", () => {
    const dir = makeGoldenTree();
    // The CLI writes "" when it could not record a hash; foreign shapes too.
    expect(verifySkillFolderHash(dir, "")).toBe("unverifiable");
    expect(verifySkillFolderHash(dir, "not-a-hash")).toBe("unverifiable");
    // Local hashing failure (missing or empty dir) is equally uncheckable.
    expect(verifySkillFolderHash(path.join(base, "missing"), GOLDEN_TREE_SHA)).toBe("unverifiable");
    expect(verifySkillFolderHash(path.join(dir, "empty"), GOLDEN_TREE_SHA)).toBe("unverifiable");
  });
});
