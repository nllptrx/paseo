import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ChatMessage, ChatRoomDetail } from "@getpaseo/protocol/chat/types";

/** The single per-daemon room every Orchestrator talks in. Created lazily by
 * whoever posts first — the daemon's MCP tool or this pane. */
export const ORCHESTRATORS_CHAT_ROOM = "orchestrators";

export const ORCHESTRATOR_THREAD_MESSAGE_LIMIT = 100;

export const orchestratorThreadQueryBaseKey = ["orchestrator-thread"] as const;

export function orchestratorThreadQueryKey(serverId: string) {
  return [...orchestratorThreadQueryBaseKey, serverId] as const;
}

export interface OrchestratorThread {
  room: ChatRoomDetail | null;
  messages: ChatMessage[];
}

type ThreadClient = Pick<DaemonClient, "listChatRooms" | "readChatMessages">;
type PostClient = Pick<DaemonClient, "createChatRoom" | "postChatMessage">;

/**
 * Reads the Orchestrators thread. The room list is consulted first because
 * reading a room that was never created is an error, and it is legitimately
 * absent until the first message lands.
 */
export async function fetchOrchestratorThread(client: ThreadClient): Promise<OrchestratorThread> {
  const rooms = await client.listChatRooms();
  if (rooms.error) {
    throw new Error(rooms.error);
  }
  const room = rooms.rooms.find((candidate) => candidate.name === ORCHESTRATORS_CHAT_ROOM) ?? null;
  if (!room) {
    return { room: null, messages: [] };
  }
  const payload = await client.readChatMessages({
    room: ORCHESTRATORS_CHAT_ROOM,
    limit: ORCHESTRATOR_THREAD_MESSAGE_LIMIT,
  });
  if (payload.error) {
    throw new Error(payload.error);
  }
  return { room, messages: payload.messages };
}

/** Posts to the Orchestrators thread, creating the room when it does not exist yet. */
export async function postOrchestratorMessage(input: {
  client: PostClient;
  body: string;
  roomExists: boolean;
}): Promise<void> {
  if (!input.roomExists) {
    const created = await input.client.createChatRoom({ name: ORCHESTRATORS_CHAT_ROOM });
    if (created.error) {
      throw new Error(created.error);
    }
  }
  const posted = await input.client.postChatMessage({
    room: ORCHESTRATORS_CHAT_ROOM,
    body: input.body,
  });
  if (posted.error) {
    throw new Error(posted.error);
  }
}

/** The mention the daemon turns into a system-notification prompt for a peer. */
export function buildOrchestratorMentionPrefix(agentId: string): string {
  return `@${agentId} `;
}
