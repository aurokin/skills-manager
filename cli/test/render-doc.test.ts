import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  doc,
  isDocList,
  isDocument,
  isScalar,
  isTableArray,
  isTextBlock,
  list,
  tableArray,
  textBlock,
  type Document,
} from "../src/render/doc";
import {
  emitYamlCanonical,
  frontmatterDocument,
  yamlCanonicalEmitter,
} from "../src/render/emit-yaml-canonical";
import { DIALECT_EMITTER, EMITTERS, emitterFor } from "../src/render/emit";
import { emitYamlPyyaml } from "../src/render/emit-yaml-pyyaml";
import { emitTomlCodex } from "../src/render/emit-toml-codex";

describe("DocBuilder ordering", () => {
  test("build() preserves insertion order", () => {
    const d = doc().set("name", "drive").set("description", "A skill").set("license", "MIT").build();
    expect(d.entries.map((e) => e.key)).toEqual(["name", "description", "license"]);
  });

  test("overwriting a key keeps its original position but updates the value", () => {
    const d = doc().set("a", 1).set("b", 2).set("a", 99).build();
    expect(d.entries.map((e) => e.key)).toEqual(["a", "b"]);
    expect(d.entries.map((e) => e.value)).toEqual([99, 2]);
  });

  test("setIf skips undefined and null, keeps false / 0 / empty string", () => {
    const d = doc()
      .setIf("keep_false", false)
      .setIf("keep_zero", 0)
      .setIf("keep_empty", "")
      .setIf("drop_undef", undefined)
      .setIf("drop_null", null)
      .build();
    expect(d.entries.map((e) => e.key)).toEqual(["keep_false", "keep_zero", "keep_empty"]);
  });

  test("merge applies record entries in iteration order (dict.update semantics)", () => {
    const d = doc().set("name", "x").merge({ b: 2, name: "y", c: 3 }).build();
    expect(d.entries.map((e) => e.key)).toEqual(["name", "b", "c"]);
    expect(d.entries[0]!.value).toBe("y");
  });

  test("has and size reflect current entries", () => {
    const b = doc().set("a", 1).set("b", 2);
    expect(b.has("a")).toBe(true);
    expect(b.has("z")).toBe(false);
    expect(b.size).toBe(2);
  });
});

describe("Document node type guards", () => {
  test("classify each value shape", () => {
    expect(isScalar("s")).toBe(true);
    expect(isScalar(3)).toBe(true);
    expect(isScalar(true)).toBe(true);
    expect(isScalar(null)).toBe(true);
    expect(isTextBlock(textBlock("t"))).toBe(true);
    expect(isDocList(list([1, 2]))).toBe(true);
    expect(isTableArray(tableArray([doc().build()]))).toBe(true);
    expect(isDocument(doc().build())).toBe(true);
    // Cross-checks: a non-matching guard is false.
    expect(isScalar(list([1]))).toBe(false);
    expect(isDocument(list([1]))).toBe(false);
    expect(isDocList(tableArray([]))).toBe(false);
  });
});

describe("emitYamlCanonical", () => {
  test("scalars in insertion order, trailing newline preserved", () => {
    const d = doc()
      .set("name", "drive")
      .set("description", "A skill")
      .set("count", 3)
      .set("flag", true)
      .set("empty", null)
      .build();
    expect(emitYamlCanonical(d)).toBe(
      "name: drive\ndescription: A skill\ncount: 3\nflag: true\nempty: null\n",
    );
  });

  test("lists render as block sequences; empty list is flow []", () => {
    const d = doc().set("allowed-tools", list(["Bash", "Read"])).set("tags", list([])).build();
    expect(emitYamlCanonical(d)).toBe("allowed-tools:\n  - Bash\n  - Read\ntags: []\n");
  });

  test("nested documents render as nested mappings", () => {
    const inner = doc().set("source", "skm").set("nested", doc().set("a", 1).build()).build();
    const d = doc().set("metadata", inner).build();
    expect(emitYamlCanonical(d)).toBe("metadata:\n  source: skm\n  nested:\n    a: 1\n");
  });

  test("text blocks render as literal block scalars", () => {
    const d = doc().set("developer_instructions", textBlock("line1\nline2\nline3\n")).build();
    expect(emitYamlCanonical(d)).toBe("developer_instructions: |\n  line1\n  line2\n  line3\n");
  });

  test("table arrays render as sequences of mappings", () => {
    const t = tableArray([
      doc().set("label", "x").set("agent", "y").build(),
      doc().set("label", "z").set("agent", "w").build(),
    ]);
    const d = doc().set("handoffs", t).build();
    expect(emitYamlCanonical(d)).toBe(
      "handoffs:\n  - label: x\n    agent: y\n  - label: z\n    agent: w\n",
    );
  });

  test("round-trips back to an equivalent plain object", () => {
    const d = doc()
      .set("name", "drive")
      .set("tools", list(["Bash"]))
      .set("meta", doc().set("k", "v").build())
      .build();
    expect(parseYaml(emitYamlCanonical(d))).toEqual({ name: "drive", tools: ["Bash"], meta: { k: "v" } });
  });
});

describe("frontmatterDocument", () => {
  const d: Document = doc().set("name", "drive").set("description", "A skill").build();

  test("produces the shared markdown wrapping shape", () => {
    expect(frontmatterDocument(d, "# Title\n\nBody text")).toBe(
      "---\nname: drive\ndescription: A skill\n---\n\n# Title\n\nBody text\n",
    );
  });

  test("normalizes a body with trailing newlines to exactly one", () => {
    expect(frontmatterDocument(d, "Body\n\n\n")).toBe(
      "---\nname: drive\ndescription: A skill\n---\n\nBody\n",
    );
  });
});

describe("emitter binding registry", () => {
  test("canonical emitter is name-tagged and callable via the registry", () => {
    expect(yamlCanonicalEmitter.name).toBe("yaml-canonical");
    expect(EMITTERS["yaml-canonical"].emit(doc().set("a", 1).build())).toBe("a: 1\n");
  });

  test("every dialect binds to a registered emitter", () => {
    for (const [dialect, name] of Object.entries(DIALECT_EMITTER)) {
      expect(EMITTERS[name]).toBeDefined();
      expect(emitterFor(dialect as keyof typeof DIALECT_EMITTER).name).toBe(name);
    }
  });

  test("skill dialects use the canonical emitter", () => {
    expect(emitterFor("skill-spec").name).toBe("yaml-canonical");
    expect(emitterFor("skill-claude").name).toBe("yaml-canonical");
  });
});

describe("byte-compat emitters on an empty document", () => {
  test("pyyaml-compat emits the empty mapping", () => {
    expect(emitYamlPyyaml(doc().build())).toBe("{}");
  });

  test("toml-codex-compat emits nothing", () => {
    expect(emitTomlCodex(doc().build())).toBe("");
  });
});
