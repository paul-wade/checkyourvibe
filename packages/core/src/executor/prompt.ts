/**
 * The text an executor is handed (spec 0011 Requirements 2.5, 2.7, 4.2).
 *
 * A dispatch declares three things the executor cannot infer: the paths it may
 * write, whether it is expected to change files at all, and the gates its
 * result will be judged by. All three decide the outcome — a write outside the
 * ownership set fails the dispatch whatever the executor reports, and a
 * dispatch that declared no expected change and changed files is reported as
 * having done something other than what was asked. Composing them into the
 * prompt states to the executor the terms it is actually being judged on.
 *
 * Nothing here is parsed back out of the executor's reply. The declaration is
 * the record, and `outcome.ts` reads the file system.
 */
import type { DispatchDeclaration } from './dispatch.js';

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function ownershipSection(declaration: DispatchDeclaration): string {
  if (declaration.ownedPaths.length === 0) {
    return 'This dispatch declares no paths it may write. Write nothing.';
  }
  return [
    'You may write only these paths, relative to the repository root:',
    '',
    bullets([...declaration.ownedPaths]),
    '',
    'A write anywhere else is recorded as a failed dispatch, whatever else you accomplish,',
    'and whatever exit code you report.',
  ].join('\n');
}

function effectSection(declaration: DispatchDeclaration): string {
  return declaration.expectsFileChanges
    ? [
        'This dispatch is expected to change files. Finishing without changing any of the paths',
        'above is recorded as having produced nothing, not as a success.',
      ].join('\n')
    : [
        'This dispatch is expected to change no files. If you change any, that is recorded as a',
        'dispatch that did something other than what was asked.',
      ].join('\n');
}

function gateSection(declaration: DispatchDeclaration): string {
  if (declaration.gates.length === 0) {
    return 'No gate is declared for this dispatch.';
  }
  return ['Your result is judged by these gates:', '', bullets([...declaration.gates])].join('\n');
}

/** The prompt for one unit of work, as it is written to disk and sent. */
export function executorPrompt(declaration: DispatchDeclaration): string {
  return [
    '# Task',
    '',
    declaration.task,
    '',
    '# Scope',
    '',
    ownershipSection(declaration),
    '',
    effectSection(declaration),
    '',
    '# How this is judged',
    '',
    gateSection(declaration),
    '',
    'Success is read from the repository, not from what you say about the run: the files above',
    'are compared before and after, and the gates are run against the result. Report what',
    'blocked you rather than exiting quietly.',
    '',
  ].join('\n');
}
