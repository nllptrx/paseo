# Tracker + Kanban — branch spec (design/workflow-stacking)

Working spec for review. Every section is tagged: **[SHIPPED]** is on the
branch and tested; **[DECIDED]** is agreed direction, not yet built;
**[IN PROGRESS]** is started but not landed; **[PROPOSED]** is my intended
next step, not built; **[OPEN]** needs your decision. Edit anything — this
file is the contract for what happens next.

## 1. Vision

One tracker, one board, one kind of chat. A **Task** is the unit of work
(bb-style: `PSE-42`, stored status, priority, labels, comments, for source of
truth check: get-bb/bb). The **kanban is the board view of tasks** —
columns are the stored statuses, never a second object with its own route.
Execution (plans, agents) attaches to tasks and is always derived, never
copied. Agents work the tracker through MCP tools; the board writes back to them.
The **Orchestrator is a plain agent** that hears board events; agent↔agent
coordination goes through the board (the bacheca), not through a parallel
messaging system. For kanban, this is source of truth Emanuele-web04/synara.
For the orchestration the architecture icould be either classic or a graph.

## 2. Data model [SHIPPED]

- SQLite at `$PASEO_HOME/tasks.db` (`node:sqlite`). Tables: task_projects,
  tasks, labels(+links), comments, attachments, task_agents, presets, revision
  counter bumped by triggers.
- **Stored** (intent): status `backlog|todo|in_progress|in_review|done|canceled`,
  priority, labels, due date, fractional position (`POSITION_STEP=1024`,
  neighbours sent by client, daemon picks the number).
- **Derived** (execution): attached agents' live state read off the agents;
  plan columns computed from step runs (`derivePlanColumn`), never stored.
- Task project ↔ Paseo project via `paseoProjectId`; prefix unique per host.
- Kanban record (JSON, unchanged engine) gains `review: { enabled, onReject }`
  and plans gain optional `taskId`.
- Sync: push `tasks.update { revision }`; client at same revision does nothing,
  behind refetches. Push-router domain `tasks` registered app-side.

### 2.1 The board IS the task project [DECIDED]

`StoredKanban` retires. There is one board-shaped object: the task project.

- `review`, `archiveWorkspacesOnDone`, and the Orchestrator association move
  onto `task_projects` (SQLite). The kanban JSON record and its get-or-create
  dance go away.
- `/kanbans/<id>` resolves to the project's board; the feed room and board
  events key on the task project, not a kanban id.
- No migration: pre-branch plan boards break. The `tasks` feature gate has
  never shipped in a release, so there is no released peer to shim for — no
  COMPAT code, no one-shot migration.

### 2.2 Workflow-on-task [DECIDED]

Plans stop being objects. The step machine (agent specs, workspace strategy,
triggers, hard gates, schedules) survives unchanged but re-homes: **steps
attach to a task**. Plan `title`/`description` and nested plans die — the task
is the only unit of work. "Add plan" becomes "Add workflow" on the card.
`derivePlanColumn` dies with them: the task's stored status plus the
transition engine are the only column truth.

Tasks gain `parentId` (subtasks) and dependencies (`blocks`/`blocked-by`) in
SQLite — the dependency gate (§6.1) and the stacked-branch mapping read them.

### 2.3 Board event bus [PROPOSED]

One emission point for board events (task created/moved/settled/approved/
rejected), three consumers: the feed room post (§6), the Orchestrator
system-notification prompt, the `tasks.update` push. Today these are three
independent writes; §6 becomes a consumer, not a second system.

## 3. Automatic transitions [SHIPPED]

`packages/server/src/server/tasks/transitions.ts` (unit-tested):

- Attached work settles green → task moves to `in_review` if the board's
  `review.enabled`, else `done`.
  - Plan-dispatched agents: attached WITHOUT observers; the plan's last step
    settling is the signal (a 3-step plan must not move the task on step 1).
  - Manually attached agents (RPC/MCP `attach_task_agent`): observer per
    attachment, re-armed at daemon boot, fires once per finish (a task pushed
    back to work moves again on the next finish).
- Review verdict: approve → `done`; reject → `review.onReject` (default
  `in_progress`). Exposed as RPC, card menu, and MCP `review_task`.
- Failure moves nothing — stays `in_progress`, shows on the card.
- Manual moves write the same stored field through the same RPC: automation
  and hand cannot disagree.

## 4. Agent access [SHIPPED]

- MCP tools: `create_task_project`, `list_tasks`, `create_task`, `update_task`,
  `comment_task` (agent identity on the comment), `attach_task_agent`
  (defaults to the calling agent — "I'm taking PSE-3"), `review_task`.
  `create_plan` accepts `taskId`. Parity Suite G covers capture→review and
  self-attach.
- CLI: `paseo task ls|create|move` (by key `PSE-42` or id).
- Board events → the board's Orchestrator agents as system-notification
  prompts (`sendPromptToAgent`): settled→in_review/done, approved, rejected.
  Superseded by §6/§6.1: with no standing Orchestrator, the consumer that
  prompts agents retires; events go to the feed room and the push instead.

## 5. Surfaces — UI/UX

### 5.1 Board page `/kanbans/<id>` [SHIPPED]

- **Header** (workspace grammar): one `ScreenHeader` row — sidebar toggle,
  project title, `···` menu (Ellipsis, hover color, sheet on compact) right
  beside the title. Right side: task count + Orchestrator toggle. No back
  arrow (back = sidebar "Kanbans" entry). Menu: Add plan, Require review
  toggle, Create Orchestrator.
- **Columns** = statuses, Canceled only when populated; flex 264–360 wide,
  horizontal scroll; compact shows one column behind a scrollable segmented
  picker.
- **Card**: key, priority label (color-coded urgent/high), live StatusBucketDot
  from attached agents, title, label chips. Press opens the conversation when
  exactly one agent is attached. Kebab + right-click ContextMenu (same list):
  Approve/Reject when in review, Add plan (binds the plan form to the task),
  Open agent per attachment, move-to-status entries, Delete.
- **Capture**: every column's "+" opens the minimal sheet (title only; first
  capture also creates the tracker project, prefilled + linked). Form model
  per docs/forms.md, unit-tested.
- **Drag**: writes `tasks.move`, optimistic paint uses the daemon's own
  position arithmetic; menu move for no-drag platforms. Every column is
  hand-sortable (order is stored — unlike the plan board).
- **Orchestrator sidebar**: full-height right sidebar (explorer shape) —
  panel-store width, viewport clamp, `SidebarResizeHandle` drag, open state
  persisted on desktop; sheet on compact. Content: see 5.4/6.

### 5.2 Workspace [SHIPPED]

- **Kanban tab kind**: payload-less singleton per workspace, renders the same
  `TaskBoardSurface` for the workspace's project. Entry points: "Kanban" in
  the tab row's ⌄ menu (pinnable) and a default pinned launcher before the
  terminal. Splittable/drag like any tab. `/kanbans` stays as cross-project
  overview.
- **Explorer sidebar**: gains an **Orchestrator** tab beside Changes/Files/PR,
  visible when the project has a board; unavailable-tab fallback follows the
  PR-tab rule. Per §6 the tab renames to **Feed** and renders the board
  channel.

### 5.3 Overview `/kanbans` [DECIDED via 2.1/2.2]

With plans gone there is no second vocabulary: the overview renders tasks per
project. Falls out of the board-is-the-project rework, not a separate build.

### 5.4 Orchestrator chat [SHIPPED — superseded by §6]

The sidebar currently mounts the real agent chat (registered agent panel
inside a sidebar-scoped PaneProvider). Per §6 it becomes the board feed; the
pane, the `orchestrator-thread-view`, and the Create Orchestrator entry
retire. Opening any agent's full chat is a tap on its feed item.

## 6. Board feed — "Slack channel per board" [DECIDED]

A real channel per board, on the existing chat store.

- One room per board, deterministic name keyed on the task project (§2.1).
- What posts there:
  - working agents' task comments (mirrored from `comment_task`, author = agent),
  - board events from the event bus (§2.3): task created/moved/settled/
    approved/rejected — every automatic transition attributed and reversible
    by hand (the flip-flop bug other boards shipped came from silent,
    unattributed moves),
  - agent finish notes, carried on the settle event,
  - you, from the sidebar composer — **posting as yourself**; `@mention`
    fanout prompts the mentioned agent (mechanism exists).
- The sidebar (board page + explorer tab) is the feed and nothing else:
  Slack-like — author, timestamp, compact event items; tapping an item opens
  the task or the agent's own chat. No Feed|Chat tabs; no agent is special.
- Consequence — full mesh retirement: the per-daemon `orchestrators` room,
  peer rail, bespoke thread-view, `send_orchestrator_message`, and the
  Orchestrator sidebar pane (5.4) all go. The explorer "Orchestrator" tab and
  the board-page toggle become the **Feed** tab/toggle.

## 6.1 No standing team-lead agent — daemon rules instead [DECIDED]

Prior-art research (Vibe Kanban, Conductor, Copilot Mission Control, Linear
agent sessions, Devin Managed Devins, Claude Code agent teams, CrewAI,
blackboard papers): worktree-per-task is universal table stakes; every
shipped product coordinates through the board, none built an agent message
bus; only Devin ships a supervisor agent, and the generic manager-agent is a
documented anti-pattern (CrewAI). Decision:

- **No Orchestrator agent for now.** The board works standalone: tracker,
  attach, auto-transitions, feed.
- **The supervision jobs that matter are deterministic and live in the
  daemon** as event-bus consumers: stall detection (agent idle/erroring/
  waiting-for-input → feed post), dependency gating (a task with unresolved
  deps is unclaimable), attributed transition posts.
- **A decomposer agent (task → subtasks with agent specs) is a later phase**,
  opt-in per board, and even then it never authors code and never issues
  review verdicts.
- **Subtask → git = stacked branches, sibling worktrees.** A subtask's base
  branch is the parent task's branch (not main); its worktree directory sits
  beside — never inside — the parent's; it merges back through the parent
  branch, which merges to main. Maps 1:1 onto stacked PRs. Depth ≥2 allowed,
  not encouraged by the UI.

## 7. Open decisions (besides 6)

1. **Card press with 0 or 2+ agents** — today a silent no-op. Options: task
   detail sheet (not built), agent picker, open the menu.
2. **Task detail sheet** — description/comments/labels/due date are
   wire-complete with no surface. Probably the same sheet solves (1).
3. **Review toggle idiom** — plain menu item with swapping label; menus.md
   wants a checkmark/toggle idiom.
4. **Presets / Delegate flow** — schema exists (`task_presets`), no UI: pick a
   preset on a task → agent spawns attached.
5. **Mesh retirement scope [DECIDED via §6]** — full delete: `orchestrators`
   room, rail, thread-view, `send_orchestrator_message`, orchestrator sidebar
   pane, Create Orchestrator entry.

## 8. Invariants (unchanged)

- Never store what can be derived (plan columns, agent liveness); always store
  intent (task status).
- One destination per object: the kanban IS the tasks' board view; no parallel
  routes/screens for the same thing.
- Protocol stays backward compatible; features gate on
  `server_info.features.{tasks,kanban}`.
- Steps keep hard gates; no second cron engine; workspaces stay the source of
  truth of execution.
- Chat/coordination composes existing primitives (agents, chat store, board);
  no new messaging subsystems.
