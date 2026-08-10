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
  priority, labels, due date, per-task execution policy, fractional position
  (`POSITION_STEP=1024`; the client sends neighbours, the daemon picks the
  number).
- **Derived** (execution): attached agents' live state, read off the agents. A
  task can link several agents across several workspaces; the exact agent links
  define task membership, not every agent that happens to share a workspace.
  **[DECIDED]** A link whose agent was deleted or archived is pruned when the
  daemon notices — at boot and when the agent goes away. A card must never
  show ghosts.
- Task project ↔ Paseo project via `paseoProjectId`; prefix unique per host.
- Sync: push `tasks.update { revision }`; a client at the same revision does
  nothing, a client behind refetches. Push-router domain `tasks` app-side.

### 2.1 The board is the task project [SHIPPED]

`StoredKanban` is gone. One board-shaped object: the task project.

- `review` and `archiveWorkspacesOnDone` live on `task_projects` in SQLite as
  board defaults. A task stores a sparse override for review, reviewer,
  correction rounds, rejection target, cleanup and ordinary delegation's
  workspace choice. Resetting it returns the task to the board defaults.
  The kanban JSON record, its store, service, engine, RPCs, protocol module,
  CLI group and plan UI are deleted, and with them the get-or-create dance the
  workspace tab needed just to obtain an id.
- `/kanbans/<taskProjectId>` resolves the board. `features.kanban` is gone
  from `server_info`; everything gates on `features.tasks`.
- No migration. The `tasks` gate had never been in a release, so no released
  peer could hold the old shape: pre-branch plan boards break, and no COMPAT
  shim was warranted.

### 2.2 Workflow on task [SHIPPED]

Plans stop being objects. The step machine — agent specs, workspace strategy,
triggers, hard gates, schedules — survives unchanged and re-homes: **steps
attach to a task**. Plan `title`/`description` and nested plans go; the task
carries them. The UI calls this ordered list an **agent plan**.

The hierarchy is task → plan → steps. A subtask is another task, so it can own
its own plan and steps. A step is never presented as a subtask and has no task
status or review policy of its own.

**[DECIDED]** Steps sequence agents inside one leaf task — same task branch,
one delivery, no board presence. A multi-phase plan that wants per-phase review
or per-phase branches is a subtask chain (§2.5), not a workflow. Steps gain no
further task-like features.

`derivePlanColumn` goes with them. A task's stored status and the transition
engine are the only column truth.

A scheduled step has one agent. Schedule lifecycle events attach that agent to
the task and settle the workflow step; scheduled fan-out is rejected when the
workflow is saved because one schedule run has one agent target.

The plan form exposes **Continue automatically**, on by default. The first step
waits for the task to start; ordinary later steps use `immediate` while the
switch is on and `manual` while it is off. Scheduled steps retain their cadence.
Editing a plan preserves each retained step's identity and run history. Turning
automatic continuation on also starts the first eligible unstarted step when
its predecessor already succeeded.
An intermediate workflow-owned agent finishing reads **Step complete**, not
**Ready to review**. Task review begins only after the final step settles; the
board then starts its configured reviewer or waits for a person.

### 2.3 Hierarchy and dependencies [SHIPPED]

Tasks carry `parentTaskId` (subtasks) and dependency edges in
`task_dependencies`. The snapshot carries the edges so a client can draw them.
A subtask is a task in every other respect — same statuses, same board.
Dependencies stay within that board and may not form a cycle; accepting one
would leave every card in the loop permanently blocked.

**[SUPERSEDED]** A parent can limit how many newly created subtasks are ready
together (`maxParallelSubtasks`, dependency waves). Replaced by the sequential
default below: parallelism becomes a per-subtask choice, not a throttle.

**[DECIDED]** New subtasks chain sequentially: creation adds a dependency on
the previous sibling. A subtask created with the parallel flag skips that edge
and is ready with its predecessor. Later edits never rewrite edges already
stored.

### 2.5 Leaf executes, parent aggregates [DECIDED]

A task without subtasks is a leaf: workers attach to it, its plan runs on it,
its status moves as §3 says. A task with subtasks is an aggregate: it holds no
workers of its own, and the transition engine writes its status from its
children — the first subtask starting moves it to `in_progress`; the last
subtask merging moves it to `in_review` or `done` per its effective review
policy. Attaching a worker to an aggregate is refused, naming the reason. The
decomposer (§6.1) is the only agent that belongs on one, and it authors
subtasks, not code.

A subtask can carry an execution spec — a preset or agent spec chosen at
creation — and the `on_unblocked` trigger: the spec starts when the last open
blocker reaches `done` or `canceled`. That is what lets a chain run hands-free;
each phase starts itself when its predecessor settles. Skipping a phase is
canceling its subtask — canceled already unblocks (§6.1).

Workspace strategy is a group concern. A sequential chain can share one
worktree, each phase reusing its predecessor's; parallel phases get their own.
Shared worktrees are released when the aggregate settles, not at each
subtask's Done (§6.2).

### 2.4 Board event bus [SHIPPED]

One emission point for board events — task created, moved, settled, approved,
rejected, agent attached, agent stalled — and three consumers: the feed room
post (§6), the `tasks.update` push, and the daemon rules (§6.1).

An event is typed data, not prose: a kind plus its references (task, agent,
verdict, cause), stored on the feed entry. The feed renders the sentence from
the event; every reader — the aggregate reviewer collecting child verdicts,
`get_task_context` (§4.1), the daemon rules — reads the kind, never the
wording. Matching feed prose to find a verdict is forbidden.

## 3. Automatic transitions [SHIPPED]

`packages/server/src/server/tasks/transitions.ts`, unit-tested:

- Attached work settles green → a root task always moves to `in_review`: Done
  means somebody accepted the work, so only a verdict or a hand reaches it. The
  effective review policy decides who judges — enabled starts the configured
  reviewer, disabled waits for a person. A subtask whose own review is off
  moves to `done` on its own: its delivery is judged by the parent's final
  review, and a chain that stopped for a verdict at every phase would not be a
  chain. The task override wins over the parent's, which wins over the board
  default.
  - Workflow-dispatched agents attach without observers; the last step
    settling is the signal, so a 3-step workflow does not move the task on
    step 1. Each attachment stores whether the workflow or the attachment
    transition owns completion, so daemon restart recovery preserves that
    boundary. Reviewer links restore the review observer instead of a worker
    observer.
  - Manually attached agents (RPC/MCP `attach_task_agent`) get an observer per
    attachment, re-armed at daemon boot. The task advances only from
    `in_progress` and only after every attached worker has stopped running, so
    a stale finish cannot pull a manually moved card or race a sibling worker.
- Review verdict: approve → `done`; reject → the task's effective
  `review.onReject`, default
  `in_progress`. A rejection sent back to work resumes **every** attached worker
  with the review feedback and returns to review after the correction — the
  review judged the integrated branch, so findings can belong to any worker that
  fed it. The task can
  override the board's correction limit (default 3, maximum 10); exhausting it
  leaves the card in review for a human. Exposed as RPC, card menu, detail
  sheet, and MCP
  `review_task`. If no worker can be resumed, the card returns to review
  with the failure in the feed; it never stays in Working with no correction
  running.
- **[DECIDED]** A reviewer cannot start without the task tools: when the
  daemon is not injecting its MCP server into agents, starting one would
  produce a review that cannot record its verdict, so the board refuses and
  says why in the feed instead of burning the run.
- **[DECIDED]** A reviewer that ends without a verdict strands its findings in
  a chat nobody reads. Its final message is posted to the task feed, so a
  human can turn it into a rejection with feedback — the findings reach the
  workers either way.
- **[DECIDED]** A card sitting in review with no live reviewer offers one
  gesture — Start review — on the card menu and the detail sheet, the same
  arming a manual move into review performs.
- A reviewer that ends without a verdict is recorded in the feed and replaced
  once; the second one ending the same way leaves the card to a human. A
  reviewer that neither answers nor stops is cancelled at a 30-minute ceiling
  and counts as an ending. A board that names a reviewer preset it no longer has
  says so on the card instead of quietly falling back to human review.
- A review checkout is released as soon as its reviewer stops, verdict or not:
  it is a worktree the daemon made for one judgement on the task branch, and the
  findings live in the feed. Worker checkouts still follow
  `archiveWorkspacesOnDone`.
- Failure moves nothing. The task stays `in_progress` and the card shows it.
- Manual moves write the same stored field through the same RPC, so automation
  and hand cannot disagree.

**[DECIDED]** Review runs at two levels of the hierarchy (§2.5):

- A subtask's review policy resolves subtask override ?? parent override ??
  board default. The parent tier is new; a plan-wide review mode — final only,
  each subtask and final, each subtask only — writes it, and a per-subtask
  toggle still overrides it.
- A subtask in review is judged on its own task branch. Approve merges it into
  the parent branch and unblocks its dependents; reject resumes its workers
  with the findings, within its own correction limit.
- The aggregate's review is the final review. It starts when the last subtask
  merges and reads the integrated parent branch. Its reviewer receives the
  child verdicts from the feed and judges the integration, not each diff again.
- Rejection corrects on the branch the review judged. A subtask's findings go
  to its workers on the subtask branch. The final review's findings go to the
  aggregate's most recent worker — resumed, or a fresh corrector when none can
  resume — on the parent branch. Subtasks already Done are not reopened. Each
  level counts its own correction rounds against its own limit.

Every automatic move posts to the feed naming what
caused it, and stays reversible by hand. Boards that moved cards silently
shipped ping-pong bugs between In Progress and In Review; attribution plus a
one-move undo is what prevents it.

## 4. Agent access [SHIPPED]

- MCP tools: `create_task_project`, `list_tasks`, `create_task`, `update_task`,
  `comment_task` (agent identity on the comment, with optional delivery to the
  target task's attached agents), `get_task_context` (the caller's live task
  position), `attach_task_agent` (defaults to the calling agent — "I'm taking
  PSE-3"), `review_task`.
  Parity Suite G covers capture→review, self-attach, workflow replace, live
  task context, and cross-card delivery.
- CLI: `paseo task ls|create|move`, by key (`PSE-42`) or id.

### 4.1 Agent awareness [SHIPPED]

An agent the tracker dispatches works inside a machine where statuses move when
it stops, gates open when siblings settle, and review judges what it integrated.
Three pieces expose that machine through the typed event history in §2.4.

- **The briefing.** Every task-dispatched agent — worker, reviewer, corrector,
  preset delegate, scheduled step — gets one standard prompt preamble, built
  in one place, that explains the environment: what the tracker is, what
  finishing its turn triggers (settle → integration → review or done), its own
  position (task key and id, role, step n of m, parent chain, open blockers
  and dependents, the review mode in force), and the exact task tools it may
  use. One builder; the per-role prompts extend it instead of each inventing
  its own fragment.
- **`get_task_context`.** A read tool that returns the live position: the
  task and its status, the caller's role and attachment, the workflow step and
  run under way, sibling subtasks with statuses, blockers and dependents, the
  effective review policy, and the tail of the task's feed. Prompt text goes
  stale the moment a sibling moves; a tool the agent calls at turn start does
  not.
- **`comment_task` gains `deliver`.** Cross-task signalling stays
  board-mediated (§6.1 stands: no agent-to-agent bus) and earns no new tool:
  posting on a card is what `comment_task` already does, on any card in the
  project. The optional `deliver` flag hands the entry to the target task's
  attached agents through the one write primitive (§6) — recipient snapshot,
  delivery outcomes, visible on the board. A worker that finds a blocking
  defect in a sibling's area says so on the sibling's card, where a person can
  see it, not in a private channel. The briefing reserves delivery for what
  blocks or invalidates the recipient's work.

Awareness is pull, not push: the daemon never interrupts a running agent with
board events. The briefing tells the agent when reading the feed or its
context is worth a call — at turn start, before finishing, after a
correction resume.

- **[SHIPPED]** `create_plan` is replaced by `add_task_workflow`,
  `get_task_workflow` and `run_task_step`. The kanban and orchestrator-mesh
  tools are gone. `create_task` takes a `parentTaskId`, and
  `add_task_dependency` / `remove_task_dependency` / `list_task_blockers`,
  `delegate_task` / `list_task_presets` and `read_board_feed` cover the rest.
  Board events reach agents through the feed, not per-agent prompts (§6.1).

## 5. Surfaces

### 5.1 Board page `/kanbans/<id>` [SHIPPED]

- **Header**, in workspace grammar: one `ScreenHeader` row — sidebar toggle,
  project title, `···` menu right beside the title (Ellipsis, hover colour,
  sheet on compact). Right side: the task count. No back arrow; back is the
  sidebar's Kanbans entry. The feed toggle returns with §6.
- **Columns** are the statuses. Canceled appears only when populated. Columns
  flex 264–360 wide and scroll vertically on their own inside one horizontal
  board; compact shows one column behind a scrollable segmented picker.
- **[DECIDED] Threads view** joins the view picker: every attached agent and
  untracked chat in the project as one live list, grouped by task, newest
  activity first — role, model, exact execution state, last update. A row
  opens the chat. The board answers "where is everything", Threads answers
  "what is running right now"; same data, third projection, no route of its
  own. This is the surface synara gets right — threads nested and always
  visible — and cards alone do not give.
- **View picker** switches between Kanban and Tasks in place. Tasks is the same
  project data grouped by status as dense rows, with one capture action and the
  same detail and menu actions as cards. Search, status/priority/label filters,
  sort, direct status and priority controls, and scroll position are shared
  surface preferences and persist per board. Filtering changes the projection,
  never the stored task set. It has no route or task data of its own.
- **Card**: key, priority label (colour-coded urgent/high), title, label chips,
  direct subtask/blocker counts, and a compact execution summary from every
  exact attached agent. The summary preserves actionable states — needs input,
  failed, starting, working, ready to review, step complete, done — instead of collapsing
  several agents to one workspace status. A press opens the detail sheet
  (§5.4). Kebab and right-click context menu carry the same list: Details,
  Approve/Reject when in review, Add agent plan, Open agent per attachment,
  move-to-status, Delete. Subtasks indent under their parent when the parent is
  in the same column. **[DECIDED]** An aggregate's card shows derived child
  counts — running, ready to review, done — and the board collapses its
  subtasks under it by default. Expanding them into their own columns is a view
  projection toggle, stored with the other surface preferences; the stored
  statuses stay the only column truth.
- **Capture**: every column's "+" opens the minimal sheet — title only. The
  first capture also creates the tracker project, prefilled and linked. Form
  model per [docs/forms.md](forms.md), unit-tested.
- **Untracked work**: standalone root chats in the Paseo project appear in a
  separate rail until a task links their exact agent id. Each row shows its live
  execution state and workspace, opens the chat, and can create a prefilled task
  or attach to an open task through the searchable task picker. Child agents do
  not become separate capture entries. Starting work from a task attaches the
  new agent before it appears on the board.
- **Drag** writes `tasks.move`; the optimistic paint uses the daemon's own
  position arithmetic. Menu move covers platforms without drag. Every column
  is hand-sortable, because order is stored.
- **Sidebar**: full-height right sidebar in the explorer shape — panel-store
  width, viewport clamp, `SidebarResizeHandle`, open state persisted on
  desktop, sheet on compact. Its content is the feed (§6); it reuses the
  panel-store keys the orchestrator pane left behind.

Menu changes: "Add workflow" → "Add agent plan"; "Require review"
becomes a checkmark toggle per [docs/menus.md](menus.md) rather than a menu
item with a swapping label. Review policy is one submenu with reviewer,
rejection target, and correction-round limit. "Create Orchestrator" goes
(§6.1).

### 5.2 Workspace [SHIPPED]

- **Kanban tab kind**: payload-less singleton per workspace, rendering the
  same `TaskBoardSurface` for the workspace's project. Entry points: "Kanban"
  in the tab row's ⌄ menu (pinnable) and a default pinned launcher before the
  terminal. Splittable and draggable like any tab.
- **Explorer sidebar**: has a **Feed** tab beside Changes/Files/PR when the
  workspace's project has a board, following the PR-tab fallback rule. It
  replaced the orchestrator tab that stood there (§6.1).

### 5.3 Global overview `/kanbans` [SHIPPED]

Renders the complete Paseo project directory across hosts, joined to tracker
boards when they exist, so a project does not disappear before its first task.
Each column is a Paseo project/host pair; its cards are read-only, because
acting on a task belongs to the board one press away. Opening an empty project
creates its linked tracker project and enters it. Projects on hosts without the
tasks capability stay visible and say that tasks are unavailable. Unlinked
tracker projects are ignored; a board in Paseo belongs to a registered Paseo
project.

The route is `/kanbans/<taskProjectId>`: a board is a tracker project, so the
same id addresses the column and the board it opens.

### 5.4 Task detail sheet [SHIPPED]

The detail sheet is the task's working surface. Its title and agent brief are
editable in place. It shows comments, labels, due date, subtasks, dependencies,
attachments, agents, the agent plan and review actions. Attached agents are
grouped by workspace; each workspace shows its branch, pull request and every
agent's exact execution state. Automation is summarized in plain language and
expands to task-specific controls; the board menu only sets defaults. The
agent-plan form names steps consistently, places automatic continuation above
the step list, and keeps workspace, evidence, verification command and timeout
behind Advanced. A step with a run opens that run's latest agent chat when its
row is pressed; Run, Cancel and overflow remain separate controls. Rejecting
from the sheet accepts correction feedback that is sent to the resumed worker.
This also settles what a card press does:

- **press → detail sheet, always**, whatever the number of attached agents.
  Attached agents are rows in the sheet; opening a conversation is a tap on a
  row. Today's behaviour — open the chat when exactly one agent is attached,
  silently do nothing otherwise — has no rule a user can learn.

**[DECIDED]** The subtask list stops being title-only. A subtask can be
created with a preset or agent spec and the parallel flag (§2.5), and each row
expands to its live state and review actions — Approve and Reject inline, with
correction feedback on reject. The parent's review control offers the three
modes from §3 and writes the parent tier of the policy.

### 5.5 Presets and delegate [SHIPPED]

A preset is the one-step workflow you do not have to author: pick one on a
card and an agent starts, already attached, in the environment the preset asks
for. It attaches through the tracker, so a blocked task refuses before an agent
or worktree exists rather than after one is running. Workflow dispatch uses the
same preflight and checks again when attaching. Every generated worker or
reviewer prompt carries the task key and id so its task tools have an exact
target.

`project_default` means "where this card is already being worked" — the
workspace an agent on it is using. A card nobody is on gets a worktree like the
other mode; the project root is not a workspace the daemon can attach to.
The task can force ordinary preset delegation to a dedicated worktree or to
reuse its attached workspace. Explicit agent-plan steps keep their own
workspace setting.

The picker is on the detail sheet: one press per preset, disabled while the
card has open blockers — the daemon would refuse anyway, and a button that
throws when pressed is worse than one that says why it cannot be.

## 6. Board feed [SHIPPED]

The board's feed is its durable history. `task_comments` carries notes, agent
updates, system events, and messages rather than opening a second chat room.
Every entry has one kind and an optional task; a task-scoped entry appears in
the task detail and the board feed.

**[SHIPPED]** One write primitive under every surface: an entry on a card,
optionally delivered to its attached agents. `tasks.feed.post`,
`tasks.feed.send_message`, `comment_task` and the system events off the bus
(§2.4) are thin wrappers over it — the wire RPCs stay as they are; what
unifies is the server path, so recipient snapshots, delivery outcomes and
revision bumps cannot diverge between a user's message and an agent's.

- Migration 3 rebuilt the table board-scoped: `project_id` required, `task_id`
  nullable. A comment on a card is an entry with a card; a note at the board is
  one without.
- What lands there: notes typed by a user, agents' `comment_task` updates, every
  automatic transition (naming the card and what caused it), and messages sent
  to selected task agents.
- A note changes no task state and does not notify agents. A message stores its
  recipient snapshot and each daemon delivery outcome (`pending`, `delivered`,
  or `failed`). `delivered` means the daemon accepted the prompt; the protocol
  has no agent read or acknowledgement callback, so the UI never calls it read.
- Ordering is `created_at` then rowid. Two entries in the same millisecond are
  ordinary — a move and the note about it — and ids are random hex, so ordering
  by them shuffled a cause after its effect.
- Read capped at the newest 200, returned oldest-first: a feed reads back, and
  past that the answer is to open the card.
- Surfaces: a resizable right sidebar on the board page (the slot the
  orchestrator pane left, same panel-store width), a sheet on compact, and a
  **Feed** tab in the explorer sidebar when the workspace's project has a
  board. RPCs are `tasks.feed.read`, `tasks.feed.post`, and
  `tasks.feed.send_message`; agents read it with `read_board_feed`.
- Message recipients come from agents attached to the task. A board is not a
  directory of the host, and a message cannot target a stranger. Task keys and
  subtask keys identify work; stable agent IDs identify agents; provider
  subagents remain children of an agent rather than task identities. Agent
  `comment_task` delivery excludes the caller, and refuses when no other
  attached agent remains, so a delivered reply cannot wake its sender again.

### 6.1 No standing team-lead agent — daemon rules instead [DECIDED]

Prior-art research settled this: worktree-per-task is universal; every shipped
product coordinates through the board and none built an agent-to-agent message
bus; only Devin ships a supervisor agent, and the generic manager-agent is a
documented failure mode elsewhere (mis-routing, sequential execution,
overwritten outputs, ~75x the tokens).

- **No Orchestrator agent.** The board stands alone: tracker, attach,
  transitions, feed.
- **[SHIPPED] The supervision that matters is deterministic**, and lives in
  the daemon: a stalled agent (errored or closed without finishing) says so in
  the feed; a task whose blockers are still open refuses an attachment, naming
  them, which is what claiming means; every transition posts what caused it.
  A canceled blocker stops blocking — it is never going to be done.
- **A decomposer agent is a later phase** — turn a task into subtasks with
  agent specs — opt-in per board. Even then it authors no code and issues no
  review verdicts. Review is human, or a verification agent with no
  implementation context.
- **[SHIPPED]** Retired in full: the per-daemon `orchestrators` room, the peer
  rail, `orchestrator-thread-view`, `send_orchestrator_message`, provisioning,
  the orchestrator sidebar pane, the workspace tab kind, the explorer tab, and
  Create Orchestrator.

### 6.2 Task delivery — canonical branches, worker worktrees [SHIPPED]

- A task that runs code owns one durable `paseo/tasks/<key>` branch. Agent
  workspaces are temporary workers; their branches merge into the task branch
  when work settles. Tracker-only tasks create no Git state.
- A root task branch starts from the selected or repository default branch. A
  subtask branch starts from its parent's task branch. Every worker for that
  subtask starts from the subtask branch.
- Review reads the integrated task branch. Approval and a manual move to Done
  use the same completion gate: a subtask reaches Done only after its task
  branch merges into the parent task branch.
- A conflict aborts the merge, moves the task to Working and records the Git
  error in the board feed and task detail. The latest worker receives the
  resolution prompt. Finishing again retries the gate.
- Done is the dependency-unblocking state, so an unintegrated subtask cannot
  unblock its dependents. Depth beyond one level uses the same rule.
- **[DECIDED]** A worktree shared by a subtask chain outlives each subtask's
  Done: `archiveWorkspacesOnDone` runs when the aggregate settles, because the
  next phase still needs the checkout. Parallel phases with their own worktrees
  keep the per-task timing.

## 7. Build order

Each phase leaves the branch green — typecheck, lint, the touched unit tests,
and the board e2e.

1. **Workflow on task** (§2.2) — _first, not second_. The kanban record cannot
   leave the data path while it still holds the plans, so the steps move out
   before the record does. New tracker storage, `TaskWorkflowEngine`, the
   `tasks.workflow.*` and `tasks.step.*` RPCs, the agent tools, and the
   workflow form.
2. **Board is the task project** (§2.1). **Done.**
3. **Event bus and feed** (§2.4, §6). **Done.** Single emission point, room per
   board, `comment_task` mirroring, composer with mention fanout, mesh
   retirement, Feed tab.
4. **Hierarchy and rules** (§2.3, §6.1, §6.2). **Done.**
5. **Detail sheet and delegate** (§5.4, §5.5). **Done.**
6. **Leaf/aggregate model** (§2.3, §2.5, §3 two-level review). Aggregation
   transitions, sequential-default subtask creation, execution spec and
   `on_unblocked` trigger, review inheritance tier and modes, correction per
   level, shared-worktree release, board collapse projection, subtask rows in
   the sheet.

## 8. Invariants

- Store intent, derive everything else. Task status is stored; agent liveness
  and run outcomes are read, never copied.
- A leaf executes, an aggregate aggregates. Workers attach to leaves; a task
  with subtasks is moved by its children through the transition engine, never
  by workers of its own.
- One destination per object. The kanban is the tasks' board view; no parallel
  route or screen shows the same thing.
- The protocol stays backward compatible. The tracker gates on
  `server_info.features.tasks`; per-task automation gates separately on
  `server_info.features.taskExecutionPolicy`. Compatibility shims are only for
  shapes a released peer can actually produce.
- Steps keep their hard gates. No second cron engine. Workspaces remain the
  source of truth for execution.
- Coordination composes what exists — agents, chat store, board. No new
  messaging subsystem, and no agent-to-agent bus.
