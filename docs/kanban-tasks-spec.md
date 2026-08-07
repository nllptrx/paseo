# Tracker + Kanban — branch spec (design/workflow-stacking)

Working spec for review. Every section is tagged: **[SHIPPED]** is on the
branch and tested; **[IN PROGRESS]** is started but not landed; **[PROPOSED]**
is my intended next step, not built; **[OPEN]** needs your decision. Edit
anything — this file is the contract for what happens next.

## 1. Vision

One tracker, one board, one kind of chat. A **Task** is the unit of work
(bb-style: `PSE-42`, stored status, priority, labels, comments). The **kanban
is the board view of tasks** — columns are the stored statuses, never a second
object with its own route. Execution (plans, agents) attaches to tasks and is
always derived, never copied. Agents work the tracker through MCP tools; the
board writes back to them. The **Orchestrator is a plain agent** that hears
board events; agent↔agent coordination goes through the board (the bacheca),
not through a parallel messaging system.

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
  PR-tab rule.

### 5.3 Overview `/kanbans` [OPEN]

Still renders **plan** cards per project column while the board shows tasks —
two vocabularies one click apart. Options: (a) switch overview columns to
tasks, (b) keep plans and label it as the execution overview. Not decided.

### 5.4 Orchestrator chat [SHIPPED, being superseded by §6]

The sidebar mounts the **real agent chat** (registered agent panel inside a
sidebar-scoped PaneProvider — AgentStreamView + Composer, the normal
composer). The bespoke `orchestrator-thread-view` is out of the loop.

## 6. Board feed — "Slack channel per board" [IN PROGRESS — your pick]

Your chosen model: **a real channel per board**, on the existing chat store.

- One room per kanban, deterministic name (`kanban:<kanbanId>`).
- What posts there:
  - working agents' task comments (mirrored from `comment_task`, author = agent),
  - board events (task created/moved/settled/approved/rejected) as system
    posts,
  - the Orchestrator's messages,
  - you, from the sidebar composer; `@mention` fanout prompts the mentioned
    agent (mechanism exists).
- The sidebar (board page + explorer Orchestrator tab) renders this channel as
  a Slack-like feed: author, timestamp, event items compact; tapping an item
  opens the task or the agent chat.
- The Orchestrator agent still receives events as system notifications (so it
  can act without polling the room).
- Consequence: the per-daemon `orchestrators` room, peer mesh rail and
  mention-only steering become redundant → retire after this lands.

**[OPEN] within §6**: (a) does the composer post as "you" into the room, or
always steer the Orchestrator? (b) do agent finish-notes auto-post, or only
explicit `comment_task`? (c) does the sidebar replace the agent chat (5.4)
entirely, with the Orchestrator's own chat one tap away, or are they two tabs
(Feed | Chat)?

## 7. Open decisions (besides 5.3 and 6)

1. **Card press with 0 or 2+ agents** — today a silent no-op. Options: task
   detail sheet (not built), agent picker, open the menu.
2. **Task detail sheet** — description/comments/labels/due date are
   wire-complete with no surface. Probably the same sheet solves (1).
3. **Review toggle idiom** — plain menu item with swapping label; menus.md
   wants a checkmark/toggle idiom.
4. **Presets / Delegate flow** — schema exists (`task_presets`), no UI: pick a
   preset on a task → agent spawns attached.
5. **Mesh retirement scope** — delete `orchestrators` room, rail,
   thread-view, `send_orchestrator_message`, or keep dormant behind the
   feature flag.
6. **Overview** — see 5.3.

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
