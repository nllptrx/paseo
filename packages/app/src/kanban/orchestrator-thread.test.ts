import type { ChatMessage, ChatRoomDetail } from "@getpaseo/protocol/chat/types";
import { describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATORS_CHAT_ROOM,
  ORCHESTRATOR_THREAD_MESSAGE_LIMIT,
  buildOrchestratorMentionPrefix,
  fetchOrchestratorThread,
  postOrchestratorMessage,
} from "./orchestrator-thread";

function room(overrides: Partial<ChatRoomDetail> = {}): ChatRoomDetail {
  return {
    id: "room-1",
    name: ORCHESTRATORS_CHAT_ROOM,
    purpose: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    messageCount: 1,
    lastMessageAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    roomId: "room-1",
    authorAgentId: "agent-1",
    body: "hello",
    replyToMessageId: null,
    mentionAgentIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("fetchOrchestratorThread", () => {
  it("reads the room's latest messages", async () => {
    const readChatMessages = vi.fn().mockResolvedValue({
      requestId: "req",
      messages: [message()],
      error: null,
    });

    const result = await fetchOrchestratorThread({
      listChatRooms: vi.fn().mockResolvedValue({ requestId: "req", rooms: [room()], error: null }),
      readChatMessages,
    });

    expect(readChatMessages).toHaveBeenCalledWith({
      room: ORCHESTRATORS_CHAT_ROOM,
      limit: ORCHESTRATOR_THREAD_MESSAGE_LIMIT,
    });
    expect(result.messages).toEqual([message()]);
    expect(result.room?.name).toBe(ORCHESTRATORS_CHAT_ROOM);
  });

  it("returns an empty thread when the room does not exist yet", async () => {
    const readChatMessages = vi.fn();

    const result = await fetchOrchestratorThread({
      listChatRooms: vi.fn().mockResolvedValue({
        requestId: "req",
        rooms: [room({ id: "room-9", name: "other" })],
        error: null,
      }),
      readChatMessages,
    });

    expect(result).toEqual({ room: null, messages: [] });
    expect(readChatMessages).not.toHaveBeenCalled();
  });

  it("surfaces a listing error", async () => {
    await expect(
      fetchOrchestratorThread({
        listChatRooms: vi
          .fn()
          .mockResolvedValue({ requestId: "req", rooms: [], error: "chat unavailable" }),
        readChatMessages: vi.fn(),
      }),
    ).rejects.toThrow("chat unavailable");
  });

  it("surfaces a read error", async () => {
    await expect(
      fetchOrchestratorThread({
        listChatRooms: vi
          .fn()
          .mockResolvedValue({ requestId: "req", rooms: [room()], error: null }),
        readChatMessages: vi
          .fn()
          .mockResolvedValue({ requestId: "req", messages: [], error: "room vanished" }),
      }),
    ).rejects.toThrow("room vanished");
  });
});

describe("postOrchestratorMessage", () => {
  it("creates the room before the first message", async () => {
    const createChatRoom = vi
      .fn()
      .mockResolvedValue({ requestId: "req", room: room(), error: null });
    const postChatMessage = vi
      .fn()
      .mockResolvedValue({ requestId: "req", message: message(), error: null });

    await postOrchestratorMessage({
      client: { createChatRoom, postChatMessage },
      body: "@agent-1 status?",
      roomExists: false,
    });

    expect(createChatRoom).toHaveBeenCalledWith({ name: ORCHESTRATORS_CHAT_ROOM });
    expect(postChatMessage).toHaveBeenCalledWith({
      room: ORCHESTRATORS_CHAT_ROOM,
      body: "@agent-1 status?",
    });
  });

  it("skips creation when the room is already there", async () => {
    const createChatRoom = vi.fn();
    const postChatMessage = vi
      .fn()
      .mockResolvedValue({ requestId: "req", message: message(), error: null });

    await postOrchestratorMessage({
      client: { createChatRoom, postChatMessage },
      body: "hello",
      roomExists: true,
    });

    expect(createChatRoom).not.toHaveBeenCalled();
    expect(postChatMessage).toHaveBeenCalledTimes(1);
  });

  it("surfaces a post error", async () => {
    await expect(
      postOrchestratorMessage({
        client: {
          createChatRoom: vi.fn(),
          postChatMessage: vi
            .fn()
            .mockResolvedValue({ requestId: "req", message: null, error: "author required" }),
        },
        body: "hello",
        roomExists: true,
      }),
    ).rejects.toThrow("author required");
  });
});

describe("buildOrchestratorMentionPrefix", () => {
  it("produces a mention the daemon's parser recognizes", () => {
    expect(buildOrchestratorMentionPrefix("agent-1")).toBe("@agent-1 ");
  });
});
