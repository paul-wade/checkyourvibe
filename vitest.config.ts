import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    // A `pnpm install` run inside the checkout left a 5.5 GB store at the root,
    // and this glob matched the copies of every package inside it — so the whole
    // suite ran twice, from two paths, and a failure appeared as two failures.
    exclude: ['**/node_modules/**', '**/dist/**', '.pnpm-store/**'],
    environment: 'node',
    /**
     * Well above vitest's 5s default, deliberately.
     *
     * A large part of this suite is not unit tests: the CLI, doctor and
     * end-to-end tests initialise real repositories, spawn real subprocesses,
     * and run real analyzers — one of them boots a .NET compilation. Several
     * already sit near 4s when the machine is idle, so under the parallel load
     * of a full run they cross 5s and fail on nothing but scheduling.
     *
     * The timeout is set for the loaded case rather than the idle one, so a
     * failure means the test failed and not that it was descheduled.
     *
     * This does not hide a hang. A test that genuinely never finishes still
     * fails; it just takes 30s to say so instead of 5.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
