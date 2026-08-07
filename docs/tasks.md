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

## One destination

There is one place work lives, and it is the tracker. The kanban board is a
_representation_ of the same tasks, not a second object with a nav entry of its
own — this branch already learned that once, building a sidebar kanban grouping
beside the Kanbans nav entry and deleting it because two routes to one object
read as confusing. A tab switches List and Board; nothing switches what you are
looking at.

Until Plans are folded into Tasks, `/kanbans` stays reachable by URL and out of
the nav. Putting a tab bar over the two before the fusion would claim they are
representations of one thing while showing two.

## Surfaces

Two views over the same tasks behind one tab, and the difference is what you
came to do. The **list** groups by status and is for reading a lot at once; the
**board** is for moving things. Both read `task-views.ts`, so neither invents an
ordering, and the tab changes how a task is drawn rather than which tasks are
there.

The board moves a task through a menu on the card, not a drag, for now. Dragging
is the gesture the board exists for and it is the next thing; a menu that writes
through beats a board you can only read.

The board always shows five columns and adds **Canceled** only once something is
in it. A board is where work is going; a permanent column of abandoned work is
dead width.

A **row** is one line: priority, key, status, title, then a right-hand rail of
label chips, attachment and comment counts. The rail is capped — two chips, one
when narrow, the rest collapsing into a count that names them on hover — because
a task with nine labels must not push its own title off the row.

Status and priority are editable from the row without opening the task. They are
the two fields you change in a sweep, and making a sweep cost one navigation each
is what makes people stop grooming a backlog.

Sorting defaults to **manual**, the order you dragged things into, because every
other sort throws that away. Sorting by due date puts undated tasks last: no date
is not an early date.

Label filters collapse by name, so selecting "bug" across projects matches every
project's own "bug" rather than asking which one you meant.

The live-activity chip sits in the rail next to the labels: same shape, green,
pulsing. That placement is the whole argument of this doc in one glance — what
you intend on the left, what is happening on the right, neither pretending to be
the other.

## Not built

- Folders for grouping task projects. The sidebar groups by project.
- Cross-host tasks. The tracker is host-local, like the kanban.
