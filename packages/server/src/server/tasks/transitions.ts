import {
  resolveTaskExecutionPolicy,
  type ResolvedTaskExecutionPolicy,
  type TaskBoardConfig,
  type Task,
  type TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import type pino from "pino";
import { observeAgentCompletion } from "../agent/agent-completion.js";
import { REVIEW_APPROVED_NOTE, REVIEW_REJECTED_NOTE } from "./review-verdict-notes.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { TaskService } from "./service.js";

export interface TaskTransitionEngineDeps {
  taskService: Pick<
    TaskService,
    | "getTask"
    | "getProject"
    | "snapshot"
    | "updateTask"
    | "finalizeTaskDone"
    | "listAgentLinks"
    | "listTaskAgents"
    | "listSubtasks"
    | "countSubtasks"
    | "listDependents"
    | "listUnmetDependencies"
    | "isAvailable"
    | "createComment"
  >;
  agentManager: Pick<AgentManager, "subscribe" | "getAgent">;

  logger: pino.Logger;
  /** How long a reviewer may run before the board stops waiting on it. */
  reviewTimeoutMs?: number;
  /** How many reviewers the board will put on one card before handing it to a
   * human. */
  maxReviewAttempts?: number;
}

const DEFAULT_ON_REJECT: TaskBoardConfig["reviewOnReject"] = "in_progress";

/**
 * A reviewer that neither answers nor stops holds the card in review forever.
 * Nothing it does is an error, so no observer fires, and nobody watches a board
 * continuously — so the board stops waiting on its own.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60_000;

/**
 * Two attempts. A reviewer that ended without a verdict twice will not produce
 * one on the third try, and a card that keeps respawning agents spends tokens
 * nobody asked for.
 */
export const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

/**
 * The two transitions a run can write. Work attached to a task settling green moves it to `in_review`
 * when the board reviews, else `done`; a review verdict moves it on. Failure
 * moves nothing: the task stays where it was, with the failure on the card.
 *
 * Everything here writes through `TaskService.updateTask`, the same stored
 * field a hand writes, so automation and a drag can never disagree about where
 * status lives.
 */
export class TaskTransitionEngine {
  private readonly deps: TaskTransitionEngineDeps;
  private readonly unsubscribesByLink = new Map<string, () => void>();
  private readonly reviewUnsubscribesByLink = new Map<string, () => void>();
  private readonly reviewTimeoutsByLink = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reviewAttemptsByTask = new Map<string, number>();
  private readonly verdictsInFlight = new Set<string>();
  private readonly completionsInFlight = new Map<string, Promise<Task>>();
  private readonly reviewTimeoutMs: number;
  private readonly maxReviewAttempts: number;
  /** Puts a fresh agent on a card that reached review. Unset on hosts that do
   * not run agents; review then waits for a human, the same answer a board
   * without a reviewer preset gives. */
  private requestReview: ((taskId: string) => Promise<{ agentId: string } | null>) | null = null;
  /** Final cleanup belongs to the final task transition, not to implementation
   * settlement: a reviewed task still needs its checkout until approval. */
  private onTaskDone: ((taskId: string) => Promise<void>) | null = null;
  private requestCorrection:
    | ((input: {
        taskId: string;
        feedback: string | null;
      }) => Promise<{ agentIds: string[] } | null>)
    | null = null;
  /** Lets go of a reviewer that has stopped: its checkout is a worktree the
   * daemon made for one judgement, and the findings live in the feed. */
  private releaseReviewer:
    | ((input: { taskId: string; agentId: string; cancelAgent: boolean }) => Promise<void>)
    | null = null;
  private integrateTaskWork: ((taskId: string) => Promise<void>) | null = null;
  private integrateTaskIntoParent: ((taskId: string) => Promise<void>) | null = null;
  private requestIntegrationFix:
    | ((input: { taskId: string; error: string }) => Promise<void>)
    | null = null;
  /** Starts a task from its own execution spec. Unset on hosts that do not run
   * agents; a chain then waits for a hand, which is what it did before. */
  private requestDelegation:
    | ((input: { taskId: string; presetId: string }) => Promise<{ agentId: string } | null>)
    | null = null;
  private readonly autoStartsInFlight = new Set<string>();

  constructor(deps: TaskTransitionEngineDeps) {
    this.deps = deps;
    this.reviewTimeoutMs = deps.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    this.maxReviewAttempts = deps.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
  }

  /** Re-arm completion observers for every stored attachment, and pick up the
   * chains a restart interrupted. A daemon restart must not turn an attached
   * agent's finish into a transition nobody saw, nor leave a task that became
   * ready while the daemon was down waiting on a trigger that already fired. */
  async start(): Promise<void> {
    if (!(await this.deps.taskService.isAvailable())) {
      return;
    }
    try {
      const links = await this.deps.taskService.listAgentLinks();
      for (const link of links) {
        if ((link.role ?? "worker") === "reviewer") {
          this.observeReviewer({ taskId: link.taskId, agentId: link.agentId });
        } else if ((link.completionOwner ?? "attachment") === "attachment") {
          this.observeAttachment({ taskId: link.taskId, agentId: link.agentId });
        }
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not re-arm task attachment observers");
    }
    try {
      await this.startTasksReadyAfterRestart();
    } catch (error) {
      this.deps.logger.warn(
        { err: error },
        "Could not start the tasks whose blockers settled while the daemon was down",
      );
    }
  }

  private linkKey(input: { taskId: string; agentId: string }): string {
    return `${input.taskId}\u0000${input.agentId}`;
  }

  /**
   * Watch an attached agent for completion. The observer is replaced after each
   * finish rather than removed: an attached agent runs many turns over a task's
   * life, and each green settle is a fresh answer to "is the work done".
   */
  observeAttachment(input: { taskId: string; agentId: string }): void {
    const key = this.linkKey(input);
    if (this.unsubscribesByLink.has(key)) {
      return;
    }
    let observer = observeAgentCompletion();
    const handleOutcome = (outcome: "finished" | "errored" | "closed"): void => {
      if (outcome === "finished") {
        observer = observeAgentCompletion();
        void this.onWorkSettled(input.taskId, input.agentId).catch((error) => {
          this.deps.logger.error(
            { err: error, taskId: input.taskId, agentId: input.agentId },
            "Failed to move a task after its attached agent finished",
          );
        });
        return;
      }
      if (outcome === "errored") {
        this.reportStall(input, "stopped on an error");
        return;
      }
      if (outcome === "closed") {
        this.reportStall(input, "closed before finishing");
        this.unobserveAttachment(input);
      }
    };
    const unsubscribe = this.deps.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") {
          return;
        }
        const outcome = observer.observeLifecycle(event.agent.lifecycle);
        if (outcome) {
          handleOutcome(outcome);
        }
      },
      { agentId: input.agentId, replayState: false },
    );
    this.unsubscribesByLink.set(key, unsubscribe);

    // Read where the agent already is, when it is loaded. An agent still
    // running when the daemon restarted would otherwise reach `idle` without
    // this observer having seen it run, and the settle that moves the card
    // would never fire. A cold `idle` is not treated as finished, so an
    // attached agent waiting between turns stays put.
    //
    // An agent the manager does not hold is not gone — agents load on demand —
    // so absence proves nothing and the observer simply waits.
    const snapshot = this.deps.agentManager.getAgent(input.agentId);
    if (snapshot) {
      const initial = observer.observeLifecycle(snapshot.lifecycle);
      if (initial) {
        handleOutcome(initial);
      }
    }
  }

  unobserveAttachment(input: { taskId: string; agentId: string }): void {
    const key = this.linkKey(input);
    this.unsubscribesByLink.get(key)?.();
    this.unsubscribesByLink.delete(key);
  }

  /**
   * An attached agent stopped without finishing. Nobody watches a board
   * continuously, so the thing that would otherwise go unnoticed for an hour is
   * said once, in the feed, where the rest of the board's history is. The task
   * does not move: a failure leaves the card where it was.
   */
  private reportStall(input: { taskId: string; agentId: string }, note: string): void {
    void (async () => {
      const task = await this.deps.taskService.getTask(input.taskId);
      if (!task) {
        return;
      }
      const project = await this.deps.taskService.getProject(task.projectId);
      if (!project) {
        return;
      }
      await this.deps.taskService.createComment({
        taskId: task.id,
        kind: "system",
        authorName: "board",
        agentId: input.agentId,
        body: `${project.prefix}-${task.number} "${task.title}": its agent ${note}.`,
      });
    })().catch((error) => {
      this.deps.logger.warn(
        { err: error, taskId: input.taskId, agentId: input.agentId },
        "Could not record a stalled agent in the feed",
      );
    });
  }

  /**
   * Attached work settled green. Failure never reaches here on purpose — a
   * failed run leaves the task where it was.
   */
  async onWorkSettled(taskId: string, sourceAgentId?: string): Promise<void> {
    const task = await this.deps.taskService.getTask(taskId);
    if (!task || task.status !== "in_progress") {
      return;
    }
    if (sourceAgentId) {
      const workers = (await this.deps.taskService.listTaskAgents(taskId)).filter(
        (link) => (link.role ?? "worker") === "worker" && link.agentId !== sourceAgentId,
      );
      const siblingStillRunning = workers.some((link) => {
        const lifecycle = this.deps.agentManager.getAgent(link.agentId)?.lifecycle;
        return lifecycle === "initializing" || lifecycle === "running";
      });
      if (siblingStillRunning) {
        return;
      }
    }
    const project = await this.deps.taskService.getProject(task.projectId);
    const policy = await this.resolveEffectivePolicy(task);
    try {
      await this.requireIntegrateTaskWork(taskId);
    } catch (error) {
      await this.handleIntegrationFailure(task, project, error);
      return;
    }
    // A root task always parks in review: Done means somebody accepted the
    // work, so only a verdict or a hand reaches it. The review toggle decides
    // who judges — an agent reviewer, or a person when it is off. A subtask
    // whose own review is off still completes on its own: its delivery is
    // judged by the parent's final review, and a chain that stopped for a
    // verdict at every phase would not be a chain.
    if (policy.reviewEnabled || task.parentTaskId === null) {
      await this.deps.taskService.updateTask({ taskId, status: "in_review" });
      this.reviewAttemptsByTask.delete(taskId);
      this.announceToBoard(project, {
        task,
        note: policy.reviewEnabled
          ? "settled its attached work, integrated it into the task branch, and moved to in_review"
          : "settled its attached work and moved to in_review to await a verdict",
      });
      if (policy.reviewEnabled) {
        this.startReview(taskId);
      }
      return;
    }
    await this.completeTask(taskId, "settled its attached work");
  }

  /**
   * The effective policy for one task: its own override, then its parent
   * aggregate's, then the board. A subtask chain configured once at the parent
   * therefore behaves the same at every level that did not say otherwise.
   */
  private async resolveEffectivePolicy(task: Task): Promise<ResolvedTaskExecutionPolicy> {
    const project = await this.deps.taskService.getProject(task.projectId);
    const parent = task.parentTaskId
      ? await this.deps.taskService.getTask(task.parentTaskId)
      : null;
    return resolveTaskExecutionPolicy(
      project?.board,
      task.executionPolicy,
      parent?.executionPolicy,
    );
  }

  /**
   * The one reaction to a stored status change, wherever it was written from.
   * Two rules hang off it: a parent's status is written from its children, and a
   * task whose last blocker just settled starts itself when it was given a way
   * to. Both are fire-and-forget, like the observer paths — the write that
   * caused them has already landed.
   */
  handleTaskStatusChange(input: {
    taskId: string;
    parentTaskId: string | null;
    previousStatus: TaskStatus;
    status: TaskStatus;
  }): void {
    if (input.parentTaskId) {
      const parentTaskId = input.parentTaskId;
      void this.aggregateFromChildren(parentTaskId, input.taskId).catch((error) => {
        this.deps.logger.error(
          { err: error, taskId: parentTaskId, childTaskId: input.taskId },
          "Failed to move a parent task from its children",
        );
      });
    }
    if (input.status === "done" || input.status === "canceled") {
      void this.startUnblockedDependents(input.taskId).catch((error) => {
        this.deps.logger.error(
          { err: error, taskId: input.taskId },
          "Failed to start the tasks a settled task unblocked",
        );
      });
    }
  }

  /**
   * Writes an aggregate's status from its children. The status is stored, not
   * computed at read: the board's columns are the stored statuses, and a card
   * whose column existed only in a projection could not be moved by hand.
   *
   * The child that caused the move is named in the feed, the same way every
   * other automatic move is.
   */
  private async aggregateFromChildren(parentTaskId: string, childTaskId: string): Promise<void> {
    const parent = await this.deps.taskService.getTask(parentTaskId);
    if (!parent || parent.status === "done" || parent.status === "canceled") {
      return;
    }
    const children = await this.deps.taskService.listSubtasks(parentTaskId);
    const child = children.find((candidate) => candidate.id === childTaskId);
    if (!child) {
      return;
    }
    const project = await this.deps.taskService.getProject(parent.projectId);
    const childKey = project ? `${project.prefix}-${child.number}` : `#${child.number}`;
    if (
      child.status === "in_progress" &&
      (parent.status === "backlog" || parent.status === "todo")
    ) {
      await this.deps.taskService.updateTask({ taskId: parentTaskId, status: "in_progress" });
      this.announceToBoard(project, {
        task: parent,
        note: `moved to in_progress: its subtask ${childKey} started`,
      });
      return;
    }
    if (parent.status === "in_review") {
      return;
    }
    const open = children.filter(
      (candidate) => candidate.status !== "done" && candidate.status !== "canceled",
    );
    // Nothing was delivered when every subtask was canceled, so the aggregate is
    // left to a person rather than being called finished.
    if (open.length > 0 || !children.some((candidate) => candidate.status === "done")) {
      return;
    }
    const policy = await this.resolveEffectivePolicy(parent);
    // Same rule as a settling leaf: a root aggregate waits for a verdict, and
    // only a nested aggregate whose own review is off flows through — its
    // integration is judged one level further up.
    if (policy.reviewEnabled || parent.parentTaskId === null) {
      await this.deps.taskService.updateTask({ taskId: parentTaskId, status: "in_review" });
      this.reviewAttemptsByTask.delete(parentTaskId);
      this.announceToBoard(project, {
        task: parent,
        note: `moved to in_review: its last subtask ${childKey} merged and the integration is ready to judge`,
      });
      if (policy.reviewEnabled) {
        this.startReview(parentTaskId);
      }
      return;
    }
    await this.completeTask(parentTaskId, `saw its last subtask ${childKey} merge`);
  }

  /**
   * A settled blocker starts what was waiting on it, when the waiting task
   * carries an execution spec asking for that. This is what lets a chain run
   * hands-free: each phase starts itself once its predecessor is done or
   * canceled — canceling a phase is how you skip it.
   */
  private async startUnblockedDependents(settledTaskId: string): Promise<void> {
    if (!this.requestDelegation) {
      return;
    }
    for (const dependentId of await this.deps.taskService.listDependents(settledTaskId)) {
      await this.startTaskIfUnblocked(dependentId);
    }
  }

  /**
   * One attempt at starting one task, at most once.
   *
   * The claim on `autoStartsInFlight` is taken before the first await and held
   * until the dispatch settles. Two blockers of the same task settling together
   * both reach here, and every check between them is asynchronous: claiming
   * after those reads would let both pass and dispatch two agents onto one task.
   */
  private async startTaskIfUnblocked(taskId: string): Promise<void> {
    if (this.autoStartsInFlight.has(taskId)) {
      return;
    }
    this.autoStartsInFlight.add(taskId);
    try {
      const task = await this.deps.taskService.getTask(taskId);
      const spec = task?.executionSpec;
      if (!task || !spec || spec.trigger !== "on_unblocked") {
        return;
      }
      if (task.status !== "backlog" && task.status !== "todo") {
        return;
      }
      if ((await this.deps.taskService.listUnmetDependencies(taskId)).length > 0) {
        return;
      }
      if ((await this.deps.taskService.countSubtasks(taskId)) > 0) {
        return;
      }
      await this.startTaskFromSpec(task, spec.presetId);
    } finally {
      this.autoStartsInFlight.delete(taskId);
    }
  }

  /**
   * Starts the chains a restart interrupted. A blocker that settled while the
   * daemon was down leaves its dependent ready and unstarted, and nothing else
   * would ever look at it again: the trigger fires on a status change, and that
   * change already happened.
   */
  private async startTasksReadyAfterRestart(): Promise<void> {
    if (!this.requestDelegation) {
      return;
    }
    const ready = (await this.deps.taskService.snapshot()).tasks.filter(
      (task) =>
        task.executionSpec?.trigger === "on_unblocked" &&
        (task.status === "backlog" || task.status === "todo") &&
        task.agents.length === 0,
    );
    for (const task of ready) {
      await this.startTaskIfUnblocked(task.id);
    }
  }

  private async startTaskFromSpec(task: Task, presetId: string): Promise<void> {
    const project = await this.deps.taskService.getProject(task.projectId);
    try {
      const started = await this.requestDelegation?.({ taskId: task.id, presetId });
      if (!started) {
        return;
      }
      this.observeAttachment({ taskId: task.id, agentId: started.agentId });
      this.announceToBoard(project, {
        task,
        note: "started automatically: its last blocker settled",
      });
    } catch (error) {
      this.announceToBoard(project, {
        task,
        note: `could not start automatically after its last blocker settled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  /**
   * Hands a card that reached review to a reviewer, when the board names one.
   * Fire-and-forget: the card is already in review, and a reviewer that fails
   * to start leaves a human to do what a human did before — but the board says
   * so on the card rather than only in the daemon log.
   */
  setRequestReview(request: (taskId: string) => Promise<{ agentId: string } | null>): void {
    this.requestReview = request;
  }

  setReleaseReviewer(
    listener: (input: { taskId: string; agentId: string; cancelAgent: boolean }) => Promise<void>,
  ): void {
    this.releaseReviewer = listener;
  }

  setOnTaskDone(listener: (taskId: string) => Promise<void>): void {
    this.onTaskDone = listener;
  }

  setRequestCorrection(
    listener: (input: {
      taskId: string;
      feedback: string | null;
    }) => Promise<{ agentIds: string[] } | null>,
  ): void {
    this.requestCorrection = listener;
  }

  setIntegrateTaskWork(listener: (taskId: string) => Promise<void>): void {
    this.integrateTaskWork = listener;
  }

  setIntegrateTaskIntoParent(listener: (taskId: string) => Promise<void>): void {
    this.integrateTaskIntoParent = listener;
  }

  setRequestIntegrationFix(
    listener: (input: { taskId: string; error: string }) => Promise<void>,
  ): void {
    this.requestIntegrationFix = listener;
  }

  setRequestDelegation(
    listener: (input: { taskId: string; presetId: string }) => Promise<{ agentId: string } | null>,
  ): void {
    this.requestDelegation = listener;
  }

  private async finishTask(taskId: string): Promise<void> {
    await this.onTaskDone?.(taskId);
  }

  private startReview(taskId: string): void {
    if (!this.requestReview) {
      return;
    }
    const attempt = (this.reviewAttemptsByTask.get(taskId) ?? 0) + 1;
    this.reviewAttemptsByTask.set(taskId, attempt);
    void (async () => {
      const reviewer = await this.requestReview?.(taskId);
      if (reviewer) {
        this.observeReviewer({ taskId, agentId: reviewer.agentId });
        return;
      }
      // No reviewer preset: the card waits for a human, which is not a failure
      // and not something to retry.
      this.reviewAttemptsByTask.delete(taskId);
    })().catch((error) => {
      this.deps.logger.warn({ err: error, taskId }, "Could not start a review for this task");
      void this.reportReviewStartFailure(taskId, error);
    });
  }

  /**
   * A board that names a reviewer and then silently falls back to a human is
   * indistinguishable from a board with no reviewer at all. Say which one this
   * is, on the card.
   */
  private async reportReviewStartFailure(taskId: string, error: unknown): Promise<void> {
    this.reviewAttemptsByTask.delete(taskId);
    try {
      const task = await this.deps.taskService.getTask(taskId);
      if (!task) {
        return;
      }
      const project = await this.deps.taskService.getProject(task.projectId);
      this.announceToBoard(project, {
        task,
        note: `could not start its review and now requires a human: ${error instanceof Error ? error.message : String(error)}`,
      });
    } catch (reportError) {
      this.deps.logger.warn(
        { err: reportError, taskId },
        "Could not record a review that failed to start",
      );
    }
  }

  private observeReviewer(input: { taskId: string; agentId: string }): void {
    const key = this.linkKey(input);
    this.clearReviewWatch(key);
    let observer = observeAgentCompletion();
    const finish = (outcome: "finished" | "errored" | "closed"): void => {
      this.clearReviewWatch(key);
      void this.settleReviewer({
        ...input,
        note: reviewerOutcomeNote(outcome),
        cancelAgent: false,
      }).catch((error) => {
        this.deps.logger.warn(
          { err: error, taskId: input.taskId, agentId: input.agentId },
          "Could not settle a reviewer that ended without a verdict",
        );
      });
    };
    const unsubscribe = this.deps.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") {
          return;
        }
        const outcome = observer.observeLifecycle(event.agent.lifecycle);
        if (outcome) {
          finish(outcome);
        }
      },
      { agentId: input.agentId, replayState: false },
    );
    this.reviewUnsubscribesByLink.set(key, unsubscribe);
    this.reviewTimeoutsByLink.set(
      key,
      setTimeout(() => this.timeOutReviewer(input), this.reviewTimeoutMs),
    );
    const snapshot = this.deps.agentManager.getAgent(input.agentId);
    if (snapshot) {
      const initial = observer.observeLifecycle(snapshot.lifecycle);
      if (initial) {
        finish(initial);
      }
    }
  }

  private clearReviewWatch(key: string): void {
    this.reviewUnsubscribesByLink.get(key)?.();
    this.reviewUnsubscribesByLink.delete(key);
    const timeout = this.reviewTimeoutsByLink.get(key);
    if (timeout) {
      clearTimeout(timeout);
    }
    this.reviewTimeoutsByLink.delete(key);
  }

  private timeOutReviewer(input: { taskId: string; agentId: string }): void {
    this.clearReviewWatch(this.linkKey(input));
    void this.settleReviewer({
      ...input,
      note: `ran past the ${this.reviewTimeoutMs}ms review limit and was stopped`,
      cancelAgent: true,
    }).catch((error) => {
      this.deps.logger.warn(
        { err: error, taskId: input.taskId, agentId: input.agentId },
        "Could not settle a reviewer that ran past its limit",
      );
    });
  }

  /**
   * A reviewer stopped. Its checkout goes either way — it exists for one
   * judgement on the task branch, and the findings are in the feed. If the
   * verdict never landed, the board puts one more reviewer on the card and then
   * leaves it to a human, so a card can neither sit in review forever nor spawn
   * agents forever.
   */
  private async settleReviewer(input: {
    taskId: string;
    agentId: string;
    note: string;
    cancelAgent: boolean;
  }): Promise<void> {
    await this.releaseReviewer?.({
      taskId: input.taskId,
      agentId: input.agentId,
      cancelAgent: input.cancelAgent,
    });
    const task = await this.deps.taskService.getTask(input.taskId);
    if (!task || task.status !== "in_review") {
      return;
    }
    const attempts = this.reviewAttemptsByTask.get(input.taskId) ?? 0;
    const retrying = this.requestReview !== null && attempts < this.maxReviewAttempts;
    await this.deps.taskService.createComment({
      taskId: input.taskId,
      kind: "system",
      authorName: "board",
      agentId: input.agentId,
      body: `The reviewer ${input.note}; ${
        retrying ? "the board is starting a fresh review" : "this task still requires review"
      }.`,
    });
    if (retrying) {
      this.startReview(input.taskId);
      return;
    }
    this.reviewAttemptsByTask.delete(input.taskId);
  }

  /** Approve goes to done. Reject follows the task's effective rejection
   * target, `in_progress` when neither task nor board chose one. */
  async applyReviewVerdict(input: {
    taskId: string;
    verdict: "approve" | "reject";
    feedback?: string;
  }): Promise<Task> {
    if (this.verdictsInFlight.has(input.taskId)) {
      throw new Error(`Task ${input.taskId} review is already being decided`);
    }
    this.verdictsInFlight.add(input.taskId);
    try {
      const task = await this.deps.taskService.getTask(input.taskId);
      if (!task) {
        throw new Error(`No task ${input.taskId} to review`);
      }
      if (task.status !== "in_review") {
        throw new Error(`Task ${input.taskId} is not in review`);
      }
      const project = await this.deps.taskService.getProject(task.projectId);
      this.reviewAttemptsByTask.delete(input.taskId);
      if (input.verdict === "approve") {
        return await this.completeTask(input.taskId, REVIEW_APPROVED_NOTE);
      }
      return await this.applyReviewRejection({ task, project, feedback: input.feedback });
    } finally {
      this.verdictsInFlight.delete(input.taskId);
    }
  }

  /** The only completion gate. Agent settlement, review approval and manual
   * moves all arrive here so a child cannot say Done before it is delivered
   * into its parent's canonical branch. */
  async completeTask(taskId: string, reason = "was completed"): Promise<Task> {
    const inFlight = this.completionsInFlight.get(taskId);
    if (inFlight) return await inFlight;
    const completion = this.performTaskCompletion(taskId, reason).finally(() => {
      this.completionsInFlight.delete(taskId);
    });
    this.completionsInFlight.set(taskId, completion);
    return await completion;
  }

  private async performTaskCompletion(taskId: string, reason: string): Promise<Task> {
    const task = await this.deps.taskService.getTask(taskId);
    if (!task) throw new Error(`No task ${taskId} to complete`);
    const project = await this.deps.taskService.getProject(task.projectId);
    const openSubtasks = (await this.deps.taskService.snapshot()).tasks.filter(
      (candidate) =>
        candidate.parentTaskId === taskId &&
        candidate.status !== "done" &&
        candidate.status !== "canceled",
    );
    if (openSubtasks.length > 0) {
      this.announceToBoard(project, {
        task,
        note: `could not complete because subtasks ${openSubtasks
          .map((subtask) => `#${subtask.number}`)
          .join(", ")} are still open`,
      });
      return task;
    }
    try {
      await this.requireIntegrateTaskIntoParent(taskId);
    } catch (error) {
      return await this.handleIntegrationFailure(task, project, error);
    }
    const completed = await this.deps.taskService.finalizeTaskDone(taskId);
    this.announceToBoard(project, {
      task,
      note: task.parentTaskId
        ? `${reason}, integrated into its parent, and moved to done`
        : `${reason} and moved to done`,
    });
    await this.finishTask(taskId);
    return completed;
  }

  private async requireIntegrateTaskWork(taskId: string): Promise<void> {
    if (!this.integrateTaskWork) throw new Error("task integration is not configured");
    await this.integrateTaskWork(taskId);
  }

  private async requireIntegrateTaskIntoParent(taskId: string): Promise<void> {
    if (!this.integrateTaskIntoParent) throw new Error("task integration is not configured");
    await this.integrateTaskIntoParent(taskId);
  }

  private async handleIntegrationFailure(
    task: Task,
    project: Awaited<ReturnType<TaskService["getProject"]>>,
    error: unknown,
  ): Promise<Task> {
    const message = error instanceof Error ? error.message : String(error);
    const working = await this.deps.taskService.updateTask({
      taskId: task.id,
      status: "in_progress",
    });
    this.announceToBoard(project, {
      task,
      note: `could not integrate and moved back to in_progress: ${message}`,
    });
    if (this.requestIntegrationFix) {
      void this.requestIntegrationFix({ taskId: task.id, error: message }).catch((fixError) => {
        this.deps.logger.warn(
          { err: fixError, taskId: task.id },
          "Could not return an integration conflict to the worker",
        );
      });
    }
    return working;
  }

  private async applyReviewRejection(input: {
    task: Task;
    project: Awaited<ReturnType<TaskService["getProject"]>>;
    feedback?: string;
  }): Promise<Task> {
    const { task, project } = input;
    const policy = await this.resolveEffectivePolicy(task);
    const target = policy.reviewOnReject ?? DEFAULT_ON_REJECT;
    const currentIteration = task.reviewIteration ?? 0;
    const maxIterations = policy.maxReviewIterations;
    if (currentIteration >= maxIterations) {
      this.announceToBoard(project, {
        task,
        note: `${REVIEW_REJECTED_NOTE} after ${currentIteration} correction rounds and now requires human review`,
      });
      return task;
    }
    const rejected = await this.deps.taskService.updateTask({
      taskId: task.id,
      status: target,
      reviewIteration: currentIteration + 1,
    });
    this.announceToBoard(project, {
      task,
      note: `${REVIEW_REJECTED_NOTE} for correction ${currentIteration + 1}/${maxIterations} and moved back to ${target}`,
    });
    if (target === "in_progress") {
      try {
        await this.startCorrection(task.id, input.feedback);
      } catch (error) {
        const restored = await this.deps.taskService.updateTask({
          taskId: task.id,
          status: "in_review",
          reviewIteration: currentIteration,
        });
        this.announceToBoard(project, {
          task,
          note: `could not start correction work and returned to review: ${error instanceof Error ? error.message : String(error)}`,
        });
        return restored;
      }
    }
    return rejected;
  }

  private async startCorrection(taskId: string, feedback?: string): Promise<void> {
    if (!this.requestCorrection) {
      throw new Error("no correction runner is configured");
    }
    const correction = await this.requestCorrection({
      taskId,
      feedback: feedback?.trim() || null,
    });
    if (!correction || correction.agentIds.length === 0) {
      throw new Error("no attached worker is available to resume");
    }
    const corrected = new Set(correction.agentIds);
    const links = await this.deps.taskService.listTaskAgents(taskId);
    for (const link of links) {
      const isSupersededWorker =
        (link.role ?? "worker") === "worker" && !corrected.has(link.agentId);
      if (isSupersededWorker) {
        this.unobserveAttachment({ taskId, agentId: link.agentId });
      }
    }
    for (const agentId of corrected) {
      this.observeAttachment({ taskId, agentId });
    }
  }

  /**
   * Every automatic move says so in the board's feed, naming the card and what
   * caused it. A board that moves cards silently is one you cannot audit, and
   * it is where the ping-pong bugs other boards shipped went unnoticed.
   */
  private announceToBoard(
    project: Awaited<ReturnType<TaskService["getProject"]>>,
    input: { task: Task; note: string },
  ): void {
    if (!project) {
      return;
    }
    const key = `${project.prefix}-${input.task.number}`;
    void this.deps.taskService
      .createComment({
        taskId: input.task.id,
        kind: "system",
        authorName: "board",
        body: `${key} "${input.task.title}" ${input.note}.`,
      })
      .catch((error) => {
        this.deps.logger.warn(
          { err: error, taskId: input.task.id },
          "Could not record a board event in the feed",
        );
      });
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribesByLink.values()) {
      unsubscribe();
    }
    this.unsubscribesByLink.clear();
    for (const unsubscribe of this.reviewUnsubscribesByLink.values()) {
      unsubscribe();
    }
    this.reviewUnsubscribesByLink.clear();
    for (const timeout of this.reviewTimeoutsByLink.values()) {
      clearTimeout(timeout);
    }
    this.reviewTimeoutsByLink.clear();
    this.reviewAttemptsByTask.clear();
  }
}

function reviewerOutcomeNote(outcome: "finished" | "errored" | "closed"): string {
  if (outcome === "finished") return "finished without recording a verdict";
  if (outcome === "errored") return "stopped on an error before recording a verdict";
  return "closed before recording a verdict";
}
