declare const arr: string[];
declare const tuple: [string, number];
declare const indexSig: { [k: string]: string };
type RuleOverride = { severity: 'error' | 'warning' };
declare const merged: Record<string, RuleOverride>;
declare const ruleCounts: Record<string, number>;
declare const settings: Record<string, RuleOverride>;
declare const ruleAnalyzers: Record<string, string>;
declare const i: number;
declare const key: string;
declare const n: number;
declare const rule: { id: string; severity: 'error' };
declare const violation: { ruleId: string };
declare const manifest: { id: string };

merged[rule.id] = { severity: rule.severity };
ruleCounts[violation.ruleId] = (ruleCounts[violation.ruleId] ?? 0) + 1;
settings[rule.id] = { severity: rule.severity };
ruleAnalyzers[rule.id] = manifest.id;
indexSig[key] = 'value';

if (i < arr.length) {
  arr[i] = 'x';
}

if (i in arr) {
  arr[i] = 'x';
}

for (let j = 0; j < arr.length; j++) {
  arr[j] = 'x';
}

for (let j = 1; j <= n; j++) {
  arr[j] = 'x';
}

tuple[0] = 'a';
tuple[1] = 1;

arr[0] = 'x';

arr.push('x');

arr[i] ??= 'default';
