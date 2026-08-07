# Kanban / Workflow stacking — plan

Product and engineering plan for the kanban/workflow orchestration layer. This is a plan doc: once shipped, its durable content moves into `docs/kanban.md`, `docs/glossary.md`, and `docs/data-model.md`, and this file is deleted.

## 1. Executive summary

Paseo gains an orchestration overlay on Project: each project can have one **Kanban** — a board whose cards are **Plans**, ordered in columns. A Plan is either a **Workflow** (an ordered pipeline of **Steps**, each running agents on a Workspace, with hard gates between steps) or a **nested kanban** (one level deep, children workflow-only). Workspaces stay the source of truth of execution; the overlay only references them. Work not on any kanban is **Unbounded** and keeps today's exact sidebar experience — the default user never sees a board.

Each Kanban can have an optional **Orchestrator**: a normal Workspace used as the control plane, whose primary agent session steers the board through the same kanban tools users have. Orchestrators on a daemon see each other with live status and message each other over the existing chat rooms — coordination between control planes, not a second dispatch path. Cards carry live execution status derived from workspace status buckets; agents can place their own Plan in the right column when they finish; and the user can always drag any card anywhere — a user gesture beats every automatic move.

Everything persists daemon-side under `$PASEO_HOME/kanbans/`, speaks dotted-namespace RPCs behind a `kanban` feature flag, reuses the existing Schedule store for timed steps (no second cron engine), reuses `createAgentCommand` + agent labels + the agent-manager completion rule for dispatch, and reuses chat rooms for orchestrator messaging. It ships with CLI and MCP surfaces. v1 is the complete feature: automations, multi-agent dispatch, nested depth 2, rich Kanbans view, Orchestrator mesh. The hard-outs are a short list of things that would break the layering, not scope trims.

## 2. Glossary

Canonical entries now live in `docs/glossary.md` and the durable layering notes in `docs/kanban.md`. The definitions below stay as the plan's working copy until this file is deleted.

- **Kanban** — Per-project board organizing Plans in ordered columns. One kanban per project in v1, created lazily on first use. Daemon-local: it lives on one daemon and can only reference that daemon's workspaces. UI: "Kanban" / "Kanbans" (the view). Forbidden: "Board" as UI label.
- **Plan** — A card on a kanban. Exactly one of two kinds: `workflow` or `nested_kanban`. Has a column position and an order within the column, and shows live execution status (workspace status buckets + step progress) beside its declared column. UI: "Plan". Forbidden: "Card", "Ticket", "Task" as UI labels ("card" may appear in docs describing the draggable visual, never as the entity name).
- **Workflow** — Plan kind: an ordered pipeline of Steps with hard gates — a step cannot start until the previous one succeeded or was skipped. UI: "Workflow".
- **Step** — One stage of a Workflow: a prompt, one or more agent specs, a workspace strategy, and a trigger. Running a step creates agent sessions. UI: "Step". Forbidden: "Stage", "Phase" as UI labels.
- **Nested kanban** — Plan kind: a board inside a card, maximum depth 2 (project kanban → nested kanban → stop). Its children are Plans restricted to kind `workflow`. UI: "Nested kanban".
- **Orchestrator** — A normal Workspace linked to one Kanban as its control plane: board and chat in one surface, with a primary agent session that steers the kanban through the kanban tools. Optional and lazily created; at most one per kanban in v1. Not a workspace kind — the link lives on the kanban record and the primary agent carries the labels `paseo.kanban-orchestrator` and `paseo.kanban-id`. UI: "Orchestrator". Forbidden: "Commander", "Manager", "Conductor".
- **Unbounded** — Workspaces not referenced by any active Plan on that daemon. In kanban-grouped surfaces they appear under an "Unbounded" section grouped by workspace status bucket — which is exactly today's status experience. UI: "Unbounded". Derived client-side; never persisted.
- **Column** — Ordered progress state on a kanban. Soft: moving a card between columns has no execution effect except declared column automations. UI: "Column".

"Peer" is not a UI label. Docs and code comments may say "peer" for the symmetric relationship, but the UI always names the concrete entity: another **Orchestrator** in the peer rail, a **Plan** on the board.

### Collision notes

- **Plan vs provider Mode `plan`.** `docs/glossary.md` defines Mode as provider-specific (`plan`, `default`, …). In UI copy and docs, the provider mode is always "Plan Mode" or "mode", never bare "Plan". In code, never export a bare `Plan` type: the entity is `KanbanPlan` (protocol and server), avoiding collision with `modeId: "plan"` call sites.
- **Workflow vs product-discussion "workflow".** The glossary's Product discussion entry uses lowercase "workflow" for a user's practice. The entity is capital-W Workflow and only ever appears as a Plan kind. Docs referring to user practices keep lowercase and rephrase where ambiguous.
- **Step run vs forbidden "Run".** "Run" is forbidden as an Agent synonym (`docs/glossary.md:10`). A **step run** is one execution attempt of a Step (same relationship as `ScheduleRun` to Schedule) and is always written qualified: "step run", never bare "run" for an agent.
- **Status vs Column.** Workspace status buckets ("Needs input", "Working", …) are live activity; Columns are declared progress with user-chosen names. The card's status badge uses bucket vocabulary; the column header uses the user's name. Never mix the vocabularies in one control.
- **Dead `packages/server/src/tasks/` module.** An unwired task-graph prototype (`FileTaskStore`, zero non-test references) overlaps conceptually and uses forbidden "Task" naming. It is not reused; flag it for deletion in a separate cleanup PR.

## 3. Object model

One kanban file per project kanban. Plans embed their workflow/nested body; step runs embed inline like `ScheduleRun` does, capped.

```
Kanban            (kbn_<8 hex>)
├── projectId     FK → projects/projects.json (host-local, prj_*)
├── name, createdAt, updatedAt, archivedAt
├── autoAdvance   boolean — workflow lifecycle moves cards (see §5 automations)
├── orchestrator  { workspaceId, agentId } | null — the control-plane link
├── columns[]     Column { id (col_<8 hex>), name, role, onCardEnter, archiveWorkspacesOnEnter, planIds[] }
└── plans         Record<planId, KanbanPlan>

KanbanPlan        (pln_<8 hex>)
├── title, description?, createdAt, updatedAt, archivedAt
├── lastMove      { at, by: "user" | "agent" | "sync" } | null — feeds the move-precedence rule (§5)
└── body          discriminated union on "type"
    ├── { type: "workflow", steps: Step[] }
    └── { type: "nested_kanban", columns[], plans: Record<planId, KanbanPlan(workflow-only)> }

Step              (stp_<8 hex>)
├── name, prompt
├── agents[]      StepAgentSpec { provider, model?, modeId?, thinkingOptionId?, featureValues?, promptOverride? }   (1..N)
├── completion    "all"            (v1: only value; step succeeds when every agent finishes without error)
├── workspace     StepWorkspaceStrategy
│     { mode: "reuse_previous" } | { mode: "existing", workspaceId } |
│     { mode: "worktree" } | { mode: "worktree_per_agent" }
├── trigger       { type: "immediate" } | { type: "manual" } | { type: "schedule", cadence: ScheduleCadence }
└── runs[]        StepRun { id, startedAt, endedAt?, status, agentIds[], workspaceIds[], scheduleId?, error? }
                  status: "running" | "succeeded" | "failed" | "interrupted" | "canceled"
```

`StepAgentSpec` reuses the field vocabulary of the schedule new-agent config (`packages/protocol/src/schedule/types.ts:20-51`) minus `cwd`/`isolation` — placement comes from the step's workspace strategy, never from the agent spec.

The Orchestrator adds no new entity: it is a Workspace plus an agent session plus one nullable pointer on the kanban. Discovering peers = reading the daemon's kanbans and resolving each `orchestrator` pointer against the agent and workspace stores.

### Source-of-truth matrix

| Fact                                                                                        | SoT                                                                                   | Kanban layer holds                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace existence, cwd, kind, archive                                                     | Workspace registry (`projects/workspaces.json`, `workspace-registry.ts`)              | `workspaceId` references only; strategy intents                                                                                                                              |
| Agent session state, timeline, attention                                                    | Agent storage + `AgentManager` (`agents/<cwd>/<id>.json`)                             | `agentIds` per step run; agents carry labels `paseo.plan-id`, `paseo.step-id`, `paseo.step-run-id`; orchestrator agents carry `paseo.kanban-orchestrator`, `paseo.kanban-id` |
| Timing / cadence                                                                            | Schedule store (`schedules/<id>.json`, `ScheduleService`)                             | `scheduleId` of the one-shot schedule a timed step materializes                                                                                                              |
| Card placement, column order, plan/step definitions, step-run history, orchestrator pointer | Kanban store (`kanbans/<kanbanId>.json`)                                              | owns it                                                                                                                                                                      |
| Orchestrator messages                                                                       | Chat store (`chat/rooms.json`, `chat-service.ts`)                                     | nothing; the mesh is one chat room                                                                                                                                           |
| Workspace status bucket / live peer status                                                  | Derived from agents/terminals (`agent-state-bucket.ts`, agent `lastStatus`/attention) | never written; columns are plan progress, not workspace status                                                                                                               |
| Unbounded membership                                                                        | Derived client-side (workspaces minus workspaceIds referenced by active plans)        | nothing persisted                                                                                                                                                            |
| Sidebar grouping preference                                                                 | Client device (`sidebar-view-store.ts`, AsyncStorage)                                 | gated on the `kanban` host feature                                                                                                                                           |

Decisions on the open questions:

1. **SoT matrix** — above. The rule: the kanban layer stores references and its own board/pipeline state; it never duplicates a fact another store owns.
2. **Workflow is a Plan kind** (confirmed lean). A workflow does not exist outside a Plan; no standalone workflow registry.
3. **Columns are soft, steps are hard** — spelled out in §5.
4. **Nested card types** — nested children are Plans with `body.type` restricted to `"workflow"`; the Zod schema for the nested body embeds a workflow-only plan schema, so depth 3 is unrepresentable, not just validated away.
5. **Kanbans view and sidebar grouping both ship**; opening a Plan lands on a Workspace (§4).
6. **Persistence is daemon-first** — §6.
7. **Hard-outs** — §7.

## 4. UX / IA

### Default path (unchanged)

Today's sidebar is the default: `SidebarGroupMode = "project" | "status"` (`packages/app/src/stores/sidebar-view-store.ts:5`), workspace rows, status buckets. A user who never opts in sees zero kanban UI. Everything they have is, by definition, Unbounded.

### Power path — entry points (progressive disclosure)

- **"Add to Kanban"** action in the workspace row menu and project header menu. First use on a project lazily creates that project's kanban with the default column template and a workflow Plan wrapping the workspace (one manual step, `existing` workspace). This is the discovery seam — no settings hunt.
- **Sidebar grouping "Kanban"** — third value in the display-preferences grouping menu (`packages/app/src/components/sidebar/display-preferences/menu.tsx:87-93`), shown only when at least one connected host reports the `kanban` feature. Widening the persisted union is safe: the store guard falls back to `"project"` for unknown values, no version bump (`sidebar-view-store.ts:26-28`).
- **Kanbans view** — sidebar header row (next to Sessions and Schedules in `left-sidebar.tsx`), visible when a connected host has ≥1 kanban or the user has used "Add to Kanban". Route `/kanbans`, added via the `/schedules` 5-edit recipe (`packages/app/src/app/schedules.tsx`, `_layout.tsx:889-911`, `shouldShowAppChrome`, `host-routes.ts`, both sidebar variants).
- **"Create Orchestrator"** action on the board header menu of the Kanbans view. One tap provisions a **`local` workspace on the project root** (the main-checkout default for git projects, `docs/product.md`; `createWorkspaceForDirectory`), starts the primary agent session, and links it to the kanban. No worktree: isolation exists to protect the checkout from agent edits, and the Orchestrator steers through kanban tools and chat — it does not edit code. Optional and lazy: a kanban works fully without one; a default user never meets the concept.

### Sidebar, Kanban grouping mode

Sidebar rows stay **workspaces** (reusing `SidebarWorkspaceRow` and all meta-row machinery untouched). Grouping key: the column of the Plan whose steps reference the workspace; nested-child workspaces map to the top-level card's column. Sections in board order per column, then a trailing **Unbounded** section rendered with the existing status-mode renderer (`sidebar-status-list.tsx`). The Orchestrator workspace rows in its project like any other workspace. Plans with no workspaces yet are invisible here — the sidebar is execution-centric; planning lives in the Kanbans view.

### Kanbans view

Aggregate multi-host screen modeled on `schedules-screen.tsx` (host filter, aggregate fetch per host). One board per project kanban; each column a vertical lane. Host badge on the board header when multiple hosts are connected (kanbans are daemon-local; see §8).

- **Cards carry live status.** Every card shows plan title, kind icon, step progress (e.g. "2/5"), and the aggregated status-bucket dot of its workspaces — derived from the same `WorkspaceStateBucket` signals the sidebar uses, never a parallel status vocabulary. The column says where the work is declared to be; the badge says what it is actually doing right now. Nested-kanban cards aggregate their children.
- **Card DnD is a v1 requirement, not a nice-to-have.** Cross-column drag and within-column reorder on desktop/web via the existing `draggable-list` wrapper (`@dnd-kit` on web, `react-native-draggable-flatlist` native). Compact form factor shows one column at a time with a segmented control and a long-press "Move to column" menu. Moves commit through `kanban.plan.move.request`, render optimistically, and reconcile on push; the precedence rule (§5) guarantees a user gesture is never undone by an automatic move.
- **Card open** — workflow Plan: opens a Plan sheet (steps list with per-step status, run/retry/skip/cancel, trigger editor reusing `cadence-editor.tsx`, agent config reusing `AgentControls`); from there, tapping a step run navigates via `navigateToWorkspace` (`navigation-active-workspace-store/navigation.ts:82`). Nested-kanban Plan: drills into the nested board, breadcrumb back.
- **Forms** — plan/step editors follow the non-React form-model pattern with the schedule form as the golden example (`docs/forms.md`, `schedule-form-model.ts` + `use-schedule-form-model.ts`).

### Orchestrator surface

The Orchestrator is its workspace — no new top-level view. Opening it lands on the workspace screen with the primary agent session; the workspace gains two kanban-linked panes:

- **Board pane** — its kanban rendered with the same board component as the Kanbans view, DnD included. The user steers by dragging; the agent steers by tools; both land on the same daemon state and reconcile over the same push.
- **Peer rail** — the other Orchestrators on connected daemons, each with project/kanban name, host badge, and live status (agent `lastStatus`/attention plus its workspace status bucket — the exact signals the sidebar already derives, `agent-state-bucket.ts`). Tapping a peer opens the shared chat thread; the thread header repeats the peer's status so a conversation is glanceable without switching surfaces.

Chat, board, and status are one mesh with three duties: the board is the shared spatial truth, chat is steering, status badges keep both glanceable.

### Client data path

Kanbans use the TanStack Query + push-router pattern like schedules, not a new `SessionState` map: `useKanbans` aggregate hook, `kanbansQueryKey(serverIds)`, a `serverData` domain entry in `push-router.ts` (`RECONNECT_REPAIR_POLICIES` gets a `kanban` entry), pushes only to sessions that sent `kanban.subscribe.request`. Peer status is composed client-side from data the app already holds (agents, workspaces) joined on the kanban's `orchestrator` pointer — no new status RPC.

## 5. Execution semantics

### Columns: soft order

Moving a card between/within columns is a persistence-only act (position), except declared column automations. Card order in a column is user order; it does not schedule anything.

### Steps: hard gates

Step states: `pending → ready → (scheduled) → running → succeeded | failed | interrupted | canceled | skipped`.

- Step _i_ becomes `ready` when step _i−1_ is `succeeded` or `skipped` (step 0 is ready when the workflow starts).
- `trigger.immediate`: ready → dispatch now.
- `trigger.manual`: ready → wait for `kanban.step.run.request` (or MCP/CLI equivalent).
- `trigger.schedule`: ready → the engine materializes a **real Schedule** (`ScheduleService.createOrReplace`) with the step's cadence, `maxRuns: 1`, target `new-agent` carrying labels `paseo.plan-id`/`paseo.step-id`, `archiveOnFinish: false`, and the resolved `workspaceId` (one new optional field on the new-agent config — see §6). Timing SoT stays in the schedule store; no second cron engine. When the schedule's run finishes, the engine evaluates the step outcome and completes/deletes the schedule. Pausing the workflow pauses the schedule via `pause_schedule` semantics.
- Failure: step `failed` halts the workflow at that step. `kanban.step.retry.request` starts a new step run reusing the same workspace(s); `kanban.step.skip.request` marks it `skipped` and opens the gate; `kanban.step.cancel.request` maps to `cancelAgentRunCommand` per agent.
- Daemon restart: boot recovery marks in-flight step runs `interrupted` (the `recoverInterruptedRuns` precedent, `schedule/service.ts:572`); the card stays put; the user retries. No auto-resume in v1.

### Workspace strategies

- Defaults: step 1 `worktree` (a Paseo-owned worktree via `WorkspaceProvisioningService.createWorkspaceForWorktree`, `workspace-provisioning-service.ts:210`), steps ≥ 2 `reuse_previous`. That default is the "stack": sequential steps compounding on one worktree.
- `existing` pins a workspace by id; `worktree_per_agent` gives each agent of a fan-out step its own worktree. `reuse_previous` after a `worktree_per_agent` step is a validation error (ambiguous parent) — the next step must say `existing` or `worktree`.
- The kanban layer never archives, renames, or mutates a workspace except through existing commands, and only when a column automation says so.

### Multi-agent dispatch

A step's `agents[]` fan out concurrently. Each agent is created with `createAgentCommand` (`create-agent/create.ts:173`) — `kind: "mcp"`, `background: true`, `notifyOnFinish: false`, **not** `internal` (these are user-visible sessions that open as tabs in their workspace), labels stamped as above. Completion detection reuses the agent-manager rule — must observe `running`, then `idle` ⇒ finished; `error` ⇒ errored (`agent-prompt.ts:325-373`): extract that observer into a shared helper (e.g. `observeAgentCompletion` in `packages/server/src/server/agent/agent-completion.ts`) used by both `setupFinishNotification` and the workflow engine, instead of duplicating the subtle `hasSeenRunning` logic. `notifyOnFinish` remains the agent-to-agent surface and is untouched. Step outcome under `completion: "all"`: succeeded when every agent finished; failed on first agent error (remaining agents keep running; the engine records the failure and does not kill siblings).

Attention flows through the existing pipeline unchanged: each agent already fires `agent_attention_required` with push notification support; the kanban layer adds no parallel notification channel.

### Who moves a card — precedence

Three movers exist: the user (DnD or move menu), an agent (self-placement via tools), and lifecycle sync. The rules:

- **Self-placement is first-class.** A step agent that finishes its work places its own Plan in the right column (`move_plan`, resolved through its `paseo.plan-id` label) before ending its turn — it does not have to wait for a human drag or for `autoAdvance`. An Orchestrator manages any Plan on its kanban the same way. This is how agents "put themselves in the right state".
- **Explicit beats automatic.** Every move records `lastMove.by` (`user | agent | sync`). Lifecycle sync fires only on a workflow state transition and skips the card if a user or agent moved it after that transition began — sync never overrides an explicit placement.
- **The user always wins.** Among near-simultaneous explicit moves the daemon applies arrival order, but a user gesture is final for that gesture: the client renders it optimistically and the daemon accepts it as the latest move; a concurrent agent move that lands earlier is simply superseded. No lock, no hold window — last user gesture wins, and pushes reconcile every client to the same answer.

### Permissions — who steers what

Enforced in the tool/RPC handlers from the caller's labels (the `requireCallerHeartbeat` and `resolveChildAgentCwd` precedents):

| Caller                                       | Move Plans             | Run/skip/retry/cancel steps | Create/update Plans | Columns, automations, orchestrator link  |
| -------------------------------------------- | ---------------------- | --------------------------- | ------------------- | ---------------------------------------- |
| User (app, CLI)                              | any                    | yes                         | yes                 | yes                                      |
| Orchestrator agent (labels match the kanban) | any Plan on its kanban | yes, on its kanban          | yes, on its kanban  | no (board shape stays human-owned in v1) |
| Step agent (carries `paseo.plan-id`)         | own Plan only          | no                          | no                  | no                                       |
| Any other agent                              | no                     | no                          | no                  | no                                       |

### Automations = column bindings + lifecycle sync

No rules DSL. Two fixed mechanisms, both compositions of existing primitives:

1. **Column bindings** (per column):
   - `onCardEnter: "none" | "start"` — entering the column starts the Plan's workflow (first ready step). Idempotent: an already-running workflow ignores it.
   - `archiveWorkspacesOnEnter: boolean` (default false) — entering the column archives the Plan's Paseo-owned worktree workspaces via `workspace-archive-service.ts`. Never touches `existing`-mode workspaces the user brought.
2. **Lifecycle sync** (kanban-level `autoAdvance`, default on): columns carry an optional `role` (`backlog | active | review | done`). Workflow started → card moves to the first `active` column; all steps succeeded → first `done` column; step failed → card stays, badge on the card. Subject to the precedence rules above.

Default column template: Backlog (`backlog`), In progress (`active`, `onCardEnter: "start"`), Review (`review`), Done (`done`).

### Orchestrator coordination — visibility and messaging

The Orchestrator mesh is Orchestrator↔Orchestrator only in v1; step agents are not in it (they already have `notifyOnFinish` toward a parent and their own workspace surface). Scope: same daemon. Cross-host peers are visible read-only in the app's peer rail (the client aggregates hosts anyway) but daemon-side discovery and messaging stay host-local in v1 — see §8.

- **Visibility** — `list_orchestrators` (MCP) and `kanban.orchestrator.list_peers.request` return, per peer: kanban id and name, project, workspace id, agent id, agent `lastStatus`, attention flags. All read joins over existing stores; nothing new persisted.
- **Messaging composes on chat.** The chat store already has rooms, agent-authored messages, replies, and `@mention` parsing (`chat/rooms.json`, `chat-service.ts:215`, `docs/data-model.md`). v1 uses **one room per daemon**, name `orchestrators`, lazily created when the second Orchestrator appears; directed asks use `@mention` of the peer's primary agent, threads use `replyToMessageId`. Room-per-pair is rejected: it multiplies rooms without adding addressing power that mentions don't already give. The one thin extension chat needs: **mention delivery** — when a message mentions an orchestrator agent, the daemon injects it as a system-notification prompt into that agent (the `formatSystemNotificationPrompt` + `sendPromptToAgent` pattern from `setupFinishNotification`, `agent-prompt.ts:268`). If inspection shows chat already delivers mentions to agents, there is no extension at all. No parallel IM system.
- **Messaging is steering, not dispatch.** "Status?", "take this plan", "hold column X while I land Y" are messages; running work is Steps, timing is Schedules. An Orchestrator asked to "take this plan" acts through the same kanban tools (`move_plan`, `run_plan_step`) — the message never carries execution semantics of its own.

## 6. Persistence & protocol

### `$PASEO_HOME` layout

```
$PASEO_HOME/
└── kanbans/
    └── {kanbanId}.json        # One file per kanban; plans, steps, runs, orchestrator pointer inline
```

Store: `packages/server/src/server/kanban/store.ts`, modeled on `ScheduleStore` (`schedule/store.ts`) — load-once cache like `FileBackedRegistry`, `writeJsonFileAtomic`, per-id mutation serialization. Step runs capped (keep the most recent 20 per step) so files stay bounded. No migrations: optional fields with defaults, per `docs/data-model.md:33`. Orchestrator messages live in the chat store, untouched.

### Zod sketch

`packages/protocol/src/kanban/types.ts` (wire-pure, no transforms):

```ts
const StepRunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "interrupted", "canceled"]),
  agentIds: z.array(z.string()),
  workspaceIds: z.array(z.string()),
  scheduleId: z.string().nullable(),
  error: z.string().nullable(),
});

const StepSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string().min(1),
  agents: z.array(StepAgentSpecSchema).min(1),
  completion: z.literal("all"),
  workspace: StepWorkspaceStrategySchema,
  trigger: StepTriggerSchema, // immediate | manual | schedule{cadence: ScheduleCadenceSchema}
  runs: z.array(StepRunSchema),
});

const LastMoveSchema = z.object({
  at: z.string(),
  by: z.enum(["user", "agent", "sync"]),
});

const NestedPlanSchema = PlanBaseSchema.extend({
  body: z.object({ type: z.literal("workflow"), steps: z.array(StepSchema) }),
});

const KanbanPlanSchema = PlanBaseSchema.extend({
  body: z.discriminatedUnion("type", [
    z.object({ type: z.literal("workflow"), steps: z.array(StepSchema) }),
    z.object({
      type: z.literal("nested_kanban"),
      columns: z.array(ColumnSchema),
      plans: z.record(NestedPlanSchema),
    }),
  ]),
});
// PlanBaseSchema carries id, title, description, timestamps, archivedAt, lastMove: LastMoveSchema.nullable()

const StoredKanbanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  autoAdvance: z.boolean(),
  orchestrator: z.object({ workspaceId: z.string(), agentId: z.string() }).nullable(),
  columns: z.array(ColumnSchema), // Column carries planIds[] for order
  plans: z.record(KanbanPlanSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
```

Depth 2 is structural: `NestedPlanSchema` has no `nested_kanban` arm.

### Schedule extension (the only touch on an existing wire schema)

`ScheduleTargetSchema` new-agent config gains optional `workspaceId` and optional `labels` (`packages/protocol/src/schedule/types.ts:20-51`). Optional additions only — never a new union variant, which would break old-client parsing. Old daemons strip the unknown keys; the client only sends them behind the feature gate. This is a forward feature field, not a shim, so no `COMPAT` removal date — the feature-contract note goes next to the schema.

### Feature gate

`server_info.features.kanban?: boolean` — add to `ServerInfoStatusPayloadSchema.features` (`protocol/src/messages.ts:2846ff`) with the standard `COMPAT(kanban): added in vX.Y` comment, declare `true` in `buildServerInfoStatusPayload` (`websocket-server.ts:1507ff`). One flag covers the whole surface, Orchestrator included — it ships as one feature. App gates every entry point through `useHostFeature(serverId, "kanban")` / `useHostFeatureMap` (`packages/app/src/runtime/host-features.ts`). Per the feature contract: gate once, then run or say "update the host" — no fallback paths.

### RPCs (dotted, verb operations)

`packages/protocol/src/kanban/rpc-schemas.ts`; dispatcher `dispatchKanbanMessage` added to the chain in `session.ts:1822-1840`; `DaemonClient` methods via `sendCorrelatedSessionRequest`.

```
kanban.list.request / .response                — summaries for a host
kanban.get.request / .response                 — one kanban, full
kanban.create.request / .response
kanban.update.request / .response              — name, columns, automations
kanban.archive.request / .response
kanban.plan.create.request / .response
kanban.plan.update.request / .response
kanban.plan.move.request / .response           — columnId + index + movedBy (top-level or nested)
kanban.plan.archive.request / .response
kanban.step.run.request / .response
kanban.step.retry.request / .response
kanban.step.skip.request / .response
kanban.step.cancel.request / .response
kanban.orchestrator.provision.request / .response  — create workspace + primary agent + link, atomically
kanban.orchestrator.unlink.request / .response     — clear the pointer; workspace and agent stay
kanban.orchestrator.list_peers.request / .response
kanban.subscribe.request / .response
kanban.unsubscribe.request / .response
```

Push: `kanban.update` outbound event `{ kind: "upsert" | "remove", kanban | kanbanId }`, sent only to subscribed sessions — old clients never receive an unknown message type. New inbound messages regenerate zod-aot validation per `docs/protocol-validation.md`.

### MCP tools

Registered in the shared catalog (`paseo-tools.ts`), so they are MCP + programmatic + covered by the parity test. Caller scope per the §5 permission table, resolved from the caller's labels.

| Tool                                                 | Available to                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_kanbans`, `inspect_kanban`, `plan_logs`        | any caller                                                                                                                                                 |
| `move_plan`                                          | user-scoped: any; orchestrator: its kanban; step agent: own Plan                                                                                           |
| `create_kanban`, `create_plan`, `update_plan`        | user-scoped; orchestrator on its kanban                                                                                                                    |
| `run_plan_step`, `skip_plan_step`, `retry_plan_step` | user-scoped; orchestrator on its kanban                                                                                                                    |
| `list_orchestrators`                                 | any caller                                                                                                                                                 |
| `send_orchestrator_message`                          | orchestrator agents only — a thin wrapper posting to the `orchestrators` chat room with mention support; reading arrives via mention delivery, not polling |

### CLI

`packages/cli/src/commands/kanban/` mirroring the schedule group (`commands/schedule/index.ts`): `paseo kanban ls|inspect|create|archive|peers`, `paseo plan ls|inspect|create|move|run|retry|skip|logs`. Orchestrator messaging needs no new CLI — the existing `paseo chat` group already reads and posts rooms. Update `cli-surface.test.ts`.

## 7. v1 scope vs hard-outs

**In v1 (the complete mega-feature):** kanban CRUD + columns + card DnD (cross-column and reorder, desktop/web; move menu compact); live status badges on cards; Plans of both kinds; nested depth 2 (workflow-only children); full workflow engine with hard gates, immediate/manual/schedule triggers, retry/skip/cancel, restart recovery; multi-agent dispatch with all four workspace strategies; agent self-placement with the permission model; column-binding automations + lifecycle sync with the precedence rule; Orchestrator provisioning, peer visibility with live status, and chat-room messaging with mention delivery; Kanbans view (multi-host aggregate, compact + desktop); Orchestrator board pane + peer rail; sidebar Kanban grouping + Unbounded; daemon persistence; feature flag; dotted RPCs + subscribe push; MCP tools; CLI group; glossary + docs.

**Hard-outs (each would break an invariant, not trim scope):**

- Anything that makes Kanban required — the default path stays exactly today's sidebar.
- Nested kanban inside nested kanban (depth 3) — structurally unrepresentable.
- A second cron/timing engine — timed steps materialize real Schedules.
- Replacing or wrapping Schedule, Heartbeat, or Loop — they stay independent primitives.
- Client-only board state — every board fact is daemon-persisted.
- Cross-daemon kanbans, plans referencing another host's workspaces, or cross-daemon orchestrator messaging — kanban and mesh are daemon-local; the view aggregates.
- A parallel IM system — orchestrator messaging is the existing chat store plus mention delivery, nothing more.
- Step agents in the peer mesh — Orchestrator↔Orchestrator only.
- A generic automation rules DSL — automations are the fixed column bindings + lifecycle sync.
- Kanban writing workspace status, ownership, cwd, or archive semantics outside existing commands.
- A new workspace kind or schema field for the Orchestrator — the link lives on the kanban record and in agent labels.
- Synara UI cloning — Paseo idioms only (menus per `docs/menus.md`, forms per `docs/forms.md`, tokens per `docs/design.md`).

## 8. Tensions with current Paseo

- **Project is host-local; grouping is cross-host.** `projectKey` groups the logical project across hosts, but a kanban binds to one daemon's `projectId`. Two hosts with the same repo can each have a kanban — and each its own Orchestrator, which cannot message the other in v1 (chat rooms are daemon-local). The app's peer rail still shows cross-host peers with status because the client aggregates hosts; only daemon-side discovery and messaging stay host-local. Merging boards or bridging the mesh across hosts is future work and must never parse `projectKey` (`docs/glossary.md:5`).
- **Columns vs status buckets.** `WorkspaceStateBucket` (`needs_input|failed|running|attention|done`) is derived activity; columns are declared progress. They meet only on the card's status badge. "Ready to review" (bucket label) vs a user's "Review" column is a real confusion risk — the badge uses bucket labels, the column header uses the user's name, and no control mixes the two.
- **Chat mention delivery.** Chat parses and stores `mentionAgentIds` (`chat-service.ts:215`) but delivery into a mentioned agent's prompt must be verified during slice 3; if absent, it is the one chat extension this feature adds, built on the existing system-notification prompt path.
- **Sidebar perf.** Project mode deliberately skips workspace status entries (`sidebar-model.tsx:52-54`, `use-sidebar-workspaces-list.ts:46-55`); Kanban grouping and card status badges need them (like status mode). Follow the status-mode projection path, not the project-mode one.
- **Status mode has no DnD and no per-column order store.** Card order is daemon state (`columns[].planIds`), not a client order store — do not extend `sidebar-order-store.ts` for it.
- **Schedule run workspaces are ephemeral by default.** `executeSchedule` archives the run workspace when `archiveOnFinish ?? true` (`schedule/service.ts:949`); workflow-materialized schedules must set `archiveOnFinish: false` and pass `workspaceId` so the run lands on the step's workspace instead of minting one.
- **Agent labels are the only parent/child mechanism.** Plan/step/orchestrator stamping follows the `paseo.schedule-id` precedent; nothing new in the agent schema.
- **`packages/server/src/tasks/` dead module** — conceptual overlap, forbidden vocabulary; delete separately, don't build on it.
- **Glossary "Agent session opens as a tab".** Step-dispatched agents and the Orchestrator's primary agent are ordinary visible sessions in their workspace tabs — resist making them `internal` like loop workers; observability in the workspace is the point of the layering.

## 9. Implementation phasing inside v1

Slices ship behind the `kanban` feature flag; the feature announces when the whole surface is coherent. No slice drops automations, dispatch, or the Orchestrator mesh from v1 — they land before the UI slice completes.

1. **Protocol + store + service (daemon read/write).** `protocol/src/kanban/*` (including `orchestrator` pointer and `lastMove`), kanban store + `KanbanService` CRUD, feature flag, dotted RPCs + subscribe push, zod-aot regen, `DaemonClient` methods, CLI `kanban ls|inspect|create`. Tests: store unit + RPC round-trip via the ad-hoc daemon harness (`docs/ad-hoc-daemon-testing.md`).
2. **Workflow engine core + self-placement.** Step gates, `immediate`/`manual` triggers, single-agent dispatch through `createAgentCommand`, shared `observeAgentCompletion` extraction, step runs, restart recovery, retry/skip/cancel, labels, move-precedence rule, permission model in the tool handlers (`move_plan` for step agents included). MCP tools + parity test; CLI `plan run|retry|skip|logs`.
3. **Timed steps + dispatch + automations + Orchestrator (daemon).** Schedule materialization (one-shot, `workspaceId` + `labels` config extension), multi-agent fan-out with all workspace strategies, column bindings, lifecycle sync under the precedence rule; orchestrator provision/unlink RPCs, peer listing, `orchestrators` chat room wiring, mention delivery (verify first, extend if absent), `send_orchestrator_message`.
4. **App.** Kanbans view (aggregate + board + DnD + compact variant + card status badges), Plan sheet + forms (golden form pattern), Orchestrator board pane + peer rail with live status + thread entry, sidebar Kanban grouping + Unbounded, "Add to Kanban" and "Create Orchestrator" entry points, push-router domain + reconnect repair, feature gating everywhere.
5. **Docs + QA close-out.** Glossary entries, `docs/kanban.md` (subject doc), `docs/data-model.md` section, CLAUDE.md table row, delete this plan doc; QA evidence per §11.

## 10. Risks, open decisions, recommended defaults

| Risk / decision                        | Default                                                                              | Why                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Board DnD on native                    | Compact = single-column + move menu; cross-column drag desktop/web only              | native drag across horizontal lanes is the classic mobile-board failure; the wrapper supports within-list first |
| Kanban file growth                     | Cap 20 runs per step, oldest dropped                                                 | schedule runs are unbounded today and it shows; don't repeat                                                    |
| Completion-rule drift                  | One shared `observeAgentCompletion`, two consumers                                   | the `hasSeenRunning` subtlety must not fork                                                                     |
| Failed sibling agents in fan-out       | Record failure, let siblings finish, step fails                                      | killing siblings destroys work; user can cancel explicitly                                                      |
| Move conflicts (user vs agent vs sync) | `lastMove.by` + arrival order; sync skips explicitly-moved cards; user gesture final | one simple total order beats lock machinery; pushes reconcile all clients                                       |
| Self-placement scope                   | Step agent: own Plan; Orchestrator: its kanban; board shape human-owned              | agents manage work, humans own structure                                                                        |
| Peer mesh membership                   | Orchestrator↔Orchestrator, same daemon                                               | step agents have `notifyOnFinish`; cross-host needs a chat bridge that doesn't exist                            |
| Messaging topology                     | One `orchestrators` room per daemon, `@mention` for directed asks                    | room-per-pair multiplies rooms without adding addressing power                                                  |
| Orchestrator cardinality               | At most one per kanban in v1                                                         | two control planes on one board is a conflict generator                                                         |
| Orchestrator placement                 | `local` workspace on the project root                                                | worktree isolation protects the checkout from agent edits; the Orchestrator steers, it doesn't edit             |
| Column customization                   | Rename/add/remove/reorder allowed; roles optional                                    | fixed columns fight real teams; roles keep sync simple                                                          |
| Kanban-per-project cardinality         | Exactly one in v1                                                                    | multiple boards per project is IA sprawl; nested kanban covers sub-boards                                       |
| `autoAdvance` default                  | On                                                                                   | the sync is the visible payoff of the overlay; explicit moves still win                                         |
| `archiveWorkspacesOnEnter` default     | Off everywhere                                                                       | destructive-ish; opt-in per column                                                                              |
| Unbounded in Kanbans view              | Yes, trailing rail per board's project                                               | otherwise on-ramp work is invisible in the planning surface                                                     |
| Interrupted runs on restart            | Mark `interrupted`, manual retry                                                     | auto-resume needs idempotency guarantees agents don't have                                                      |
| Code naming                            | `KanbanPlan`, never bare `Plan`                                                      | mode-`plan` collision                                                                                           |

## 11. Test / QA bar

Per `docs/testing.md` (real dependencies, determinism, one behavior per test) and `docs/qa.md` (evidence bar):

- **Store**: unit tests — atomic write, per-id serialization, run capping, archive semantics, orchestrator pointer lifecycle. Run only the changed file: `npx vitest run <file> --bail=1`.
- **Engine**: ad-hoc daemon harness tests — gate progression, manual/immediate/schedule triggers (schedule tests drive `run_schedule_once`), fan-out completion, failure halt, retry-reuses-workspace, restart recovery, cancel; move precedence (sync skips user- and agent-moved cards; arrival order for explicit moves); permission model (step agent cannot move a foreign Plan; non-orchestrator agent cannot message the mesh). Mock provider agents, real stores.
- **Orchestrator mesh**: harness tests — provision links workspace + agent + pointer atomically; peer listing joins live status; a mention in the `orchestrators` room lands as a system-notification prompt in the peer agent.
- **Protocol**: zod-aot regen committed; old-client/new-daemon and new-client/old-daemon drift checks (schedule config extension stripped by old daemons; no unsolicited `kanban.update` to non-subscribers); MCP parity test extended; `cli-surface.test.ts` updated.
- **App**: e2e specs mirroring `schedules-*.spec.ts` — create kanban, add plan, move card, card status badge reflects a running agent, run step lands on workspace, Unbounded grouping, orchestrator peer rail shows a second orchestrator with status, feature-gate hides everything against an old daemon. Form model unit tests (pure TS, no React).
- **QA evidence for the PR set**: platform matrix (iOS, Android, web, Electron) screenshots of the board, compact variant, and orchestrator peer rail; version-drift session (new app ↔ old daemon shows no kanban UI, no errors); DnD interaction video on at least one native platform including a user drag winning over a concurrent agent move; daemon restart mid-step-run recovery shown in `daemon.log`.

## 12. Ready-to-implement checklist

- [ ] `docs/kanban-workflow-stacking-plan.md` merged (this doc) + CLAUDE.md table row
- [ ] Glossary entries drafted (land with slice 5, written during slice 1 for naming discipline)
- [ ] `packages/protocol/src/kanban/types.ts` + `rpc-schemas.ts` (incl. `orchestrator`, `lastMove`, `movedBy`) + messages unions + zod-aot regen
- [ ] `server_info.features.kanban` + COMPAT comment
- [ ] `packages/server/src/server/kanban/` — store, service, workflow engine; bootstrap wiring next to `scheduleService`
- [ ] `observeAgentCompletion` extraction (refactor `setupFinishNotification` to consume it; zero behavior change, tested)
- [ ] Schedule new-agent config: optional `workspaceId` + `labels`; `archiveOnFinish:false` path verified
- [ ] Move-precedence rule + permission model in tool/RPC handlers, tested
- [ ] Orchestrator provision/unlink/list_peers RPCs; labels stamped; `orchestrators` chat room; mention delivery verified or added
- [ ] `dispatchKanbanMessage` in the session chain; `DaemonClient` methods
- [ ] MCP tools in `paseo-tools.ts` (incl. `move_plan` scoping, `list_orchestrators`, `send_orchestrator_message`) + parity test
- [ ] `packages/cli/src/commands/kanban/` + surface test
- [ ] App: route + view, board DnD + status badges, orchestrator surface (board pane + peer rail), sidebar grouping widening, push-router domain, forms, entry points, gating
- [ ] Test suites per §11; QA evidence collected
- [ ] Sweep: `rg -n 'ADR ?\d+'` in source (none expected), `rg "COMPAT\("` entries dated, no bare `Plan` exports

## 13. Task fusion (second wave)

The tracker ([tasks.md](tasks.md)) exists as backend only: SQLite store, RPCs,
`features.tasks`. This wave makes the kanban board its surface and retires the
idea of a Plan as the unit of work. Direction settled 2026-08-07 after building
and deleting a parallel `/tasks` surface twice: the kanban is the destination,
tasks are what it shows.

### Model

- **Card = Task.** A Plan is execution attached to a task, never a card of its
  own. Delegate / Attach / Plan all hang off the task (tasks.md, "Attaching
  work").
- **Column = stored task status**: `backlog | todo | in_progress | in_review |
done`, `canceled` shown only when populated. This replaces the three derived
  plan columns on the board. Execution state stays derived and shows on the
  card, exactly as the status-vs-column tension in §8 already demands.
- **Automatic transitions** (daemon, on run settlement — same observation path
  steps already use): last attached work settles green → `in_review` if the
  board's `review.enabled`, else `done`. Review verdict: approve → `done`,
  reject → `review.onReject` (default `in_progress`). Failure moves nothing.
- **Quick capture.** The bb habit worth keeping: creating a task inside a
  project costs one gesture and a title — board column "+", project menu, and
  ⌘-shortcut all open the same minimal sheet, and the task lands in `backlog`
  where drafts are found. Every other field is editable later; a capture form
  that asks questions is a capture form that gets skipped.
- **Agent access.** MCP task tools on the daemon (`create/list/update/comment`,
  review verdict), scoped like the kanban tools in §6, so project agents and
  Orchestrators work the tracker instead of only plans.

### Phasing

1. Board reads tasks: status columns, task cards, move menu + drag writing
   `task.update` status; quick-capture sheet.
2. Attachment surfaced: plan/agent chips on the card, live-activity derived
   from attached agents.
3. Automatic transitions + `review` config on the board record.
4. MCP task tools + parity test; CLI `paseo task ls|create|move`.
