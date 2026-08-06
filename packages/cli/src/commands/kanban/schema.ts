import type { OutputSchema } from "../../output/index.js";
import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import type { KanbanSummary, StoredKanban } from "@getpaseo/protocol/kanban/types";

export interface KanbanRow {
  id: string;
  name: string;
  projectId: string;
  archivedAt: string | null;
}

export const kanbanSchema: OutputSchema<KanbanRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "NAME", field: "name", width: 24 },
    { header: "PROJECT", field: "projectId", width: 16 },
  ],
};

export function toKanbanRow(kanban: KanbanSummary | StoredKanban): KanbanRow {
  return {
    id: kanban.id,
    name: kanban.name,
    projectId: kanban.projectId,
    archivedAt: kanban.archivedAt,
  };
}

export interface KanbanInspectRow {
  key: string;
  value: string;
}

export function createKanbanInspectSchema(kanban: StoredKanban): OutputSchema<KanbanInspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => kanban,
  };
}

export function createKanbanInspectRows(kanban: StoredKanban): KanbanInspectRow[] {
  return [
    { key: "Id", value: kanban.id },
    { key: "Name", value: kanban.name },
    { key: "ProjectId", value: kanban.projectId },
    { key: "ArchiveWorkspacesOnDone", value: `${kanban.archiveWorkspacesOnDone}` },
    { key: "Plans", value: `${Object.keys(kanban.plans).length}` },
    { key: "CreatedAt", value: kanban.createdAt },
    { key: "UpdatedAt", value: kanban.updatedAt },
    { key: "ArchivedAt", value: kanban.archivedAt ?? "null" },
  ];
}

export interface PeerRow {
  kanbanId: string;
  kanbanName: string;
  projectId: string;
  agentId: string;
  agentLastStatus: string | null;
  attention: boolean;
}

export const peerSchema: OutputSchema<PeerRow> = {
  idField: "kanbanId",
  columns: [
    { header: "KANBAN", field: "kanbanId", width: 10 },
    { header: "NAME", field: "kanbanName", width: 20 },
    { header: "PROJECT", field: "projectId", width: 16 },
    { header: "AGENT", field: "agentId", width: 10 },
    { header: "STATUS", field: "agentLastStatus", width: 16 },
    { header: "ATTENTION", field: "attention", width: 10 },
  ],
};

export function toPeerRow(peer: OrchestratorPeer): PeerRow {
  return {
    kanbanId: peer.kanbanId,
    kanbanName: peer.kanbanName,
    projectId: peer.projectId,
    agentId: peer.agentId.slice(0, 7),
    agentLastStatus: peer.agentLastStatus,
    attention: peer.attention,
  };
}
