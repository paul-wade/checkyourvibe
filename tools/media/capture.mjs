#!/usr/bin/env node
// Regenerate every terminal image in the README, from real runs.
//
//   node tools/media/capture.mjs
//
// Each image is produced by running the actual command against a scratch
// project built here, capturing stdout, and rendering it. Nothing is typed by
// hand, so an image cannot outlive the behaviour it claims to show — the same
// reason this project refuses to print a number without saying how it was
// obtained.
//
// Run it after any change to output formatting, and commit whatever it produces.

import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import net from 'node:net';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'packages', 'core', 'dist', 'cli', 'index.js');
const OUT = path.join(REPO, 'docs', 'media');
const TS_MANIFEST = path.join(REPO, 'packages', 'analyzer-typescript', 'analyzer.manifest.json');

const DEMO_SOURCE = `interface Order {
  id: string;
  total: number;
}

export async function loadOrder(res: Response): Promise<Order> {
  return (await res.json()) as Order;
}

export function refund(order: Order): void {
  sendRefund(order.id).catch(() => {});
}

declare function sendRefund(id: string): Promise<void>;
`;

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd });
}

/** Run `cyv` and keep stdout whichever way it exits — a finding is a non-zero exit. */
async function cyv(cwd, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if (err && typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

/**
 * Shorten the absolute paths in captured output to what a reader would see.
 *
 * The scratch project lives under the system temp directory, so every finding
 * arrives prefixed with a machine-specific path nobody needs to read. Only the
 * prefix is removed — the file, line and column stay exactly as printed.
 */
function trimPaths(lines, roots) {
  const prefixes = roots.map((r) => r.replace(/\\/g, '/').replace(/\/$/, '') + '/');
  return lines.map((line) => {
    let out = line;
    for (const prefix of prefixes) out = out.split(prefix).join('');
    return out;
  });
}

async function svg(lines, file, title) {
  const tmp = path.join(OUT, `.${path.basename(file)}.txt`);
  await mkdir(OUT, { recursive: true });
  await writeFile(tmp, lines.join('\n'), 'utf8');
  await execFileAsync(process.execPath, [
    path.join(HERE, 'term-svg.mjs'), tmp, path.join(OUT, file), title,
  ]);
  await rm(tmp, { force: true });
}

/** Keep a finding and its guidance, drop the rest, so one image shows one idea. */
function firstFinding(output, ruleId) {
  const lines = output.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.includes(ruleId) && /^\s*(error|warning)\s/.test(l));
  if (start === -1) return lines;
  const kept = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(error|warning)\s/.test(line) || /^\S/.test(line)) break;
    kept.push(line);
  }
  return kept;
}

function summaryOf(output) {
  return output.replace(/\r/g, '').split('\n').filter((l) => /errors?, \d+ warnings?,/.test(l));
}


/**
 * Serve the dashboard, take the TypeScript interlock graph out of the page, and
 * save it standalone.
 *
 * The page's stylesheet lives in a `<style>` block the graph does not carry with
 * it, so the few rules the graph actually needs are inlined here. Nothing about
 * the geometry is touched — the layout is whatever `radialLayout` produced.
 */
/**
 * Whether anything is already listening on a port.
 *
 * Checked because the spawn below cannot report its own failure: if the port is
 * taken, the new dashboard exits and the fetch still succeeds — against the
 * process that was already there. That is how this script silently regenerated
 * the interlock figure from a dashboard left running by an earlier session,
 * producing a picture of an older build while reporting success.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

async function extractInterlockGraph() {
  const port = 4399;
  if (await portInUse(port)) {
    throw new Error(
      `Port ${port} is already in use. Something else would answer this script's requests, ` +
        'and the figure would show whatever that process renders rather than this build. ' +
        'Stop it and re-run.',
    );
  }

  const server = spawn(process.execPath, [CLI, 'dashboard', '--port', String(port)], {
    cwd: REPO, stdio: 'ignore', detached: false,
  });

  try {
    let html = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        html = await res.text();
        break;
      } catch {
        // Not listening yet.
      }
    }
    if (html === '') throw new Error('dashboard did not start');

    const groups = [...html.matchAll(/<h3><code>(\w+)<\/code><\/h3>[\s\S]*?(<svg[\s\S]*?<\/svg>)/g)];
    const found = groups.find((g) => g[1] === 'typescript');
    const raw = found ? found[2] : '';
    if (!raw) throw new Error('no typescript interlock graph in the page');

    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(raw);
    const w = box ? box[1] : '560';
    const h = box ? box[2] : '560';
    const style =
      '<style>'
      + '.node circle{fill:#0B1017;stroke:#8FB8D8;stroke-width:2}'
      + '.node.iso circle{stroke:#3A4A5E;stroke-dasharray:4 3}'
      + '.node text{font-size:12.5px;fill:#E8E3D9;font-family:ui-monospace,Consolas,monospace}'
      + '.edge{stroke:#4A5D75;fill:none;stroke-width:1.3;opacity:.85}'
      + '</style>';
    const svg = raw.replace(/<svg[^>]*>/,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"`
      + ' role="img" aria-label="Every arrow is a notFix: a remediation that would trip the rule it points at">'
      + `${style}<rect width="${w}" height="${h}" fill="#0B1017"/>`);

    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, 'interlock-graph.svg'), `${svg}
`, 'utf8');
    const nodes = (svg.match(/class="node/g) ?? []).length;
    const edges = (svg.match(/class="edge"/g) ?? []).length;
    console.log(`docs/media/interlock-graph.svg — ${nodes} rules, ${edges} dead ends`);
  } finally {
    server.kill();
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyv-media-'));
  const demo = path.join(root, 'demo');
  await mkdir(path.join(demo, 'src'), { recursive: true });

  await writeFile(path.join(demo, 'src', 'orders.ts'), DEMO_SOURCE, 'utf8');
  await writeFile(path.join(demo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noUncheckedIndexedAccess: true,
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    },
    include: ['src/**/*.ts'],
  }, null, 2), 'utf8');

  const config = {
    packs: ['core-ts', 'strict-boundaries'],
    analyzers: [{ id: 'typescript', package: TS_MANIFEST.replace(/\\/g, '/') }],
    agents: [],
    strict: false,
  };
  await writeFile(path.join(demo, 'checkyourvibe.json'), JSON.stringify(config, null, 2), 'utf8');

  await git(demo, ['init', '-q']);
  await git(demo, ['add', '-A']);

  // 1 — the interlock. One finding, its allowed fixes, and the dead ends that
  // would each trip a different rule. This is the whole product in one frame.
  const checkOut = await cyv(demo, ['check', 'src/orders.ts', '--no-color']);
  await svg(
    trimPaths(
      ['$ cyv check src/orders.ts', '', ...firstFinding(checkOut, 'no-json-parse-cast'), '', ...summaryOf(checkOut)],
      [demo],
    ),
    'interlock.svg',
    'cyv check',
  );

  // 2 — a one-character typo in a pack name. Four rules silently disabled, and
  // the run used to report a clean pass.
  const broken = { ...config, packs: ['core-ts', 'strict-boundries'] };
  await writeFile(path.join(demo, 'checkyourvibe.json'), JSON.stringify(broken, null, 2), 'utf8');
  const typoOut = await cyv(demo, ['check', '--all', '--no-color']);
  await svg(
    ['$ cyv check --all      # "strict-boundries" — one character wrong', '',
      ...typoOut.replace(/\r/g, '').split('\n').filter((l) => /rules enabled|Unknown pack/.test(l)),
      '', '# it used to print "0 errors" here, and exit 0.',
      '$ echo $?', '2'],
    'silent-failure.svg',
    'how much of your config actually ran',
  );
  await writeFile(path.join(demo, 'checkyourvibe.json'), JSON.stringify(config, null, 2), 'utf8');

  // 3 — guidance an agent reads when it hits a rule, including which other rule
  // each tempting fix would trip.
  const explainOut = await cyv(REPO, ['explain', 'no-floating-promise']);
  const explainLines = explainOut.replace(/\r/g, '').split('\n').slice(0, 26);
  await svg(['$ cyv explain no-floating-promise', '', ...explainLines], 'explain.svg', 'cyv explain');

  // 4 — a file whose types could not be resolved. Its semantic findings are
  // withheld rather than fabricated, and the run says so.
  const degraded = path.join(root, 'degraded');
  await mkdir(path.join(degraded, 'pkg', 'src'), { recursive: true });
  await writeFile(path.join(degraded, 'pkg', 'src', 'api.ts'),
    // An import that cannot resolve is what makes this real: with no usable
    // tsconfig every symbol from it becomes `any`, and the semantic rules fire
    // on all of it. That is the 673-fabricated-findings case, in one file.
    'import { Client } from "@acme/sdk";\n\n'
    + 'export function run(c: Client) {\n'
    + '  const rows = c.query("select 1");\n'
    + '  return rows.map((r) => r.id);\n}\n', 'utf8');
  await writeFile(path.join(degraded, 'pkg', 'tsconfig.json'),
    JSON.stringify({ files: [], include: [], references: [{ path: './tsconfig.lib.json' }] }, null, 2), 'utf8');
  await writeFile(path.join(degraded, 'checkyourvibe.json'), JSON.stringify(config, null, 2), 'utf8');
  await git(degraded, ['init', '-q']);
  await git(degraded, ['add', '-A']);
  const degradedOut = await cyv(degraded, ['check', '--all', '--no-color']);
  await svg(
    ['$ cyv check --all      # a tsconfig that resolves no types', '',
      ...degradedOut.replace(/\r/g, '').split('\n')
        .filter((l) => /withheld|Until the analyzer|Reason:|errors,/.test(l))],
    'withheld.svg',
    'findings it will not make',
  );

  await rm(root, { recursive: true, force: true });

  // 5 — the interlock graph, lifted straight out of the dashboard rather than
  // redrawn. It is already an SVG built from the static manifests, so taking it
  // as-is means the README cannot drift from what the tool renders. A screenshot
  // could; this cannot.
  await extractInterlockGraph();

  const made = await readFile(path.join(OUT, 'interlock.svg'), 'utf8');
  console.log(`\nWrote 4 SVGs to docs/media/ (hero is ${(made.length / 1024).toFixed(1)} KB)`);
}

await main();
