# Kanban

Orchestration overlay on **Project**. Workspaces stay the source of truth of
execution; the kanban only references them. Terms live in
[glossary.md](glossary.md). The shipping plan that produced this layer is
[kanban-workflow-stacking-plan.md](kanban-workflow-stacking-plan.md) — delete
that file once nothing in it remains undocs'd here or in data-model.

## Layering

- **Lower layer:** Workspace (cwd, agents, archive, FS). Unchanged ownership.
- **Overlay:** one Kanban per project (v1), Plans in Columns, optional
  Orchestrator workspace linked from the kanban record.
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
3. Sidebar grouping "Kanban" — columns then Unbounded — gated on host feature
   `kanban`.
4. `/kanbans` view — board per project kanban; host badge when multi-host.
5. "Create Orchestrator" — provisions a **local** workspace on the **project
   root** (not a worktree). The Orchestrator steers via tools and chat; it does
   not need checkout isolation for code edits.

## Soft columns, hard steps

Moving a Plan between columns is soft (no execution effect except declared
column automations). Step gates are hard: the next step cannot start until the
previous succeeded or was skipped.

Three movers exist: user (DnD / move menu), agent (self-placement via tools),
lifecycle sync (`autoAdvance`). **User gesture always wins** — recorded on
`lastMove.by`. Never let an automatic move undo a recent user drag.

## Orchestrator mesh

Same-daemon Orchestrators discover each other via
`kanban.orchestrator.list_peers`. Messaging reuses the chat store: one room
named `orchestrators`, directed asks via `@mention` of the peer's primary
agent. Messages are steering, not dispatch — "take this plan" still goes through
kanban tools. Cross-host peers are visible read-only in the app rail; daemon
messaging stays host-local in v1.

In the app, an Orchestrator workspace gains an **Orchestrator** tab (menu ⋯ →
Open Orchestrator when that workspace is linked). The pane reuses
`KanbanBoardSurface` (same board as `/kanbans`, including web cross-column DnD)
plus an Orchestrators rail that opens the host's `orchestrators` chat thread.

## Client data

TanStack Query + push-router domain `kanban` (subscribe / `kanban.update`), same
shape as schedules — not a new `SessionState` map. Gate every entry point on
`server_info.features.kanban`. Feature contract: gate once, then run or tell the
user to update the host — no silent fallbacks.

Sidebar kanban grouping derives column membership client-side from plan step
workspace refs (`existing` + `runs[].workspaceIds`). Nested-kanban children map
to the top-level card's column. Plans with no workspaces yet stay invisible in
the sidebar (execution-centric); planning lives in `/kanbans`.

## Persistence

`$PASEO_HOME/kanbans/{kanbanId}.json` — see [data-model.md](data-model.md).
Protocol: `packages/protocol/src/kanban/`. Engine: `packages/server/src/server/kanban/`.

## Hard-outs

Things that break the layering (not scope trims): replacing Workspace as SoT of
execution, a second cron engine, treating Columns as hard gates, a parallel IM
system for Orchestrators, or nesting deeper than depth 2.
