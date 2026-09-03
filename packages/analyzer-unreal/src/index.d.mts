/** The subset of the analyze request this analyzer reads. */
export interface AnalyzeRequest {
  protocol: number;
  repoRoot: string;
  mode: string;
  files: readonly string[];
  rules: Readonly<Record<string, { severity: string }>>;
}

export interface AnalyzeResponse {
  protocol: number;
  violations: Array<{
    file: string;
    line: number;
    column: number;
    ruleId: string;
    message: string;
    snippet: string;
    severity: string;
  }>;
  skipped: Array<{ file: string; reason: string }>;
  diagnostics: Array<{ level: string; message: string }>;
}

export default function analyze(request: AnalyzeRequest): Promise<AnalyzeResponse>;
