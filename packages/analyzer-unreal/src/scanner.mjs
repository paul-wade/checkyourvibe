// A lexical scanner for Unreal Engine C++ headers and translation units.
//
// It is a lexer with a brace-scope stack, not a C++ parser. It establishes two
// things the reflection rules need and that a regular expression over a line
// cannot supply:
//
//   1. Which type declaration encloses a given member, and whether that
//      declaration carries a reflection macro (`UCLASS`, `USTRUCT`,
//      `UINTERFACE`) together with a `GENERATED_BODY()` family macro.
//   2. Whether a declaration sits at member scope at all, rather than inside a
//      function body, a parameter list, or a nested initializer.
//
// Requirement 2 of the specification turns on the first: `UPROPERTY()` is only
// available inside a reflected type, so a finding that recommends it must
// establish the enclosing type first. `FLyraPerformanceStatCache` in Lyra is a
// plain `struct` holding a `ULyraPerformanceStatSubsystem*`, and a check that
// matched the pointer shape alone would prescribe a macro that does not compile
// there.
//
// Everything here rests on what the lexer can see. No type is resolved, no
// header is followed, and no inheritance chain is walked.

/** Reflection macros that mark a type declaration for Unreal Header Tool. */
const REFLECTION_MACROS = new Set(['UCLASS', 'USTRUCT', 'UINTERFACE']);

/**
 * Macros that inject the generated reflection body into a type.
 *
 * Documented on "Objects in Unreal Engine" (Unreal Engine 5.8): the
 * `GENERATED_BODY` macro "is required for all `UCLASS` and `USTRUCT`". The
 * older per-kind spellings still compile and appear in existing code.
 */
const GENERATED_BODY_PATTERN =
  /\bGENERATED_(?:BODY|USTRUCT_BODY|UCLASS_BODY|IINTERFACE_BODY|UINTERFACE_BODY|BODY_LEGACY)\b/g;

/** Declaration specifiers that precede the type in a member declaration. */
const LEADING_SPECIFIERS = new Set([
  'static',
  'mutable',
  'virtual',
  'inline',
  'explicit',
  'constexpr',
  'consteval',
  'thread_local',
  'FORCEINLINE',
  'FORCENOINLINE',
]);

/** Keywords whose statement is not a member field and is not worth parsing further. */
const NON_FIELD_KEYWORDS = new Set(['friend', 'typedef', 'using', 'template', 'static_assert', 'enum', 'namespace']);

function isSpace(char) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function isIdentifierChar(char) {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Replace every byte that is not code with a space, keeping every offset and
 * newline where it was.
 *
 * Comments, string and character literals, and preprocessor directives are all
 * blanked. Directives go because a `#define` body can contain unbalanced braces
 * that would derail the scope stack, and because `#include "X.generated.h"`
 * would otherwise read as an identifier.
 */
export function blankNonCode(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let at = from; at < to && at < text.length; at++) {
      if (out[at] !== '\n') out[at] = ' ';
    }
  };

  let index = 0;
  let onlySpaceSoFar = true;

  while (index < text.length) {
    const char = text[index];

    if (char === '\n') {
      onlySpaceSoFar = true;
      index += 1;
      continue;
    }
    if (isSpace(char)) {
      index += 1;
      continue;
    }

    if (onlySpaceSoFar && char === '#') {
      const end = endOfDirective(text, index);
      blank(index, end);
      index = end;
      continue;
    }
    onlySpaceSoFar = false;

    if (char === '/' && text[index + 1] === '/') {
      let end = index;
      while (end < text.length && text[end] !== '\n') end += 1;
      blank(index, end);
      index = end;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      let end = index + 2;
      while (end < text.length && !(text[end] === '*' && text[end + 1] === '/')) end += 1;
      end = Math.min(end + 2, text.length);
      blank(index, end);
      index = end;
      continue;
    }

    if (char === 'R' && text[index + 1] === '"' && !isIdentifierChar(text[index - 1])) {
      const end = endOfRawString(text, index);
      blank(index + 1, end);
      index = end;
      continue;
    }

    if (char === '"' || (char === "'" && !isIdentifierChar(text[index - 1]))) {
      const end = endOfQuoted(text, index, char);
      blank(index, end);
      index = end;
      continue;
    }

    index += 1;
  }

  return out.join('');
}

/** End offset of a preprocessor directive, following backslash continuations. */
function endOfDirective(text, start) {
  let at = start;
  while (at < text.length) {
    if (text[at] !== '\n') {
      at += 1;
      continue;
    }
    let back = at - 1;
    while (back >= start && (text[back] === ' ' || text[back] === '\t' || text[back] === '\r')) back -= 1;
    if (back >= start && text[back] === '\\') {
      at += 1;
      continue;
    }
    return at;
  }
  return at;
}

function endOfRawString(text, start) {
  const openParen = text.indexOf('(', start);
  if (openParen === -1) return text.length;
  const delimiter = text.slice(start + 2, openParen);
  const terminator = `)${delimiter}"`;
  const end = text.indexOf(terminator, openParen);
  return end === -1 ? text.length : end + terminator.length;
}

function endOfQuoted(text, start, quote) {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === '\\') {
      at += 2;
      continue;
    }
    if (text[at] === quote) return at + 1;
    if (text[at] === '\n') return at;
    at += 1;
  }
  return at;
}

/** Offsets at which each 1-based line begins. */
function buildLineStarts(text) {
  const starts = [0];
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '\n') starts.push(at + 1);
  }
  return starts;
}

function positionAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

/** Offset just past the matching close for the bracket at `start`. */
function skipBalanced(text, start, open, close) {
  let depth = 0;
  let at = start;
  while (at < text.length) {
    if (text[at] === open) depth += 1;
    else if (text[at] === close) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
    at += 1;
  }
  return text.length;
}

/**
 * Consume leading access specifiers, reflection and annotation macros, and
 * declaration specifiers from a statement.
 *
 * Returns the offset of the first character of the declaration proper, so a
 * finding can be reported at the declaration rather than at the `UPROPERTY`
 * line above it.
 */
function stripLeadingAnnotations(statement) {
  const macros = [];
  const specifiers = [];
  let at = 0;
  let rejected = false;

  for (;;) {
    while (at < statement.length && isSpace(statement[at])) at += 1;
    const rest = statement.slice(at);

    const access = /^(?:public|private|protected)\s*:/.exec(rest);
    if (access !== null) {
      at += access[0].length;
      continue;
    }

    const macro = /^([A-Z][A-Z0-9_]{2,})\s*\(/.exec(rest);
    if (macro !== null) {
      macros.push(macro[1]);
      at = skipBalanced(statement, at + rest.indexOf('('), '(', ')');
      continue;
    }

    const word = /^([A-Za-z_]\w*)\b/.exec(rest);
    if (word !== null && LEADING_SPECIFIERS.has(word[1])) {
      specifiers.push(word[1]);
      at += word[0].length;
      continue;
    }
    if (word !== null && NON_FIELD_KEYWORDS.has(word[1])) {
      rejected = true;
    }
    break;
  }

  return { macros, specifiers, declarationOffset: at, rejected };
}

/** Skip a `template < ... >` clause, balancing nested angle brackets. */
function skipTemplateClause(text, start) {
  const match = /^template\s*</.exec(text.slice(start));
  if (match === null) return start;
  const open = start + match[0].length - 1;
  let depth = 0;
  let at = open;
  while (at < text.length) {
    if (text[at] === '<') depth += 1;
    else if (text[at] === '>') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
    at += 1;
  }
  return text.length;
}

/**
 * Decide what the text before an opening brace introduces.
 *
 * A type head is `class`/`struct`/`union`, a name, an optional `final`, and an
 * optional base-clause. Anything else — a function body, an initializer, a
 * lambda — is `other`, and members are not collected inside it.
 */
function classifyScopeHead(head) {
  const { macros, declarationOffset } = stripLeadingAnnotations(head);
  const afterAnnotations = head.slice(declarationOffset);
  const text = afterAnnotations.slice(skipTemplateClause(afterAnnotations, 0)).trim();

  if (/^namespace\b/.test(text)) return { kind: 'namespace' };
  if (/^enum\b/.test(text)) return { kind: 'enum' };

  const declaration = /^(class|struct|union)\s+(?:[A-Za-z_]\w*_API\s+)?([A-Za-z_]\w*)\s*(final\b\s*)?(?::([\s\S]*))?$/.exec(
    text,
  );
  if (declaration === null) return { kind: 'other' };

  const reflection = macros.find((name) => REFLECTION_MACROS.has(name));
  return {
    kind: 'type',
    typeKind: declaration[1],
    name: declaration[2],
    reflectionMacro: reflection,
    bases: parseBaseClause(declaration[4]),
  };
}

function parseBaseClause(clause) {
  if (clause === undefined) return [];
  return clause
    .split(',')
    .map((entry) => {
      const names = entry.match(/[A-Za-z_]\w*/g);
      return names === null ? '' : names[names.length - 1];
    })
    .filter((name) => name !== '');
}

/**
 * Every type declaration and every member-scope statement in one file.
 *
 * `types[i].reflected` is true only when the declaration carries both a
 * reflection macro and a generated-body macro, which is the condition
 * Requirement 2.1 sets before `UPROPERTY()` may be recommended.
 */
export function scanUnrealSource(text) {
  const source = blankNonCode(text);
  const lineStarts = buildLineStarts(text);
  const types = [];
  const statements = [];
  const stack = [];

  let parenDepth = 0;
  let bracketDepth = 0;
  let bufferStart = -1;

  const noteChar = (at) => {
    if (bufferStart === -1 && !isSpace(source[at])) bufferStart = at;
  };
  const currentType = () => {
    const top = stack[stack.length - 1];
    return top !== undefined && top.kind === 'type' ? top.typeIndex : -1;
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === '(') {
      noteChar(index);
      parenDepth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      index += 1;
      continue;
    }
    if (char === '[') {
      noteChar(index);
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      index += 1;
      continue;
    }
    if (parenDepth > 0 || bracketDepth > 0) {
      index += 1;
      continue;
    }

    if (char === '{') {
      const head = bufferStart === -1 ? '' : source.slice(bufferStart, index);
      const scope = classifyScopeHead(head);
      if (scope.kind === 'type') {
        types.push({
          name: scope.name,
          typeKind: scope.typeKind,
          reflectionMacro: scope.reflectionMacro,
          bases: scope.bases,
          hasGeneratedBody: false,
          reflected: false,
          headOffset: bufferStart,
          bodyStart: index,
          bodyEnd: source.length,
          parent: currentType(),
        });
        stack.push({ kind: 'type', typeIndex: types.length - 1 });
      } else {
        stack.push({ kind: scope.kind, typeIndex: -1 });
      }
      bufferStart = -1;
      index += 1;
      continue;
    }

    if (char === '}') {
      const top = stack.pop();
      if (top !== undefined && top.kind === 'type') types[top.typeIndex].bodyEnd = index;
      bufferStart = -1;
      index += 1;
      continue;
    }

    if (char === ';') {
      const owner = currentType();
      if (owner !== -1 && bufferStart !== -1) {
        statements.push({ typeIndex: owner, start: bufferStart, text: source.slice(bufferStart, index) });
      }
      bufferStart = -1;
      index += 1;
      continue;
    }

    noteChar(index);
    index += 1;
  }

  markGeneratedBodies(source, types);

  const members = [];
  for (const statement of statements) {
    const member = parseMemberStatement(statement.text, statement.start);
    if (member === undefined) continue;
    members.push({
      ...member,
      typeIndex: statement.typeIndex,
      ...positionAt(lineStarts, member.offset),
      snippet: snippetAt(text, lineStarts, member.offset),
    });
  }

  return { types, members };
}

/** Attribute each generated-body macro to the innermost type containing it. */
function markGeneratedBodies(source, types) {
  GENERATED_BODY_PATTERN.lastIndex = 0;
  for (let match = GENERATED_BODY_PATTERN.exec(source); match !== null; match = GENERATED_BODY_PATTERN.exec(source)) {
    const at = match.index;
    let innermost = -1;
    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      if (type.bodyStart < at && at < type.bodyEnd) {
        if (innermost === -1 || type.bodyStart > types[innermost].bodyStart) innermost = i;
      }
    }
    if (innermost !== -1) types[innermost].hasGeneratedBody = true;
  }
  for (const type of types) {
    type.reflected = type.reflectionMacro !== undefined && type.hasGeneratedBody;
  }
}

function snippetAt(text, lineStarts, offset) {
  const position = positionAt(lineStarts, offset);
  const start = lineStarts[position.line - 1];
  const end = text.indexOf('\n', start);
  const line = (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * Split one member-scope statement into its annotations, its type, and its
 * declared name.
 *
 * A statement carrying parentheses after its annotations is a function
 * declaration, a constructor, or a function-pointer member, and is returned as
 * `kind: 'function'` rather than parsed as a field.
 */
export function parseMemberStatement(statement, baseOffset) {
  const { macros, specifiers, declarationOffset, rejected } = stripLeadingAnnotations(statement);
  const offset = baseOffset + declarationOffset;
  const rest = statement.slice(declarationOffset).trim();

  if (rejected || rest === '') return { macros, specifiers, kind: 'other', offset, text: rest };
  if (rest.includes('(') || rest.includes(')') || rest.startsWith('~') || /\boperator\b/.test(rest)) {
    return { macros, specifiers, kind: 'function', offset, text: rest };
  }

  const withoutBitfield = rest.replace(/\s*:\s*\d+\s*$/, '');
  const declaration = splitInitializer(withoutBitfield).trim();
  const named = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*$/.exec(declaration);
  if (named === null) return { macros, specifiers, kind: 'other', offset, text: rest };

  const typeText = declaration.slice(0, named.index).trim();
  if (typeText === '') return { macros, specifiers, kind: 'other', offset, text: rest };

  return { macros, specifiers, kind: 'field', offset, text: rest, typeText, name: named[1] };
}

/** Everything before a top-level `=`, so a default initializer is not read as part of the type. */
function splitInitializer(declaration) {
  let angle = 0;
  for (let at = 0; at < declaration.length; at++) {
    const char = declaration[at];
    if (char === '<') angle += 1;
    else if (char === '>') angle = Math.max(0, angle - 1);
    else if (char === '=' && angle === 0 && declaration[at + 1] !== '=' && declaration[at - 1] !== '=') {
      return declaration.slice(0, at);
    }
  }
  return declaration;
}
