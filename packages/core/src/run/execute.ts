import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isAnalyzeResponse,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type AnalyzerManifest,
  type Diagnostic,
  type Severity,
  type Violation,
} from '../protocol/index.js';

export class AnalyzerError extends Error {
  readonly code: 'MALFORMED' | 'CRASHED' | 'LOAD_FAILED' | 'MISSING_COMMAND';
  readonly analyzerId: string;

  constructor(
    code: 'MALFORMED' | 'CRASHED' | 'LOAD_FAILED' | 'MISSING_COMMAND',
    analyzerId: string,
    message?: string,
  ) {
    super(message ?? `Analyzer ${analyzerId} failed with code ${code}`);
    this.code = code;
    this.analyzerId = analyzerId;
  }
}

export async function runAnalyzer(
  manifest: AnalyzerManifest,
  request: AnalyzeRequest,
  repoRoot: string,
): Promise<AnalyzeResponse> {
  if (manifest.exec.type === 'node') {
    // `repoRoot` is not passed on: a node analyzer's module is located by the
    // manifest, and the request already carries the repository root for the
    // analyzer's own use.
    return runNodeAnalyzer(manifest, request);
  }

  if (manifest.exec.type === 'process') {
    return runProcessAnalyzer(manifest, request, repoRoot);
  }

  throw new AnalyzerError(
    'CRASHED',
    manifest.id,
    `Unsupported exec type for analyzer ${manifest.id}`,
  );
}

/** True when `value` is a non-null object, so its properties can be inspected by name. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type AnalyzeFn = (req: AnalyzeRequest) => Promise<unknown>;

/**
 * All that can honestly be checked about a dynamically imported analyzer
 * function is that it is callable; its parameter and return shapes are
 * verified after the call, via `isAnalyzeResponse` on the actual result.
 */
function isAnalyzeFn(value: unknown): value is AnalyzeFn {
  return typeof value === 'function';
}

/**
 * Turn a manifest's `exec.module` into a specifier `import()` accepts.
 *
 * Resolution of a relative module path happens once, at load time, against the
 * manifest's own directory (`withResolvedExecPaths` in `registry/load.ts`).
 * Every manifest that reaches this function through `loadAnalyzerManifest`
 * therefore carries an absolute path already. A value that is still relative
 * here came from a manifest object built in memory, and the runner has no
 * directory that reproduces what the manifest's author wrote down — the
 * repository root is a different place. That case is reported instead of
 * resolved against a second base, so there is one resolution rule to document
 * and one to learn.
 *
 * A value that is neither absolute, relative, nor a `file:` URL is handed to
 * Node unchanged as a package specifier.
 */
function resolveModulePath(manifest: AnalyzerManifest, modulePath: string): string {
  if (modulePath.startsWith('file:')) {
    return modulePath;
  }

  if (isAbsolute(modulePath)) {
    return pathToFileURL(modulePath).href;
  }

  if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
    throw new AnalyzerError(
      'LOAD_FAILED',
      manifest.id,
      `Analyzer ${manifest.id} declares a relative module path "${modulePath}" that was never ` +
        'resolved. A relative "exec.module" is resolved against the manifest\'s own directory ' +
        'when the manifest is read, so pass the manifest through loadAnalyzerManifest, or give ' +
        'exec.module an absolute path or a file: URL.',
    );
  }

  return modulePath;
}

/** True when Node will treat the specifier as a package name rather than a path. */
function isPackageSpecifier(modulePath: string): boolean {
  return (
    !modulePath.startsWith('file:') &&
    !isAbsolute(modulePath) &&
    !modulePath.startsWith('./') &&
    !modulePath.startsWith('../')
  );
}

/**
 * True when `err` is an ENOENT from `node:child_process`.
 *
 * The emitted error is an Error whose `code` property is the string 'ENOENT'.
 * The check avoids `as` casts by reading through Reflect, which returns an
 * honest `unknown` for a property that may not exist on the Error shape.
 */
function isEnoent(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code: unknown = Reflect.get(err, 'code');
  return code === 'ENOENT';
}

/**
 * Map a missing bare command to an actionable install hint.
 *
 * Keeping the hint here means `run/execute.ts` stays language-agnostic while
 * still telling a user without .NET exactly what to install.
 */
function installHintFor(command: string): string {
  const known: Record<string, string> = {
    dotnet: 'Install the .NET SDK',
    python: 'Install Python',
    python3: 'Install Python',
    node: 'Install Node.js',
    clang: 'Install Clang',
  };
  const hint = known[command];
  return hint !== undefined
    ? hint
    : `Install the "${command}" toolchain`;
}

/**
 * Build the message for a process analyzer whose command is not on PATH.
 *
 * It names the analyzer, the command that could not be run, what to install,
 * and the fact that the claimed files were not checked.
 */
function missingCommandMessage(manifest: AnalyzerManifest, command: string): string {
  return (
    `The "${manifest.id}" analyzer could not start because the command "${command}" ` +
    `was not found on PATH. ${installHintFor(command)} to use the "${manifest.id}" analyzer. ` +
    'The files it claims were not checked.'
  );
}

/**
 * Import the analyzer module and call its default export with the request.
 *
 * The module is loaded into this process. Nothing is spawned, no request is
 * written to stdin, and the module's top level runs before the analyzer
 * function is ever called — so a module that waits for stdin at import time
 * waits for input that is never sent.
 */
async function runNodeAnalyzer(
  manifest: AnalyzerManifest,
  request: AnalyzeRequest,
): Promise<AnalyzeResponse> {
  if (manifest.exec.type !== 'node') {
    throw new AnalyzerError(
      'CRASHED',
      manifest.id,
      `Internal error: expected node exec for analyzer ${manifest.id}`,
    );
  }

  const moduleUrl = resolveModulePath(manifest, manifest.exec.module);

  let imported: unknown;
  try {
    imported = await import(moduleUrl);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // A package specifier is resolved from this core package's own location,
    // not from the manifest or the repository, so a failure there means
    // something different from a missing file and says so.
    const hint = isPackageSpecifier(manifest.exec.module)
      ? ' A module value that does not start with "./", "../", or "/" is treated as a package ' +
        'specifier and resolved from the checkyourvibe core package, not from the manifest.'
      : '';
    throw new AnalyzerError(
      'LOAD_FAILED',
      manifest.id,
      `Failed to load analyzer module ${manifest.exec.module}: ${reason}.${hint}`,
    );
  }

  if (!isRecord(imported) || !isAnalyzeFn(imported.default)) {
    throw new AnalyzerError(
      'LOAD_FAILED',
      manifest.id,
      `Analyzer module ${manifest.exec.module} has no callable default export. An ` +
        `exec.type "node" analyzer is imported and its default export is called with the ` +
        'AnalyzeRequest; it is not spawned, and it is never sent a request on stdin.',
    );
  }

  const analyze = imported.default;
  let result: unknown;
  try {
    result = await analyze(request);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new AnalyzerError('CRASHED', manifest.id, `Analyzer ${manifest.id} crashed: ${reason}`);
  }

  return normalizeResponse(result, manifest, request);
}

function runProcessAnalyzer(
  manifest: AnalyzerManifest,
  request: AnalyzeRequest,
  repoRoot: string,
): Promise<AnalyzeResponse> {
  if (manifest.exec.type !== 'process') {
    throw new AnalyzerError(
      'CRASHED',
      manifest.id,
      `Internal error: expected process exec for analyzer ${manifest.id}`,
    );
  }

  const { command, args } = manifest.exec;

  return new Promise<AnalyzeResponse>((resolve, reject) => {
    const child = spawn(command, args ?? [], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      reject(new AnalyzerError('CRASHED', manifest.id, `Analyzer ${manifest.id} could not open stdio`));
      return;
    }

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    });

    child.on('error', (err) => {
      if (isEnoent(err)) {
        reject(
          new AnalyzerError(
            'MISSING_COMMAND',
            manifest.id,
            missingCommandMessage(manifest, command),
          ),
        );
        return;
      }

      reject(
        new AnalyzerError(
          'CRASHED',
          manifest.id,
          `Failed to spawn analyzer ${manifest.id}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });

    child.on('close', (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      let response: unknown;
      try {
        response = JSON.parse(stdout);
      } catch {
        const code = exitCode === null ? 'null' : String(exitCode);
        reject(
          new AnalyzerError(
            'CRASHED',
            manifest.id,
            `Analyzer ${manifest.id} exited with code ${code}: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }

      resolve(normalizeResponse(response, manifest, request, stderr));
    });
  });
}

function normalizeResponse(
  result: unknown,
  manifest: AnalyzerManifest,
  request: AnalyzeRequest,
  stderr = '',
): AnalyzeResponse {
  if (!isAnalyzeResponse(result)) {
    throw new AnalyzerError(
      'MALFORMED',
      manifest.id,
      `Analyzer ${manifest.id} returned a malformed response`,
    );
  }

  const diagnostics: Diagnostic[] = [...result.diagnostics];
  for (const line of stderr.split(/\r?\n/)) {
    if (line.length > 0) {
      diagnostics.push({ level: 'warn', message: line });
    }
  }

  const violations = result.violations.map((violation) => ({
    ...violation,
    severity: resolveSeverity(violation, request.rules),
  }));

  return { ...result, violations, diagnostics };
}

function resolveSeverity(violation: Violation, rules: AnalyzeRequest['rules']): Severity {
  const configured = rules[violation.ruleId]?.severity;
  if (violation.severity === 'error' || violation.severity === 'warning') {
    return violation.severity;
  }
  if (configured === 'error' || configured === 'warning') {
    return configured;
  }
  return 'error';
}
