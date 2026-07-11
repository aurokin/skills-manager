// Minimal TOML reader for tprompt's config.toml (ADR 0008). skm reads (never
// writes) tprompt's own config to learn the prompts directory, so it only needs
// the two prompt-source fields — `prompts_dir` (string) and
// `additional_prompts_dirs` (array of strings). Rather than take a runtime TOML
// dependency (the repo ships a single `yaml` prod dep; smol-toml is test-only),
// this ports just enough of the format: top-level string and string-array
// key/values, honoring `#` comments and `~`-preserving quoted strings. Anything
// after the first table header (`[section]`) is ignored — the two keys skm cares
// about are always top-level, matching how tprompt's decoder surfaces them.

export type TomlRootValue = string | string[];

/**
 * A top-level `key = value` line that is not valid TOML (e.g. an unquoted
 * `prompts_dir = /custom/prompts`). tprompt's BurntSushi loader hard-errors on
 * such a config and refuses to run, so skm must not silently drop the line and
 * fall back to a default prompts dir. resolveTpromptDirs turns this into a
 * ConfigError.
 */
export class TomlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlParseError";
  }
}

/**
 * Parse the top-level (pre-table) `key = value` pairs of a TOML document where
 * the value is a basic/literal string or an array of such strings. Other value
 * shapes (ints, bools, tables) and every key after the first `[header]` are
 * skipped — this is a targeted reader, not a general TOML parser.
 */
export function parseTomlRootStrings(text: string): Record<string, TomlRootValue> {
  const out: Record<string, TomlRootValue> = {};
  const s = text;
  const n = s.length;
  let i = 0;

  while (i < n) {
    i = skipBlank(s, i);
    if (i >= n) break;
    const ch = s[i]!;
    if (ch === "[") break; // first table header — top-level scan is done
    // key
    const keyMatch = /^([A-Za-z0-9_.-]+)[ \t]*=[ \t]*/.exec(s.slice(i));
    if (!keyMatch) {
      i = skipLine(s, i); // not a recognizable key line; skip it
      continue;
    }
    const key = keyMatch[1]!;
    i += keyMatch[0].length;
    const vch = s[i];
    if (vch === '"' || vch === "'") {
      const [value, next] = readString(s, i);
      out[key] = value;
      i = skipLine(s, next);
    } else if (vch === "[") {
      const [value, next] = readStringArray(s, i);
      out[key] = value;
      i = skipLine(s, next);
    } else {
      // Bare (unquoted) value. Strings are only valid when quoted, so a bare token
      // must be a valid TOML scalar (bool / number / datetime / inline table). Any
      // other token — e.g. an unquoted path `prompts_dir = tmp/prompts` — is
      // malformed TOML that tprompt's BurntSushi loader rejects; surface it instead
      // of silently dropping the line (which would fall back to the XDG default and,
      // under --prune, relocate/delete the user's owned exports). Recognized scalars
      // are skipped — skm only consumes the two prompt-source string fields.
      const raw = bareValue(s, i);
      if (!isValidTomlScalar(raw)) {
        throw new TomlParseError(
          `malformed value for key '${key}': '${raw}' is not a string, array, or valid TOML scalar`,
        );
      }
      i = skipLine(s, i);
    }
  }
  return out;
}

/** The raw bare-value token on this line: everything up to `#` or EOL, trimmed. */
function bareValue(s: string, i: number): string {
  const nl = s.indexOf("\n", i);
  const line = nl < 0 ? s.slice(i) : s.slice(i, nl);
  const hash = line.indexOf("#");
  return (hash < 0 ? line : line.slice(0, hash)).trim();
}

/**
 * True only for a bare token that BurntSushi would accept as a scalar value:
 * booleans, integers/floats (underscores, hex/oct/bin, inf/nan with sign),
 * date-time shapes, and (pragmatically) a balanced inline table. Everything else
 * — including unquoted strings — is malformed and must raise TomlParseError.
 */
function isValidTomlScalar(raw: string): boolean {
  if (raw === "") return false;
  if (raw === "true" || raw === "false") return true;
  if (raw.startsWith("{") && raw.endsWith("}")) return true; // inline table (pragmatic)
  return isTomlNumber(raw) || isTomlDateTime(raw);
}

function isTomlNumber(raw: string): boolean {
  if (/^[+-]?(inf|nan)$/.test(raw)) return true;
  if (/^0x[0-9a-fA-F](_?[0-9a-fA-F])*$/.test(raw)) return true;
  if (/^0o[0-7](_?[0-7])*$/.test(raw)) return true;
  if (/^0b[01](_?[01])*$/.test(raw)) return true;
  // decimal integer or float (no leading zeros in the integer part except `0`).
  return /^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$/.test(raw);
}

function isTomlDateTime(raw: string): boolean {
  // offset/local date-time, local date (RFC 3339-ish).
  if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw)) return true;
  // local time.
  return /^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw);
}

/** Skip whitespace, blank lines, and full `#` comment lines. Returns new index. */
function skipBlank(s: string, i: number): number {
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
    } else if (ch === "#") {
      i = skipLine(s, i);
    } else {
      break;
    }
  }
  return i;
}

/** Advance past the end of the current line (consuming the newline). */
function skipLine(s: string, i: number): number {
  const nl = s.indexOf("\n", i);
  return nl < 0 ? s.length : nl + 1;
}

/**
 * Read a basic (`"`) or literal (`'`) string starting at `i`. Returns [value,
 * nextIndex]. Mirrors BurntSushi strictness: an unterminated string (EOL/EOF
 * before the closing quote) and an invalid escape sequence both raise
 * TomlParseError rather than resolving to a bogus value — a silently wrong
 * prompts_dir could redirect prunes.
 */
function readString(s: string, i: number): [string, number] {
  const quote = s[i]!;
  i++;
  let out = "";
  const n = s.length;
  if (quote === "'") {
    // literal string: no escapes, must be terminated on the same line.
    while (i < n && s[i] !== "'" && s[i] !== "\n") out += s[i++];
    if (i >= n || s[i] !== "'") throw new TomlParseError("unterminated literal string");
    return [out, i + 1];
  }
  // basic string: backslash escapes, must be terminated on the same line.
  while (i < n && s[i] !== '"') {
    const ch = s[i]!;
    if (ch === "\n") throw new TomlParseError("unterminated basic string");
    if (ch === "\\") {
      const esc = s[i + 1];
      switch (esc) {
        case "n": out += "\n"; i += 2; break;
        case "t": out += "\t"; i += 2; break;
        case "r": out += "\r"; i += 2; break;
        case "b": out += "\b"; i += 2; break;
        case "f": out += "\f"; i += 2; break;
        case '"': out += '"'; i += 2; break;
        case "\\": out += "\\"; i += 2; break;
        case "u": out += unicodeEscape(s, i + 2, 4); i += 6; break;
        case "U": out += unicodeEscape(s, i + 2, 8); i += 10; break;
        default:
          throw new TomlParseError(`invalid escape sequence '\\${esc ?? ""}' in basic string`);
      }
    } else {
      out += ch;
      i++;
    }
  }
  if (i >= n || s[i] !== '"') throw new TomlParseError("unterminated basic string");
  return [out, i + 1];
}

/** Decode exactly `len` hex digits at `at` as a \u/\U escape; throw on malformed hex. */
function unicodeEscape(s: string, at: number, len: number): string {
  const hex = s.slice(at, at + len);
  if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TomlParseError(`invalid unicode escape '\\${len === 4 ? "u" : "U"}${hex}'`);
  }
  return String.fromCodePoint(Number.parseInt(hex, 16));
}

/** Read an inline/multi-line array of strings starting at `[`. Non-string items are skipped. */
function readStringArray(s: string, i: number): [string[], number] {
  const items: string[] = [];
  const n = s.length;
  i++; // consume "["
  while (i < n) {
    i = skipBlank(s, i);
    if (i >= n) break;
    const ch = s[i]!;
    if (ch === "]") {
      i++;
      break;
    }
    if (ch === ",") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const [value, next] = readString(s, i);
      items.push(value);
      i = next;
    } else {
      // Unsupported element type — advance one char to avoid a stuck loop.
      i++;
    }
  }
  return [items, i];
}
