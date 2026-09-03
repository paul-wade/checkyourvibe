import { describe, expect, it } from 'vitest';

// The analyzer is plain ESM JavaScript. Declaration files next to each module
// give it real types here, so this reads it the way any consumer would rather
// than suppressing the checker. It lives under `test/` so the repository's one
// vitest run collects it instead of it needing a harness of its own.
import { extractComments, mergeAdjacent, syntaxFor } from '../src/comments.mjs';
import type { CommentSyntax } from '../src/comments.d.mts';
import { findEditorialComments } from '../src/no-editorial-comment.mjs';
import type { EditorialFinding } from '../src/no-editorial-comment.d.mts';

function syntaxOrThrow(extension: string): CommentSyntax {
  const syntax = syntaxFor(extension);
  if (syntax === undefined) {
    throw new Error(`No comment syntax is defined for "${extension}".`);
  }
  return syntax;
}

const ts = syntaxOrThrow('.ts');
const py = syntaxOrThrow('.py');

function findingsIn(source: string, syntax: CommentSyntax = ts): EditorialFinding[] {
  return findEditorialComments(mergeAdjacent(extractComments(source, syntax)));
}

describe('comment extraction', () => {
  it('does not treat a comment delimiter inside a string as a comment', () => {
    const source = 'const url = "https://example.com/nobody would care";\n';
    expect(findingsIn(source)).toHaveLength(0);
  });

  it('reads a block comment whole, so a phrase spanning lines is still seen', () => {
    const source = '/*\n * Nobody\n * would want this.\n */\nconst a = 1;\n';
    expect(findingsIn(source)).toHaveLength(1);
  });

  it('reports a run of line comments once, at its first line', () => {
    const source = ['const a = 1;', '// Nobody', '// would want this.', '// Truly.'].join('\n');
    const found = findingsIn(source);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  it('reads Python comments and docstrings', () => {
    expect(findingsIn('# Nobody would want this.\n', py)).toHaveLength(1);
  });
});

describe('what counts as editorial', () => {
  it('reports a universal claim paired with a verb of preference', () => {
    expect(findingsIn('// Nobody would open this twice.\n')).toHaveLength(1);
  });

  /**
   * The distinction this rule turns on. Both sentences contain "nobody"; only
   * the first makes a claim about people. Reporting the second is the false
   * finding that would make the rule not worth running, and it is why the
   * pattern requires a verb of preference rather than the pronoun alone.
   */
  it('does not report a universal pronoun used to describe a state', () => {
    expect(findingsIn('// The first means nobody has ever checked this row.\n')).toHaveLength(0);
  });

  it('reports a rhetorical stake', () => {
    expect(findingsIn('// Reusing the socket is the whole point of the pool.\n')).toHaveLength(1);
  });

  it('reports a persuasion marker at the start of a clause', () => {
    expect(findingsIn('// Obviously the cache is warmed first.\n')).toHaveLength(1);
  });

  it('does not report a word that merely contains a marker', () => {
    expect(findingsIn('// Values are cleared of course-level defaults.\n')).toHaveLength(0);
  });

  it('does not report a plain description', () => {
    const source =
      '// A single file, overwritten each run, so its cost does not grow with\n' +
      '// the number of runs.\n';
    expect(findingsIn(source)).toHaveLength(0);
  });
});

describe('text that is not prose', () => {
  it('does not report a directive comment', () => {
    expect(findingsIn('// eslint-disable-next-line nobody-would-care\n')).toHaveLength(0);
  });

  it('does not report a licence header', () => {
    expect(findingsIn('// Copyright 2026. Everyone knows this notice.\n')).toHaveLength(0);
  });

  it('does not report a TODO marker', () => {
    expect(findingsIn('// TODO: nobody would want the retry to be unbounded\n')).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('reports a phrase the repository added', () => {
    const comments = mergeAdjacent(extractComments('// This is frankly a mess.\n', ts));
    expect(findEditorialComments(comments, { phrases: ['frankly'] })).toHaveLength(1);
    expect(findEditorialComments(comments, {})).toHaveLength(0);
  });

  it('treats a configured phrase as literal text, not a pattern', () => {
    const comments = mergeAdjacent(extractComments('// a.b happens here\n', ts));
    expect(findEditorialComments(comments, { phrases: ['a.b'] })).toHaveLength(1);
    expect(findEditorialComments(comments, { phrases: ['axb'] })).toHaveLength(0);
  });
});
