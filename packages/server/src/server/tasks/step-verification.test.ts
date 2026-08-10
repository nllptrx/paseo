import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../../utils/run-git-command.js";
import { checkStepEvidence, readHeadCommit } from "./step-verification.js";

describe("checkStepEvidence", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "paseo-step-evidence-"));
    await runGitCommand(["init"], { cwd });
    await runGitCommand(["config", "user.email", "test@example.com"], { cwd });
    await runGitCommand(["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, "seed.txt"), "seed\n");
    await runGitCommand(["add", "."], { cwd });
    await runGitCommand(["commit", "-m", "seed"], { cwd });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** An agent reaching the end of its turn proves it stopped, not that it did
   * anything — which is the whole point of asking for evidence. */
  it("fails a step that changed nothing when changes are required", async () => {
    const result = await checkStepEvidence({ cwd, requireChanges: true, verify: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without changing anything/);
  });

  it("passes when the working tree carries edits", async () => {
    writeFileSync(join(cwd, "seed.txt"), "changed\n");
    const result = await checkStepEvidence({ cwd, requireChanges: true, verify: null });
    expect(result).toEqual({ ok: true, error: null });
  });

  /** A project does not have to be a repository; the changed-anything gate has
   * no diff to read there and must not fail the run for it. */
  it("passes the changes gate in a workspace Git does not back", async () => {
    const bare = mkdtempSync(join(tmpdir(), "paseo-step-evidence-nogit-"));
    try {
      const result = await checkStepEvidence({ cwd: bare, requireChanges: true, verify: null });
      expect(result).toEqual({ ok: true, error: null });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  /** Committing is the tidier habit; requiring a dirty tree would punish it. */
  it("counts committed work as a change", async () => {
    const before = await readHeadCommit(cwd);
    writeFileSync(join(cwd, "seed.txt"), "changed\n");
    await runGitCommand(["commit", "-am", "work"], { cwd });
    const result = await checkStepEvidence({
      cwd,
      requireChanges: true,
      verify: null,
      startCommit: before,
    });
    expect(result.ok).toBe(true);
  });

  /** A run that began where it ended, with a clean tree, did nothing. */
  it("fails when the checkout is where the run found it", async () => {
    const before = await readHeadCommit(cwd);
    const result = await checkStepEvidence({
      cwd,
      requireChanges: true,
      verify: null,
      startCommit: before,
    });
    expect(result.ok).toBe(false);
  });

  it("passes a verification command that exits zero", async () => {
    const result = await checkStepEvidence({
      cwd,
      requireChanges: false,
      verify: { command: ["node", "-e", "process.exit(0)"] },
    });
    expect(result).toEqual({ ok: true, error: null });
  });

  /** The failure has to name the command and carry enough output to act on. */
  it("fails a verification command and reports its output", async () => {
    const result = await checkStepEvidence({
      cwd,
      requireChanges: false,
      verify: { command: ["node", "-e", "console.error('two tests failed'); process.exit(1)"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("two tests failed");
    expect(result.error).toContain("node");
  });

  it("fails a verification command that outlives its timeout", async () => {
    const result = await checkStepEvidence({
      cwd,
      requireChanges: false,
      verify: { command: ["node", "-e", "setTimeout(() => {}, 10_000)"], timeoutMs: 200 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not finish within 200ms/);
  });

  /** The command is an argv, so shell metacharacters are arguments, not syntax. */
  it("does not interpret the command through a shell", async () => {
    const result = await checkStepEvidence({
      cwd,
      requireChanges: false,
      verify: {
        command: [
          "node",
          "-e",
          "process.exit(process.argv[1] === '; rm -rf .' ? 0 : 1)",
          "; rm -rf .",
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("reports a command that writes more than the host will buffer", async () => {
    const result = await checkStepEvidence({
      cwd,
      requireChanges: false,
      verify: { command: ["node", "-e", "console.log('x'.repeat(64 * 1024)); process.exit(0)"] },
    });
    expect(result.ok).toBe(true);
  });
});
