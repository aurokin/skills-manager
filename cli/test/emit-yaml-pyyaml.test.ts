import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { parse as parseYaml } from "yaml";
import { doc, float, list, tableArray, textBlock, type DocValue, type Document } from "../src/render/doc";
import { emitYamlPyyaml, yamlPyyamlEmitter } from "../src/render/emit-yaml-pyyaml";

// ─────────────────────────────────────────────────────────────────────────────
// Scalar rendering + implicit-tag quoting heuristics
// ─────────────────────────────────────────────────────────────────────────────

describe("scalar rendering", () => {
  test("int / float / bool / null / plain string", () => {
    const d = doc()
      .set("i", 20)
      .set("f", 0.1)
      .set("b", true)
      .set("bf", false)
      .set("n", null)
      .set("s", "Read")
      .build();
    expect(emitYamlPyyaml(d)).toBe("i: 20\nf: 0.1\nb: true\nbf: false\nn: null\ns: Read");
  });

  test("negative int and larger int render as decimals", () => {
    const d = doc().set("a", -3).set("b", 1000000).build();
    expect(emitYamlPyyaml(d)).toBe("a: -3\nb: 1000000");
  });

  test("bare-token strings that resolve to bool/null are single-quoted", () => {
    const d = doc().set("tools", list(["yes", "no", "on", "true", "null", "Read"])).build();
    expect(emitYamlPyyaml(d)).toBe("tools:\n- 'yes'\n- 'no'\n- 'on'\n- 'true'\n- 'null'\n- Read");
  });

  test("numeric-looking strings are single-quoted to stay strings", () => {
    const d = doc().set("v", "123").set("w", "1.5").set("x", "0x1f").build();
    expect(emitYamlPyyaml(d)).toBe("v: '123'\nw: '1.5'\nx: '0x1f'");
  });

  test("empty string renders as ''", () => {
    expect(emitYamlPyyaml(doc().set("k", "").build())).toBe("k: ''");
  });

  test("leading special / colon-space / trailing space force quoting", () => {
    expect(emitYamlPyyaml(doc().set("k", "@edge").build())).toBe("k: '@edge'");
    expect(emitYamlPyyaml(doc().set("k", "a: b").build())).toBe("k: 'a: b'");
    expect(emitYamlPyyaml(doc().set("k", "trailing ").build())).toBe("k: 'trailing '");
    // Embedded colon without a following space stays plain.
    expect(emitYamlPyyaml(doc().set("k", "a:b").build())).toBe("k: a:b");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-ASCII escaping under allow_unicode=False (\xXX / \uXXXX / \UXXXXXXXX)
// ─────────────────────────────────────────────────────────────────────────────

describe("unicode escaping (allow_unicode=False)", () => {
  test("BMP and astral code points are escaped, and the line folds with backslash joins", () => {
    const d = doc()
      .set(
        "description",
        "@edge: CJK 中文 and emoji \u{1F680} padded out long enough to trigger PyYAML line wrapping past eighty columns",
      )
      .build();
    expect(emitYamlPyyaml(d)).toBe(
      'description: "@edge: CJK \\u4E2D\\u6587 and emoji \\U0001F680 padded out long enough\\\n' +
        '  \\ to trigger PyYAML line wrapping past eighty columns"',
    );
  });

  test("latin-1 supplement escapes as \\xXX", () => {
    // é = U+00E9. "café" has no other forcing chars, so double-quoted with \xE9.
    expect(emitYamlPyyaml(doc().set("k", "café").build())).toBe('k: "caf\\xE9"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 80-column folding of plain scalars
// ─────────────────────────────────────────────────────────────────────────────

describe("80-column folding", () => {
  test("long plain scalar folds at a space onto a continuation line", () => {
    const d = doc()
      .set("description", "Fully populated agent exercising every harness block for byte-compat goldens.")
      .build();
    expect(emitYamlPyyaml(d)).toBe(
      "description: Fully populated agent exercising every harness block for byte-compat\n  goldens.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block structure: nested maps, indentless sequences, bool maps, empty collections
// ─────────────────────────────────────────────────────────────────────────────

describe("block structure", () => {
  test("nested maps and the indentless sequence under a mapping key", () => {
    const d = doc()
      .set(
        "mcpServers",
        doc()
          .set(
            "github",
            doc().set("command", "npx").set("args", list(["-y", "@x/y"])).build(),
          )
          .build(),
      )
      .build();
    expect(emitYamlPyyaml(d)).toBe(
      "mcpServers:\n  github:\n    command: npx\n    args:\n    - -y\n    - '@x/y'",
    );
  });

  test("empty list and empty map take inline flow forms", () => {
    const d = doc().set("tools", list([])).set("meta", doc().build()).build();
    expect(emitYamlPyyaml(d)).toBe("tools: []\nmeta: {}");
  });

  test("boolean-valued map", () => {
    const d = doc().set("tools", doc().set("write", false).set("read", true).build()).build();
    expect(emitYamlPyyaml(d)).toBe("tools:\n  write: false\n  read: true");
  });

  test("map keys that need quoting are quoted", () => {
    const d = doc()
      .set("permission", doc().set("*", "ask").set("git diff*", "allow").build())
      .build();
    expect(emitYamlPyyaml(d)).toBe("permission:\n  '*': ask\n  git diff*: allow");
  });

  test("table-array renders as a sequence of mappings, same as a list of documents", () => {
    const tables = [doc().set("name", "a").build(), doc().set("name", "b").build()];
    const asTableArray = doc().set("servers", tableArray(tables)).build();
    const asList = doc().set("servers", list(tables)).build();
    expect(emitYamlPyyaml(asTableArray)).toBe("servers:\n- name: a\n- name: b");
    expect(emitYamlPyyaml(asList)).toBe(emitYamlPyyaml(asTableArray));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Float marker: a FloatScalar always renders with a decimal, matching PyYAML's
// represent_float on a Python float (whole values → `N.0`). Regression for the
// gemini/opencode temperature & top_p integer-coercion divergence.
// ─────────────────────────────────────────────────────────────────────────────

describe("float marker renders like PyYAML represent_float", () => {
  test("whole-valued floats keep a trailing .0 (0.0 / 1.0 / 2.0)", () => {
    const d = doc().set("a", float(0)).set("b", float(1)).set("c", float(2)).build();
    expect(emitYamlPyyaml(d)).toBe("a: 0.0\nb: 1.0\nc: 2.0");
  });

  test("fractional floats are unchanged and bare numbers stay ints", () => {
    const d = doc().set("f", float(0.1)).set("i", 2).build();
    expect(emitYamlPyyaml(d)).toBe("f: 0.1\ni: 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Simple-key threshold: PyYAML's check_simple_key adds len(prepare_tag(tag))
// (`!!str` = 5) before the `< 128` cutoff, so a str key of length ≥ 123 spills
// to the explicit `? key\n: value` form. Regression for the off-by-5 key length.
// ─────────────────────────────────────────────────────────────────────────────

describe("simple-key length accounts for the prepared str tag", () => {
  test("a 122-char key stays inline; a 123-char key goes explicit", () => {
    const inline = doc().set("k".repeat(122), "v").build();
    expect(emitYamlPyyaml(inline)).toBe(`${"k".repeat(122)}: v`);

    const explicit = doc().set("k".repeat(123), "v").build();
    expect(emitYamlPyyaml(explicit)).toBe(`? ${"k".repeat(123)}\n: v`);
  });

  test("a 125-char key uses the explicit key form", () => {
    const d = doc().set("k".repeat(125), "v").build();
    expect(emitYamlPyyaml(d)).toBe(`? ${"k".repeat(125)}\n: v`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TextBlock: the pyyaml-compat emitter reproduces safe_dump, which does not use
// literal block scalars — a TextBlock renders exactly like its raw string.
// ─────────────────────────────────────────────────────────────────────────────

describe("text blocks reproduce safe_dump (no literal block)", () => {
  test("multiline text renders single-quoted with folded blank lines", () => {
    const asText = doc().set("body", textBlock("line one\nline two\nline three")).build();
    const asString = doc().set("body", "line one\nline two\nline three").build();
    expect(emitYamlPyyaml(asText)).toBe("body: 'line one\n\n  line two\n\n  line three'");
    expect(emitYamlPyyaml(asText)).toBe(emitYamlPyyaml(asString));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bound emitter identity
// ─────────────────────────────────────────────────────────────────────────────

describe("bound emitter", () => {
  test("yamlPyyamlEmitter delegates to emitYamlPyyaml under the right name", () => {
    expect(yamlPyyamlEmitter.name).toBe("yaml-pyyaml-compat");
    const d = doc().set("name", "x").build();
    expect(yamlPyyamlEmitter.emit(d)).toBe(emitYamlPyyaml(d));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Golden byte-match: the emitted block equals each PyYAML-bound golden's
// frontmatter (round-tripped: parse the golden's YAML, rebuild the Document,
// re-emit, compare).
// ─────────────────────────────────────────────────────────────────────────────

const PYYAML_HARNESSES = ["claude", "copilot", "cursor", "opencode", "gemini"];

function docValueFromPlain(v: unknown): DocValue {
  if (v === null || typeof v !== "object") return v as DocValue;
  if (Array.isArray(v)) return list(v.map(docValueFromPlain));
  return documentFromPlain(v as Record<string, unknown>);
}

function documentFromPlain(obj: Record<string, unknown>): Document {
  const b = doc();
  for (const [k, val] of Object.entries(obj)) b.set(k, docValueFromPlain(val));
  return b.build();
}

describe("golden frontmatter byte-match", () => {
  const goldensDir = `${import.meta.dir}/goldens/agent-defs`;
  const fixtures = readdirSync(goldensDir);

  for (const fixture of fixtures) {
    for (const harness of PYYAML_HARNESSES) {
      const path = `${goldensDir}/${fixture}/${harness}.golden`;
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue; // skill-only fixtures have no agent-def harness goldens
      }
      test(`${fixture}/${harness}`, () => {
        const match = content.match(/^---\n([\s\S]*?)\n---\n/);
        expect(match).not.toBeNull();
        const frontmatter = match![1]!;
        const parsed = parseYaml(frontmatter) as Record<string, unknown>;
        expect(emitYamlPyyaml(documentFromPlain(parsed))).toBe(frontmatter);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Property test: seeded random Documents vs live `python3 yaml.safe_dump`
// ─────────────────────────────────────────────────────────────────────────────

const pythonAvailable = (() => {
  try {
    return spawnSync("python3", ["-c", "import yaml"]).status === 0;
  } catch {
    return false;
  }
})();

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EDGE_STRINGS = [
  "yes", "no", "on", "off", "true", "false", "null", "Null", "NULL", "~", "",
  "123", "0x1f", "1.5", "-3", "+4", "1e5", ".inf", ".nan", "<<", "=",
  "hello world", "a: b", "a:b", "@edge", "#comment", " leading", "trailing ",
  "line\nbreak", "multi\nline\ntext", "tab\there", "quote'single", 'dbl"quote',
  "中文", "emoji 🚀 here", "café", "---doc", "...end", "- dash", "? question",
  "[bracket]", "{brace}", "&anchor", "*star", "!bang", "|pipe", ">gt", "%percent", "`tick`",
  "a very long string that definitely exceeds eighty columns so pyyaml has to fold it somewhere",
  "colons: everywhere: in: this: string: that: is: also: quite: long: enough: to: fold",
  "CJK 中文 mixed with emoji 🚀 and padded out long enough to trigger the line wrapping heuristic here",
  "  spaces  around  ", "trailing space at end ", "'quoted'", "back\\slash",
];

// A DocValue plus a JSON-safe mirror that preserves the int/float distinction
// so the Python oracle rebuilds identical types.
type PlainMirror = unknown;

function buildRandom(seed: number, count: number): { asts: Document[]; mirror: PlainMirror[] } {
  const rand = mulberry32(seed);
  const ri = (n: number) => Math.floor(rand() * n);
  const pick = <T>(a: T[]): T => a[ri(a.length)]!;

  const asts: Document[] = [];
  const mirror: PlainMirror[] = [];

  function scalar(): { v: DocValue; m: PlainMirror } {
    const k = ri(6);
    if (k === 0) return { v: null, m: null };
    if (k === 1) {
      const bool = rand() < 0.5;
      return { v: bool, m: bool };
    }
    if (k === 2) {
      const n = ri(2000) - 1000;
      return { v: n, m: n };
    }
    if (k === 3) {
      const f = Math.round((rand() * 100 - 50) * 100) / 100 + 0.001 * (1 + ri(9));
      return { v: f, m: { __float__: f } };
    }
    const s = pick(EDGE_STRINGS);
    return { v: s, m: s };
  }

  function value(depth: number): { v: DocValue; m: PlainMirror } {
    if (depth <= 0 || rand() < 0.5) return scalar();
    if (rand() < 0.5) {
      const n = ri(4);
      const items: DocValue[] = [];
      const mirrors: PlainMirror[] = [];
      for (let i = 0; i < n; i++) {
        const c = value(depth - 1);
        items.push(c.v);
        mirrors.push(c.m);
      }
      return { v: list(items), m: mirrors };
    }
    const c = mapping(depth - 1);
    return c;
  }

  function mapping(depth: number): { v: Document; m: PlainMirror } {
    const b = doc();
    const pairs: [string, PlainMirror][] = [];
    const n = 1 + ri(4);
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      let key = pick(["name", "description", "a", "b", "tools", "model", "x", "0", "yes", "k" + i]);
      if (used.has(key)) key += "_" + i;
      used.add(key);
      const c = value(depth);
      b.set(key, c.v);
      pairs.push([key, c.m]);
    }
    return { v: b.build(), m: { __map__: pairs } };
  }

  for (let i = 0; i < count; i++) {
    const c = mapping(3);
    asts.push(c.v);
    mirror.push(c.m);
  }
  return { asts, mirror };
}

const PY_ORACLE = `
import sys, json, yaml
def rebuild(v):
    if isinstance(v, dict):
        if "__float__" in v: return float(v["__float__"])
        if "__map__" in v:
            d = {}
            for k, val in v["__map__"]:
                d[k] = rebuild(val)
            return d
        return v
    if isinstance(v, list): return [rebuild(x) for x in v]
    return v
data = json.load(sys.stdin)
out = [yaml.safe_dump(rebuild(c), sort_keys=False, allow_unicode=False, default_flow_style=False).strip() for c in data]
sys.stdout.write("\\x00".join(out))
`;

(pythonAvailable ? test : test.skip)(
  "property: 300 seeded random Documents match live python safe_dump().strip()",
  () => {
    const { asts, mirror } = buildRandom(0x9e3779b9, 300);
    const res = spawnSync("python3", ["-c", PY_ORACLE], {
      input: JSON.stringify(mirror),
      encoding: "utf8",
      maxBuffer: 1e8,
    });
    expect(res.status).toBe(0);
    const expected = res.stdout.split("\x00");
    expect(expected.length).toBe(asts.length);
    for (let i = 0; i < asts.length; i++) {
      expect(emitYamlPyyaml(asts[i]!)).toBe(expected[i]);
    }
  },
);
