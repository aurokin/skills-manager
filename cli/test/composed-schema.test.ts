// AUR-645: composed-skill source validation (data layer). Covers the full
// validation matrix, posture-marker grammar, and the self-derivation guards.

import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import {
  ComposedSkillError,
  loadComposedSkill,
  splitConsumerSections,
  validatePostureMarkers,
  type ComposedSkillInput,
} from "../src/composed/schema";
import { loadRegistry } from "../src/registry";
import type { Registry } from "../src/types";
import { realRegistryPath } from "./util";

const registry = loadRegistry(realRegistryPath());

/** A provider file (frontmatter registry + body). */
function providerText(
  name: string,
  cli: string,
  models: Record<string, { default?: boolean }>,
  verified?: string,
): string {
  const fm: Record<string, unknown> = { name, cli, models };
  if (verified) fm.verified = verified;
  return `---\n${stringify(fm)}---\n\nProvider ${name}. {{provider_clis}}\n`;
}

/** A valid composed-skill input (providers claude/codex/grok, consumers claude-code/codex). */
function baseInput(): ComposedSkillInput {
  return {
    name: "orchestrate",
    source: { root: "public", visibility: "public", path: "/x/composed/orchestrate" },
    path: "/x/composed/orchestrate/skill.yaml",
    skillYaml: {
      name: "orchestrate",
      posture: "yolo",
      consumers: {
        "claude-code": { description: "Delegate to codex/grok; not for code review." },
        codex: { description: "Delegate to claude/grok." },
      },
      dimensions: [
        {
          key: "implementation",
          title: "Bounded implementation",
          when: "bulk changes",
          candidates: [
            { provider: "codex", model: "gpt-5.5" },
            { provider: "grok", model: "grok-4.5" },
          ],
        },
        { key: "judgment", candidates: [{ provider: "claude", model: "opus", note: "fable on request" }] },
      ],
    },
    template: "Body\n\n{{routing_table}}\n",
    providerFiles: {
      claude: providerText("claude", "claude", { opus: { default: true } }),
      codex: providerText("codex", "codex", { "gpt-5.5": { default: true } }),
      grok: providerText("grok", "grok", { "grok-4.5": { default: true } }),
    },
    consumerFiles: {},
    registry,
  };
}

/** Deep-clone + mutate the skill.yaml mapping of a base input. */
function withYaml(mut: (y: any) => void): ComposedSkillInput {
  const input = baseInput();
  input.skillYaml = JSON.parse(JSON.stringify(input.skillYaml));
  mut(input.skillYaml as any);
  return input;
}

describe("loadComposedSkill — happy path", () => {
  test("parses a valid composed skill into the carrier", () => {
    const { skill, warnings } = loadComposedSkill(baseInput());
    expect(skill.name).toBe("orchestrate");
    expect(skill.posture).toBe("yolo");
    expect(Object.keys(skill.consumers).sort()).toEqual(["claude-code", "codex"]);
    expect(skill.dimensions.map((d) => d.key)).toEqual(["implementation", "judgment"]);
    expect(Object.keys(skill.providers).sort()).toEqual(["claude", "codex", "grok"]);
    expect(skill.providers.grok!.cli).toBe("grok");
    expect(skill.providers.grok!.models["grok-4.5"]).toEqual({ default: true });
    expect(warnings).toEqual([]);
  });

  test("absent posture defaults to sandboxed", () => {
    const { skill } = loadComposedSkill(withYaml((y) => delete y.posture));
    expect(skill.posture).toBe("sandboxed");
  });
});

describe("validation matrix", () => {
  test("duplicate dimension key is rejected", () => {
    const input = withYaml((y) => {
      y.dimensions[1].key = "implementation";
    });
    expect(() => loadComposedSkill(input)).toThrow(/Duplicate dimension key 'implementation'/);
  });

  test("unique dimension keys pass", () => {
    expect(() => loadComposedSkill(baseInput())).not.toThrow();
  });

  test("empty candidate list is rejected", () => {
    const input = withYaml((y) => {
      y.dimensions[1].candidates = [];
    });
    expect(() => loadComposedSkill(input)).toThrow(/Dimension 'judgment' has no candidates/);
  });

  test("candidate provider with no provider file is rejected", () => {
    const input = withYaml((y) => {
      y.dimensions[1].candidates = [{ provider: "gemini-cli", model: "x" }];
    });
    // gemini-cli is not a directory id either, but the provider-file-existence check
    // fires: no providers/gemini-cli.md was supplied.
    expect(() => loadComposedSkill(input)).toThrow(/references provider 'gemini-cli' with no providers/);
  });

  test("candidate model absent from the provider frontmatter is rejected", () => {
    const input = withYaml((y) => {
      y.dimensions[1].candidates = [{ provider: "claude", model: "sonnet" }];
    });
    expect(() => loadComposedSkill(input)).toThrow(/names model 'sonnet' not in provider 'claude' frontmatter/);
  });

  test("a valid candidate model passes", () => {
    const input = withYaml((y) => {
      y.dimensions[1].candidates = [{ provider: "claude", model: "opus" }];
    });
    expect(() => loadComposedSkill(input)).not.toThrow();
  });

  test("a dimension listing the same provider twice is rejected", () => {
    const input = withYaml((y) => {
      y.dimensions[0].candidates = [
        { provider: "codex", model: "gpt-5.5" },
        { provider: "codex", model: "gpt-5.5" },
      ];
    });
    expect(() => loadComposedSkill(input)).toThrow(/lists provider 'codex' twice/);
  });

  test("a declared consumer that is not skills-supported is rejected", () => {
    const input = withYaml((y) => {
      y.consumers.aider = { description: "nope" };
    });
    expect(() => loadComposedSkill(input)).toThrow(/Consumer 'aider' has skillsSupport 'none'/);
  });

  test("an unknown consumer agent is rejected", () => {
    const input = withYaml((y) => {
      y.consumers.nobody = { description: "nope" };
    });
    expect(() => loadComposedSkill(input)).toThrow(/Consumer 'nobody' is not a known agent/);
  });

  test("a supported consumer passes", () => {
    const input = withYaml((y) => {
      y.consumers.opencode = { description: "opencode reads claude; ok as a consumer." };
    });
    // opencode ownDir is `opencode`, not a provider → requires selfProvider: none.
    (input.skillYaml as any).consumers.opencode.selfProvider = "none";
    expect(() => loadComposedSkill(input)).not.toThrow();
  });

  test("a consumer with an empty description is rejected", () => {
    const input = withYaml((y) => {
      y.consumers.codex.description = "";
    });
    expect(() => loadComposedSkill(input)).toThrow(/Expected 'description' to be non-empty/);
  });

  test("a missing consumer description is rejected", () => {
    const input = withYaml((y) => {
      delete y.consumers.codex.description;
    });
    expect(() => loadComposedSkill(input)).toThrow(/Missing required field 'description'/);
  });

  test("an invalid posture value is rejected", () => {
    const input = withYaml((y) => {
      y.posture = "chaos";
    });
    expect(() => loadComposedSkill(input)).toThrow(/Invalid posture.*chaos/);
  });

  test("a provider file referenced by no dimension surfaces a warning, not an error", () => {
    const input = baseInput();
    input.providerFiles.pi = providerText("pi", "pi", { "pi-1": {} });
    // pi IS a registry directory id, so the filename↔dir guard passes; but no
    // dimension references it → warning.
    const { warnings } = loadComposedSkill(input);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe("unused-provider");
    expect(warnings[0]!.message).toContain("providers/pi.md");
  });

  test("a missing SKILL.tmpl.md is rejected", () => {
    const input = baseInput();
    input.template = undefined;
    expect(() => loadComposedSkill(input)).toThrow(/Missing SKILL\.tmpl\.md/);
  });

  test("a provider filename not matching a registry directory id is rejected", () => {
    const input = baseInput();
    input.providerFiles.bogus = providerText("bogus", "bogus", { m: {} });
    expect(() => loadComposedSkill(input)).toThrow(/does not match any registry directory id/);
  });
});

describe("consumer files", () => {
  test("a consumer file not naming a declared consumer is rejected", () => {
    const input = baseInput();
    input.consumerFiles = { ...input.consumerFiles, cdoex: "<!-- @section gate -->\nx\n" };
    expect(() => loadComposedSkill(input)).toThrow(
      /consumer file 'consumers\/cdoex\.md' does not match any declared consumer/,
    );
  });

  test("a consumer file for a declared consumer passes", () => {
    const input = baseInput();
    input.consumerFiles = { ...input.consumerFiles, codex: "<!-- @section gate -->\nx\n" };
    expect(() => loadComposedSkill(input)).not.toThrow();
  });
});

describe("self-derivation guards", () => {
  test("droid (ownDir factory) with no matching provider requires selfProvider: none", () => {
    // factory is not among providers {claude,codex,grok} → the acknowledgment is
    // mandatory. This is the droid/factory mismatch precedent.
    const input = withYaml((y) => {
      y.consumers.droid = { description: "droid delegates to claude/codex/grok." };
    });
    expect(() => loadComposedSkill(input)).toThrow(/derives self-provider 'factory'.*selfProvider: none/s);
  });

  test("droid passes once selfProvider: none is acknowledged", () => {
    const input = withYaml((y) => {
      y.consumers.droid = { description: "droid delegates to claude/codex/grok.", selfProvider: "none" };
    });
    expect(() => loadComposedSkill(input)).not.toThrow();
  });

  test("a consumer whose ownDir IS a declared provider needs no acknowledgment", () => {
    // claude-code (ownDir claude) and codex (ownDir codex) both self-match a provider.
    expect(() => loadComposedSkill(baseInput())).not.toThrow();
  });

  test("selfProvider: none is rejected when the derived self IS a declared provider", () => {
    const input = withYaml((y) => {
      y.consumers.codex.selfProvider = "none"; // codex's ownDir 'codex' IS a provider
    });
    expect(() => loadComposedSkill(input)).toThrow(/IS a declared provider; remove the acknowledgment/);
  });

  test("selfProvider only accepts \"none\"", () => {
    const input = withYaml((y) => {
      y.consumers.codex.selfProvider = "codex";
    });
    expect(() => loadComposedSkill(input)).toThrow(/only "none" is allowed/);
  });

  test("two consumers resolving to the same ownDir is rejected", () => {
    // Synthetic registry: a1 and a2 share ownDir `shared`.
    const synth: Registry = {
      version: 1,
      directories: { shared: { path: "~/.agents/skills" }, codex: { path: "~/.codex/skills" } },
      agents: {
        a1: { skillsSupport: "supported", reads: ["shared"], maybeReads: [], ownDir: "shared", dialect: "claude", symlinks: "followed", evidence: "t" },
        a2: { skillsSupport: "supported", reads: ["shared"], maybeReads: [], ownDir: "shared", dialect: "claude", symlinks: "followed", evidence: "t" },
      },
    };
    const input: ComposedSkillInput = {
      name: "c",
      source: { root: "public", visibility: "public", path: "/x/composed/c" },
      path: "/x/composed/c/skill.yaml",
      skillYaml: {
        name: "c",
        consumers: {
          a1: { description: "a1 consumer.", selfProvider: "none" },
          a2: { description: "a2 consumer.", selfProvider: "none" },
        },
        dimensions: [{ key: "impl", candidates: [{ provider: "codex", model: "gpt-5.5" }] }],
      },
      template: "{{routing_table}}",
      providerFiles: { codex: providerText("codex", "codex", { "gpt-5.5": { default: true } }) },
      consumerFiles: {},
      registry: synth,
    };
    expect(() => loadComposedSkill(input)).toThrow(/both resolve to output directory 'shared'/);
  });
});

describe("posture-marker grammar", () => {
  test("a well-formed posture block passes", () => {
    const text = "intro\n<!-- @posture yolo -->\nyolo line\n<!-- @end -->\ntail\n";
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });

  test("an unknown posture value is rejected", () => {
    const text = "<!-- @posture chaos -->\nx\n<!-- @end -->\n";
    expect(() => validatePostureMarkers(text, "t", false)).toThrow(/unknown @posture value 'chaos'/);
  });

  test("an unclosed block at EOF is rejected", () => {
    const text = "<!-- @posture yolo -->\nx\n";
    expect(() => validatePostureMarkers(text, "t", false)).toThrow(/unclosed @posture yolo/);
  });

  test("a nested block is rejected", () => {
    const text = "<!-- @posture yolo -->\n<!-- @posture sandboxed -->\nx\n<!-- @end -->\n<!-- @end -->\n";
    expect(() => validatePostureMarkers(text, "t", false)).toThrow(/nested @posture block/);
  });

  test("an @end with no open block is rejected", () => {
    const text = "x\n<!-- @end -->\n";
    expect(() => validatePostureMarkers(text, "t", false)).toThrow(/@end without an open @posture block/);
  });

  test("in a consumer file, a posture block crossing an @section boundary is rejected", () => {
    const text = "<!-- @section gate -->\n<!-- @posture yolo -->\nx\n<!-- @section appendix -->\ny\n<!-- @end -->\n";
    expect(() => validatePostureMarkers(text, "t", true)).toThrow(/crosses an @section boundary/);
  });

  test("markers inside a fenced code block are ignored", () => {
    const text = [
      "intro",
      "```md",
      "<!-- @posture chaos -->", // unknown value, but inside a fence → ignored
      "<!-- @end -->",
      "<!-- @posture yolo -->", // unbalanced, but inside a fence → ignored
      "```",
      "tail",
    ].join("\n");
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });

  test("a marker not at line start is treated as plain text", () => {
    const text = "prefix <!-- @posture chaos --> still text\n";
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });

  test("markers inside a tilde fence are ignored", () => {
    const text = ["~~~", "<!-- @posture chaos -->", "~~~", "tail"].join("\n");
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });

  test("markers inside an indented (three-space) fence are ignored", () => {
    const text = ["   ```", "<!-- @posture chaos -->", "   ```", "tail"].join("\n");
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });

  test("a longer backtick fence is only closed by a run at least as long", () => {
    const text = [
      "````md",
      "```", // shorter run inside a ```` fence — content, not a closer
      "<!-- @posture chaos -->",
      "````",
      "tail",
    ].join("\n");
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });

  test("a mismatched fence char does not close the block", () => {
    const text = ["```", "~~~", "<!-- @posture chaos -->", "```", "tail"].join("\n");
    expect(() => validatePostureMarkers(text, "t", false)).not.toThrow();
  });
});

describe("splitConsumerSections", () => {
  test("splits gate and appendix, dropping preamble and marker lines", () => {
    const text = "ignored preamble\n<!-- @section gate -->\ngate body\n<!-- @section appendix -->\nappendix body\n";
    expect(splitConsumerSections(text)).toEqual({ gate: "gate body", appendix: "appendix body" });
  });

  test("both sections are optional", () => {
    expect(splitConsumerSections("just prose, no markers\n")).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared provider pool (ADR 0012)
// ─────────────────────────────────────────────────────────────────────────────

describe("shared provider pool", () => {
  /** baseInput with the claude provider moved from local files to the pool. */
  function pooledInput(): ComposedSkillInput {
    const input = baseInput();
    const { claude, ...local } = input.providerFiles;
    input.providerFiles = local;
    input.poolProviderFiles = { claude: claude! };
    return input;
  }

  test("a dimension candidate resolves from the pool", () => {
    const { skill, warnings } = loadComposedSkill(pooledInput());
    expect(Object.keys(skill.providers).sort()).toEqual(["claude", "codex", "grok"]);
    expect(skill.providers.claude!.cli).toBe("claude");
    expect(warnings).toEqual([]);
  });

  test("pool resolution renders byte-identically to local resolution", () => {
    // Same provider bytes, different location → identical carrier content.
    const local = loadComposedSkill(baseInput()).skill;
    const pooled = loadComposedSkill(pooledInput()).skill;
    expect(pooled.providers).toEqual(local.providers);
  });

  test("the same provider id local AND pooled is a build error, not shadowing", () => {
    const input = baseInput();
    input.poolProviderFiles = { claude: input.providerFiles.claude! };
    expect(() => loadComposedSkill(input)).toThrow(/mutually exclusive, not shadowed/);
  });

  test("a pool provider filename not matching a registry directory id is rejected", () => {
    const input = baseInput();
    input.poolProviderFiles = { bogus: providerText("bogus", "bogus", { m: {} }) };
    expect(() => loadComposedSkill(input)).toThrow(
      /pool provider file '_providers\/bogus\.md' does not match any registry directory id/,
    );
  });

  test("an unresolvable candidate names both lookup locations", () => {
    const input = pooledInput();
    delete input.poolProviderFiles!.claude;
    expect(() => loadComposedSkill(input)).toThrow(
      /no providers\/claude\.md or pool _providers\/claude\.md file/,
    );
  });

  test("declared set derives from dimensions: an unreferenced local file is excluded (and warns)", () => {
    const input = baseInput();
    input.providerFiles.pi = providerText("pi", "pi", { "pi-1": {} });
    const { skill, warnings } = loadComposedSkill(input);
    // pi never enters the declared set, so {{provider_clis}} and self-derivation
    // are computed without it (ADR 0012).
    expect(Object.keys(skill.providers).sort()).toEqual(["claude", "codex", "grok"]);
    expect(warnings.map((w) => w.kind)).toEqual(["unused-provider"]);
  });

  test("a referenced pool body gets posture-marker validation under the pool label", () => {
    const input = pooledInput();
    input.poolProviderFiles!.claude = input.poolProviderFiles!.claude!.replace(
      "Provider claude.",
      "<!-- @posture yolo -->\nunclosed",
    );
    expect(() => loadComposedSkill(input)).toThrow(/_providers\/claude\.md.*unclosed @posture/);
  });

  test("an UNreferenced pool file is not this skill's problem (no validation, no warning)", () => {
    const input = baseInput();
    // Malformed markers AND an id no dimension references: the skill loads clean.
    input.poolProviderFiles = {
      pi: `---\n${"name: pi\ncli: pi\nmodels: {}\n"}---\n\n<!-- @posture yolo -->\nunclosed\n`,
    };
    const { skill, warnings } = loadComposedSkill(input);
    expect(Object.keys(skill.providers).sort()).toEqual(["claude", "codex", "grok"]);
    expect(warnings).toEqual([]);
  });
});
