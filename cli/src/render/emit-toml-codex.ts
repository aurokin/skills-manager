// Codex-compat TOML emitter (ADR 0009).
//
// A verbatim port of custom_agents' bespoke TOML serializer
// (shared_agents/generators/codex.py: _dump_toml_document / _dump_table /
// _format_value). Byte-format quirks live ONLY here: within every table each
// entry is partitioned into scalars → nested tables → arrays-of-tables and
// emitted in that group order (insertion order preserved within a group),
// multi-line strings render as triple-quoted (`"""`) with only `\` and `"""`
// escaped, single-line strings escape `\ " \n \t`, and keys are emitted bare
// (the Python source applies no key quoting). A general-purpose TOML emitter
// will not reproduce this partition/order/escaping — do not substitute one.

import type { Document, DocValue } from "./doc";
import { isDocList, isDocument, isFloat, isTableArray, isTextBlock } from "./doc";
import type { Emitter } from "./emit";

/** Serialize a Document to Codex-compatible TOML bytes. */
export function emitTomlCodex(document: Document): string {
  const lines: string[] = [];
  dumpTable(lines, document, []);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/** Port of codex.py `_dump_table`: scalars, then nested tables, then arrays-of-tables. */
function dumpTable(lines: string[], table: Document, prefix: readonly string[]): void {
  const scalarItems: DocValue[] = [];
  const scalarKeys: string[] = [];
  const nestedTables: Array<readonly [string, Document]> = [];
  const arrayTables: Array<readonly [string, readonly Document[]]> = [];

  for (const { key, value } of table.entries) {
    if (isDocument(value)) {
      nestedTables.push([key, value]);
    } else if (isTableArray(value)) {
      arrayTables.push([key, value.tables]);
    } else {
      scalarKeys.push(key);
      scalarItems.push(value);
    }
  }

  scalarKeys.forEach((key, i) => {
    lines.push(`${key} = ${formatValue(scalarItems[i]!)}`);
  });

  for (const [key, value] of nestedTables) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    const header = [...prefix, key].join(".");
    lines.push(`[${header}]`);
    dumpTable(lines, value, [...prefix, key]);
  }

  for (const [key, values] of arrayTables) {
    for (const item of values) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      const header = [...prefix, key].join(".");
      lines.push(`[[${header}]]`);
      dumpTable(lines, item, [...prefix, key]);
    }
  }
}

/** Port of codex.py `_format_value` over the Document AST's scalar/text-block/list values. */
function formatValue(value: DocValue): string {
  // Explicit multi-line marker: always triple-quoted (ADR 0009 design note 3).
  if (isTextBlock(value)) {
    return tripleQuote(value.text);
  }
  if (isDocList(value)) {
    return "[" + value.items.map(formatValue).join(", ") + "]";
  }
  // Float marker: mirror codex.py `repr(float)` — whole values keep a `.0`.
  if (isFloat(value)) {
    const s = String(value.value);
    return /[.e]/.test(s) ? s : s + ".0";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return tripleQuote(value);
    }
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  // null / Document / TableArray reaching here is unsupported (Python raises TypeError).
  throw new TypeError(`Unsupported TOML value: ${JSON.stringify(value)}`);
}

/** Triple-quoted TOML string: only `\` and `"""` are escaped (codex.py verbatim). */
function tripleQuote(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replaceAll('"""', '\\"\\"\\"');
  return `"""${escaped}"""`;
}

/** The Codex-TOML-compat emitter as a bound Emitter (see emit.ts registry). */
export const tomlCodexEmitter: Emitter = {
  name: "toml-codex-compat",
  emit: emitTomlCodex,
};
