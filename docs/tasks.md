# Tasks

The tracker. A **Task** is a unit of work you own — title, description, status,
priority, labels, comments, attachments, subtasks — and any number of agents can
be attached to it. Terms live in [glossary.md](glossary.md); the board that shows
tasks by status is [kanban.md](kanban.md).

## Intent is stored, execution is derived

The kanban rule — never store what can be derived — was about **execution**. A
column computed from step runs is a second copy of a fact the runs already hold,
and it lies the moment the copy is missed.

A task's status is not that. `backlog`, `todo`, `in_review`, `canceled` are
judgements no run can produce: nothing derives "I am not doing this yet". So
status is stored, because there is no other place for it to live.

The two are shown together and never merged. A task in `in_review` may have an
agent still working in it; the status says what you intend, the attached agents
say what is happening. `taskAgents` therefore stores only the attachment — which
agent, in which workspace, since when — and reads its live status off the agent
itself. That is where this departs from the tracker it is modelled on, which
stores a `live_status` column and has to push it back in sync.

| Fact                                      | Where it lives                    |
| ----------------------------------------- | --------------------------------- |
| status, priority, labels, due date, order | stored on the task                |
| an agent is attached to this task         | stored in `task_agents`           |
| that agent is working / idle / failed     | derived from the agent            |
| a plan's step ran and how it went         | derived from step runs, as before |

## Identity

A task project owns a `prefix` (`BB`, `PASEO`) and a counter. A task is
`PREFIX-N`, allocated once and never reused, so it can be typed, pasted into a
commit message and mentioned in a comment. Prefixes are unique per host and
stored uppercase.

A task project is not a Paseo Project. It may link to one (`paseo_project_id`),
which is what lets a task open a workspace in the right checkout, but a tracker
that could only describe code you already have checked out would be useless for
the thing you have not started.

## Storage

SQLite at `$PASEO_HOME/tasks.db`, through `node:sqlite` — built into Node, so no
native module to rebuild per platform and per Electron ABI.

The rest of Paseo is JSON files ([data-model.md](data-model.md)), and this is a
deliberate exception rather than the start of a migration. A task has comments,
attachments and labels, all append-heavy: one board per JSON file means every
comment rewrites every task on that board. The store-surface rule in
data-model.md already asks that a store method map to one statement or one
transaction, so this is that rule taken at its word.

Attachment bytes live under `$PASEO_HOME/tasks/blobs/`, not in the database.
Rows carry the path.

`node:sqlite` is unflagged from Node 22.13. The store fails loudly on an older
runtime rather than degrading.

## Sync

A `task_revision` counter is bumped by triggers on every write that a list view
would notice. Clients compare revisions instead of diffing the tree, and the
push channel carries the counter.

## Attaching work

An agent reaches a task in one of two ways, and they are the same attachment
underneath:

- **Delegate** — pick a preset, get an agent. A **preset** is a named, reusable
  agent configuration: provider, model, thinking level, permission mode, standing
  instructions, and where it runs. Paseo already describes all of that per plan
  step; a preset is that description with a name on it, so the tenth task does
  not re-author it.
- **Attach** — point an agent that already exists at the task.

A **Plan** is the third way, and the only one that is more than a single
dispatch: an ordered, gated workflow. It attaches to a task like any other work.
The tracker does not gain workflow semantics; the plan keeps them.

## Surface

The tracker has one surface, and it is the kanban board ([kanban.md](kanban.md)).
There is no tasks screen, list route or nav entry of its own — this branch built
one twice and deleted it twice, because a second route to the same work reads as
a second kind of work. A card is a task; a column is the task's stored status,
with **Canceled** appearing only once something is in it. `task-views.ts` owns
grouping, ordering and rail-capping rules, tested on their own, so the board
renders what it returns.

A card is one press from its work: with one agent attached it opens the
conversation; its menu opens any of them, moves the status, or authors a plan
already bound to the task. Every column's "+" captures straight into that
status — one gesture and a title, and the first capture on a project creates
its tracker project too, prefilled and linked through `paseoProjectId`. The
attached agents' live bucket shows as a dot beside the key: intent on the
left, what is happening on the right.

Dragging writes `tasks.move` with the neighbours the card landed between and
paints optimistically with the daemon's own position arithmetic, so the settled
write does not jump. The `tasks` push domain carries the revision counter to
every client.

## Automatic transitions

Status is stored intent, but two transitions are written by the daemon rather
than by a hand, because they are judgements the runs _can_ produce
(`packages/server/src/server/tasks/transitions.ts`):

- When work attached to a task settles successfully — a plan's last step, or a
  manually attached agent finishing a turn — the task moves to `in_review` when
  the board's `review.enabled` flag is on, else `done`.
- A review verdict moves it on: approve goes to `done`; reject goes back to
  `review.onReject` (default `in_progress`). The verdict can come from a person
  or from an agent through `review_task`.

A failed run moves nothing. Failure shows on the card and the task stays
`in_progress` — moving it would bury work that still needs a decision.

The two attachment kinds observe differently on purpose. Plan-dispatched agents
are attached without observers: for plan work, the run settling is the signal,
not each agent's turn, or a three-step plan would move the task on step one.
Manually attached agents get an observer that survives daemon restarts (re-armed
from the stored attachments at boot) and fires once per finish, so a task pushed
back to work moves again when the next turn lands.

Manual moves write the same stored field through the same RPC, so automation
and hand never disagree about where status lives; the revision counter carries
either to every client.

## Agents in the tracker

MCP tools on the daemon (`packages/server/src/server/agent/tools/paseo-tools.ts`):
`create_task_project`, `list_tasks`, `create_task`, `update_task`,
`comment_task`, `attach_task_agent` (defaults to the calling agent — "I'm
taking PSE-3" arms the observer above), `review_task`. Agent comments carry the
agent's identity so they link back to the transcript.

The CLI mirrors the basics: `paseo task ls|create|move`, addressing tasks by
key (`PSE-42`) or id.

## Not built

- Presets and the Delegate flow — attach and plans are the two ways in today.
- A task detail sheet: description, comments and labels are wire-complete but
  the board card is the only surface.
- Folders for grouping task projects. The sidebar groups by project.
- Cross-host tasks. The tracker is host-local, like the kanban.
