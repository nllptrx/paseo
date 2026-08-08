import { execFile, type ExecFileException } from "node:child_process";
import type { StepVerification } from "@getpaseo/protocol/tasks/workflow";
import { runGitCommand } from "../../utils/run-git-command.js";

/** Enough of the tail to say what failed without pasting a build log into a run. */
const MAX_CAPTURED_OUTPUT_BYTES = 8_000;
/**
 * How much the command may write before the host kills it. Far above what a run
 * reports, because these are different limits: a test suite that prints a
 * megabyte and exits zero has passed, and reading only its last 8KB must not
 * turn that into a failure.
 */
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1_000;

export interface StepEvidenceResult {
  ok: boolean;
  /** Why it failed, ready to put on the run. Null when it passed. */
  error: string | null;
}

export interface CheckStepEvidenceInput {
  cwd: string;
  requireChanges: boolean;
  verify: StepVerification | null;
  /** HEAD when the run began. Commits made since count as changes; without it
   * only an uncommitted edit can be seen. */
  startCommit?: string | null;
  signal?: AbortSignal;
}

/**
 * What a step run has to show before it counts as succeeded.
 *
 * An agent reaching the end of its turn proves that it stopped, not that it
 * did anything: a step whose agent wrote nothing, or wrote something broken,
 * settles exactly like one that worked. These are the two things a host can
 * check for itself — that the checkout actually changed, and that a command
 * the author named still passes.
 */
export async function checkStepEvidence(
  input: CheckStepEvidenceInput,
): Promise<StepEvidenceResult> {
  if (input.requireChanges) {
    const changed = await workspaceHasChanges(input.cwd, input.startCommit ?? null);
    if (!changed) {
      return {
        ok: false,
        error: "The step finished without changing anything in its workspace",
      };
    }
  }

  if (!input.verify) {
    return { ok: true, error: null };
  }
  return runVerifyCommand({
    cwd: input.cwd,
    verify: input.verify,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * Uncommitted edits, or commits made since the run began. Both count: an agent
 * that committed its work changed the checkout as surely as one that left the
 * tree dirty, and requiring one shape would punish the tidier habit.
 *
 * The comparison is against the run's own starting commit rather than an
 * upstream, because a fresh worktree has no upstream until it is pushed and
 * would otherwise read as having done nothing.
 */
async function workspaceHasChanges(cwd: string, startCommit: string | null): Promise<boolean> {
  const status = await runGitCommand(["status", "--porcelain"], { cwd });
  if (status.stdout.trim().length > 0) {
    return true;
  }
  if (!startCommit) {
    return false;
  }
  const head = await readHeadCommit(cwd);
  return head !== null && head !== startCommit;
}

/**
 * Best-effort: null when the checkout has no commit yet, is not a repository,
 * or cannot be read at all. This is a note taken so a later check can be more
 * precise — failing to take it must never stop the work from starting.
 */
export async function readHeadCommit(cwd: string): Promise<string | null> {
  try {
    const head = await runGitCommand(["rev-parse", "HEAD"], { cwd, acceptExitCodes: [0, 128] });
    if (head.exitCode !== 0) {
      return null;
    }
    const sha = head.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function runVerifyCommand(input: {
  cwd: string;
  verify: StepVerification;
  signal?: AbortSignal;
}): Promise<StepEvidenceResult> {
  const [command, ...args] = input.verify.command;
  const timeout = input.verify.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: input.cwd,
        timeout,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        // No shell: the command is an argv the author wrote, not a string this
        // host interpolates into one.
        shell: false,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, error: null });
          return;
        }
        const output = `${stdout}${stderr}`.trim().slice(-MAX_CAPTURED_OUTPUT_BYTES);
        const reason = describeFailure(error, timeout);
        resolve({
          ok: false,
          error: `Verification \`${input.verify.command.join(" ")}\` ${reason}${
            output.length > 0 ? `:\n${output}` : ""
          }`,
        });
      },
    );
  });
}

function describeFailure(error: ExecFileException, timeout: number): string {
  if (isOutputOverflow(error)) {
    return `wrote more than ${MAX_COMMAND_OUTPUT_BYTES} bytes and was stopped`;
  }
  if (isTimeout(error)) {
    return `did not finish within ${timeout}ms`;
  }
  return `exited with ${describeExit(error)}`;
}

function isOutputOverflow(error: ExecFileException): boolean {
  return error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/** A kill this host ordered, rather than a command that chose to exit. The
 * overflow kill looks identical apart from its code, so it is excluded. */
function isTimeout(error: ExecFileException): boolean {
  return !isOutputOverflow(error) && (error.killed === true || error.code === "ETIMEDOUT");
}

function describeExit(error: ExecFileException): string {
  return typeof error.code === "number" ? `code ${error.code}` : (error.code ?? "an error");
}
