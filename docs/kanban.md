# Kanban

Orchestration overlay on **Project**. Workspaces stay the source of truth of
execution; the kanban only references them. Terms live in
[glossary.md](glossary.md). The shipping plan that produced this layer is
[kanban-workflow-stacking-plan.md](kanban-workflow-stacking-plan.md) — delete
that file once nothing in it remains undocs'd here or in data-model.

## Layering

- **Lower layer:** Workspace (cwd, agents, archive, FS). Unchanged ownership.
- **Overlay:** one Kanban per project (v1), a set of Plans, and any number of
  Orchestrator workspaces, which the kanban does not record — they carry its id
  on their agent labels. Columns are not stored — see below.
- **Unbounded:** workspaces not referenced by any active Plan. Default sidebar
  experience is exactly today's status/project grouping — a user who never opts
  in never sees a board.

Do not invent a parallel execution path. Steps dispatch through the same agent
create + labels + completion observation schedules already use. Timed steps
materialize real Schedules (`maxRuns: 1`); there is no second cron engine.

## Progressive disclosure

1. Default sidebar (`project` | `status`) — zero kanban UI.
2. "Add to Kanban" on a workspace/project menu lazily creates the project's
   kanban and (from a workspace row) a one-step manual workflow Plan with
   `existing` workspace strategy.
3. `/kanbans` — overview, one column per project, running work first, gated on
   host feature `kanban`. Opening a project goes to `/kanbans/<kanbanId>`, its
   three-column board. The sidebar has no kanban grouping: it is for watching
   status, and the board is somewhere you go.
4. "Create Orchestrator" — provisions a **local** workspace on the **project
   root** (not a worktree). The Orchestrator steers via tools and chat; it does
   not need checkout isolation for code edits.

## Derived columns, hard steps

A Plan's column is computed from its step runs, never stored: no runs is
`draft`, every step settled successfully is `done`, anything else is
`inProgress`. `derivePlanColumn` in `packages/protocol/src/kanban/derive.ts` is
the single definition, shared by app, CLI and daemon.

This is why there is no move RPC, no `lastMove`, and no lifecycle sync. A stored
column is a second copy of execution state that something has to push back after
every finish, and it lies whenever that push is missed.

Failure is not a column. A failed run still belongs to work in progress;
splitting it out doubles the places a card can hide. Surfaces show it as status
on the card instead.

Step gates stay hard: the next step cannot start until the previous succeeded or
was skipped.

Surfaces offer only the step actions the daemon would accept, from
`resolveStepActions` in `packages/app/src/kanban/step-detail.ts`: a step that has
never started offers Run, one whose last run failed offers Retry (which reuses
the workspace it failed in, so Run is not also offered), one still going offers
Cancel, and one that succeeded or was skipped offers nothing. Skip survives a
closed gate; Run and Retry do not. A disabled button that can never become
enabled is a worse answer than no button.

Dragging means one thing: a draft dropped on the running column runs its first
unfinished step. Dropping on Done says so and does nothing. Draft order is the
only hand-set ordering, and it is a client-side view preference
(`kanban-draft-order-store`); the other columns order by recency.

The one automation left is `archiveWorkspacesOnDone`, per kanban and off by
default: once a plan's last step settles, the worktrees its steps created are
archived. Shared and pre-existing workspaces are never touched.

## Orchestrator mesh

Same-daemon Orchestrators discover each other via
`kanban.orchestrator.list_peers`. Messaging reuses the chat store: one room
named `orchestrators`, directed asks via `@mention` of the peer's primary
agent. Messages are steering, not dispatch — "take this plan" still goes through
kanban tools. Cross-host peers are visible read-only in the app rail; daemon
messaging stays host-local in v1.

Two surfaces reach that thread, and they answer different questions.
`/kanbans/<kanbanId>` carries a pane beside the board listing **this board's**
Orchestrators — derived by filtering the peer listing to the board's host and id
— and opens straight into the conversation when there is only one. An
Orchestrator workspace gains an **Orchestrator** tab (menu ⋯ → Open
Orchestrator) that reuses `KanbanBoardSurface` plus a rail of the **other**
boards' Orchestrators, for steering across boards.

Both run the same conversation: `useOrchestratorPeerThread` plus the message
list and composer in `orchestrator-thread-view.tsx`. A peer row is titled by its
agent title, because every Orchestrator on one board shares the board's name.

## Client data

TanStack Query + push-router domain `kanban` (subscribe / `kanban.update`), same
shape as schedules — not a new `SessionState` map. Gate every entry point on
`server_info.features.kanban`. Feature contract: gate once, then run or tell the
user to update the host — no silent fallbacks.

"Add to Kanban" resolves a workspace to a plan through its step workspace refs
(`existing` + `runs[].workspaceIds`) so it can tell whether a board already
covers that workspace.

## Persistence

`$PASEO_HOME/kanbans/{kanbanId}.json` — see [data-model.md](data-model.md).
Protocol: `packages/protocol/src/kanban/`. Engine: `packages/server/src/server/kanban/`.

## Hard-outs

Things that break the layering (not scope trims): replacing Workspace as SoT of
execution, a second cron engine, storing a column so it can disagree with what
ran, a parallel IM system for Orchestrators, or nesting deeper than depth 2.
