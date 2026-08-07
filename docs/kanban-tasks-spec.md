# Tracker + Kanban — branch spec (design/workflow-stacking)

The contract for the redesign on this branch. Section tags: **[SHIPPED]** is
on the branch and tested; **[DECIDED]** is agreed and not yet built;
**[SUPERSEDED]** shipped but a later decision removes or reshapes it.

Docs of record (`docs/kanban.md`, `docs/tasks.md`) return once the code
matches this file. Until then this is the only kanban/tasks doc.

## 1. Vision

One tracker, one board, one channel.

A **task** is the unit of work: key (`PSE-42`), stored status, priority,
labels, comments, subtasks, dependencies. The **kanban is the board view of
tasks** — columns are the stored statuses, never a second object with its own
route. Execution attaches to a task: agents, and workflows of steps. Nothing
about execution is stored twice; it is read off the agents and the runs.

Agents work the tracker through MCP tools. The board writes back to them. All
coordination goes through the board and its feed — the bacheca — never through
a parallel messaging system between agents.

Reference implementations for the tracker semantics: `get-bb/bb` (task model,
keys, capture) and `Emanuele-web04/synara` (board behaviour).

## 2. Data model

### 2.0 Tracker [SHIPPED]

- SQLite at `$PASEO_HOME/tasks.db` (`node:sqlite`). Tables: task_projects,
  tasks, labels(+links), comments, attachments, task_agents, presets, revision
  counter bumped by triggers.
- **Stored** (intent): status `backlog|todo|in_progress|in_review|done|canceled`,
  priority, labels, due date, fractional position (`POSITION_STEP=1024`;
  the client sends neighbours, the daemon picks the number).
- **Derived** (execution): attached agents' live state, read off the agents.
- Task project ↔ Paseo project via `paseoProjectId`; prefix unique per host.
- Sync: push `tasks.update { revision }`; a client at the same revision does
  nothing, a client behind refetches. Push-router domain `tasks` app-side.

### 2.1 The board is the task project [DECIDED]

`StoredKanban` retires. One board-shaped object: the task project.

- `review`, `archiveWorkspacesOnDone` and the board's agent associations move
  onto `task_projects` in SQLite. The kanban JSON record goes, and with it the
  get-or-create dance the workspace tab needs today just to obtain an id.
- `/kanbans/<id>` resolves to the project's board. Feed room and board events
  key on the task project.
- No migration. The `tasks` feature gate has never been in a release, so no
  released peer can hold the old shape: pre-branch plan boards break, and no
  COMPAT shim is warranted.

### 2.2 Workflow on task [DECIDED]

Plans stop being objects. The step machine — agent specs, workspace strategy,
triggers, hard gates, schedules — survives unchanged and re-homes: **steps
attach to a task**. Plan `title`/`description` and nested plans go; the task
carries them. "Add plan" on the card becomes "Add workflow".

`derivePlanColumn` goes with them. A task's stored status and the transition
engine are the only column truth.

### 2.3 Hierarchy and dependencies [DECIDED]

Tasks gain `parentId` (subtasks) and dependency links (`blocks` /
`blocked-by`). The dependency gate (§6.1) and the stacked-branch mapping
(§6.2) read them. A subtask is a task in every other respect — same statuses,
same board, indented under its parent in the column.

### 2.4 Board event bus [DECIDED]

One emission point for board events — task created, moved, settled, approved,
rejected, agent attached, agent stalled — and three consumers: the feed room
post (§6), the `tasks.update` push, and the daemon rules (§6.1). Today those
are independent writes from different call sites, which is how they drift.

## 3. Automatic transitions [SHIPPED]

`packages/server/src/server/tasks/transitions.ts`, unit-tested:

- Attached work settles green → the task moves to `in_review` when the board
  has `review.enabled`, else to `done`.
  - Workflow-dispatched agents attach without observers; the last step
    settling is the signal, so a 3-step workflow does not move the task on
    step 1.
  - Manually attached agents (RPC/MCP `attach_task_agent`) get an observer per
    attachment, re-armed at daemon boot, firing once per finish. A task pushed
    back to work moves again on the next finish.
- Review verdict: approve → `done`; reject → `review.onReject`, default
  `in_progress`. Exposed as RPC, card menu, and MCP `review_task`.
- Failure moves nothing. The task stays `in_progress` and the card shows it.
- Manual moves write the same stored field through the same RPC, so automation
  and hand cannot disagree.

**[DECIDED] addition:** every automatic move posts to the feed naming what
caused it, and stays reversible by hand. Boards that moved cards silently
shipped ping-pong bugs between In Progress and In Review; attribution plus a
one-move undo is what prevents it.

## 4. Agent access [SHIPPED]

- MCP tools: `create_task_project`, `list_tasks`, `create_task`, `update_task`,
  `comment_task` (agent identity on the comment), `attach_task_agent`
  (defaults to the calling agent — "I'm taking PSE-3"), `review_task`.
  `create_plan` accepts `taskId`. Parity Suite G covers capture→review and
  self-attach.
- CLI: `paseo task ls|create|move`, by key (`PSE-42`) or id.
- **[DECIDED]** `create_plan` becomes `add_task_workflow` (§2.2); new tools
  for subtasks and dependencies follow the same shape. Board events reach
  agents through the feed room, not through per-agent prompts (§6.1).

## 5. Surfaces

### 5.1 Board page `/kanbans/<id>` [SHIPPED]

- **Header**, in workspace grammar: one `ScreenHeader` row — sidebar toggle,
  project title, `···` menu right beside the title (Ellipsis, hover colour,
  sheet on compact). Right side: task count and the sidebar toggle. No back
  arrow; back is the sidebar's Kanbans entry.
- **Columns** are the statuses. Canceled appears only when populated. Columns
  flex 264–360 wide with horizontal scroll; compact shows one column behind a
  scrollable segmented picker.
- **Card**: key, priority label (colour-coded urgent/high), live
  `StatusBucketDot` from attached agents, title, label chips. Kebab and
  right-click context menu carry the same list: Approve/Reject when in review,
  Add workflow, Open agent per attachment, move-to-status, Delete.
- **Capture**: every column's "+" opens the minimal sheet — title only. The
  first capture also creates the tracker project, prefilled and linked. Form
  model per [docs/forms.md](forms.md), unit-tested.
- **Drag** writes `tasks.move`; the optimistic paint uses the daemon's own
  position arithmetic. Menu move covers platforms without drag. Every column
  is hand-sortable, because order is stored.
- **Sidebar**: full-height right sidebar in the explorer shape — panel-store
  width, viewport clamp, `SidebarResizeHandle`, open state persisted on
  desktop, sheet on compact. Content is the feed (§6).

**[DECIDED] menu changes**: "Add plan" → "Add workflow"; "Require review"
becomes a checkmark toggle per [docs/menus.md](menus.md) rather than a menu
item with a swapping label; "Create Orchestrator" goes (§6.1).

### 5.2 Workspace [SHIPPED]

- **Kanban tab kind**: payload-less singleton per workspace, rendering the
  same `TaskBoardSurface` for the workspace's project. Entry points: "Kanban"
  in the tab row's ⌄ menu (pinnable) and a default pinned launcher before the
  terminal. Splittable and draggable like any tab.
- **Explorer sidebar** gains a tab beside Changes/Files/PR when the project
  has a board; the unavailable-tab fallback follows the PR-tab rule.
  **[DECIDED]** the tab is named **Feed** and renders the board channel.

### 5.3 Overview `/kanbans` [SHIPPED]

Renders tasks per project. Each column is a tracker project — its cards are
read-only, because acting on a task belongs to the board one press away. Hosts
without a tracker are skipped rather than asked and failed.

The route is `/kanbans/<taskProjectId>`: a board is a tracker project, so the
same id addresses the column and the board it opens.

### 5.4 Task detail sheet [DECIDED]

Description, comments, labels, due date, subtasks, dependencies and
attachments are wire-complete with no surface. Build one sheet that shows
them, opened by pressing a card. That also settles what a card press does:

- **press → detail sheet, always**, whatever the number of attached agents.
  Attached agents are rows in the sheet; opening a conversation is a tap on a
  row. Today's behaviour — open the chat when exactly one agent is attached,
  silently do nothing otherwise — has no rule a user can learn.

### 5.5 Presets and delegate [DECIDED]

`task_presets` exists in the schema with no UI. The delegate flow: pick a
preset on a task, an agent spawns already attached, in its own worktree
(§6.2). Presets are per board. This is the fast path to "start work on this
card" and it lands after the feed.

## 6. Board feed [DECIDED]

A real channel per board, on the existing chat store.

- One room per board, deterministic name keyed on the task project.
- What posts there:
  - agents' task comments, mirrored from `comment_task`, authored by the agent;
  - board events from the bus (§2.4), attributed;
  - agent finish notes, carried on the settle event;
  - you, from the sidebar composer, posting as yourself. `@mention` prompts
    the mentioned agent through the existing fanout.
- The sidebar renders the channel Slack-style: author, timestamp, compact
  event items. Tapping an item opens the task or that agent's own chat. There
  are no Feed|Chat tabs and no agent is special.

### 6.1 No standing team-lead agent — daemon rules instead [DECIDED]

Prior-art research settled this: worktree-per-task is universal; every shipped
product coordinates through the board and none built an agent-to-agent message
bus; only Devin ships a supervisor agent, and the generic manager-agent is a
documented failure mode elsewhere (mis-routing, sequential execution,
overwritten outputs, ~75x the tokens).

- **No Orchestrator agent.** The board stands alone: tracker, attach,
  transitions, feed.
- **The supervision that matters is deterministic**, and lives in the daemon
  as event-bus consumers: stall detection (agent idle, erroring, or waiting on
  input → feed post), dependency gating (a task with unresolved `blocked-by`
  is not claimable), attributed transition posts.
- **A decomposer agent is a later phase** — turn a task into subtasks with
  agent specs — opt-in per board. Even then it authors no code and issues no
  review verdicts. Review is human, or a verification agent with no
  implementation context.
- Retired in full: the per-daemon `orchestrators` room, the peer rail,
  `orchestrator-thread-view`, `send_orchestrator_message`, the orchestrator
  sidebar pane, and Create Orchestrator.

### 6.2 Subtask isolation — stacked branches, sibling worktrees [DECIDED]

- A task's agent works in its own worktree and branch.
- A **subtask** branches off its **parent task's branch**, not off main. Its
  worktree directory sits beside the parent's, never inside it — a checkout
  nested in a live worktree confuses git and the agents' file tools.
- A subtask merges into the parent branch; the parent merges to main. This
  maps 1:1 onto stacked PRs and keeps review units bounded.
- Depth beyond one level works, and the UI does not encourage it.

## 7. Build order

Each phase leaves the branch green — typecheck, lint, the touched unit tests,
and the board e2e.

1. **Workflow on task** (§2.2) — _first, not second_. The kanban record cannot
   leave the data path while it still holds the plans, so the steps move out
   before the record does. New tracker storage, `TaskWorkflowEngine`, the
   `tasks.workflow.*` and `tasks.step.*` RPCs, the agent tools, and the
   workflow form.
2. **Board is the task project** (§2.1). With the record down to config, fold
   it into `task_projects`, delete the kanban store, service, engine, RPCs and
   plan UI, and resolve routes and the overview on the project.
3. **Event bus and feed** (§2.4, §6). Single emission point, room per board,
   `comment_task` mirroring, composer with mention fanout, mesh retirement,
   Feed tab.
4. **Hierarchy and rules** (§2.3, §6.1, §6.2). `parentId` and dependencies,
   stall detection, dependency gate, stacked-branch worktrees for subtasks.
5. **Detail sheet and delegate** (§5.4, §5.5).

## 8. Invariants

- Store intent, derive everything else. Task status is stored; agent liveness
  and run outcomes are read, never copied.
- One destination per object. The kanban is the tasks' board view; no parallel
  route or screen shows the same thing.
- The protocol stays backward compatible; features gate on
  `server_info.features.{tasks,kanban}`. Compatibility shims are only for
  shapes a released peer can actually produce.
- Steps keep their hard gates. No second cron engine. Workspaces remain the
  source of truth for execution.
- Coordination composes what exists — agents, chat store, board. No new
  messaging subsystem, and no agent-to-agent bus.
