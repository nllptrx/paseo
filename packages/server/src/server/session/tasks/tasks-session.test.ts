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
      reviewerPresetId: null,
      maxReviewIterations: 3,
    });
  });

  it("creates a subtask with its execution spec and its place in the chain", async () => {
    const { projectId, taskId } = await seedTask();
    await session.handleCreateRequest({
      type: "tasks.create.request",
      requestId: "r1",
      projectId,
      title: "Phase one",
      parentTaskId: taskId,
      executionSpec: { presetId: "tpst_1", trigger: "on_unblocked" },
    });

    await session.handleCreateRequest({
      type: "tasks.create.request",
      requestId: "r2",
      projectId,
      title: "Phase two",
      parentTaskId: taskId,
      parallel: true,
    });

    const first = payloadOf(emitted, "tasks.create.response").task;
    expect(first?.executionSpec).toEqual({ presetId: "tpst_1", trigger: "on_unblocked" });
    const second = (await service.snapshot()).tasks.find((task) => task.title === "Phase two");
    expect(await service.listUnmetDependencies(second?.id ?? "")).toEqual([]);
  });

  /** A task with subtasks holds no workers of its own; the RPC surface has to
   * refuse the same way the service does, naming the rule rather than leaving
   * the caller to guess why nothing happened. */
  it("refuses to attach a worker to an aggregate over RPC, naming the rule", async () => {
    const { projectId, taskId } = await seedTask();
    await session.handleCreateRequest({
      type: "tasks.create.request",
      requestId: "r1",
      projectId,
      title: "Phase one",
      parentTaskId: taskId,
    });

    await session.handleAgentAttachRequest({
      type: "tasks.agent.attach.request",
      requestId: "r2",
      taskId,
      agentId: "agt_1",
      workspaceId: "ws_1",
    });

    expect(payloadOf(emitted, "rpc_error").error).toMatch(
      /has 1 subtask, so workers attach to its subtasks instead/,
    );
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

  it("preserves an edited step's identity and run history", async () => {
    const { taskId } = await seedTask();
    await service.setWorkflow({
      taskId,
      steps: [
        {
          id: "stp_existing",
          name: "Implement",
          prompt: "do the thing",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "worktree" },
          trigger: { type: "manual" },
          runs: [
            {
              id: "run_1",
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: "2026-01-01T00:01:00.000Z",
              status: "succeeded",
              agentIds: ["agt_1"],
              workspaceIds: ["wsp_1"],
              scheduleId: null,
              error: null,
            },
          ],
        },
      ],
    });

    await session.handleWorkflowSetRequest({
      type: "tasks.workflow.set.request",
      requestId: "r1",
      taskId,
      steps: [
        {
          existingStepId: "stp_existing",
          name: "Implement and verify",
          prompt: "do the thing and verify it",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "worktree" },
          trigger: { type: "immediate" },
        },
      ],
    });

    const [step] = payloadOf(emitted, "tasks.workflow.set.response").workflow?.steps ?? [];
    expect(step.id).toBe("stp_existing");
    expect(step.name).toBe("Implement and verify");
    expect(step.trigger).toEqual({ type: "immediate" });
    expect(step.runs).toEqual([expect.objectContaining({ id: "run_1", status: "succeeded" })]);
    expect(step).not.toHaveProperty("existingStepId");
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

  it("persists a message recipient and its delivery result", async () => {
    const { projectId, taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_1", workspaceId: "ws_1" });

    await session.handleFeedSendMessageRequest({
      type: "tasks.feed.send_message.request",
      requestId: "r1",
      projectId,
      taskId,
      body: "Please continue",
      recipientAgentIds: ["agt_1"],
    });

    const entry = payloadOf(emitted, "tasks.feed.send_message.response").entry;
    expect(entry?.entryKind).toBe("message");
    expect(entry?.recipients).toEqual([
      { agentId: "agt_1", workspaceId: "ws_1", deliveryStatus: "delivered" },
    ]);
    expect(notified).toHaveLength(1);
  });

  it("rejects a message recipient that is not attached to the task", async () => {
    const { projectId, taskId } = await seedTask();

    await session.handleFeedSendMessageRequest({
      type: "tasks.feed.send_message.request",
      requestId: "r1",
      projectId,
      taskId,
      body: "Please continue",
      recipientAgentIds: ["agt_missing"],
    });

    expect(payloadOf(emitted, "rpc_error").error).toMatch(/not attached to this task/);
    expect(notified).toEqual([]);
    expect(
      (await service.listBoardFeed({ projectId })).filter(
        (entry) => entry.taskId === taskId && entry.entryKind === "message",
      ),
    ).toHaveLength(0);
  });

  it("persists failed delivery when an agent prompt cannot be sent", async () => {
    const { projectId, taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_1", workspaceId: "ws_1" });
    const failingSession = new TasksSession({
      host: { emit: (msg) => emitted.push(msg) },
      taskService: service,
      transitions: new TaskTransitionEngine({
        taskService: service,
        agentManager: { subscribe: () => () => {}, getAgent: () => null },
        logger,
      }),
      notifyAgent: async () => {
        throw new Error("agent unavailable");
      },
      logger,
    });

    await failingSession.handleFeedSendMessageRequest({
      type: "tasks.feed.send_message.request",
      requestId: "r1",
      projectId,
      taskId,
      body: "Please continue",
      recipientAgentIds: ["agt_1"],
    });

    expect(payloadOf(emitted, "tasks.feed.send_message.response").entry?.recipients).toEqual([
      { agentId: "agt_1", workspaceId: "ws_1", deliveryStatus: "failed" },
    ]);
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
    const feed = await service.listBoardFeed({ projectId });
    expect(feed.filter((entry) => entry.kind === "user")).toEqual([]);
  });
});
