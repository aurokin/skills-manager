// AUR-617: the minimal TOML reader used to parse tprompt's config.toml. Only the
// two prompt-source keys (strings + string arrays) need to survive; everything
// else is intentionally ignored.

import { describe, expect, test } from "bun:test";
import { parseTomlRootStrings, TomlParseError } from "../src/tprompt/toml";

describe("parseTomlRootStrings", () => {
  test("reads a basic string and a string array", () => {
    const out = parseTomlRootStrings(
      'prompts_dir = "/home/u/prompts"\nadditional_prompts_dirs = ["/a", "/b"]\n',
    );
    expect(out["prompts_dir"]).toBe("/home/u/prompts");
    expect(out["additional_prompts_dirs"]).toEqual(["/a", "/b"]);
  });

  test("honors comments, literal strings, and multi-line arrays", () => {
    const text = [
      "# a comment",
      "prompts_dir = '~/lib' # trailing note",
      "additional_prompts_dirs = [",
      '  "/one",',
      '  "/two",   # inline',
      "]",
      "default_mode = \"paste\"",
    ].join("\n");
    const out = parseTomlRootStrings(text);
    expect(out["prompts_dir"]).toBe("~/lib");
    expect(out["additional_prompts_dirs"]).toEqual(["/one", "/two"]);
    expect(out["default_mode"]).toBe("paste");
  });

  test("stops at the first table header and skips unsupported scalar types", () => {
    const text = [
      "prompts_dir = \"/p\"",
      "max_paste_bytes = 2097152",
      "[reserved_keys]",
      'prompts_dir = "SHOULD_NOT_WIN"',
    ].join("\n");
    const out = parseTomlRootStrings(text);
    expect(out["prompts_dir"]).toBe("/p");
    expect(out["max_paste_bytes"]).toBeUndefined();
  });

  test("decodes basic-string escapes", () => {
    const out = parseTomlRootStrings('prompts_dir = "a\\tb\\\\c"\n');
    expect(out["prompts_dir"]).toBe("a\tb\\c");
  });

  test("throws on a malformed (unquoted) value instead of dropping the line", () => {
    // tprompt's BurntSushi loader hard-errors on this; skm must not silently skip
    // it and fall back to a default prompts dir (tp-malformed-config-fallback).
    expect(() => parseTomlRootStrings("prompts_dir = /custom/prompts\n")).toThrow(TomlParseError);
  });

  test("throws on an unquoted string that merely STARTS like a scalar (t/f/i/n/digit)", () => {
    // The old first-char heuristic mis-classified these as valid-but-unsupported
    // scalars and dropped them → XDG fallback → destructive prune relocation.
    for (const bad of ["tmp/prompts", "foo/bar", "true/false", "inf/oo", "1.2.3", "0x", "01"]) {
      expect(() => parseTomlRootStrings(`prompts_dir = ${bad}\n`)).toThrow(TomlParseError);
    }
  });

  test("skips genuinely valid bare scalars cleanly (no throw, not consumed)", () => {
    const text = [
      'prompts_dir = "/p"',
      "max_paste_bytes = 2097152",
      "ratio = 1.5",
      "big = inf",
      "flag = true",
      "hexy = 0xFF",
      "under = 1_000",
    ].join("\n");
    const out = parseTomlRootStrings(text);
    expect(out["prompts_dir"]).toBe("/p");
    expect(out["max_paste_bytes"]).toBeUndefined();
    expect(out["ratio"]).toBeUndefined();
  });

  test("throws on an unterminated basic string instead of resolving to a bogus value", () => {
    // `prompts_dir = "/new/path` (no closing quote) must NOT resolve to /new/path —
    // a silently wrong prompts_dir could redirect prunes.
    expect(() => parseTomlRootStrings('prompts_dir = "/new/path\n')).toThrow(TomlParseError);
    expect(() => parseTomlRootStrings("prompts_dir = '/new/path\n")).toThrow(TomlParseError);
    expect(() => parseTomlRootStrings('prompts_dir = "/new/path')).toThrow(TomlParseError);
  });

  test("throws on an invalid escape sequence; valid escapes still parse", () => {
    expect(() => parseTomlRootStrings('prompts_dir = "a\\xb"\n')).toThrow(TomlParseError);
    expect(() => parseTomlRootStrings('prompts_dir = "a\\u12"\n')).toThrow(TomlParseError); // short hex
    const out = parseTomlRootStrings('prompts_dir = "a\\tb\\nc\\u0041"\n');
    expect(out["prompts_dir"]).toBe("a\tb\ncA");
  });
});
