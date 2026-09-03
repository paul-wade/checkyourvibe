// The garbage-collection rule family.
//
// Every finding here rests on a reflection macro being lexically present or
// lexically absent, which is what Requirement 1.1 means by `evidence: 'syntax'`.
// No type is resolved and no base class is followed, so a member whose type is
// spelled outside Epic's `U`/`A` prefix contract is not reported at all.
//
// Documentation these rules are read from, at Unreal Engine 5.8:
//
//   "Unreal Object Handling in Unreal Engine" — "An Object reference stored in
//   a raw pointer will be unknown to the Unreal Engine, and will not be
//   automatically nulled, nor will it prevent garbage collection." The same
//   page gives `TWeakObjectPtr` as the alternative for "an Object pointer that
//   is not a UPROPERTY", and states that references "visible to the reflection
//   system (UProperty pointers and pointers stored in Unreal Engine container
//   classes such as TArray) are automatically nulled".
//
//   "Object Pointers in Unreal Engine" — "TObjectPtr is only garbage
//   collection safe if it is marked as a UPROPERTY", and "existing
//   UPROPERTY-marked raw pointers should migrate to use UPROPERTY-marked
//   TObjectPtr if possible".
//
//   "Objects in Unreal Engine" — the `GENERATED_BODY` macro "is required for
//   all UCLASS and USTRUCT".

import { classifyDeclaredType } from './object-types.mjs';
import { scanUnrealSource } from './scanner.mjs';

export const RULE_UNTRACKED = 'gc-untracked-object-member';
export const RULE_UNREFLECTED_OWNER = 'gc-object-pointer-in-unreflected-type';
export const RULE_RAW_UPROPERTY = 'uproperty-raw-object-pointer';

/** Shapes whose lifetime the reflection system governs when, and only when, the member is a UPROPERTY. */
const GC_RELEVANT_SHAPES = new Set([
  'raw-object-pointer',
  'container-of-raw-object-pointers',
  'tobjectptr',
  'container-of-tobjectptr',
]);

const RAW_SHAPES = new Set(['raw-object-pointer', 'container-of-raw-object-pointers']);

/**
 * Hooks that hand a non-reflected member to the collector explicitly.
 *
 * `FGCObject` "provides common registration for garbage collection for
 * non-UObject classes" and requires an `AddReferencedObjects` override;
 * `UObject` exposes a static `AddReferencedObjects` for the same purpose, and a
 * `USTRUCT` uses `AddStructReferencedObjects`. A type that declares one has
 * answered the question this family asks, so it is not reported.
 */
const COLLECTOR_HOOKS = /\bAdd(?:Struct)?ReferencedObjects\b/;

function ownerOf(scan, member) {
  return member.typeIndex === -1 ? undefined : scan.types[member.typeIndex];
}

/** True when the type, or any type enclosing it, hands members to a reference collector itself. */
function handlesItsOwnReferences(scan, typeIndex, source) {
  let index = typeIndex;
  while (index !== -1) {
    const type = scan.types[index];
    if (type.bases.some((base) => base === 'FGCObject')) return true;
    if (COLLECTOR_HOOKS.test(source.slice(type.bodyStart, type.bodyEnd))) return true;
    index = type.parent;
  }
  return false;
}

function describeShape(shape, objectType) {
  if (shape === 'raw-object-pointer') return `the raw pointer "${objectType}*"`;
  if (shape === 'container-of-raw-object-pointers') return `the container of raw "${objectType}*" pointers`;
  if (shape === 'tobjectptr') return `the TObjectPtr<${objectType}>`;
  return 'the container of TObjectPtr elements';
}

/**
 * Every garbage-collection finding in one file.
 *
 * `enabled` is the set of rule ids the request asked for, so a rule the core
 * did not enable is never evaluated.
 */
export function findGarbageCollectionIssues(text, enabled) {
  const scan = scanUnrealSource(text);
  const source = text;
  const findings = [];

  for (const member of scan.members) {
    if (member.kind !== 'field') continue;
    if (member.specifiers.includes('static')) continue;

    const owner = ownerOf(scan, member);
    if (owner === undefined) continue;

    const classified = classifyDeclaredType(member.typeText);
    if (!GC_RELEVANT_SHAPES.has(classified.shape)) continue;

    const hasUProperty = member.macros.includes('UPROPERTY');
    const where = describeShape(classified.shape, classified.objectType);
    const position = { line: member.line, column: member.column, snippet: member.snippet };

    if (owner.reflected && !hasUProperty) {
      if (!enabled.has(RULE_UNTRACKED)) continue;
      if (handlesItsOwnReferences(scan, member.typeIndex, source)) continue;
      findings.push({
        ruleId: RULE_UNTRACKED,
        ...position,
        message:
          `"${member.name}" holds ${where} inside ${owner.reflectionMacro}(...) ${owner.name}, ` +
          'but carries no UPROPERTY, so the reflection system does not see it and the collector does not ' +
          'count it as a reference to the object it points at.',
      });
      continue;
    }

    if (!owner.reflected) {
      if (!enabled.has(RULE_UNREFLECTED_OWNER)) continue;
      if (handlesItsOwnReferences(scan, member.typeIndex, source)) continue;
      findings.push({
        ruleId: RULE_UNREFLECTED_OWNER,
        ...position,
        message:
          `"${member.name}" holds ${where}, but the enclosing ${owner.typeKind} ${owner.name} is plain C++ ` +
          'with no reflection macro and no GENERATED_BODY, so UPROPERTY is not available here and nothing ' +
          'keeps the object alive or nulls the member when it is collected.',
      });
      continue;
    }

    if (hasUProperty && RAW_SHAPES.has(classified.shape) && enabled.has(RULE_RAW_UPROPERTY)) {
      findings.push({
        ruleId: RULE_RAW_UPROPERTY,
        ...position,
        message:
          `The UPROPERTY "${member.name}" is declared as ${where} rather than TObjectPtr. ` +
          'Epic documents TObjectPtr as the form UPROPERTY-marked object members should migrate to.',
      });
    }
  }

  return findings;
}
