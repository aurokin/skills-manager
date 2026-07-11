// Canonical YAML frontmatter emitter (ADR 0009).
//
// Clean, library-default YAML for skm-native formats (skill rendering, tprompt)
// and for all formats post-cutover. This is NOT the PyYAML-compat emitter — it
// makes no attempt to reproduce `safe_dump`'s wrapping/escaping heuristics; it
// delegates to the `yaml` dependency's defaults, which is exactly what the
// existing skill renderer already does (so migrating it onto this pipeline is
// byte-preserving as long as the Document mirrors the current key order).

import { stringify } from "yaml";
import type { Document, DocValue } from "./doc";
import { isDocList, isDocument, isFloat, isScalar, isTableArray, isTextBlock } from "./doc";
import type { Emitter } from "./emit";

/**
 * Serialize a Document to a YAML mapping block. Returns the library's output
 * verbatim — including its single trailing newline — so callers wrapping their
 * own frontmatter fence get byte-identical results to a direct `stringify`.
 */
export function emitYamlCanonical(document: Document): string {
  return stringify(toPlain(document));
}

/** The canonical emitter as a bound Emitter (see emit.ts registry). */
export const yamlCanonicalEmitter: Emitter = {
  name: "yaml-canonical",
  emit: emitYamlCanonical,
};

/**
 * Wrap a Document + body into the frontmatter markdown shape shared by every
 * markdown dialect: `---\n{yaml}\n---\n\n{body}\n`. The YAML block is trimmed
 * of its trailing newline and the body is normalized to exactly one trailing
 * newline, matching the Python generators' `f"---\n{yaml.strip()}\n---\n\n{body}\n"`.
 */
export function frontmatterDocument(document: Document, body: string): string {
  const yaml = emitYamlCanonical(document).replace(/\n+$/, "");
  const trimmedBody = body.replace(/\n+$/, "");
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document AST → plain JS (fed to the `yaml` serializer)
// ─────────────────────────────────────────────────────────────────────────────

function toPlain(document: Document): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of document.entries) {
    out[key] = plainValue(value);
  }
  return out;
}

function plainValue(value: DocValue): unknown {
  if (isFloat(value)) return value.value;
  if (isScalar(value)) return value;
  if (isTextBlock(value)) return value.text;
  if (isDocList(value)) return value.items.map(plainValue);
  if (isTableArray(value)) return value.tables.map(toPlain);
  if (isDocument(value)) return toPlain(value);
  // Exhaustive: DocValue has no other shape.
  throw new Error(`Unrenderable Document value: ${JSON.stringify(value)}`);
}
