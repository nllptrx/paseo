import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { TaskService } from "../../tasks/service.js";
import { TaskTransitionEngine } from "../../tasks/transitions.js";
import { FEED_MENTION_FANOUT_LIMIT } from "../../tasks/feed-mentions.js";
import { TasksSession } from "./tasks-session.js";

const logger = pino({ level: "silent" });

function payloadOf<T extends SessionOutboundMessage["type"]>(
  emitted: SessionOutboundMessage[],
  type: T,
): Extract<SessionOutboundMessage, { type: T }>["payload"] {
  const message = emitted.find((candidate) => candidate.type === type);
  if (!message) {
    throw new Error(`No ${type} was emitted; got ${emitted.map((m) => m.type).join(", ")}`);
  }
  return (message as Extract<SessionOutboundMessage, { type: T }>).payload;
}

describe("TasksSession workflow requests", () => {
  let directory: string;
  let service: TaskService;
  let emitted: SessionOutboundMessage[];
  let session: TasksSession;
  let notified: Array<{ agentId: string; text: string }>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-tasks-session-"));
    service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
    emitted = [];
    notified = [];
    session = new TasksSession({
      host: { emit: (msg) => emitted.push(msg) },
      taskService: service,
      transitions: new TaskTransitionEngine({
        taskService: service,
        agentManager: { subscribe: () => () => {}, getAgent: () => null },
        logger,
      }),
      notifyAgent: async (input) => {
        notified.push(input);
      },
      logger,
    });
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function seedTask() {
    const project = await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    const task = await service.createTask({ projectId: project.id, title: "Ship it" });
    return { projectId: project.id, taskId: task.id };
  }

  it("configures only the board settings the request names", async () => {
    const { projectId } = await seedTask();

    await session.handleBoardConfigureRequest({
      type: "tasks.board.configure.request",
      requestId: "r1",
      projectId,
      reviewEnabled: true,
    });

    expect(payloadOf(emitted, "tasks.board.configure.response").project?.board).toEqual({
      reviewEnabled: true,
      reviewOnReject: "in_progress",
      archiveWorkspacesOnDone: false,
    });
  });

  /** The client describes what to run; identity is the daemon's to hand out, so
   * two steps sent with the same shape still address separately. */
  it("stamps step ids on the way in", async () => {
    const { taskId } = await seedTask();
    const step = {
      name: "Implement",
      prompt: "do the thing",
      agents: [{ provider: "claude" as const }],
      completion: "all" as const,
      workspace: { mode: "worktree" as const },
      trigger: { type: "manual" as const },
    };

    await session.handleWorkflowSetRequest({
      type: "tasks.workflow.set.request",
      requestId: "r1",
      taskId,
      steps: [step, step],
    });

    const workflow = payloadOf(emitted, "tasks.workflow.set.response").workflow;
    expect(workflow?.steps).toHaveLength(2);
    const [first, second] = workflow!.steps;
    expect(first.id).not.toBe(second.id);
    expect(first.runs).toEqual([]);
  });

  it("clears a task's workflow", async () => {
    const { taskId } = await seedTask();
    await service.setWorkflow({
      taskId,
      steps: [
        {
          id: "stp_1",
          name: "Implement",
          prompt: "do the thing",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "worktree" },
          trigger: { type: "manual" },
          runs: [],
        },
      ],
    });

    await session.handleWorkflowClearRequest({
      type: "tasks.workflow.clear.request",
      requestId: "r1",
      taskId,
    });

    expect(payloadOf(emitted, "tasks.workflow.clear.response").error).toBeNull();
    expect(await service.getWorkflow(taskId)).toBeNull();
  });

  /** A host with no workflow engine has to say so. Reporting success while
   * dispatching nothing would leave a step that never runs and never explains. */
  it("reports a step request as failed when the host runs no workflows", async () => {
    const { taskId } = await seedTask();

    await session.handleStepRunRequest({
      type: "tasks.step.run.request",
      requestId: "r1",
      taskId,
      stepId: "stp_1",
    });

    expect(payloadOf(emitted, "rpc_error").error).toMatch(/does not run task workflows/);
  });
  /** A mention wakes the agent it names, and only when that agent is actually
   * working this board. */
  it("wakes a mentioned agent that works this board", async () => {
    const { projectId, taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_1", workspaceId: "ws_1" });

    await session.handleFeedPostRequest({
      type: "tasks.feed.post.request",
      requestId: "r1",
      projectId,
      taskId,
      body: "@agt_1 can you take this",
    });

    expect(payloadOf(emitted, "tasks.feed.post.response").error).toBeNull();
    expect(notified).toHaveLength(1);
    expect(notified[0].agentId).toBe("agt_1");
    expect(notified[0].text).toContain("You were mentioned on PSE-1");
    expect(notified[0].text).toContain("can you take this");
  });

  /** Typing a name that is not on this board is a sentence, not a failure: the
   * note still posts. */
  it("posts a note whose mention matches nobody", async () => {
    const { projectId } = await seedTask();

    await session.handleFeedPostRequest({
      type: "tasks.feed.post.request",
      requestId: "r1",
      projectId,
      body: "ask @someone-else about it",
    });

    expect(payloadOf(emitted, "tasks.feed.post.response").entry?.body).toBe(
      "ask @someone-else about it",
    );
    expect(notified).toEqual([]);
  });

  /** The note is refused before it posts: waking eleven agents cannot be taken
   * back, so it must not happen as a side effect of a note that stands. */
  it("refuses an everyone that would wake more agents than the limit", async () => {
    const { projectId, taskId } = await seedTask();
    for (let index = 0; index <= FEED_MENTION_FANOUT_LIMIT; index++) {
      await service.attachAgent({ taskId, agentId: `agt_${index}`, workspaceId: "ws_1" });
    }

    await session.handleFeedPostRequest({
      type: "tasks.feed.post.request",
      requestId: "r1",
      projectId,
      body: "@everyone standup",
    });

    expect(payloadOf(emitted, "rpc_error").error).toMatch(/over the limit/);
    expect(notified).toEqual([]);
    expect(await service.listBoardFeed({ projectId })).toEqual([]);
  });
});
