// tprompt prompts-directory resolution (ADR 0008). skm resolves the prompt
// namespace from tprompt's OWN config.toml — never a hardcoded path — matching
// tprompt/internal/config + internal/promptsource semantics:
//   - config.toml lives at $XDG_CONFIG_HOME/tprompt/config.toml, falling back to
//     ~/.config/tprompt/config.toml (tprompt's standardConfigPaths order).
//   - `prompts_dir` set → used verbatim (tilde-expanded like tprompt's expandHome).
//   - `prompts_dir` unset → $XDG_CONFIG_HOME/tprompt/prompts, else
//     ~/.config/tprompt/prompts (promptsource.primarySource).
//   - `additional_prompts_dirs` → tilde-expanded extra global dirs; part of the
//     flat prompt namespace for collision scanning, never a placement target.

import * as fs from "node:fs";
import * as path from "node:path";
import { configHome, type SkmEnv } from "../env";
import { ConfigError } from "../errors";
import { parseTomlRootStrings, TomlParseError } from "./toml";

export interface TpromptDirs {
  /** Primary prompts directory — the only place skm writes prompt files. */
  promptsDir: string;
  /** Additional global prompt dirs (namespace members for collision scanning). */
  additionalDirs: string[];
  /** The config.toml that was read, if one existed. */
  configPath?: string;
}

/**
 * Resolve the tprompt prompt directories for this environment. Pure over the
 * injected `env` (home + XDG), reading only tprompt's config.toml from disk.
 */
export function resolveTpromptDirs(env: SkmEnv): TpromptDirs {
  const configFile = findConfig(env);
  let promptsDirRaw = "";
  let additionalRaw: string[] = [];

  if (configFile) {
    let parsed: Record<string, string | string[]>;
    try {
      parsed = parseTomlRootStrings(fs.readFileSync(configFile, "utf8"));
    } catch (err) {
      // An existing-but-unparseable config.toml is a hard error in tprompt, which
      // then refuses to run. Mirror that instead of silently falling back to the
      // XDG default prompts dir (which would relocate — and, under --prune, delete
      // — the user's owned exports). See ADR 0008.
      if (err instanceof TomlParseError) {
        throw new ConfigError(
          `tprompt config ${configFile} is not valid TOML (${err.message}); ` +
            `refusing to fall back to a default prompts dir`,
        );
      }
      throw err;
    }
    const pd = parsed["prompts_dir"];
    if (typeof pd === "string") promptsDirRaw = pd;
    const ad = parsed["additional_prompts_dirs"];
    if (Array.isArray(ad)) additionalRaw = ad;
  }

  const promptsDir = promptsDirRaw.trim()
    ? expandHome(env, promptsDirRaw)
    : path.join(configHome(env), "tprompt", "prompts");

  const additionalDirs = additionalRaw
    .filter((p) => p.trim() !== "")
    .map((p) => expandHome(env, p));

  return { promptsDir, additionalDirs, configPath: configFile };
}

/** First existing candidate: <XDG>/tprompt/config.toml, then ~/.config/tprompt/config.toml. */
function findConfig(env: SkmEnv): string | undefined {
  const candidates = [
    path.join(configHome(env), "tprompt", "config.toml"),
    path.join(env.home, ".config", "tprompt", "config.toml"),
  ];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/** Expand a leading `~`/`~/` against the injected home (tprompt's expandHome). */
function expandHome(env: SkmEnv, p: string): string {
  if (p === "~") return env.home;
  if (p.startsWith("~/")) return path.join(env.home, p.slice(2));
  return p;
}
