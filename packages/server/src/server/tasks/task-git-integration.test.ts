import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../../utils/run-git-command.js";
import { defaultTaskGitIntegration } from "./workflow-engine.js";

describe("task Git integration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("commits worker changes into the task branch and delivers that branch to its parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-task-git-"));
    roots.push(root);
    await runGitCommand(["init", "-b", "main"], { cwd: root });
    await runGitCommand(["config", "user.name", "Paseo Test"], { cwd: root });
    await runGitCommand(["config", "user.email", "paseo-test@localhost"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n");
    await runGitCommand(["add", "README.md"], { cwd: root });
    await runGitCommand(["commit", "-m", "base"], { cwd: root });

    await defaultTaskGitIntegration.createBranch(root, "paseo/tasks/pse-1", "main");
    await defaultTaskGitIntegration.createBranch(root, "paseo/tasks/pse-2", "paseo/tasks/pse-1");
    const worker = join(root, "worker");
    await runGitCommand(
      ["worktree", "add", "-b", "paseo/workers/pse-2", worker, "paseo/tasks/pse-2"],
      { cwd: root },
    );
    await writeFile(join(worker, "child.txt"), "delivered\n");

    await defaultTaskGitIntegration.integrateWorkspace(
      worker,
      "paseo/tasks/pse-2",
      "Integrate task PSE-2",
    );
    await defaultTaskGitIntegration.integrateBranch(
      root,
      "paseo/tasks/pse-2",
      "paseo/tasks/pse-1",
      "Integrate subtask PSE-2",
    );

    const delivered = await runGitCommand(["show", "paseo/tasks/pse-1:child.txt"], { cwd: root });
    expect(delivered.stdout).toBe("delivered\n");
    expect(await readFile(join(worker, "child.txt"), "utf8")).toBe("delivered\n");
    expect((await runGitCommand(["status", "--porcelain"], { cwd: worker })).stdout).toBe("");
  });
});
