// A code comment describes the code. This rule reports the ones that argue
// about it instead.
//
// The distinction is not style preference. A description stays true as long as
// the code does; an argument is written to persuade a reader at one moment and
// rots immediately, because the debate it answers is not in the file. Comments
// that rehearse a decision, editorialise about quality, or address the reader
// rhetorically are the ones that survive long past the discussion that produced
// them and mislead whoever reads them next.
//
// The phrase list is deliberately short. Editorial writing has no syntax, so
// this cannot be decided the way `no-any` is decided; every entry here is a
// construction that is almost never part of a factual description of code. A
// rule that guessed would produce exactly the false findings this project
// argues cost more than the misses.

/**
 * Each entry is a construction that argues rather than describes.
 *
 * `pattern` matches case-insensitively against the comment's full text.
 * `why` names what the phrase is doing, so a finding explains itself rather
 * than pointing at a word list.
 */
export const EDITORIAL_PATTERNS = [
  {
    // Paired with a verb of preference or belief, not any verb. The pronoun
    // followed by "would" or "wants" argues; followed by "has checked" it
    // describes a state the code can be in. Matching the pronoun alone reported
    // the second kind, which is the false finding this rule cannot afford.
    id: 'universal-claim',
    pattern:
      /\b(nobody|no one|everybody|everyone|anybody|anyone)\s+(?:\w+\s+)?(would|wants?|cares?|knows?|likes?|expects?|thinks?|believes?|opens?|bothers?|reads?)\b/i,
    why: 'a claim about what people in general want or believe, which the code cannot establish',
  },
  {
    id: 'rhetorical-stake',
    pattern: /\b(the whole point|that is the point|that's the point|the real reason|the entire point)\b/i,
    why: 'a statement about why the reader should care rather than what the code does',
  },
  {
    id: 'comparative-judgment',
    pattern: /\b(is (?:far )?(?:worse|better) than|much better than|much worse than|the opposite of what)\b/i,
    why: 'a judgment comparing this code to an alternative that is not here',
  },
  {
    id: 'persuasion-marker',
    pattern: /(?:^\s*|[.;:—-]\s+)(obviously|clearly|of course|after all|needless to say)\b/i,
    why: 'a word that presses the reader to agree instead of stating the fact',
  },
  {
    id: 'self-congratulation',
    pattern: /\b(this is what makes|which is exactly why|and that is why this)\b/i,
    why: 'an argument for the design rather than a description of it',
  },
];

/**
 * Comment text that is not prose and must never be judged as prose.
 *
 * Directives, licence headers, and commented-out code are not editorial
 * writing, and matching a phrase inside them would be a false finding.
 */
const NOT_PROSE = [
  /^\s*(eslint|prettier|ts-|@ts-|biome-|c8|istanbul|noqa|type:|pragma|SPDX-)/i,
  /^\s*(TODO|FIXME|HACK|NOTE|XXX)\b/,
  /^\s*[/*\s]*(Copyright|Licensed under|SPDX)/i,
];

/**
 * Flatten a comment to the sentence an author wrote.
 *
 * Block comments carry a `*` at the start of each line, so a phrase spanning
 * two lines is separated by a newline and that marker rather than by a space.
 * Matching the raw text missed every multi-line phrase, which is most of them.
 */
function normalise(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProse(text) {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return !NOT_PROSE.some((pattern) => pattern.test(trimmed));
}

/**
 * Report each comment that argues, once, at its opening delimiter.
 *
 * A comment matching several patterns is one finding: the fix is to rewrite the
 * comment, and listing every phrase separately would imply several fixes.
 */
export function findEditorialComments(comments, options = {}) {
  const extra = Array.isArray(options.phrases) ? options.phrases : [];
  const extraPatterns = extra
    .filter((phrase) => typeof phrase === 'string' && phrase.length > 0)
    .map((phrase) => ({
      id: 'configured-phrase',
      pattern: new RegExp(escapeForRegExp(phrase), 'i'),
      why: 'a phrase this repository configured as editorial',
    }));

  const patterns = [...EDITORIAL_PATTERNS, ...extraPatterns];
  const findings = [];

  for (const comment of comments) {
    if (!isProse(comment.text)) continue;

    const prose = normalise(comment.text);
    const hit = patterns.find((entry) => entry.pattern.test(prose));
    if (hit === undefined) continue;

    findings.push({
      line: comment.line,
      column: comment.column,
      snippet: firstLine(comment.text),
      message:
        `This comment argues rather than describes: ${hit.why}. ` +
        'Say what the code does, and leave the reasoning that is not durable out of it.',
    });
  }

  return findings;
}

function firstLine(text) {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
