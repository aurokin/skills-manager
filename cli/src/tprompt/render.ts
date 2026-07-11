// tprompt prompt-file rendering (ADR 0008). A rendered prompt is YAML
// frontmatter (title, description, tags; optional key/mode/enter) + a body of the
// artifact's instructions. Tags always carry the declared tags plus the stamped
// `skm` and `agent-def`|`skill` markers so the flat library stays filterable. The
// no-subagents footer is appended to agent-definition-derived prompts only
// (suppressible via `tprompt.footer: false`), never to skill-derived prompts.
//
// Field order and shape follow the oracle generators/tprompt.py and tprompt's
// promptmeta.go; bytes come from the canonical YAML emitter (ADR 0009 binds the
// `prompt-tprompt` surface to yaml-canonical — tprompt is skm-native, no goldens).

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAgentDefinitionFromDir } from "../agentdef/source";
import { hashContent } from "../render";
import { doc, list } from "../render/doc";
import type { DocValue } from "../render/doc";
import { frontmatterDocument } from "../render/emit-yaml-canonical";
import type { ArtifactType } from "../types";
import type { TpromptConfig } from "../agentdef/schema";
import { defaultTitle, parseSkillTpromptBlock, SUBAGENT_FOOTER } from "./spec";

interface PromptInput {
  cfg: TpromptConfig;
  name: string;
  description: string;
  body: string;
  isAgentDef: boolean;
}

/** Render the full tprompt prompt file for one artifact (frontmatter + body [+ footer]). */
export function renderTpromptPrompt(artifactType: ArtifactType, sourceDir: string): string {
  const input = artifactType === "agent-def" ? agentDefInput(sourceDir) : skillInput(sourceDir);
  const typeTag = input.isAgentDef ? "agent-def" : "skill";

  const tags = stampTags(input.cfg.tags ?? [], typeTag);
  const fm = doc();
  fm.set("title", input.cfg.title || defaultTitle(input.name));
  fm.set("description", input.cfg.description || input.description);
  fm.set("tags", list(tags as DocValue[]));
  fm.setIf("key", input.cfg.key);
  fm.setIf("mode", input.cfg.mode);
  fm.setIf("enter", input.cfg.enter);

  let body = input.body.replace(/\n+$/, "");
  if (input.isAgentDef && input.cfg.footer !== false) {
    body = `${body}\n\n${SUBAGENT_FOOTER}`;
  }
  return frontmatterDocument(fm.build(), body);
}

/** sha256 of the rendered prompt file (deletion-safety / drift ownership). */
export function tpromptPromptHash(artifactType: ArtifactType, sourceDir: string): string {
  return hashContent(renderTpromptPrompt(artifactType, sourceDir));
}

/** Declared tags plus the stamped `skm` and type markers, de-duplicated (order-stable). */
function stampTags(declared: string[], typeTag: string): string[] {
  const out: string[] = [];
  for (const tag of [...declared, "skm", typeTag]) {
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function agentDefInput(sourceDir: string): PromptInput {
  const def = loadAgentDefinitionFromDir(sourceDir);
  return {
    cfg: def.tprompt,
    name: def.name,
    description: def.description,
    body: def.instructions,
    isAgentDef: true,
  };
}

function skillInput(sourceDir: string): PromptInput {
  const raw = fs.readFileSync(path.join(sourceDir, "SKILL.md"), "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = (parseYaml(frontmatter) as Record<string, unknown> | null) ?? {};
  const name = path.basename(sourceDir);
  const label = path.join(sourceDir, "SKILL.md");
  const description = typeof fm.description === "string" ? fm.description : "";
  return {
    cfg: parseSkillTpromptBlock(fm, label),
    name,
    description,
    // Drop the blank line the frontmatter fence leaves in front of the body so the
    // prompt body starts at the content (trailing newlines are trimmed on render).
    body: body.replace(/^\r?\n+/, ""),
    isAgentDef: false,
  };
}

/** Split a `---`-fenced frontmatter block from the body (mirrors render.ts). */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1]!, body: content.slice(match[0].length) };
}
