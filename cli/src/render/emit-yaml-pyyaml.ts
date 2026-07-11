// PyYAML-compat YAML frontmatter emitter (ADR 0009).
//
// Reproduces `yaml.safe_dump(sort_keys=False, allow_unicode=False,
// default_flow_style=False)` byte-for-byte for the Document AST value domain,
// then `.strip()` (the Python generators strip the YAML block before wrapping it
// in `---` fences — see shared_agents.generators.claude.render_claude_agent).
//
// This is a direct port of CPython PyYAML's pure-Python emitter: the scalar
// analyzer, style chooser, and column-tracking writers (80-column folding,
// single/double-quote heuristics, `\xXX`/`\uXXXX`/`\UXXXXXXXX` escaping for
// non-ASCII under allow_unicode=False), driven by the same event state machine
// and the same implicit-tag resolver. All byte-format quirks live here, per
// ADR 0009 — dialects only build the format-neutral Document AST.

import type { Document, DocValue } from "./doc";
import { isDocList, isDocument, isFloat, isScalar, isTableArray, isTextBlock } from "./doc";
import type { Emitter } from "./emit";

/** Serialize a Document to a PyYAML-`safe_dump`-compatible mapping block. */
export function emitYamlPyyaml(document: Document): string {
  const node = reprData(document);
  const events = serialize(node);
  const emitter = new PyYamlEmitter();
  return emitter.run(events).replace(/^\s+|\s+$/g, "");
}

/** The PyYAML-compat emitter as a bound Emitter (see emit.ts registry). */
export const yamlPyyamlEmitter: Emitter = {
  name: "yaml-pyyaml-compat",
  emit: emitYamlPyyaml,
};

// ─────────────────────────────────────────────────────────────────────────────
// Representer: DocValue → repr node (mirrors SafeRepresenter)
// ─────────────────────────────────────────────────────────────────────────────

type Tag = "str" | "int" | "float" | "bool" | "null";
const FULL_TAG: Record<Tag, string> = {
  str: "tag:yaml.org,2002:str",
  int: "tag:yaml.org,2002:int",
  float: "tag:yaml.org,2002:float",
  bool: "tag:yaml.org,2002:bool",
  null: "tag:yaml.org,2002:null",
};
const STR_TAG = FULL_TAG.str;

type ScalarNode = { t: "scalar"; tag: string; value: string; style: string };
type SeqNode = { t: "seq"; items: ReprNode[] };
type MapNode = { t: "map"; pairs: [ReprNode, ReprNode][] };
type ReprNode = ScalarNode | SeqNode | MapNode;

function scalarNode(tag: Tag, value: string, style = ""): ScalarNode {
  return { t: "scalar", tag: FULL_TAG[tag], value, style };
}

function reprScalar(value: string | number | boolean | null): ScalarNode {
  if (value === null) return scalarNode("null", "null");
  if (typeof value === "boolean") return scalarNode("bool", value ? "true" : "false");
  if (typeof value === "number") return reprNumber(value);
  return scalarNode("str", value);
}

function reprNumber(n: number): ScalarNode {
  if (Number.isInteger(n) && Number.isFinite(n)) {
    return scalarNode("int", String(n));
  }
  return scalarNode("float", reprFloat(n));
}

// Mirror SafeRepresenter.represent_float (repr(data).lower() + `.0e` fixup).
// Python's `repr(1.0)` is `'1.0'`, but JS `String(1.0)` is `'1'`; PyYAML never
// emits a bare-integer float (the round-trip would re-resolve it as an int), so
// a whole value with neither `.` nor `e` gets a `.0` suffix.
function reprFloat(n: number): string {
  if (Number.isNaN(n)) return ".nan";
  if (n === Infinity) return ".inf";
  if (n === -Infinity) return "-.inf";
  let value = String(n).toLowerCase();
  if (!value.includes(".") && value.includes("e")) {
    value = value.replace("e", ".0e");
  } else if (!value.includes(".") && !value.includes("e")) {
    value += ".0";
  }
  return value;
}

function reprData(value: DocValue): ReprNode {
  if (isFloat(value)) return scalarNode("float", reprFloat(value.value));
  if (isScalar(value)) return reprScalar(value);
  if (isTextBlock(value)) return scalarNode("str", value.text);
  if (isDocList(value)) return { t: "seq", items: value.items.map(reprData) };
  if (isTableArray(value)) return { t: "seq", items: value.tables.map(reprData) };
  if (isDocument(value)) {
    return {
      t: "map",
      pairs: value.entries.map(
        (e) => [scalarNode("str", e.key), reprData(e.value)] as [ReprNode, ReprNode],
      ),
    };
  }
  throw new Error(`emit-yaml-pyyaml: unrenderable value ${JSON.stringify(value)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver: implicit tag detection (mirrors resolver.py Resolver)
// ─────────────────────────────────────────────────────────────────────────────

// Regexes ported verbatim (re.X verbose whitespace stripped; char classes kept).
const RESOLVERS: [string, RegExp][] = [
  [
    FULL_TAG.bool,
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  ],
  [
    FULL_TAG.float,
    /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  ],
  [
    FULL_TAG.int,
    /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  ],
  ["tag:yaml.org,2002:merge", /^(?:<<)$/],
  [FULL_TAG.null, /^(?:~|null|Null|NULL|)$/],
  [
    "tag:yaml.org,2002:timestamp",
    /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  ],
  ["tag:yaml.org,2002:value", /^(?:=)$/],
  ["tag:yaml.org,2002:yaml", /^(?:!|&|\*)$/],
];

// resolve(ScalarNode, value, (True, False)) — detected implicit tag.
function resolveScalarTag(value: string): string {
  for (const [tag, re] of RESOLVERS) {
    if (re.test(value)) return tag;
  }
  return STR_TAG;
}

// Mirror Emitter.prepare_tag with the default tag_prefixes ({'!': '!',
// 'tag:yaml.org,2002:': '!!'}). check_simple_key adds len(prepare_tag(tag)) to
// the key length before the `< 128` test, so `!!str` (5) is why keys of length
// 123–127 spill to the explicit `? key` form. Our tags are always yaml.org
// tags, so this reduces to `!!` + suffix; the general fallback is kept faithful.
const TAG_PREFIX = "tag:yaml.org,2002:";
function prepareTag(tag: string): string {
  if (tag === "!") return tag;
  if (tag.startsWith(TAG_PREFIX) && TAG_PREFIX.length < tag.length) {
    return "!!" + tag.slice(TAG_PREFIX.length);
  }
  return `!<${tag}>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializer: repr node → event stream (mirrors serializer.py)
// ─────────────────────────────────────────────────────────────────────────────

type ScalarEvent = { t: "scalar"; tag: string; implicit: [boolean, boolean]; value: string; style: string };
type Event =
  | { t: "stream-start" }
  | { t: "stream-end" }
  | { t: "doc-start" }
  | { t: "doc-end" }
  | ScalarEvent
  | { t: "seq-start" }
  | { t: "seq-end" }
  | { t: "map-start" }
  | { t: "map-end" };

function serialize(root: ReprNode): Event[] {
  const events: Event[] = [{ t: "stream-start" }, { t: "doc-start" }];
  serializeNode(root, events);
  events.push({ t: "doc-end" }, { t: "stream-end" });
  return events;
}

function serializeNode(node: ReprNode, out: Event[]): void {
  if (node.t === "scalar") {
    const detected = resolveScalarTag(node.value);
    // default_tag is always the str tag; implicit = (tag==detected, tag==str).
    out.push({
      t: "scalar",
      tag: node.tag,
      implicit: [node.tag === detected, node.tag === STR_TAG],
      value: node.value,
      style: node.style,
    });
  } else if (node.t === "seq") {
    out.push({ t: "seq-start" });
    for (const item of node.items) serializeNode(item, out);
    out.push({ t: "seq-end" });
  } else {
    out.push({ t: "map-start" });
    for (const [k, v] of node.pairs) {
      serializeNode(k, out);
      serializeNode(v, out);
    }
    out.push({ t: "map-end" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Character-class helpers (operate on code points, matching Python str indexing)
// ─────────────────────────────────────────────────────────────────────────────

const CP_TAB = 0x09;
const CP_LF = 0x0a;
const CP_CR = 0x0d;
const CP_SPACE = 0x20;
const CP_NEL = 0x85;
const CP_LS = 0x2028;
const CP_PS = 0x2029;
const CP_BOM = 0xfeff;

function isLineBreakCp(cp: number): boolean {
  return cp === CP_LF || cp === CP_NEL || cp === CP_LS || cp === CP_PS;
}

// Membership test for '\0 \t\r\n\x85'.
function isWhitespaceCp(cp: number): boolean {
  return (
    cp === 0 ||
    cp === CP_SPACE ||
    cp === CP_TAB ||
    cp === CP_CR ||
    isLineBreakCp(cp)
  );
}

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

function cpStr(cp: number): string {
  return String.fromCodePoint(cp);
}

function cpSlice(cps: number[], start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += cpStr(cps[i]!);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scalar analysis (mirrors Emitter.analyze_scalar)
// ─────────────────────────────────────────────────────────────────────────────

interface ScalarAnalysis {
  empty: boolean;
  multiline: boolean;
  allowFlowPlain: boolean;
  allowBlockPlain: boolean;
  allowSingleQuoted: boolean;
  allowDoubleQuoted: boolean;
  allowBlock: boolean;
}

const LEADING_INDICATORS = new Set([..."#,[]{}&*!|>'\"%@`"].map((c) => c.codePointAt(0)!));
const FLOW_ONLY_INDICATORS = new Set([...",?[]{}"].map((c) => c.codePointAt(0)!));

function analyzeScalar(scalar: string, allowUnicode: boolean): ScalarAnalysis {
  if (scalar.length === 0) {
    return {
      empty: true,
      multiline: false,
      allowFlowPlain: false,
      allowBlockPlain: true,
      allowSingleQuoted: true,
      allowDoubleQuoted: true,
      allowBlock: false,
    };
  }

  const s = codePoints(scalar);
  const n = s.length;

  let blockIndicators = false;
  let flowIndicators = false;
  let lineBreaks = false;
  let specialCharacters = false;

  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;

  if (scalar.startsWith("---") || scalar.startsWith("...")) {
    blockIndicators = true;
    flowIndicators = true;
  }

  let precededByWhitespace = true;
  let followedByWhitespace = n === 1 || isWhitespaceCp(s[1]!);
  let previousSpace = false;
  let previousBreak = false;

  let index = 0;
  while (index < n) {
    const ch = s[index]!;

    if (index === 0) {
      if (LEADING_INDICATORS.has(ch)) {
        flowIndicators = true;
        blockIndicators = true;
      }
      if (ch === 0x3f || ch === 0x3a) {
        // '?' ':'
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      }
      if (ch === 0x2d && followedByWhitespace) {
        // '-'
        flowIndicators = true;
        blockIndicators = true;
      }
    } else {
      if (FLOW_ONLY_INDICATORS.has(ch)) flowIndicators = true;
      if (ch === 0x3a) {
        // ':'
        flowIndicators = true;
        if (followedByWhitespace) blockIndicators = true;
      }
      if (ch === 0x23 && precededByWhitespace) {
        // '#'
        flowIndicators = true;
        blockIndicators = true;
      }
    }

    if (isLineBreakCp(ch)) lineBreaks = true;
    if (!(ch === CP_LF || (ch >= 0x20 && ch <= 0x7e))) {
      const printableUnicode =
        (ch === CP_NEL ||
          (ch >= 0xa0 && ch <= 0xd7ff) ||
          (ch >= 0xe000 && ch <= 0xfffd) ||
          (ch >= 0x10000 && ch < 0x10ffff)) &&
        ch !== CP_BOM;
      if (printableUnicode) {
        if (!allowUnicode) specialCharacters = true;
      } else {
        specialCharacters = true;
      }
    }

    if (ch === CP_SPACE) {
      if (index === 0) leadingSpace = true;
      if (index === n - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (isLineBreakCp(ch)) {
      if (index === 0) leadingBreak = true;
      if (index === n - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }

    index += 1;
    precededByWhitespace = isWhitespaceCp(ch);
    followedByWhitespace = index + 1 >= n || isWhitespaceCp(s[index + 1]!);
  }

  let allowFlowPlain = true;
  let allowBlockPlain = true;
  let allowSingleQuoted = true;
  const allowDoubleQuoted = true;
  let allowBlock = true;

  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
    allowFlowPlain = false;
    allowBlockPlain = false;
  }
  if (trailingSpace) allowBlock = false;
  if (breakSpace) {
    allowFlowPlain = false;
    allowBlockPlain = false;
    allowSingleQuoted = false;
  }
  if (spaceBreak || specialCharacters) {
    allowFlowPlain = false;
    allowBlockPlain = false;
    allowSingleQuoted = false;
    allowBlock = false;
  }
  if (lineBreaks) {
    allowFlowPlain = false;
    allowBlockPlain = false;
  }
  if (flowIndicators) allowFlowPlain = false;
  if (blockIndicators) allowBlockPlain = false;

  return {
    empty: false,
    multiline: lineBreaks,
    allowFlowPlain,
    allowBlockPlain,
    allowSingleQuoted,
    allowDoubleQuoted,
    allowBlock,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emitter (mirrors emitter.py Emitter, encoding=None, allow_unicode=False)
// ─────────────────────────────────────────────────────────────────────────────

const ESCAPE_REPLACEMENTS: Record<number, string> = {
  0x00: "0",
  0x07: "a",
  0x08: "b",
  0x09: "t",
  0x0a: "n",
  0x0b: "v",
  0x0c: "f",
  0x0d: "r",
  0x1b: "e",
  0x22: '"',
  0x5c: "\\",
  0x85: "N",
  0xa0: "_",
  0x2028: "L",
  0x2029: "P",
};

type State = () => void;

class PyYamlEmitter {
  private out = "";

  private states: State[] = [];
  // Set at the top of run(); the arrow-field states are initialized after this.
  private state!: State;

  private events: Event[] = [];
  private event: Event | null = null;

  private indents: (number | null)[] = [];
  private indent: number | null = null;

  private flowLevel = 0;

  private rootContext = false;
  private mappingContext = false;
  private simpleKeyContext = false;

  private line = 0;
  private column = 0;
  private whitespace = true;
  private indention = true;
  private openEnded = false;

  private readonly bestIndent = 2;
  private readonly bestWidth = 80;
  private readonly allowUnicode = false;

  private analysis: ScalarAnalysis | null = null;
  private analysisScalar = "";
  private style: string | null = null;

  run(events: Event[]): string {
    this.state = this.expectStreamStart;
    for (const ev of events) {
      this.events.push(ev);
      while (!this.needMoreEvents()) {
        this.event = this.events.shift()!;
        this.state();
        this.event = null;
      }
    }
    return this.out;
  }

  // Event lookahead -------------------------------------------------------------

  private needMoreEvents(): boolean {
    if (this.events.length === 0) return true;
    const event = this.events[0]!;
    if (event.t === "doc-start") return this.needEvents(1);
    if (event.t === "seq-start") return this.needEvents(2);
    if (event.t === "map-start") return this.needEvents(3);
    return false;
  }

  private needEvents(count: number): boolean {
    let level = 0;
    for (let i = 1; i < this.events.length; i++) {
      const event = this.events[i]!;
      if (event.t === "doc-start" || event.t === "seq-start" || event.t === "map-start") {
        level += 1;
      } else if (event.t === "doc-end" || event.t === "seq-end" || event.t === "map-end") {
        level -= 1;
      } else if (event.t === "stream-end") {
        level = -1;
      }
      if (level < 0) return false;
    }
    return this.events.length < count + 1;
  }

  private increaseIndent(flow: boolean, indentless = false): void {
    this.indents.push(this.indent);
    if (this.indent === null) {
      this.indent = flow ? this.bestIndent : 0;
    } else if (!indentless) {
      this.indent += this.bestIndent;
    }
  }

  // Stream / document states ----------------------------------------------------

  private expectStreamStart: State = () => {
    if (this.event!.t === "stream-start") {
      this.state = this.expectFirstDocumentStart;
    } else {
      throw new Error("expected StreamStartEvent");
    }
  };

  private expectNothing: State = () => {
    throw new Error("expected nothing");
  };

  private expectFirstDocumentStart: State = () => this.expectDocumentStart(true);

  private expectDocumentStartState: State = () => this.expectDocumentStart(false);

  private expectDocumentStart(first: boolean): void {
    const event = this.event!;
    if (event.t === "doc-start") {
      // No version/tags. Implicit document (no `---`) unless empty scalar root.
      const implicit = first && !this.checkEmptyDocument();
      if (!implicit) {
        this.writeIndent();
        this.writeIndicator("---", true);
      }
      this.state = this.expectDocumentRoot;
    } else if (event.t === "stream-end") {
      this.state = this.expectNothing;
    } else {
      throw new Error("expected DocumentStartEvent");
    }
  }

  private expectDocumentEnd: State = () => {
    if (this.event!.t === "doc-end") {
      this.writeIndent();
      this.state = this.expectDocumentStartState;
    } else {
      throw new Error("expected DocumentEndEvent");
    }
  };

  private expectDocumentRoot: State = () => {
    this.states.push(this.expectDocumentEnd);
    this.expectNode(true, false, false);
  };

  // Node dispatch ---------------------------------------------------------------

  private expectNode(root: boolean, mapping: boolean, simpleKey: boolean): void {
    this.rootContext = root;
    this.mappingContext = mapping;
    this.simpleKeyContext = simpleKey;
    const event = this.event!;
    if (event.t === "scalar") {
      this.expectScalar();
    } else if (event.t === "seq-start") {
      if (this.flowLevel || this.checkEmptySequence()) {
        this.expectFlowSequence();
      } else {
        this.expectBlockSequence();
      }
    } else if (event.t === "map-start") {
      if (this.flowLevel || this.checkEmptyMapping()) {
        this.expectFlowMapping();
      } else {
        this.expectBlockMapping();
      }
    } else {
      throw new Error("expected NodeEvent");
    }
  }

  private expectScalar(): void {
    this.increaseIndent(true);
    this.processScalar();
    this.indent = this.indents.pop()!;
    this.state = this.states.pop()!;
  }

  // Flow collections (only reached for empty [] / {} in our domain) ------------

  private expectFlowSequence(): void {
    this.writeIndicator("[", true, true);
    this.flowLevel += 1;
    this.increaseIndent(true);
    this.state = this.expectFirstFlowSequenceItem;
  }

  private expectFirstFlowSequenceItem: State = () => {
    if (this.event!.t === "seq-end") {
      this.indent = this.indents.pop()!;
      this.flowLevel -= 1;
      this.writeIndicator("]", false);
      this.state = this.states.pop()!;
    } else {
      if (this.column > this.bestWidth) this.writeIndent();
      this.states.push(this.expectFlowSequenceItem);
      this.expectNode(false, false, false);
    }
  };

  private expectFlowSequenceItem: State = () => {
    if (this.event!.t === "seq-end") {
      this.indent = this.indents.pop()!;
      this.flowLevel -= 1;
      this.writeIndicator("]", false);
      this.state = this.states.pop()!;
    } else {
      this.writeIndicator(",", false);
      if (this.column > this.bestWidth) this.writeIndent();
      this.states.push(this.expectFlowSequenceItem);
      this.expectNode(false, false, false);
    }
  };

  private expectFlowMapping(): void {
    this.writeIndicator("{", true, true);
    this.flowLevel += 1;
    this.increaseIndent(true);
    this.state = this.expectFirstFlowMappingKey;
  }

  private expectFirstFlowMappingKey: State = () => {
    if (this.event!.t === "map-end") {
      this.indent = this.indents.pop()!;
      this.flowLevel -= 1;
      this.writeIndicator("}", false);
      this.state = this.states.pop()!;
    } else {
      if (this.column > this.bestWidth) this.writeIndent();
      if (this.checkSimpleKey()) {
        this.states.push(this.expectFlowMappingSimpleValue);
        this.expectNode(false, true, true);
      } else {
        this.writeIndicator("?", true);
        this.states.push(this.expectFlowMappingValue);
        this.expectNode(false, true, false);
      }
    }
  };

  private expectFlowMappingKey: State = () => {
    if (this.event!.t === "map-end") {
      this.indent = this.indents.pop()!;
      this.flowLevel -= 1;
      this.writeIndicator("}", false);
      this.state = this.states.pop()!;
    } else {
      this.writeIndicator(",", false);
      if (this.column > this.bestWidth) this.writeIndent();
      if (this.checkSimpleKey()) {
        this.states.push(this.expectFlowMappingSimpleValue);
        this.expectNode(false, true, true);
      } else {
        this.writeIndicator("?", true);
        this.states.push(this.expectFlowMappingValue);
        this.expectNode(false, true, false);
      }
    }
  };

  private expectFlowMappingSimpleValue: State = () => {
    this.writeIndicator(":", false);
    this.states.push(this.expectFlowMappingKey);
    this.expectNode(false, true, false);
  };

  private expectFlowMappingValue: State = () => {
    if (this.column > this.bestWidth) this.writeIndent();
    this.writeIndicator(":", true);
    this.states.push(this.expectFlowMappingKey);
    this.expectNode(false, true, false);
  };

  // Block sequence --------------------------------------------------------------

  private expectBlockSequence(): void {
    const indentless = this.mappingContext && !this.indention;
    this.increaseIndent(false, indentless);
    this.state = this.expectFirstBlockSequenceItem;
  }

  private expectFirstBlockSequenceItem: State = () => this.blockSequenceItem(true);
  private expectBlockSequenceItem: State = () => this.blockSequenceItem(false);

  private blockSequenceItem(first: boolean): void {
    if (!first && this.event!.t === "seq-end") {
      this.indent = this.indents.pop()!;
      this.state = this.states.pop()!;
    } else {
      this.writeIndent();
      this.writeIndicator("-", true, false, true);
      this.states.push(this.expectBlockSequenceItem);
      this.expectNode(false, false, false);
    }
  }

  // Block mapping ---------------------------------------------------------------

  private expectBlockMapping(): void {
    this.increaseIndent(false);
    this.state = this.expectFirstBlockMappingKey;
  }

  private expectFirstBlockMappingKey: State = () => this.blockMappingKey(true);
  private expectBlockMappingKey: State = () => this.blockMappingKey(false);

  private blockMappingKey(first: boolean): void {
    if (!first && this.event!.t === "map-end") {
      this.indent = this.indents.pop()!;
      this.state = this.states.pop()!;
    } else {
      this.writeIndent();
      if (this.checkSimpleKey()) {
        this.states.push(this.expectBlockMappingSimpleValue);
        this.expectNode(false, true, true);
      } else {
        this.writeIndicator("?", true, false, true);
        this.states.push(this.expectBlockMappingValue);
        this.expectNode(false, true, false);
      }
    }
  }

  private expectBlockMappingSimpleValue: State = () => {
    this.writeIndicator(":", false);
    this.states.push(this.expectBlockMappingKey);
    this.expectNode(false, true, false);
  };

  private expectBlockMappingValue: State = () => {
    this.writeIndent();
    this.writeIndicator(":", true, false, true);
    this.states.push(this.expectBlockMappingKey);
    this.expectNode(false, true, false);
  };

  // Checkers --------------------------------------------------------------------

  private checkEmptySequence(): boolean {
    return this.event!.t === "seq-start" && this.events.length > 0 && this.events[0]!.t === "seq-end";
  }

  private checkEmptyMapping(): boolean {
    return this.event!.t === "map-start" && this.events.length > 0 && this.events[0]!.t === "map-end";
  }

  private checkEmptyDocument(): boolean {
    if (this.event!.t !== "doc-start" || this.events.length === 0) return false;
    const event = this.events[0]!;
    return event.t === "scalar" && event.implicit[0] && event.value === "";
  }

  private checkSimpleKey(): boolean {
    let length = 0;
    const event = this.event!;
    if (event.t === "scalar") {
      // PyYAML adds len(prepare_tag(event.tag)) before the scalar length; for a
      // str-tagged key that is +5 (`!!str`), shifting the < 128 cutoff to 123.
      length += prepareTag(event.tag).length;
      if (this.analysis === null || this.analysisScalar !== event.value) {
        this.analysis = analyzeScalar(event.value, this.allowUnicode);
        this.analysisScalar = event.value;
      }
      length += codePoints(event.value).length;
    }
    return (
      length < 128 &&
      (event.t === "scalar"
        ? !this.analysis!.empty && !this.analysis!.multiline
        : this.checkEmptySequence() || this.checkEmptyMapping())
    );
  }

  // Scalar processing -----------------------------------------------------------

  private processScalar(): void {
    const event = this.event as ScalarEvent;
    if (this.analysis === null || this.analysisScalar !== event.value) {
      this.analysis = analyzeScalar(event.value, this.allowUnicode);
      this.analysisScalar = event.value;
    }
    if (this.style === null) this.style = this.chooseScalarStyle();
    const split = !this.simpleKeyContext;
    if (this.style === '"') this.writeDoubleQuoted(event.value, split);
    else if (this.style === "'") this.writeSingleQuoted(event.value, split);
    else if (this.style === ">") this.writeFolded(event.value);
    else if (this.style === "|") this.writeLiteral(event.value);
    else this.writePlain(event.value, split);
    this.analysis = null;
    this.analysisScalar = "";
    this.style = null;
  }

  private chooseScalarStyle(): string {
    const event = this.event as ScalarEvent;
    if (this.analysis === null || this.analysisScalar !== event.value) {
      this.analysis = analyzeScalar(event.value, this.allowUnicode);
      this.analysisScalar = event.value;
    }
    const a = this.analysis!;
    if (event.style === '"') return '"';
    if (!event.style && event.implicit[0]) {
      if (
        !(this.simpleKeyContext && (a.empty || a.multiline)) &&
        ((this.flowLevel && a.allowFlowPlain) || (!this.flowLevel && a.allowBlockPlain))
      ) {
        return "";
      }
    }
    if (event.style && (event.style === "|" || event.style === ">")) {
      if (!this.flowLevel && !this.simpleKeyContext && a.allowBlock) {
        return event.style;
      }
    }
    if (!event.style || event.style === "'") {
      if (a.allowSingleQuoted && !(this.simpleKeyContext && a.multiline)) {
        return "'";
      }
    }
    return '"';
  }

  // Writers ---------------------------------------------------------------------

  private write(data: string): void {
    this.out += data;
  }

  private writeIndicator(indicator: string, needWhitespace: boolean, whitespace = false, indention = false): void {
    const data = this.whitespace || !needWhitespace ? indicator : " " + indicator;
    this.whitespace = whitespace;
    this.indention = this.indention && indention;
    this.column += data.length;
    this.openEnded = false;
    this.write(data);
  }

  private writeIndent(): void {
    const indent = this.indent || 0;
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) {
      this.writeLineBreak();
    }
    if (this.column < indent) {
      this.whitespace = true;
      this.write(" ".repeat(indent - this.column));
      this.column = indent;
    }
  }

  private writeLineBreak(): void {
    this.whitespace = true;
    this.indention = true;
    this.line += 1;
    this.column = 0;
    this.write("\n");
  }

  private writeSingleQuoted(textStr: string, split = true): void {
    this.writeIndicator("'", true);
    const text = codePoints(textStr);
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: number | null = end < text.length ? text[end]! : null;
      if (spaces) {
        if (ch === null || ch !== CP_SPACE) {
          if (start + 1 === end && this.column > this.bestWidth && split && start !== 0 && end !== text.length) {
            this.writeIndent();
          } else {
            const data = cpSlice(text, start, end);
            this.column += end - start;
            this.write(data);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !isLineBreakCp(ch)) {
          if (text[start]! === CP_LF) this.writeLineBreak();
          for (let i = start; i < end; i++) {
            if (text[i]! === CP_LF) this.writeLineBreak();
            else this.writeLineBreakData(cpStr(text[i]!));
          }
          this.writeIndent();
          start = end;
        }
      } else {
        if (ch === null || ch === CP_SPACE || isLineBreakCp(ch) || ch === 0x27) {
          if (start < end) {
            const data = cpSlice(text, start, end);
            this.column += end - start;
            this.write(data);
            start = end;
          }
        }
      }
      if (ch === 0x27) {
        this.write("''");
        this.column += 2;
        start = end + 1;
      }
      if (ch !== null) {
        spaces = ch === CP_SPACE;
        breaks = isLineBreakCp(ch);
      }
      end += 1;
    }
    this.writeIndicator("'", false);
  }

  private writeDoubleQuoted(textStr: string, split = true): void {
    this.writeIndicator('"', true);
    const text = codePoints(textStr);
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: number | null = end < text.length ? text[end]! : null;
      if (
        ch === null ||
        ch === 0x22 ||
        ch === 0x5c ||
        ch === CP_NEL ||
        ch === CP_LS ||
        ch === CP_PS ||
        ch === CP_BOM ||
        !(ch >= 0x20 && ch <= 0x7e)
      ) {
        if (start < end) {
          const data = cpSlice(text, start, end);
          this.column += end - start;
          this.write(data);
          start = end;
        }
        if (ch !== null) {
          let data: string;
          if (ch in ESCAPE_REPLACEMENTS) {
            data = "\\" + ESCAPE_REPLACEMENTS[ch];
          } else if (ch <= 0xff) {
            data = "\\x" + hex(ch, 2);
          } else if (ch <= 0xffff) {
            data = "\\u" + hex(ch, 4);
          } else {
            data = "\\U" + hex(ch, 8);
          }
          this.column += data.length;
          this.write(data);
          start = end + 1;
        }
      }
      if (
        0 < end &&
        end < text.length - 1 &&
        (ch === CP_SPACE || start >= end) &&
        this.column + (end - start) > this.bestWidth &&
        split
      ) {
        const data = cpSlice(text, start, end) + "\\";
        if (start < end) start = end;
        this.column += data.length;
        this.write(data);
        this.writeIndent();
        this.whitespace = false;
        this.indention = false;
        if (text[start]! === CP_SPACE) {
          this.write("\\");
          this.column += 1;
        }
      }
      end += 1;
    }
    this.writeIndicator('"', false);
  }

  private determineBlockHints(text: number[]): string {
    let hints = "";
    if (text.length > 0) {
      const first = text[0]!;
      if (first === CP_SPACE || isLineBreakCp(first)) hints += String(this.bestIndent);
      const last = text[text.length - 1]!;
      if (!isLineBreakCp(last)) {
        hints += "-";
      } else if (text.length === 1 || isLineBreakCp(text[text.length - 2]!)) {
        hints += "+";
      }
    }
    return hints;
  }

  private writeFolded(textStr: string): void {
    const text = codePoints(textStr);
    const hints = this.determineBlockHints(text);
    this.writeIndicator(">" + hints, true);
    if (hints.endsWith("+")) this.openEnded = true;
    this.writeLineBreak();
    let leadingSpace = true;
    let spaces = false;
    let breaks = true;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: number | null = end < text.length ? text[end]! : null;
      if (breaks) {
        if (ch === null || !isLineBreakCp(ch)) {
          if (!leadingSpace && ch !== null && ch !== CP_SPACE && text[start]! === CP_LF) {
            this.writeLineBreak();
          }
          leadingSpace = ch === CP_SPACE;
          for (let i = start; i < end; i++) {
            if (text[i]! === CP_LF) this.writeLineBreak();
            else this.writeLineBreakData(cpStr(text[i]!));
          }
          if (ch !== null) this.writeIndent();
          start = end;
        }
      } else if (spaces) {
        if (ch !== CP_SPACE) {
          if (start + 1 === end && this.column > this.bestWidth) {
            this.writeIndent();
          } else {
            const data = cpSlice(text, start, end);
            this.column += end - start;
            this.write(data);
          }
          start = end;
        }
      } else {
        if (ch === null || ch === CP_SPACE || isLineBreakCp(ch)) {
          const data = cpSlice(text, start, end);
          this.column += end - start;
          this.write(data);
          if (ch === null) this.writeLineBreak();
          start = end;
        }
      }
      if (ch !== null) {
        breaks = isLineBreakCp(ch);
        spaces = ch === CP_SPACE;
      }
      end += 1;
    }
  }

  private writeLiteral(textStr: string): void {
    const text = codePoints(textStr);
    const hints = this.determineBlockHints(text);
    this.writeIndicator("|" + hints, true);
    if (hints.endsWith("+")) this.openEnded = true;
    this.writeLineBreak();
    let breaks = true;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: number | null = end < text.length ? text[end]! : null;
      if (breaks) {
        if (ch === null || !isLineBreakCp(ch)) {
          for (let i = start; i < end; i++) {
            if (text[i]! === CP_LF) this.writeLineBreak();
            else this.writeLineBreakData(cpStr(text[i]!));
          }
          if (ch !== null) this.writeIndent();
          start = end;
        }
      } else {
        if (ch === null || isLineBreakCp(ch)) {
          const data = cpSlice(text, start, end);
          this.write(data);
          if (ch === null) this.writeLineBreak();
          start = end;
        }
      }
      if (ch !== null) breaks = isLineBreakCp(ch);
      end += 1;
    }
  }

  private writePlain(textStr: string, split = true): void {
    if (this.rootContext) this.openEnded = true;
    if (textStr.length === 0) return;
    if (!this.whitespace) {
      this.write(" ");
      this.column += 1;
    }
    this.whitespace = false;
    this.indention = false;
    const text = codePoints(textStr);
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: number | null = end < text.length ? text[end]! : null;
      if (spaces) {
        if (ch !== CP_SPACE) {
          if (start + 1 === end && this.column > this.bestWidth && split) {
            this.writeIndent();
            this.whitespace = false;
            this.indention = false;
          } else {
            const data = cpSlice(text, start, end);
            this.column += end - start;
            this.write(data);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !isLineBreakCp(ch)) {
          if (text[start]! === CP_LF) this.writeLineBreak();
          for (let i = start; i < end; i++) {
            if (text[i]! === CP_LF) this.writeLineBreak();
            else this.writeLineBreakData(cpStr(text[i]!));
          }
          this.writeIndent();
          this.whitespace = false;
          this.indention = false;
          start = end;
        }
      } else {
        if (ch === null || ch === CP_SPACE || isLineBreakCp(ch)) {
          const data = cpSlice(text, start, end);
          this.column += end - start;
          this.write(data);
          start = end;
        }
      }
      if (ch !== null) {
        spaces = ch === CP_SPACE;
        breaks = isLineBreakCp(ch);
      }
      end += 1;
    }
  }

  private writeLineBreakData(data: string): void {
    this.whitespace = true;
    this.indention = true;
    this.line += 1;
    this.column = 0;
    this.write(data);
  }
}

function hex(cp: number, width: number): string {
  return cp.toString(16).toUpperCase().padStart(width, "0");
}
