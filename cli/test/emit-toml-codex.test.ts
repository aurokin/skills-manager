import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
  doc,
  list,
  tableArray,
  textBlock,
  type Document,
  type DocValue,
  type Scalar,
} from "../src/render/doc";
import { emitTomlCodex, tomlCodexEmitter } from "../src/render/emit-toml-codex";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "agent-defs");

const CODEX_FIXTURES = [
  "codexrabbit-code-reviewer",
  "formatting-traps",
  "kitchen-sink-floating",
  "kitchen-sink-pinned",
  "plan-reviewer",
  "retrorabbit-code-reviewer",
];

function readGolden(fixture: string): string {
  return fs.readFileSync(path.join(GOLDEN_DIR, fixture, "codex.golden"), "utf8");
}

/**
 * Reconstruct the Document AST implied by a parsed TOML object, mirroring the
 * structural decisions the codex dialect (AUR-616) makes: objects → nested
 * Documents, non-empty arrays-of-objects → TableArray (Python's
 * `_is_array_of_tables`), scalar arrays → DocList, multi-line strings →
 * TextBlock. The emitter must serialize this back to the exact golden bytes.
 */
function toDocument(obj: Record<string, unknown>): Document {
  const b = doc();
  for (const [key, value] of Object.entries(obj)) b.set(key, toValue(value));
  return b.build();
}

function toValue(value: unknown): DocValue {
  if (Array.isArray(value)) {
    const allObjects =
      value.length > 0 &&
      value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
    if (allObjects) {
      return tableArray(value.map((item) => toDocument(item as Record<string, unknown>)));
    }
    return list(value.map(toValue));
  }
  if (value !== null && typeof value === "object") {
    return toDocument(value as Record<string, unknown>);
  }
  if (typeof value === "string" && value.includes("\n")) return textBlock(value);
  return value as Scalar;
}

describe("emitTomlCodex byte-matches the codex goldens", () => {
  for (const fixture of CODEX_FIXTURES) {
    test(fixture, () => {
      const golden = readGolden(fixture);
      const document = toDocument(parseToml(golden) as Record<string, unknown>);
      expect(emitTomlCodex(document)).toBe(golden);
    });
  }
});

describe("every emission round-trips through a real TOML parser", () => {
  for (const fixture of CODEX_FIXTURES) {
    test(fixture, () => {
      const golden = readGolden(fixture);
      const document = toDocument(parseToml(golden) as Record<string, unknown>);
      const emitted = emitTomlCodex(document);
      expect(() => parseToml(emitted)).not.toThrow();
      expect(parseToml(emitted)).toEqual(parseToml(golden));
    });
  }
});

describe("table partition and ordering contract (_dump_table)", () => {
  test("scalars are emitted first even when inserted after tables", () => {
    // build_codex_document appends codex.config scalars (approval_policy) AFTER
    // the mcp_servers / skills tables; _dump_table must float them up.
    const document = doc()
      .set("name", "x")
      .set("mcp_servers", doc().set("linear", doc().set("command", "linear-mcp").build()).build())
      .set("skills", doc().set("config", tableArray([doc().set("name", "s").set("enabled", true).build()])).build())
      .set("approval_policy", "on-request")
      .build();
    expect(emitTomlCodex(document)).toBe(
      [
        'name = "x"',
        'approval_policy = "on-request"',
        "",
        "[mcp_servers]",
        "",
        "[mcp_servers.linear]",
        'command = "linear-mcp"',
        "",
        "[skills]",
        "",
        "[[skills.config]]",
        'name = "s"',
        "enabled = true",
        "",
      ].join("\n"),
    );
  });

  test("nested tables are separated from prior output by a blank line", () => {
    const document = doc()
      .set("a", 1)
      .set("t", doc().set("b", 2).build())
      .set("u", doc().set("c", 3).build())
      .build();
    expect(emitTomlCodex(document)).toBe("a = 1\n\n[t]\nb = 2\n\n[u]\nc = 3\n");
  });

  test("array-of-tables emits one [[header]] per element with dotted prefix", () => {
    const document = doc()
      .set("skills", doc().set("config", tableArray([
        doc().set("name", "one").set("enabled", false).build(),
        doc().set("path", "./two").set("enabled", true).build(),
      ])).build())
      .build();
    expect(emitTomlCodex(document)).toBe(
      "[skills]\n\n[[skills.config]]\nname = \"one\"\nenabled = false\n\n[[skills.config]]\npath = \"./two\"\nenabled = true\n",
    );
  });

  test("empty document emits an empty string", () => {
    expect(emitTomlCodex(doc().build())).toBe("");
  });
});

describe("scalar formatting (_format_value)", () => {
  test("booleans render as bare true / false", () => {
    expect(emitTomlCodex(doc().set("t", true).set("f", false).build())).toBe("t = true\nf = false\n");
  });

  test("numbers render without quotes", () => {
    expect(emitTomlCodex(doc().set("n", 42).build())).toBe("n = 42\n");
  });

  test("single-line strings escape backslash, quote, and tab", () => {
    const raw = 'a\\b"c\td';
    const emitted = emitTomlCodex(doc().set("k", raw).build());
    expect(emitted).toBe('k = "a\\\\b\\"c\\td"\n');
    expect(parseToml(emitted).k).toBe(raw);
  });

  test("inline scalar lists render comma-separated in brackets", () => {
    expect(emitTomlCodex(doc().set("xs", list(["Atlas", "Echo"])).build())).toBe(
      'xs = ["Atlas", "Echo"]\n',
    );
  });

  test("null / node values are unsupported (TypeError, matching Python)", () => {
    expect(() => emitTomlCodex(doc().set("k", null).build())).toThrow("Unsupported TOML value");
  });
});

describe("multi-line string formatting", () => {
  test("text blocks render triple-quoted, escaping only backslash and triple-quote", () => {
    const emitted = emitTomlCodex(doc().set("body", textBlock('x\ny"""z\\w')).build());
    expect(emitted).toBe('body = """x\ny\\"\\"\\"z\\\\w"""\n');
    expect(parseToml(emitted).body).toBe('x\ny"""z\\w');
  });

  test("a plain string scalar containing a newline also triple-quotes (Python \\n sniff parity)", () => {
    const emitted = emitTomlCodex(doc().set("body", "line1\nline2\n").build());
    expect(emitted).toBe('body = """line1\nline2\n"""\n');
    expect(parseToml(emitted).body).toBe("line1\nline2\n");
  });

  test("trailing blank lines inside a text block are preserved verbatim", () => {
    const emitted = emitTomlCodex(doc().set("body", textBlock("end\n\n\n")).set("after", "z").build());
    expect(emitted).toBe('body = """end\n\n\n"""\nafter = "z"\n');
    expect(parseToml(emitted).body).toBe("end\n\n\n");
  });
});

describe("bound emitter", () => {
  test("tomlCodexEmitter is name-tagged and delegates to emitTomlCodex", () => {
    expect(tomlCodexEmitter.name).toBe("toml-codex-compat");
    expect(tomlCodexEmitter.emit(doc().set("a", 1).build())).toBe("a = 1\n");
  });
});
