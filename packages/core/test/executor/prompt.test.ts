import { describe, expect, it } from 'vitest';

import { executorPrompt } from '../../src/executor/prompt.js';
import { declaration } from './fixtures.js';

describe('executorPrompt', () => {
  it('states the task it was given', () => {
    const prompt = executorPrompt(declaration({ task: 'rename splitOn to partitionOn' }));
    expect(prompt).toContain('rename splitOn to partitionOn');
  });

  it('lists every declared path and says a write elsewhere fails the dispatch', () => {
    const prompt = executorPrompt(declaration({ ownedPaths: ['src/a.ts', 'src/b.ts'] }));
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
    expect(prompt).toContain('A write anywhere else is recorded as a failed dispatch');
  });

  it('says a dispatch expected to change files that changes none produced nothing', () => {
    const prompt = executorPrompt(declaration({ expectsFileChanges: true }));
    expect(prompt).toContain('recorded as having produced nothing');
  });

  it('says the opposite for a dispatch that declared no expected change', () => {
    const prompt = executorPrompt(declaration({ expectsFileChanges: false }));
    expect(prompt).toContain('expected to change no files');
    expect(prompt).not.toContain('recorded as having produced nothing');
  });

  it('names the gates the result is judged by', () => {
    const prompt = executorPrompt(declaration({ gates: ['cyv-check', 'run:npx tsc -b'] }));
    expect(prompt).toContain('- cyv-check');
    expect(prompt).toContain('- run:npx tsc -b');
  });

  it('says so when a dispatch declares no gate', () => {
    expect(executorPrompt(declaration({ gates: [] }))).toContain('No gate is declared');
  });

  it('tells the executor success is read from the repository, not from its report', () => {
    expect(executorPrompt(declaration())).toContain('read from the repository');
  });
});
