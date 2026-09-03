import { describe, expect, it } from 'vitest';

import analyze from '../src/index.mjs';
import {
  findGarbageCollectionIssues,
  RULE_UNTRACKED,
  RULE_UNREFLECTED_OWNER,
  RULE_RAW_UPROPERTY,
} from '../src/gc-rules.mjs';

const ALL_RULES = new Set([RULE_UNTRACKED, RULE_UNREFLECTED_OWNER, RULE_RAW_UPROPERTY]);

const RULE_SETTINGS = {
  [RULE_UNTRACKED]: { severity: 'warning' as const },
  [RULE_UNREFLECTED_OWNER]: { severity: 'warning' as const },
  [RULE_RAW_UPROPERTY]: { severity: 'warning' as const },
};

function findingsFor(source: string, enabled = ALL_RULES) {
  return findGarbageCollectionIssues(source, enabled);
}

describe('garbage-collection rules', () => {
  it('reports an untracked raw pointer in a reflected class', () => {
    const source = `UCLASS()
class AMyActor : public AActor
{
    GENERATED_BODY()

public:
    UMyClass* Target;
};`;
    const found = findingsFor(source);
    expect(found).toHaveLength(1);
    expect(found[0]?.ruleId).toBe(RULE_UNTRACKED);
  });

  it('does not report the UPROPERTY rule for a raw pointer in a plain struct', () => {
    const source = `struct FPlainCache
{
    UMyClass* Target;
};`;
    const found = findingsFor(source);
    expect(found.some((f) => f.ruleId === RULE_UNTRACKED)).toBe(false);
    expect(found.some((f) => f.ruleId === RULE_UNREFLECTED_OWNER)).toBe(true);
  });

  it('reports a UPROPERTY raw object pointer', () => {
    const source = `UCLASS()
class AMyActor : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY()
    UMyClass* Target;
};`;
    const found = findingsFor(source);
    expect(found).toHaveLength(1);
    expect(found[0]?.ruleId).toBe(RULE_RAW_UPROPERTY);
  });

  it('ignores lifetime-aware templates', () => {
    const source = `UCLASS()
class AMyActor : public AActor
{
    GENERATED_BODY()

public:
    TWeakObjectPtr<UMyClass> Target;
};`;
    const found = findingsFor(source);
    expect(found).toHaveLength(0);
  });

  it('reports nothing for an empty request', async () => {
    const response = await analyze({
      protocol: 1,
      repoRoot: '/',
      mode: 'file',
      files: [],
      rules: RULE_SETTINGS,
    });
    expect(response.protocol).toBe(1);
    expect(response.violations).toHaveLength(0);
    expect(response.skipped).toHaveLength(0);
    expect(response.diagnostics).toHaveLength(0);
  });

  it('skips a nonexistent file instead of crashing', async () => {
    const response = await analyze({
      protocol: 1,
      repoRoot: '/',
      mode: 'file',
      files: ['/does/not/exist.h'],
      rules: RULE_SETTINGS,
    });
    expect(response.violations).toHaveLength(0);
    expect(response.skipped).toHaveLength(1);
  });

  it('returns an empty response for unknown rule ids', async () => {
    const response = await analyze({
      protocol: 1,
      repoRoot: '/',
      mode: 'file',
      files: [],
      rules: { 'unknown-rule': { severity: 'warning' as const } },
    });
    expect(response.protocol).toBe(1);
    expect(response.violations).toHaveLength(0);
  });
});
