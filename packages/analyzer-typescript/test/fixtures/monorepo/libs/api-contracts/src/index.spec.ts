import { describe, it } from 'vitest';
import { Project } from 'ts-morph';

export function makeProject(project: Project): string {
  return 'ok';
}

describe('project', () => {
  it('exists', () => {
    makeProject;
  });
});
