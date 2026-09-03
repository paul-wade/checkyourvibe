export type RunMode = 'files' | 'staged' | 'working' | 'branch' | 'all';

export interface FileSelection {
  mode: RunMode;
  files: string[];
  empty: boolean;
  reason?: string;
}
