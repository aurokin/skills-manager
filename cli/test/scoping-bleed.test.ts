// Regression for the allow/deny placement semantics (design §5):
// - `allow` is best-effort; the non-allowed agents are soft BLEED, "reported, not
//   blocked". doctor must NOT flag a correctly-placed allow-scoped skill as a hard
//   deny-guarantee violation (deny-solver-1).
// - An agent that received its OWN placement is an intended recipient and must
//   never be reported as bleed on another placement, nor become a kill-switch
//   suggestion (deny-solver-2).

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { diagnose } from "../src/doctor";
import { computeDesiredPlacements } from "../src/placements";
import { loadRegistry } from "../src/registry";
import type { DesiredSkill, DesiredState, MachineConfig, StateFile } from "../src/types";
import { makeSandbox, realRegistryPath } from "./util";

function skill(name: string, scoping: DesiredSkill["scoping"]): DesiredSkill {
  return {
    name,
    source: { root: "public", visibility: "public", path: "/dummy/" + name },
    scoping,
    overrides: {},
  };
}
function desiredOf(skills: DesiredSkill[]): DesiredState {
  return { skills, agentDefs: [], warnings: [], hash: "sha256:test" };
}

const registry = loadRegistry(realRegistryPath());
const config: MachineConfig = { version: 1, roots: [] }; // default enabled set

describe("allow best-effort: allowed recipients are not bleed / kill-switch targets", () => {
  test("an allowed agent with its own placement is not listed as bleed", () => {
    const sb = makeSandbox();
    try {
      const desired = desiredOf([skill("s1", { allow: ["claude-code", "opencode"] })]);
      const { placements, bleed } = computeDesiredPlacements(sb.env, config, registry, desired);

      // opencode got its own placement — it is an intended recipient.
      const dirs = placements.map((p) => p.placement.dir).sort();
      expect(dirs).toContain("opencode");
      expect(dirs).toContain("claude");

      // The claude-dir placement must NOT list opencode as incidental bleed.
      const claudeBleed = bleed.find((b) => b.agent === "claude-code");
      if (claudeBleed) expect(claudeBleed.readers).not.toContain("opencode");
    } finally {
      sb.cleanup();
    }
  });

  test("doctor does not suggest a kill switch for an allowed recipient", () => {
    const sb = makeSandbox();
    try {
      const desired = desiredOf([skill("s1", { allow: ["claude-code", "opencode"] })]);
      const state: StateFile = { version: 1, machine: "sandbox", artifacts: {} };
      const findings = diagnose(sb.env, config, registry, desired, state);

      const opencodeSuggestion = findings.find(
        (f) => f.category === "env-suggestion" && /opencode/i.test(f.message),
      );
      expect(opencodeSuggestion).toBeUndefined();
    } finally {
      sb.cleanup();
    }
  });
});

describe("allow is not a hard deny-guarantee", () => {
  test("an applied allow=[claude-code] skill triggers no deny-violation", () => {
    const sb = makeSandbox();
    try {
      const desired = desiredOf([skill("s1", { allow: ["claude-code"] })]);
      // State as after a normal apply: owned symlink in the claude dir (incidentally
      // read by opencode/cursor — the documented, acceptable bleed).
      const claudePath = path.join(sb.home, ".claude", "skills", "s1");
      const state: StateFile = {
        version: 1,
        machine: "sandbox",
        artifacts: {
          s1: {
            source: { root: "public", visibility: "public" },
            placements: [{ agent: "claude-code", path: claudePath, kind: "symlink" }],
          },
        },
      };

      const findings = diagnose(sb.env, config, registry, desired, state);
      expect(findings.some((f) => f.category === "deny-violation")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  test("a deny-scoped skill placed in a denied agent's dir IS a violation", () => {
    const sb = makeSandbox();
    try {
      // Deny opencode, but (wrongly) record a placement in the claude dir, which
      // opencode reads. The hard guarantee must catch it.
      const desired = desiredOf([skill("s2", { deny: ["opencode"] })]);
      const claudePath = path.join(sb.home, ".claude", "skills", "s2");
      const state: StateFile = {
        version: 3,
        machine: "sandbox",
        artifacts: {
          "skill:s2": {
            type: "skill",
            name: "s2",
            source: { root: "public", visibility: "public" },
            placements: [{ agent: "claude-code", path: claudePath, kind: "symlink" }],
          },
        },
      };

      const findings = diagnose(sb.env, config, registry, desired, state);
      const denyViolations = findings.filter((f) => f.category === "deny-violation");
      expect(denyViolations.length).toBeGreaterThan(0);
      expect(denyViolations[0]!.message).toMatch(/opencode/);
    } finally {
      sb.cleanup();
    }
  });
});
