/**
 * A narrow, line-oriented TOML editor for exactly one job: insert or update one
 * entry in one array-of-tables, leaving every other byte of the file alone.
 *
 * Requirement 3.5 forbids adding a general TOML parsing library for this. A full
 * parser is a large dependency and a large surface for something that only ever
 * needs to find `[[table.array.path]]` headers and the lines between them. This
 * module does exactly that and nothing more.
 *
 * What it deliberately does NOT support (fail loudly rather than guess, per
 * Requirement 3.4 — any file shaped like these throws `TomlMergeError` instead
 * of being silently reformatted or misread):
 *
 *  - Quoted or bracket-dotted table-header keys, e.g. `["a.b"]` or
 *    `[a."b.c"]`. Only bare, unquoted, dot-separated keys are recognised. A
 *    quoted header naming the same logical path as `tableArrayPath` will not
 *    be recognised as the same array and may be duplicated.
 *  - A trailing comment on a header line, e.g. `[[hooks.PostToolUse.hooks]] #
 *    note`. Such a line does not match the header patterns this module looks
 *    for, so it is treated as an ambiguous/unterminated header and throws.
 *  - A `[` or `[[` that opens a header or a multi-line array on its own line
 *    with the rest of the header on a following line. TOML headers are
 *    single-line; anything that starts a line with `[` after trimming and
 *    does not close on that same line throws.
 *  - Deep/semantic merging of a matched entry's contents. A matched entry's
 *    whole body (every line between its header and the next header) is
 *    replaced wholesale by the caller's `entryLines` — there is no per-key
 *    merge inside an entry, mirroring how `json-merge` replaces an owned
 *    array element wholesale rather than deep-merging it.
 *  - Mixed line-ending styles within a single file. One style is detected for
 *    the whole file (CRLF if any `\r\n` is present, else LF) and used
 *    uniformly for anything this module writes.
 *  - Validating or even looking at value syntax. Key = value lines, comments,
 *    and blank lines are opaque text to this module except for the one
 *    question "does this line open a new table or array-of-tables". Malformed
 *    values elsewhere in the file are passed through untouched.
 */

export class TomlMergeError extends Error {
  readonly code: 'UNPARSEABLE' = 'UNPARSEABLE';

  constructor(message: string) {
    super(message);
    this.name = 'TomlMergeError';
  }
}

/**
 * Quote a value as a TOML basic string, safely.
 *
 * A basic string's only mandatory escapes are backslash and double quote —
 * skip either and a Windows path's backslashes silently corrupt the file into
 * invalid TOML (or worse, a differently-parsed one). This does not attempt to
 * escape control characters; the values this module writes are commands and
 * paths, not arbitrary user text.
 */
export function quoteTomlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

interface HeaderLine {
  index: number;
  kind: 'table' | 'array';
  path: string;
}

interface EntrySegment {
  /** Line index of the `[[tableArrayPath]]` header itself. */
  headerIndex: number;
  /** Line index where this entry's body starts (headerIndex + 1). */
  bodyStart: number;
  /** Exclusive end of the body: the next header's index, or EOF. */
  bodyEnd: number;
}

const ARRAY_HEADER_RE = /^\[\[([^[\]]*)\]\]\s*$/;
const TABLE_HEADER_RE = /^\[([^[\]]*)\]\s*$/;

function normalizePath(rawPath: string): string {
  return rawPath
    .split('.')
    .map((segment) => segment.trim())
    .join('.');
}

/**
 * Classify a single line as a table header, an array-of-tables header, or
 * plain content — throwing when a line looks like it opens a header but does
 * not match either supported, single-line form.
 */
function parseHeaderLine(rawLine: string, index: number): HeaderLine | null {
  const line = rawLine.trim();
  if (!line.startsWith('[')) {
    return null;
  }

  const arrayMatch = ARRAY_HEADER_RE.exec(line);
  if (arrayMatch !== null) {
    const path = arrayMatch[1];
    return { index, kind: 'array', path: normalizePath(path ?? '') };
  }

  const tableMatch = TABLE_HEADER_RE.exec(line);
  if (tableMatch !== null) {
    const path = tableMatch[1];
    return { index, kind: 'table', path: normalizePath(path ?? '') };
  }

  throw new TomlMergeError(
    `Unparseable table header (unterminated, quoted, or commented on the same line): ${rawLine}`,
  );
}

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitTomlLines(text: string, eol: '\r\n' | '\n'): { lines: string[]; hadTrailingNewline: boolean } {
  const hadTrailingNewline = text.endsWith(eol);
  const body = hadTrailingNewline ? text.slice(0, -eol.length) : text;
  const lines = body.length === 0 ? [] : body.split(eol === '\r\n' ? '\r\n' : '\n');
  return { lines, hadTrailingNewline };
}

function parentPathOf(tableArrayPath: string): string {
  const segments = tableArrayPath.split('.');
  return segments.slice(0, -1).join('.');
}

function bodyContains(lines: string[], start: number, end: number, needle: string): boolean {
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line !== undefined && line.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * Append our entry (and, if missing, the parent table header) at the end of
 * the file. Mirrors `appendBlock` in apply.ts: a blank separator line goes in
 * before the new block unless one is already there.
 */
function appendEntry(
  lines: string[],
  parentPath: string,
  hasParentHeader: boolean,
  ourHeader: string,
  entryLines: string[],
): void {
  const block: string[] = [];
  if (parentPath !== '' && !hasParentHeader) {
    block.push(`[${parentPath}]`, '');
  }
  block.push(ourHeader, ...entryLines);

  if (lines.length > 0 && (lines[lines.length - 1] ?? '') !== '') {
    lines.push('');
  }
  lines.push(...block);
}

/**
 * Insert or update one entry in one TOML array-of-tables.
 *
 * @param existing The file's current contents, or null/empty if it does not
 *   exist yet.
 * @param tableArrayPath The dotted path as it appears inside `[[...]]`, e.g.
 *   `'hooks.PostToolUse.hooks'`.
 * @param entryLines The key = value lines of OUR entry, without the `[[header]]`.
 * @param ownershipMarker A substring identifying an entry as ours from a
 *   previous run. Without it, ALL entries at `tableArrayPath` are replaced by
 *   ours — matching `json-merge`'s no-marker behaviour.
 */
export function mergeToml(
  existing: string | null,
  tableArrayPath: string,
  entryLines: string[],
  ownershipMarker: string | undefined,
): string {
  const ourHeader = `[[${tableArrayPath}]]`;
  const parentPath = parentPathOf(tableArrayPath);

  if (existing === null || existing === '') {
    const block: string[] = [];
    if (parentPath !== '') {
      block.push(`[${parentPath}]`, '');
    }
    block.push(ourHeader, ...entryLines);
    return block.join('\n');
  }

  const eol = detectEol(existing);
  const { lines, hadTrailingNewline } = splitTomlLines(existing, eol);

  const headers: HeaderLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const header = parseHeaderLine(line, i);
    if (header !== null) {
      headers.push(header);
    }
  }

  const hasParentHeader =
    parentPath === '' || headers.some((h) => h.kind === 'table' && h.path === parentPath);

  const arrayHeaders = headers.filter((h) => h.kind === 'array' && h.path === tableArrayPath);
  const entrySegments: EntrySegment[] = arrayHeaders.map((header) => {
    const next = headers.find((h) => h.index > header.index);
    return {
      headerIndex: header.index,
      bodyStart: header.index + 1,
      bodyEnd: next?.index ?? lines.length,
    };
  });

  const isOurs = (segment: EntrySegment): boolean =>
    ownershipMarker !== undefined &&
    bodyContains(lines, segment.bodyStart, segment.bodyEnd, ownershipMarker);

  // With a marker: only entries containing it are candidates for replacement,
  // and everything else is foreign ground that must survive untouched. With
  // no marker there is no way to tell ours from theirs, so every entry at this
  // path is a candidate — matching json-merge's documented no-marker fallback
  // of replacing the whole array.
  const candidates =
    ownershipMarker === undefined ? entrySegments : entrySegments.filter(isOurs);

  const result = [...lines];

  if (candidates.length > 0) {
    const [target, ...extra] = candidates;
    if (target === undefined) {
      throw new TomlMergeError('internal: candidates.length > 0 but first element is undefined');
    }

    // Splice from the highest index down so earlier indices stay valid across
    // the whole batch of edits.
    const removals = [...extra].sort((a, b) => b.headerIndex - a.headerIndex);
    for (const segment of removals) {
      result.splice(segment.headerIndex, segment.bodyEnd - segment.headerIndex);
    }

    result.splice(target.bodyStart, target.bodyEnd - target.bodyStart, ...entryLines);
  } else {
    appendEntry(result, parentPath, hasParentHeader, ourHeader, entryLines);
  }

  return result.join(eol) + (hadTrailingNewline ? eol : '');
}
