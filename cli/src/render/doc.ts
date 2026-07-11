// Document AST for the ADR 0009 rendering pipeline.
//
// A `Document` is a format-neutral tree that dialects produce and emitters
// serialize. Dialects own structure (field selection, key renames, ordering);
// emitters own bytes. Nothing here builds strings or knows about YAML/TOML —
// keep it minimal (no comments, no anchors), but rich enough for TOML tables,
// arrays-of-tables, and multi-line text blocks from day one (ADR 0009).
//
// Value model:
//   - Scalars: string | number | boolean | null (primitives, untagged).
//   - Every non-scalar node is a tagged object carrying a `kind` discriminant,
//     so a value is a scalar iff it is not a non-null object.
//
// Nodes:
//   Document    — ordered key→value map (YAML mapping / TOML table).
//   DocList     — ordered sequence (YAML sequence / TOML inline array).
//   TableArray  — array-of-tables (TOML `[[x]]`; a YAML sequence of mappings).
//   TextBlock   — a multi-line text block marker (YAML literal block scalar /
//                 TOML triple-quoted string). Dialects use it to declare that a
//                 value is a body of text so emitters never guess from content.

/** A leaf scalar. */
export type Scalar = string | number | boolean | null;

/**
 * A number that must serialize as a float even when whole-valued. JS has no
 * int/float distinction, so a dialect wraps a value the oracle coerced with
 * `float()` (e.g. `_optional_number` fields) in this marker; the emitter then
 * renders `1` as `1.0`. Structure (float-ness) is the dialect's to declare —
 * bytes (the `.0`) remain the emitter's, per ADR 0009.
 */
export interface FloatScalar {
  readonly kind: "float";
  readonly value: number;
}

/** Multi-line text block marker (literal block scalar / triple-quoted string). */
export interface TextBlock {
  readonly kind: "text-block";
  readonly text: string;
}

/** Ordered sequence of values (YAML sequence / TOML inline array). */
export interface DocList {
  readonly kind: "list";
  readonly items: readonly DocValue[];
}

/** Array-of-tables: each element is a nested Document (TOML `[[key]]`). */
export interface TableArray {
  readonly kind: "table-array";
  readonly tables: readonly Document[];
}

/** Ordered key→value map — the core AST node. */
export interface Document {
  readonly kind: "document";
  readonly entries: readonly DocEntry[];
}

/** One insertion-ordered entry of a Document. */
export interface DocEntry {
  readonly key: string;
  readonly value: DocValue;
}

/** Any value a Document entry may hold. */
export type DocValue = Scalar | FloatScalar | TextBlock | DocList | TableArray | Document;

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

/** True for a leaf scalar (string | number | boolean | null). */
export function isScalar(value: DocValue): value is Scalar {
  return value === null || typeof value !== "object";
}

export function isDocument(value: DocValue): value is Document {
  return typeof value === "object" && value !== null && value.kind === "document";
}

export function isDocList(value: DocValue): value is DocList {
  return typeof value === "object" && value !== null && value.kind === "list";
}

export function isTableArray(value: DocValue): value is TableArray {
  return typeof value === "object" && value !== null && value.kind === "table-array";
}

export function isTextBlock(value: DocValue): value is TextBlock {
  return typeof value === "object" && value !== null && value.kind === "text-block";
}

export function isFloat(value: DocValue): value is FloatScalar {
  return typeof value === "object" && value !== null && value.kind === "float";
}

// ─────────────────────────────────────────────────────────────────────────────
// Node constructors
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap raw text as a multi-line text block. */
export function textBlock(text: string): TextBlock {
  return { kind: "text-block", text };
}

/** Mark a number as a float so whole values still serialize with a decimal. */
export function float(value: number): FloatScalar {
  return { kind: "float", value };
}

/** Build a list node from values. */
export function list(items: readonly DocValue[]): DocList {
  return { kind: "list", items: [...items] };
}

/** Build an array-of-tables node. */
export function tableArray(tables: readonly Document[]): TableArray {
  return { kind: "table-array", tables: [...tables] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutable, insertion-ordered Document builder — mirrors how the Python
 * generators conditionally build an ordered dict. `set` appends a new key or,
 * for an existing key, replaces its value in place while keeping its original
 * position (Python `dict` assignment / `dict.update` semantics).
 */
export class DocBuilder {
  private readonly _order: string[] = [];
  private readonly _values = new Map<string, DocValue>();

  /** Set `key` to `value`, preserving first-insertion position on overwrite. */
  set(key: string, value: DocValue): this {
    if (!this._values.has(key)) this._order.push(key);
    this._values.set(key, value);
    return this;
  }

  /** Set `key` only when `value` is neither undefined nor null. */
  setIf(key: string, value: DocValue | undefined): this {
    if (value !== undefined && value !== null) this.set(key, value);
    return this;
  }

  /** Set each entry of `record` in iteration order (Python `dict.update`). */
  merge(record: Record<string, DocValue>): this {
    for (const [key, value] of Object.entries(record)) this.set(key, value);
    return this;
  }

  has(key: string): boolean {
    return this._values.has(key);
  }

  get size(): number {
    return this._order.length;
  }

  /** Materialize the immutable Document. */
  build(): Document {
    return {
      kind: "document",
      entries: this._order.map((key) => ({ key, value: this._values.get(key)! })),
    };
  }
}

/** Start a new Document builder. */
export function doc(): DocBuilder {
  return new DocBuilder();
}
