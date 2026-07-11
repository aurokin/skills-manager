// Agent-definition source discovery + loading (AUR-616). Agent definitions live
// at `<root>/agents/<name>/{agent.yaml, instructions.md}`, parallel to `skills/`,
// in the public repo root and in overlay roots. This module reads one from disk
// and parses it through the AUR-615 schema loader. Owned by the resolve team.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentDefinition, loadAgentDefinition } from "./schema";

/**
 * Parse an `agent.yaml` string with YAML 1.1 semantics for PyYAML oracle parity.
 * PyYAML (safe_load) resolves YAML 1.1's boolean set — a definition written with
 * `yes/no/on/off` must load as booleans, not strings, so the schema's boolean
 * fields validate identically to the Python tool.
 *
 * Known accepted divergence: PyYAML's int resolver rejects float-valued literals
 * like `12.0` in an int field (`max_turns: 12.0` errors), but JS `yaml` parses
 * `12.0` to the number `12`, which is indistinguishable from an integer here — so
 * skm ACCEPTS `12.0` where Python would reject it. This is a deliberate,
 * documented behavior of the loader (JS has no int/float type distinction).
 */
export function parseAgentYaml(text: string): unknown {
  return parseYaml(text, { version: "1.1" });
}

/** True when `<dir>/agent.yaml` exists (the marker that makes a dir an agent def). */
export function isAgentDefDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "agent.yaml"));
}

/**
 * Load + validate one agent definition from its source directory. Reads
 * `agent.yaml` (YAML 1.1) and `instructions.md`, then runs the schema loader.
 */
export function loadAgentDefinitionFromDir(dir: string): AgentDefinition {
  const agentYaml = parseAgentYaml(fs.readFileSync(path.join(dir, "agent.yaml"), "utf8"));
  const instructionsMd = fs.readFileSync(path.join(dir, "instructions.md"), "utf8");
  return loadAgentDefinition({ agentYaml, instructionsMd, sourceDir: dir, path: path.join(dir, "agent.yaml") });
}
