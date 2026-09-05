#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { emptyResponse, PROTOCOL_VERSION, type AnalyzeRequest, type AnalyzeResponse } from '@checkyourvibe/core';
import analyze from '../index.js';

/**
 * The subprocess half of the analyzer protocol (`exec.type: 'process'`).
 *
 * This package already runs in-process via `../src/index.js`; this entry point
 * exists so the stdin/stdout contract has a real implementation exercising it,
 * not just a schema a future non-Node analyzer (a C# analyzer needing .NET, a
 * C++ one needing clang) would be the first to test.
 *
 * The core spawns this file, writes one `JSON.stringify(request)` to stdin,
 * closes it, and then reads the entire stdout stream and `JSON.parse`s it as
 * the response (see `packages/core/src/run/execute.ts`). stderr is folded into
 * diagnostics line-by-line. That means stdout must contain the response and
 * nothing else — one stray `console.log` here corrupts every caller's parse.
 */

function isStringArray(value: unknown): value is string[] {
  // `Array.isArray` narrows its parameter to `any[]` in lib.dom/es5 typings, so
  // the callback parameter needs an explicit annotation to stay out of `any`.
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

/**
 * Hand-written guard rather than a cast: this file is itself subject to this
 * package's `no-json-parse-cast` and `no-as-cast` rules, and the value came
 * from an external process over stdin, which makes it exactly the kind of
 * untrusted input those rules exist to stop from being trusted unchecked.
 *
 * This checks the wire-level shape the task calls for (protocol, repoRoot,
 * mode, files, rules-is-an-object) and no deeper. Per-rule settings inside
 * `rules` are opaque to this boundary: `../src/index.js` already treats each
 * entry loosely (`{ severity, ...options }`) and reports a diagnostic if a
 * rule id it does not recognize shows up, so re-validating that shape here
 * would just be a second copy of the same check.
 */
function isAnalyzeRequest(value: unknown): value is AnalyzeRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('protocol' in value) || value.protocol !== PROTOCOL_VERSION) {
    return false;
  }
  if (!('repoRoot' in value) || typeof value.repoRoot !== 'string') {
    return false;
  }
  if (!('mode' in value) || (value.mode !== 'file' && value.mode !== 'project')) {
    return false;
  }
  if (!('files' in value) || !isStringArray(value.files)) {
    return false;
  }
  if (!('rules' in value) || typeof value.rules !== 'object' || value.rules === null || Array.isArray(value.rules)) {
    return false;
  }
  return true;
}

function errorResponse(message: string): AnalyzeResponse {
  return { ...emptyResponse(), diagnostics: [{ level: 'error', message }] };
}

/**
 * Pure request/response core, kept separate from the stdin/stdout wiring below
 * so tests can call it directly with an in-memory string instead of spawning
 * a real subprocess.
 */
export async function runStdio(input: string): Promise<{ stdout: string; exitCode: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: JSON.stringify(errorResponse(`Input is not valid JSON: ${reason}`)),
      exitCode: 1,
    };
  }

  if (!isAnalyzeRequest(parsed)) {
    return {
      stdout: JSON.stringify(
        errorResponse(
          'Input does not match the AnalyzeRequest shape: expected protocol === ' +
            `${PROTOCOL_VERSION}, repoRoot: string, mode: 'file' | 'project', files: string[], rules: object.`,
        ),
      ),
      exitCode: 1,
    };
  }

  try {
    const response = await analyze(parsed);
    return { stdout: JSON.stringify(response), exitCode: 0 };
  } catch (error) {
    // The in-process analyzer already turns a single rule's failure into a
    // diagnostic rather than throwing (see ../src/index.ts). A throw here
    // means something broke below that per-rule boundary, and the stdio
    // contract has no channel for an uncaught exception other than turning
    // it into the same diagnostics shape everything else uses.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: JSON.stringify(errorResponse(`Analyzer crashed: ${reason}`)),
      exitCode: 1,
    };
  }
}

function isDirectlyExecuted(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }
  return fileURLToPath(import.meta.url) === resolve(invokedPath);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  // `process.stdin`'s async iterator yields `any` in the Node type definitions.
  // TypeScript forbids annotating a for-of binding, so annotate the iterable
  // instead: `chunk` is then `unknown` and has to be narrowed rather than
  // trusted, which is what the body below does.
  const stream: AsyncIterable<unknown> = process.stdin;
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { stdout, exitCode } = await runStdio(input);
  process.stdout.write(stdout);
  process.exitCode = exitCode;
}

if (isDirectlyExecuted()) {
  main().catch((error: unknown) => {
    // A failure here happened outside runStdio's own try/catch (e.g. stdin
    // itself erroring), so stdout may never have been written. Human-readable
    // detail still belongs on stderr only, and stdout gets a minimal, parseable
    // fallback so a caller that already committed to reading JSON from stdout
    // never sees a bare stack trace there.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`analyze: fatal error: ${reason}\n`);
    process.stdout.write(JSON.stringify(errorResponse(`Fatal error before a response could be produced: ${reason}`)));
    process.exitCode = 1;
  });
}
