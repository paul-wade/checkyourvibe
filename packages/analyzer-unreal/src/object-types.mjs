// Reading a member's declared type the way Unreal Header Tool would read it:
// lexically, from the spelling.
//
// Whether a type derives from `UObject` is a semantic question this analyzer
// does not answer. What it uses instead is Epic's own published naming
// contract, which the coding standard states as a requirement rather than a
// preference: "Classes that inherit from UObject are prefixed by U" and
// "Classes that inherit from AActor are prefixed by A" (Epic C++ Coding
// Standard for Unreal Engine, 5.8). A name outside that contract is not
// reported, so a project that departs from it loses findings rather than
// gaining wrong ones.

/**
 * Pointer and handle templates that already answer the lifetime question, so a
 * member declared with one of them is not a garbage-collection finding.
 *
 * `TStrongObjectPtr` and `TObjectPtr` differ: "Object Pointers in Unreal
 * Engine" (5.8) states "TObjectPtr is only garbage collection safe if it is
 * marked as a UPROPERTY", while `TStrongObjectPtr` holds its own reference
 * independently of the reflection system.
 */
const LIFETIME_AWARE_TEMPLATES = new Set([
  'TWeakObjectPtr',
  'TStrongObjectPtr',
  'TSoftObjectPtr',
  'TSoftClassPtr',
  'TSubclassOf',
  'TScriptInterface',
  'TObjectKey',
  'TSharedPtr',
  'TSharedRef',
  'TWeakPtr',
  'TUniquePtr',
  'TOptional',
]);

/** Unreal containers whose element type the reflection system walks. */
const REFLECTED_CONTAINERS = new Set(['TArray', 'TSet', 'TMap']);

/**
 * True when a type name follows Epic's `U` or `A` prefix for reflected classes.
 *
 * The trailing lowercase requirement separates a prefixed class name from an
 * all-capital engine typedef: `AActor` and `UWorld` qualify, `ANSICHAR`,
 * `UTF8CHAR` and `UPTRINT` do not. It also excludes an acronym-only name such
 * as `UMG`, and it accepts `AAIController`, which carries an acronym but ends
 * in lowercase letters.
 */
export function looksLikeReflectedClassName(name) {
  if (!/^[UA][A-Z]/.test(name)) return false;
  return /[a-z]/.test(name.slice(1));
}

function stripQualifiers(typeText) {
  let text = typeText.trim().replace(/\s+/g, ' ');
  for (;;) {
    const next = text.replace(/^(?:const|mutable|volatile|class|struct|typename)\s+/, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+const$/, '').trim();
}

function unqualify(name) {
  const parts = name.split('::');
  return parts[parts.length - 1];
}

/**
 * What a member's declared type is, in the terms the garbage-collection rules
 * need.
 *
 * `raw-object-pointer` is a single-level raw pointer to a `U`- or `A`-prefixed
 * class. `container-of-raw-object-pointers` is an Unreal container whose
 * element is one. `tobjectptr` is `TObjectPtr<...>`, alone or inside a
 * container. Everything else is `other`, including double pointers and
 * references, neither of which `UPROPERTY` supports.
 */
export function classifyDeclaredType(typeText) {
  const text = stripQualifiers(typeText);

  const pointer = /^((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*\*$/.exec(text);
  if (pointer !== null) {
    const name = unqualify(pointer[1].replace(/\s+/g, ''));
    if (looksLikeReflectedClassName(name)) return { shape: 'raw-object-pointer', objectType: name };
    return { shape: 'other' };
  }

  const template = /^([A-Za-z_]\w*)\s*<([\s\S]*)>$/.exec(text);
  if (template === null) return { shape: 'other' };

  const [, templateName, argumentText] = template;

  if (templateName === 'TObjectPtr') {
    return { shape: 'tobjectptr', objectType: unqualify(stripQualifiers(argumentText).replace(/\s+/g, '')) };
  }
  if (LIFETIME_AWARE_TEMPLATES.has(templateName)) return { shape: 'lifetime-aware' };

  if (REFLECTED_CONTAINERS.has(templateName)) {
    if (/\bTObjectPtr\s*</.test(argumentText)) return { shape: 'container-of-tobjectptr' };
    const element = findRawObjectPointerElement(argumentText);
    if (element !== undefined) {
      return { shape: 'container-of-raw-object-pointers', container: templateName, objectType: element };
    }
  }

  return { shape: 'other' };
}

/** The first `U`- or `A`-prefixed class name used as a raw pointer inside a container's arguments. */
function findRawObjectPointerElement(argumentText) {
  const pattern = /([A-Za-z_]\w*)\s*\*/g;
  for (let match = pattern.exec(argumentText); match !== null; match = pattern.exec(argumentText)) {
    if (looksLikeReflectedClassName(match[1])) return match[1];
  }
  return undefined;
}
