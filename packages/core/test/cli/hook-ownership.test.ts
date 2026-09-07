import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runHook } from "../../src/cli/hook.js";
import type { CommandContext } from "../../src/cli/types.js";

/**
 * Spec 0063: a dispatch's declaration is checked before the write lands, not
 * compared against it afterwards.
 *
 * These tests drive the hook with `CYV_DISPATCH_DECLARATION` set the way the
 * executor sets it, because that variable is the whole interface between a
 * running dispatch and the gate inside it.
 */
const DECLARATION = "CYV_DISPATCH_DECLARATION";

const ANALYZER_MODULE = `
export default async function analyze() {
  return { protocol: 1, violations: [], skipped: [], diagnostics: [] };
}
`;

const MANIFEST = {
  protocol: 1,
  id: "stub",
  match: ["**/*.ts"],
  rules: [
    {
      id: "no-violation-marker",
      category: "test",
      scope: "file",
      severity: "error",
      summary: "Flags an explicit VIOLATION marker left in source.",
      why: "Keeps this fixture deterministically wrong so tests can assert on it.",
      allowedFixes: ["Remove the VIOLATION marker from the file."],
      notFixes: [],
      examples: { bad: "const x = 1; // VIOLATION", good: "const x = 1;" },
    },
  ],
  exec: { type: "node", module: "./analyzer.mjs" },
};

const CONFIG = {
  packs: [],
  analyzers: [{ id: "stub", package: "./analyzer.manifest.json" }],
  rules: { "no-violation-marker": {} },
  strict: false,
  exclude: [],
};

/**
 * A repository the hook will actually inspect. It resolves a config and an
 * analyzer before reaching any decision, so a bare directory yields no verdict
 * at all and every assertion below would read an empty string.
 */
async function makeRepo(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "cyv-own-")));
  const repo = join(parent, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });

  const schemaUrl = new URL(
    "../../../../docs/protocol/config.schema.json",
    import.meta.url,
  );
  await mkdir(join(repo, "docs", "protocol"), { recursive: true });
  await writeFile(
    join(repo, "docs", "protocol", "config.schema.json"),
    await readFile(schemaUrl, "utf-8"),
  );
  await writeFile(
    join(repo, "checkyourvibe.json"),
    JSON.stringify(CONFIG, null, 2),
  );
  await writeFile(
    join(repo, "analyzer.manifest.json"),
    JSON.stringify(MANIFEST, null, 2),
  );
  await writeFile(join(repo, "analyzer.mjs"), ANALYZER_MODULE);

  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tools"), { recursive: true });
  await writeFile(join(repo, "src", "owned.ts"), "export const value = 1;\n");
  await writeFile(join(repo, "tools", "other.ts"), "export const other = 1;\n");
  return repo;
}

function context(
  repo: string,
  declaration?: readonly string[],
): CommandContext {
  const env = { ...process.env };
  if (declaration === undefined) {
    delete env[DECLARATION];
  } else {
    env[DECLARATION] = JSON.stringify(declaration);
  }
  return { cwd: repo, argv: ["claude-code"], env };
}

function prePayload(toolName: string, toolInput: unknown): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: "test-session",
  });
}

function captureOut(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  return {
    lines,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

const repos: string[] = [];

afterEach(async () => {
  for (const repo of repos.splice(0)) {
    await rm(repo, { recursive: true, force: true });
  }
});

async function track(): Promise<string> {
  const repo = await makeRepo();
  repos.push(repo);
  return repo;
}

describe("ownership as a gate", () => {
  it("allows a write to a declared path", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      const code = await runHook(
        context(repo, ["src"]),
        prePayload("Write", {
          file_path: join(repo, "src", "owned.ts"),
          content: "export const value = 2;\n",
        }),
      );
      expect(code).toBe(0);
      expect(captured.lines.join("")).not.toContain(
        '"permissionDecision":"deny"',
      );
    } finally {
      captured.restore();
    }
  });

  it("denies a write outside the declaration and quotes what may be written", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      const code = await runHook(
        context(repo, ["src"]),
        prePayload("Write", {
          file_path: join(repo, "tools", "other.ts"),
          content: "export const other = 2;\n",
        }),
      );
      expect(code).toBe(0);
      const out = captured.lines.join("");
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain("out-of-scope write");
      // The declaration itself, so the agent can see what it may write (2.1),
      // and somewhere to put a scratch file that is not the repository (4.1).
      expect(out).toContain("src");
      expect(out).toContain("temp directory");
    } finally {
      captured.restore();
    }
  });

  it("names the nearest declared path so a mistyped target is visible", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      await runHook(
        context(repo, ["packages/core/src/dashboard"]),
        prePayload("Write", {
          file_path: join(
            repo,
            "packages",
            "core",
            "src",
            "dashbaord",
            "typo.ts",
          ),
          content: "export const typo = 1;\n",
        }),
      );
      expect(captured.lines.join("")).toContain("nearest declared path");
    } finally {
      captured.restore();
    }
  });

  it("leaves a session running no dispatch unconstrained", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      const code = await runHook(
        context(repo),
        prePayload("Write", {
          file_path: join(repo, "tools", "other.ts"),
          content: "export const other = 2;\n",
        }),
      );
      expect(code).toBe(0);
      // A person editing their own repository is not a dispatch (1.2).
      expect(captured.lines.join("")).not.toContain(
        '"permissionDecision":"deny"',
      );
    } finally {
      captured.restore();
    }
  });

  it("says a declaration of the repository root constrains nothing", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      await runHook(
        context(repo, ["."]),
        prePayload("Write", {
          file_path: join(repo, "tools", "other.ts"),
          content: "export const other = 2;\n",
        }),
      );
      expect(captured.lines.join("")).not.toContain(
        '"permissionDecision":"deny"',
      );
      // Said plainly rather than silently allowed (2.3). An allow carries no
      // reason to the agent by protocol, so the decision log is where it is
      // said.
      const log = await readFile(
        join(repo, ".cyv-review", "decisions.jsonl"),
        "utf-8",
      );
      expect(log).toContain("ownership unconstrained");
    } finally {
      captured.restore();
    }
  });

  it("constrains a shell command that writes outside the declaration", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      // A `.txt` target, deliberately: the analyzer matches `**/*.ts`, and a
      // shell write to a file it claims is already denied by the older rule
      // that sends such writes through the edit tools. Only ownership can
      // refuse this one, so only this proves ownership refused it.
      await runHook(
        context(repo, ["src"]),
        prePayload("Bash", { command: "echo hi > tools/notes.txt" }),
      );
      const out = captured.lines.join("");
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain("out-of-scope write");
    } finally {
      captured.restore();
    }
  });

  it("never constrains a read", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      const code = await runHook(
        context(repo, ["src"]),
        prePayload("Read", { file_path: join(repo, "tools", "other.ts") }),
      );
      expect(code).toBe(0);
      // An agent must be free to read anything to do its work (3.1).
      expect(captured.lines.join("")).not.toContain(
        '"permissionDecision":"deny"',
      );
    } finally {
      captured.restore();
    }
  });

  it("records the refusal in the decision log", async () => {
    const repo = await track();
    const captured = captureOut();
    try {
      await runHook(
        context(repo, ["src"]),
        prePayload("Write", {
          file_path: join(repo, "tools", "other.ts"),
          content: "export const other = 2;\n",
        }),
      );
      const log = await readFile(
        join(repo, ".cyv-review", "decisions.jsonl"),
        "utf-8",
      );
      expect(log).toContain('"decision":"deny"');
      expect(log).toContain("tools/other.ts");
    } finally {
      captured.restore();
    }
  });
});
