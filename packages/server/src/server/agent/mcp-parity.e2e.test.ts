import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { AGENT_WAIT_TIMEOUT_MS } from "./mcp-shared.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentClient, AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

function str(val: unknown): string {
  return z.string().parse(val);
}

function recordArr(val: unknown): StructuredContent[] {
  return z.array(z.record(z.string(), z.unknown())).parse(val);
}

function expectAgentFeatureValue(snapshot: StructuredContent, featureId: string, value: unknown) {
  expect(recordArr(snapshot.features)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: featureId,
        value,
      }),
    ]),
  );
}

function strArrOptional(val: unknown): string[] | undefined {
  return z.array(z.string()).optional().parse(val);
}

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildExpectedAgentMcpUrl(params: { host: string; port: number; agentId: string }): string {
  const baseUrl = new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(params.host)}:${params.port}`,
  );
  baseUrl.searchParams.set("callerAgentId", params.agentId);
  return baseUrl.toString();
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) {
      return content.structuredContent;
    }
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(url: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const rawClient = await experimental_createMCPClient({ transport });
  const boundCallTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool: boundCallTool, close: () => rawClient.close() };
}

async function callToolStructured(
  client: McpClient,
  name: string,
  args?: StructuredContent,
): Promise<StructuredContent> {
  const result = await client.callTool({ name, args: args ?? {} });
  const payload = getStructuredContent(result);
  if (!payload) {
    throw new Error(`${name} returned no structured payload`);
  }
  return payload;
}

async function expectToolError(
  client: McpClient,
  name: string,
  args: StructuredContent,
  pattern: RegExp,
): Promise<void> {
  const result = await client.callTool({ name, args });
  expect(result.isError).toBe(true);
  const contentItem = result.content?.[0];
  const contentText: string | undefined =
    contentItem != null && typeof contentItem === "object"
      ? Reflect.get(contentItem, "text")
      : undefined;
  expect(contentText ?? "").toMatch(pattern);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(options: {
  timeoutMs: number;
  intervalMs?: number;
  check: () => Promise<T | null> | T | null;
  label: string;
}): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const result = await options.check();
    if (result !== null) {
      return result;
    }
    await sleep(options.intervalMs ?? 50);
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}`);
}

let tempRoot: string;
let daemonHandle: TestPaseoDaemon;
let topLevelClient: McpClient;
let agentScopedClient: McpClient;
let parentAgentId: string;
let parentAgentCwd: string;
let worktreeRepoCwd: string;
let launchConfigsByProvider: Record<AgentProvider, AgentSessionConfig[]>;

const seededAgentProfile = {
  id: "ui-profile",
  name: "UI work",
  provider: "claude",
  model: "claude-test-model",
  modeId: "bypassPermissions",
  notes: "Use for UI work: components, layout, design tokens. Not for backend.",
};

function createRecordingAgentClients(): Record<AgentProvider, AgentClient> {
  const baseClients = createTestAgentClients();
  launchConfigsByProvider = {};
  const wrappedClients: Record<AgentProvider, AgentClient> = {};

  for (const [provider, client] of Object.entries(baseClients)) {
    const launchConfigs: AgentSessionConfig[] = [];
    launchConfigsByProvider[provider] = launchConfigs;
    const wrappedClient: AgentClient = {
      provider: client.provider,
      capabilities: client.capabilities,
      createSession: async (config, launchContext, options) => {
        launchConfigs.push(config);
        return await client.createSession(config, launchContext, options);
      },
      resumeSession: async (handle, overrides, launchContext) =>
        await client.resumeSession(handle, overrides, launchContext),
      fetchCatalog: async (options) => await client.fetchCatalog(options),
      isAvailable: async () => await client.isAvailable(),
    };
    if (client.resolveCreateConfig) {
      wrappedClient.resolveCreateConfig = (input) => client.resolveCreateConfig!(input);
    }
    if (client.isCreateConfigUnattended) {
      wrappedClient.isCreateConfigUnattended = (input) => client.isCreateConfigUnattended!(input);
    }
    if (client.listCommands) {
      wrappedClient.listCommands = async (config) => await client.listCommands!(config);
    }
    if (client.listFeatures) {
      wrappedClient.listFeatures = async (config) => await client.listFeatures!(config);
    }
    if (client.listImportableSessions) {
      wrappedClient.listImportableSessions = async (options) =>
        await client.listImportableSessions!(options);
    }
    if (client.importSession) {
      wrappedClient.importSession = async (input, context) =>
        await client.importSession!(input, context);
    }
    wrappedClients[provider] = wrappedClient;
  }

  return wrappedClients;
}

async function makeCwd(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tempRoot, `${prefix}-`));
}

async function createTopLevelAgent(args?: Partial<StructuredContent>): Promise<string> {
  const cwd = typeof args?.cwd === "string" ? args.cwd : await makeCwd("agent-cwd");
  const { cwd: _cwd, ...rest } = args ?? {};
  const payload = await callToolStructured(topLevelClient, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: cwd } },
    title: "Parity agent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
    background: true,
    ...rest,
  });
  return str(payload.agentId);
}

async function createChildAgent(args?: Partial<StructuredContent>): Promise<string> {
  const payload = await callToolStructured(agentScopedClient, "create_agent", {
    relationship: { kind: "subagent" },
    workspace: { kind: "current" },
    title: "Parity child",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    notifyOnFinish: false,
    ...args,
  });
  return str(payload.agentId);
}

async function archiveAgentIfPresent(agentId: string | null | undefined): Promise<void> {
  if (!agentId) {
    return;
  }
  try {
    await topLevelClient.callTool({ name: "archive_agent", args: { agentId } });
  } catch {
    // ignore cleanup errors
  }
}

async function deleteScheduleIfPresent(id: string | null | undefined): Promise<void> {
  if (!id) {
    return;
  }
  try {
    await topLevelClient.callTool({ name: "delete_schedule", args: { id } });
  } catch {
    // ignore cleanup errors
  }
}

async function killTerminalIfPresent(terminalId: string | null | undefined): Promise<void> {
  if (!terminalId) {
    return;
  }
  try {
    await agentScopedClient.callTool({ name: "kill_terminal", args: { terminalId } });
  } catch {
    // ignore cleanup errors
  }
}

async function archiveWorkspaceIfPresent(workspaceId: string | null | undefined): Promise<void> {
  if (!workspaceId) return;
  try {
    await topLevelClient.callTool({ name: "archive_workspace", args: { workspaceId } });
  } catch {
    // ignore cleanup errors
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-parity-e2e-"));
  parentAgentCwd = await makeCwd("parent-agent-cwd");
  worktreeRepoCwd = await makeCwd("worktree-repo");

  daemonHandle = await createTestPaseoDaemon({
    agentClients: createRecordingAgentClients(),
    agentProfiles: [seededAgentProfile],
  });
  topLevelClient = await createMcpClient(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`);

  const parentPayload = await callToolStructured(topLevelClient, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: parentAgentCwd } },
    title: "MCP parity parent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
    background: true,
  });
  parentAgentId = str(parentPayload.agentId);

  agentScopedClient = await createMcpClient(
    `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${parentAgentId}`,
  );

  execSync("git init -b main", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git config user.email 'test@example.com'", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git config user.name 'Test User'", { cwd: worktreeRepoCwd, stdio: "pipe" });
  await writeFile(path.join(worktreeRepoCwd, "README.md"), "# repo\n", "utf8");
  execSync("git add README.md", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'init'", {
    cwd: worktreeRepoCwd,
    stdio: "pipe",
  });
}, 30_000);

afterAll(async () => {
  await archiveAgentIfPresent(parentAgentId);
  await agentScopedClient?.close();
  await topLevelClient?.close();
  await daemonHandle?.close();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("Suite A: Core Fixes", () => {
  test("AGENT_WAIT_TIMEOUT_MS is 30000", () => {
    expect(AGENT_WAIT_TIMEOUT_MS).toBe(30_000);
  });

  test("create_agent with callerAgentId sets the parent agent label", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent();
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels).toMatchObject({
        [PARENT_AGENT_ID_LABEL]: parentAgentId,
      });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent with detached relationship omits the parent agent label", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent({ relationship: { kind: "detached" } });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels?.[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("agentManager.createAgent injects paseo MCP using the daemon listen target", async () => {
    let agentId: string | null = null;
    try {
      const listenTarget = daemonHandle.daemon.getListenTarget();
      expect(listenTarget?.type).toBe("tcp");
      const cwd = await makeCwd("manager-direct-agent-cwd");

      const snapshot = await daemonHandle.daemon.agentManager.createAgent(
        {
          provider: "claude",
          cwd,
          title: "Manager direct parity agent",
          modeId: "bypassPermissions",
        },
        undefined,
        { workspaceId: undefined },
      );
      agentId = snapshot.id;

      const expectedUrl = buildExpectedAgentMcpUrl({
        host: listenTarget!.host,
        port: listenTarget!.port,
        agentId,
      });

      const launchConfig = launchConfigsByProvider.claude
        ?.toReversed()
        .find((config) => config.cwd === cwd);
      expect(launchConfig?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: expectedUrl,
        },
      });
      expect(snapshot.config.mcpServers?.paseo).toBeUndefined();

      const liveAgent = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(liveAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent accepts provider/model syntax", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ provider: "claude/claude-test-model" });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.config.model).toBe("claude-test-model");
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent accepts provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ settings: { features: { test_feature: true } } });
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("agent-scoped create_agent accepts provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent({
        provider: "claude/claude-test-model",
        settings: { features: { test_feature: true } },
      });
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("update_agent updates provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ settings: { features: { test_feature: false } } });
      const updated = await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        settings: { features: { test_feature: true } },
      });
      expect(updated.success).toBe(true);
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("inspect_provider returns draft provider features over MCP", async () => {
    const payload = await callToolStructured(topLevelClient, "inspect_provider", {
      provider: "claude",
      cwd: parentAgentCwd,
      settings: {
        model: "claude-test-model",
        features: { test_feature: true },
      },
    });

    expect(payload.provider).toBe("claude");
    expect(payload.selectedModel).toBe("claude-test-model");
    expect(recordArr(payload.features)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "toggle",
          id: "test_feature",
          value: true,
        }),
      ]),
    );
  });

  test("create_agent accepts labels param", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ labels: { team: "infra" } });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels).toMatchObject({ team: "infra" });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("archive_agent archives an agent", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent();
      const archivedAgentId = agentId;
      await callToolStructured(topLevelClient, "archive_agent", { agentId });
      agentId = null;

      const agents = daemonHandle.daemon.agentManager.listAgents();
      expect(agents.some((agent) => agent.id === archivedAgentId)).toBe(false);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("update_agent updates name and labels", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent();
      await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        name: "Renamed parity agent",
        labels: { team: "infra", surface: "mcp" },
      });

      const stored = await daemonHandle.daemon.agentStorage.get(agentId);
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(stored?.title).toBe("Renamed parity agent");
      expect(snapshot?.labels).toMatchObject({
        team: "infra",
        surface: "mcp",
      });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });
});

describe("Suite B: Terminal Tools", () => {
  test("create_terminal and list_terminals", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity terminal",
      });
      terminalId = str(created.id);

      const listed = await callToolStructured(agentScopedClient, "list_terminals");
      const terminals = recordArr(listed.terminals);
      expect(terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: terminalId,
            name: "Parity terminal",
            cwd: parentAgentCwd,
          }),
        ]),
      );
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("send_terminal_keys and capture_terminal", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity capture terminal",
      });
      terminalId = str(created.id);

      await callToolStructured(agentScopedClient, "send_terminal_keys", {
        terminalId,
        keys: "echo hello\r",
        literal: true,
      });
      await sleep(500);

      const captured = await waitFor({
        timeoutMs: 10_000,
        intervalMs: 100,
        label: "terminal output to contain hello",
        check: async () => {
          const payload = await callToolStructured(agentScopedClient, "capture_terminal", {
            terminalId,
            scrollback: true,
          });
          const lines = strArrOptional(payload.lines) ?? [];
          return lines.some((line) => line.includes("hello")) ? payload : null;
        },
      });

      expect(captured.lines).toEqual(expect.arrayContaining([expect.stringContaining("hello")]));
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("kill_terminal removes terminal", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity kill terminal",
      });
      terminalId = str(created.id);

      await callToolStructured(agentScopedClient, "kill_terminal", { terminalId });
      terminalId = null;

      const listed = await waitFor({
        timeoutMs: 5_000,
        intervalMs: 100,
        label: "terminal removal",
        check: async () => {
          const payload = await callToolStructured(agentScopedClient, "list_terminals");
          const terminals = recordArr(payload.terminals);
          return terminals.some((terminal) => terminal.id === created.id) ? null : payload;
        },
      });
      const terminals = recordArr(listed.terminals);
      expect(terminals.some((terminal) => terminal.id === created.id)).toBe(false);
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("kill_terminal with invalid id throws", async () => {
    await expectToolError(
      agentScopedClient,
      "kill_terminal",
      { terminalId: "missing-terminal-id" },
      /not found/i,
    );
  });
});

describe("Suite C: Schedule Tools", () => {
  test("create_schedule and list_schedules", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity schedule list",
        provider: "claude",
      });
      scheduleId = str(created.id);

      const listed = await callToolStructured(topLevelClient, "list_schedules");
      const schedules = recordArr(listed.schedules);
      expect(schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: scheduleId,
            name: "Parity schedule list",
          }),
        ]),
      );
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_schedule accepts provider/model syntax", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity provider schedule",
        provider: "codex/gpt-5.4",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "new-agent",
        config: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("inspect_schedule returns details", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity inspect schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      const inspected = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(inspected).toMatchObject({
        id: scheduleId,
        name: "Parity inspect schedule",
        prompt: "say hello",
        status: "active",
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("pause and resume schedule", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity pause schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      await callToolStructured(topLevelClient, "pause_schedule", { id: scheduleId });
      const paused = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(paused.status).toBe("paused");

      await callToolStructured(topLevelClient, "resume_schedule", { id: scheduleId });
      const resumed = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(resumed.status).toBe("active");
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("delete_schedule removes schedule", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity delete schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      await callToolStructured(topLevelClient, "delete_schedule", { id: scheduleId });
      scheduleId = null;

      const listed = await callToolStructured(topLevelClient, "list_schedules");
      const schedules = recordArr(listed.schedules);
      expect(schedules.some((schedule) => schedule.id === created.id)).toBe(false);
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_heartbeat targets the scoped agent", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_heartbeat", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity heartbeat",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "agent",
        agentId: parentAgentId,
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_schedule on agent MCP accepts provider/model override for new-agent", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        provider: "codex/gpt-5.4",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "new-agent",
        config: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_heartbeat without callerAgentId throws", async () => {
    await expectToolError(
      topLevelClient,
      "create_heartbeat",
      {
        prompt: "say hello",
        cron: "*/5 * * * *",
      },
      /requires an agent-scoped session/i,
    );
  });
});

describe("Suite D: Provider Tools", () => {
  test("list_providers returns providers", async () => {
    const payload = await callToolStructured(topLevelClient, "list_providers");
    const providers = recordArr(payload.providers);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        modes: expect.any(Array),
      }),
    );
  });

  test("list_models returns models for provider", async () => {
    const payload = await callToolStructured(topLevelClient, "list_models", {
      provider: "claude",
    });
    expect(payload.provider).toBe("claude");
    expect(Array.isArray(payload.models)).toBe(true);
  });

  test("list_profiles returns configured agent profiles, including notes", async () => {
    const payload = await callToolStructured(topLevelClient, "list_profiles");
    const profiles = recordArr(payload.profiles);
    expect(profiles).toEqual([seededAgentProfile]);
  });
});

describe("Suite E: Workspace Tools", () => {
  test("list_workspaces always returns an array", async () => {
    const payload = await callToolStructured(topLevelClient, "list_workspaces");
    expect(Array.isArray(payload.workspaces)).toBe(true);
  });

  test("create_workspace and list_workspaces", async () => {
    let workspaceId: string | null = null;
    const branchName = `parity-create-${Date.now()}`;
    try {
      const created = await callToolStructured(topLevelClient, "create_workspace", {
        isolation: "worktree",
        path: worktreeRepoCwd,
        mode: "branch-off",
        worktreeSlug: branchName,
        branchName,
        baseBranch: "main",
      });
      workspaceId = str(created.workspaceId);

      const listed = await callToolStructured(topLevelClient, "list_workspaces");
      expect(recordArr(listed.workspaces)).toEqual(
        expect.arrayContaining([expect.objectContaining({ workspaceId, cwd: created.cwd })]),
      );
    } finally {
      await archiveWorkspaceIfPresent(workspaceId);
    }
  });

  test("archive_workspace removes a worktree workspace", async () => {
    let workspaceId: string | null = null;
    const branchName = `parity-archive-${Date.now()}`;
    try {
      const created = await callToolStructured(topLevelClient, "create_workspace", {
        isolation: "worktree",
        path: worktreeRepoCwd,
        mode: "branch-off",
        worktreeSlug: branchName,
        branchName,
        baseBranch: "main",
      });
      workspaceId = str(created.workspaceId);

      await callToolStructured(topLevelClient, "archive_workspace", { workspaceId });

      const listed = await callToolStructured(topLevelClient, "list_workspaces");
      expect(
        recordArr(listed.workspaces).some((workspace) => workspace.workspaceId === workspaceId),
      ).toBe(false);
      workspaceId = null;
    } finally {
      await archiveWorkspaceIfPresent(workspaceId);
    }
  });

  test("archive_workspace succeeds when caller cwd is inside its worktree", async () => {
    let workspaceId: string | null = null;
    let worktreePath: string | null = null;
    let worktreeAgentId: string | null = null;
    let worktreeScopedClient: McpClient | null = null;
    const branchName = `parity-archive-self-cwd-${Date.now()}`;

    try {
      const created = await callToolStructured(topLevelClient, "create_workspace", {
        isolation: "worktree",
        path: worktreeRepoCwd,
        mode: "branch-off",
        worktreeSlug: branchName,
        branchName,
        baseBranch: "main",
      });
      workspaceId = str(created.workspaceId);
      worktreePath = str(created.cwd);
      worktreeAgentId = await createTopLevelAgent({
        cwd: worktreePath,
        title: "Worktree scoped parity agent",
      });
      worktreeScopedClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(
          worktreeAgentId,
        )}`,
      );

      const archived = await callToolStructured(worktreeScopedClient, "archive_workspace", {
        workspaceId,
      });
      expect(archived.workspaceId).toBe(workspaceId);
      workspaceId = null;
      worktreePath = null;
      worktreeAgentId = null;

      const listed = await callToolStructured(topLevelClient, "list_workspaces");
      expect(recordArr(listed.workspaces).map((workspace) => workspace.workspaceId)).not.toContain(
        created.workspaceId,
      );
    } finally {
      await worktreeScopedClient?.close();
      await archiveAgentIfPresent(worktreeAgentId);
      await archiveWorkspaceIfPresent(workspaceId);
    }
  });
});

describe("Suite G: Task Tools", () => {
  test("carries a task from capture to a review verdict", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Parity tracker",
      prefix: "par",
    });
    const projectId = str(project.projectId);

    const created = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Ship the tracker",
    });
    const task = created.task as StructuredContent;
    const taskId = str(task.id);
    expect(task.status).toBe("backlog");

    const listed = await callToolStructured(topLevelClient, "list_tasks", {});
    const snapshot = listed.snapshot as StructuredContent;
    expect(recordArr(snapshot.tasks).some((entry) => entry.id === taskId)).toBe(true);
    expect(
      recordArr(snapshot.projects).some(
        (entry) => entry.id === projectId && entry.prefix === "PAR",
      ),
    ).toBe(true);

    const commented = await callToolStructured(topLevelClient, "comment_task", {
      taskId,
      body: "Looks close.",
    });
    expect((commented.comment as StructuredContent).kind).toBe("user");
    const feed = await callToolStructured(topLevelClient, "read_board_feed", { projectId });
    expect(recordArr(feed.entries).map((entry) => entry.body)).toContain("Looks close.");

    await expectToolError(
      topLevelClient,
      "review_task",
      { taskId, verdict: "approve" },
      /not in review/i,
    );

    await callToolStructured(topLevelClient, "update_task", { taskId, status: "in_review" });
    const approved = await callToolStructured(topLevelClient, "review_task", {
      taskId,
      verdict: "approve",
    });
    expect((approved.task as StructuredContent).status).toBe("done");
  }, 20_000);

  /** A verdict from the agent that wrote the change is the same judgement that
   * produced it, asked twice — which is the one thing a review state exists to
   * prevent. */
  test("refuses a review from the agent that worked the task", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Review guard",
      prefix: "rvg",
    });
    const created = await callToolStructured(topLevelClient, "create_task", {
      projectId: str(project.projectId),
      title: "Self-review attempt",
    });
    const taskId = str((created.task as StructuredContent).id);

    let agentId: string | null = null;
    let agentClient: McpClient | null = null;
    try {
      agentId = await createTopLevelAgent({ title: "Task worker" });
      agentClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(agentId)}`,
      );
      await callToolStructured(agentClient, "attach_task_agent", { taskId });
      await callToolStructured(topLevelClient, "update_task", { taskId, status: "in_review" });

      await expectToolError(
        agentClient,
        "review_task",
        { taskId, verdict: "approve" },
        /cannot review it/i,
      );

      // A verdict from somewhere else still lands: the guard is about who, not
      // about refusing review.
      const approved = await callToolStructured(topLevelClient, "review_task", {
        taskId,
        verdict: "approve",
      });
      expect((approved.task as StructuredContent).status).toBe("done");
    } finally {
      await agentClient?.close();
      await archiveAgentIfPresent(agentId);
    }
  }, 20_000);

  /** A workflow belongs to the card. Adding one twice must leave one workflow,
   * not two competing answers to what this task is doing. */
  test("attaches a workflow to a task and replaces it on the next write", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Workflow tracker",
      prefix: "wfl",
    });
    const created = await callToolStructured(topLevelClient, "create_task", {
      projectId: str(project.projectId),
      title: "Multi-step work",
    });
    const taskId = str((created.task as StructuredContent).id);

    const step = {
      name: "Implement",
      prompt: "do the thing",
      agents: [{ provider: "claude" }],
      completion: "all",
      workspace: { mode: "worktree" },
      trigger: { type: "manual" },
    };

    const added = await callToolStructured(topLevelClient, "add_task_workflow", {
      taskId,
      steps: [step, { ...step, name: "Verify" }],
    });
    const workflow = added.workflow as StructuredContent;
    expect(recordArr(workflow.steps)).toHaveLength(2);
    expect(recordArr(workflow.steps)[0].runs).toEqual([]);

    await callToolStructured(topLevelClient, "add_task_workflow", { taskId, steps: [step] });
    const read = await callToolStructured(topLevelClient, "get_task_workflow", { taskId });
    expect(recordArr((read.workflow as StructuredContent).steps)).toHaveLength(1);
  }, 20_000);

  /** A task with subtasks holds no workers of its own; MCP has to refuse the
   * same way the RPC and the service do, naming the rule instead of leaving
   * an agent to wonder why the attach did nothing. */
  test("refuses to attach an agent to a task that has subtasks", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Aggregate guard",
      prefix: "agg",
    });
    const projectId = str(project.projectId);
    const parent = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Phase parent",
    });
    const parentId = str((parent.task as StructuredContent).id);
    await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Phase one",
      parentTaskId: parentId,
    });

    let agentId: string | null = null;
    let agentClient: McpClient | null = null;
    try {
      agentId = await createTopLevelAgent({ title: "Aggregate worker" });
      agentClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(agentId)}`,
      );
      await expectToolError(
        agentClient,
        "attach_task_agent",
        { taskId: parentId },
        /has 1 subtask, so workers attach to its subtasks instead/i,
      );
    } finally {
      await agentClient?.close();
      await archiveAgentIfPresent(agentId);
    }
  }, 20_000);

  test("an agent attaches itself and its comment carries its identity", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Attach tracker",
      prefix: "att",
    });
    const projectId = str(project.projectId);
    const created = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Agent-worked task",
    });
    const taskId = str((created.task as StructuredContent).id);

    let agentId: string | null = null;
    let agentClient: McpClient | null = null;
    try {
      agentId = await createTopLevelAgent({ title: "Task worker" });
      agentClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(agentId)}`,
      );

      const attached = await callToolStructured(agentClient, "attach_task_agent", { taskId });
      const links = recordArr((attached.task as StructuredContent).agents);
      expect(links.some((link) => link.agentId === agentId)).toBe(true);

      const contextResult = await callToolStructured(agentClient, "get_task_context", { taskId });
      const context = contextResult.context as StructuredContent;
      expect((context.task as StructuredContent).id).toBe(taskId);
      expect((context.caller as StructuredContent).agentId).toBe(agentId);
      expect((context.caller as StructuredContent).role).toBe("worker");
      expect(
        recordArr(context.feedTail).some(
          (entry) => (entry.event as StructuredContent | undefined)?.kind === "agent_attached",
        ),
      ).toBe(true);

      const commented = await callToolStructured(agentClient, "comment_task", {
        taskId,
        body: "On it.",
      });
      expect((commented.comment as StructuredContent).kind).toBe("agent");
      expect((commented.comment as StructuredContent).agentId).toBe(agentId);
    } finally {
      await agentClient?.close();
      await archiveAgentIfPresent(agentId);
    }
  }, 20_000);

  test("an agent delivers a board comment to a sibling card's attached agent", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Delivery tracker",
      prefix: "dvr",
    });
    const projectId = str(project.projectId);
    const source = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Source card",
    });
    const target = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Target card",
    });
    const sourceTaskId = str((source.task as StructuredContent).id);
    const targetTaskId = str((target.task as StructuredContent).id);

    let sourceAgentId: string | null = null;
    let targetAgentId: string | null = null;
    let sourceClient: McpClient | null = null;
    let targetClient: McpClient | null = null;
    try {
      sourceAgentId = await createTopLevelAgent({ title: "Source worker" });
      targetAgentId = await createTopLevelAgent({ title: "Target worker" });
      sourceClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(sourceAgentId)}`,
      );
      targetClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(targetAgentId)}`,
      );
      await callToolStructured(sourceClient, "attach_task_agent", { taskId: sourceTaskId });
      await callToolStructured(targetClient, "attach_task_agent", { taskId: targetTaskId });
      await expectToolError(
        sourceClient,
        "comment_task",
        {
          taskId: sourceTaskId,
          body: "Do not send this back to me.",
          deliver: true,
        },
        /needs another attached agent/i,
      );
      await callToolStructured(sourceClient, "attach_task_agent", { taskId: targetTaskId });

      const otherProject = await callToolStructured(topLevelClient, "create_task_project", {
        name: "Other delivery tracker",
        prefix: "odv",
      });
      const otherTask = await callToolStructured(topLevelClient, "create_task", {
        projectId: str(otherProject.projectId),
        title: "Outside card",
      });
      await expectToolError(
        sourceClient,
        "comment_task",
        {
          taskId: str((otherTask.task as StructuredContent).id),
          body: "This must stay on its own board.",
          deliver: true,
        },
        /not on a board attached to agent/i,
      );

      const delivered = await callToolStructured(sourceClient, "comment_task", {
        taskId: targetTaskId,
        body: "The shared API changed; update your caller.",
        deliver: true,
      });
      const comment = delivered.comment as StructuredContent;
      expect(comment.kind).toBe("agent");
      expect(comment.agentId).toBe(sourceAgentId);
      expect(comment.entryKind).toBe("message");
      expect(recordArr(comment.recipients)).toEqual([
        expect.objectContaining({
          agentId: targetAgentId,
          deliveryStatus: "delivered",
        }),
      ]);
    } finally {
      await sourceClient?.close();
      await targetClient?.close();
      await archiveAgentIfPresent(sourceAgentId);
      await archiveAgentIfPresent(targetAgentId);
    }
  }, 20_000);

  test("refuses to run a blocked workflow before an agent starts", async () => {
    const project = await callToolStructured(topLevelClient, "create_task_project", {
      name: "Blocked workflow",
      prefix: "blk",
    });
    const projectId = str(project.projectId);
    const blocker = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Finish first",
    });
    const blocked = await callToolStructured(topLevelClient, "create_task", {
      projectId,
      title: "Wait for it",
    });
    const taskId = str((blocked.task as StructuredContent).id);
    await callToolStructured(topLevelClient, "add_task_dependency", {
      taskId,
      dependsOnTaskId: str((blocker.task as StructuredContent).id),
    });
    const added = await callToolStructured(topLevelClient, "add_task_workflow", {
      taskId,
      steps: [
        {
          name: "Implement",
          prompt: "Do the thing",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "existing", workspaceId: "never-used" },
          trigger: { type: "manual" },
        },
      ],
    });
    const stepId = str(recordArr((added.workflow as StructuredContent).steps)[0].id);

    await expectToolError(topLevelClient, "run_task_step", { taskId, stepId }, /blocked by/i);

    const listed = await callToolStructured(topLevelClient, "list_tasks", {});
    const task = recordArr((listed.snapshot as StructuredContent).tasks).find(
      (entry) => entry.id === taskId,
    );
    expect(task).toMatchObject({ status: "backlog", agents: [] });
  }, 20_000);
});
