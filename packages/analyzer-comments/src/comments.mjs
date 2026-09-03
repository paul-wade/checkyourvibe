// Extract comments from source text, for the languages this repository's
// analyzers already cover.
//
// This is a lexer, not a parser: it tracks string and comment state character
// by character so that a `//` inside a string literal is not read as a comment,
// and a quote inside a comment does not open a string. That is the minimum
// needed to avoid reporting on text that is not a comment at all.

/** Comment syntax per file extension. */
const SYNTAX = {
  '.ts': { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'] },
  '.tsx': { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'] },
  '.js': { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'] },
  '.mjs': { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'] },
  '.cs': { line: ['//'], block: [['/*', '*/']], strings: ['"'] },
  '.rs': { line: ['//'], block: [['/*', '*/']], strings: ['"'] },
  '.py': { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], strings: ['"', "'"] },
  '.go': { line: ['//'], block: [['/*', '*/']], strings: ['"', '`'] },
};

export function syntaxFor(extension) {
  return SYNTAX[extension];
}

export function supportedExtensions() {
  return Object.keys(SYNTAX);
}

/**
 * Every comment in `text`, as `{ text, line, column }` with 1-based positions
 * pointing at the comment's opening delimiter.
 *
 * Block comments are returned whole, so a rule reads the paragraph an author
 * actually wrote rather than one line of it out of context.
 */
export function extractComments(text, syntax) {
  const comments = [];
  let line = 1;
  let column = 1;
  let index = 0;

  const startsWith = (token) => text.startsWith(token, index);

  const advance = (count) => {
    for (let step = 0; step < count; step++) {
      if (text[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  while (index < text.length) {
    const char = text[index];

    // A string literal can contain comment delimiters, so it is skipped whole.
    if (syntax.strings.includes(char)) {
      const quote = char;
      advance(1);
      while (index < text.length) {
        if (text[index] === '\\') {
          advance(2);
          continue;
        }
        if (text[index] === quote) {
          advance(1);
          break;
        }
        // An unterminated single-quoted string would otherwise swallow the rest
        // of the file; a newline ends the scan for the line-oriented quotes.
        if (text[index] === '\n' && quote !== '`') {
          break;
        }
        advance(1);
      }
      continue;
    }

    const block = syntax.block.find(([open]) => startsWith(open));
    if (block !== undefined) {
      const [open, close] = block;
      const startLine = line;
      const startColumn = column;
      advance(open.length);
      const body = [];
      while (index < text.length && !startsWith(close)) {
        body.push(text[index]);
        advance(1);
      }
      advance(Math.min(close.length, text.length - index));
      comments.push({ text: body.join(''), line: startLine, column: startColumn });
      continue;
    }

    const lineToken = syntax.line.find((token) => startsWith(token));
    if (lineToken !== undefined) {
      const startLine = line;
      const startColumn = column;
      advance(lineToken.length);
      const body = [];
      while (index < text.length && text[index] !== '\n') {
        body.push(text[index]);
        advance(1);
      }
      comments.push({ text: body.join(''), line: startLine, column: startColumn });
      continue;
    }

    advance(1);
  }

  return comments;
}

/**
 * Consecutive line comments are one remark, not several.
 *
 * A paragraph written as five `//` lines should be reported once, at its first
 * line, because that is where an author would go to rewrite it. Reporting each
 * line separately would turn one problem into five findings.
 */
export function mergeAdjacent(comments) {
  const merged = [];
  for (const comment of comments) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && comment.line === previous.line + previous.lineSpan) {
      previous.text = `${previous.text}\n${comment.text}`;
      previous.lineSpan += 1;
      continue;
    }
    merged.push({ ...comment, lineSpan: countLines(comment.text) });
  }
  return merged;
}

function countLines(text) {
  return text.split('\n').length;
}
