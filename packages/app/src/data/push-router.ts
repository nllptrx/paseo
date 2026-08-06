import type { Query, QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ListTerminalsResponse,
  MutableDaemonConfig,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { KanbanSummary, StoredKanban } from "@getpaseo/protocol/kanban/types";
import { agentCommandsQueryRoot } from "@/hooks/agent-commands-query";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { providerSnapshotCache, type ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import {
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
} from "@/data/providers-snapshot";
import {
  kanbanQueryKey,
  kanbansQueryBaseKey,
  updateAggregatedKanbansData,
  type AggregatedKanban,
  type FetchAggregatedKanbansState,
} from "@/kanban/aggregated-kanbans";

type ProvidersSnapshotUpdateMessage = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>;
type CheckoutDiffUpdateMessage = Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>;
type SubscribeCheckoutDiffResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "subscribe_checkout_diff_response" }
>;
type StatusMessage = Extract<SessionOutboundMessage, { type: "status" }>;
type TerminalsChangedMessage = Extract<SessionOutboundMessage, { type: "terminals_changed" }>;
type KanbanUpdateMessage = Extract<SessionOutboundMessage, { type: "kanban.update" }>;
type ServerDataEventType =
  | "providers_snapshot_update"
  | "checkout_diff_update"
  | "subscribe_checkout_diff_response"
  | "status"
  | "terminals_changed"
  | "kanban.update";
type CheckoutDiffResponsePayload = SubscribeCheckoutDiffResponseMessage["payload"];
type CheckoutDiffCachePayload = Omit<CheckoutDiffResponsePayload, "subscriptionId">;
type ListTerminalsPayload = ListTerminalsResponse["payload"];

interface CheckoutDiffCompare {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
}

interface CheckoutDiffRoute {
  domain: "checkoutDiff";
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}

interface WorkspaceTerminalsRoute {
  domain: "workspaceTerminals";
  enabled: boolean;
  serverId: string;
  cwd: string;
  workspaceId?: string;
}

interface KanbanRoute {
  domain: "kanban";
  enabled: boolean;
  serverIds: readonly string[];
}

type ServerDataRoute = CheckoutDiffRoute | WorkspaceTerminalsRoute | KanbanRoute;

export interface ServerDataQueryMeta extends Record<string, unknown> {
  serverData: ServerDataRoute;
}

export type ProvidersSnapshotUpdate = ProvidersSnapshotUpdateMessage;

interface ServerDataPushClient {
  on<TType extends ServerDataEventType>(
    type: TType,
    handler: (message: Extract<SessionOutboundMessage, { type: TType }>) => void,
  ): () => void;
  subscribeCheckoutDiff(
    cwd: string,
    compare: CheckoutDiffCompare,
    options: { subscriptionId: string; requestId?: string },
  ): Promise<CheckoutDiffResponsePayload>;
  unsubscribeCheckoutDiff(subscriptionId: string): void;
  subscribeTerminals(input: { cwd: string; workspaceId?: string }): void;
  unsubscribeTerminals(input: { cwd: string; workspaceId?: string }): void;
  kanbanSubscribe(requestId?: string): Promise<{ error: string | null }>;
  kanbanUnsubscribe(requestId?: string): Promise<{ error: string | null }>;
}

interface PushRouterInput {
  client: ServerDataPushClient;
  queryClient: QueryClient;
  serverId: string;
}

interface ActiveServerDataSubscriptions {
  checkoutDiff: Map<string, CheckoutDiffRoute>;
  workspaceTerminals: Map<string, WorkspaceTerminalsRoute>;
  kanban: Map<string, KanbanRoute>;
}

interface ReconnectRepairPolicy {
  domain: string;
  invalidate(input: { queryClient: QueryClient; serverId: string }): void;
}

const RECONNECT_REPAIR_POLICIES: ReconnectRepairPolicy[] = [
  {
    domain: "providersSnapshot",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });
    },
  },
  {
    domain: "daemonConfig",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
    },
  },
  {
    domain: "daemonPairingOffer",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonPairingOfferQueryKey(serverId) });
    },
  },
  {
    domain: "checkoutDiff",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "checkoutDiff", serverId),
      });
    },
  },
  {
    domain: "workspaceTerminals",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "terminals", serverId),
      });
    },
  },
  {
    domain: "kanban",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: kanbansQueryBaseKey });
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "kanban", serverId),
      });
    },
  },
];
const reconnectSubscriptionRepairsByServerId = new Map<string, Set<() => void>>();
const EMPTY_KANBAN_SUBSCRIPTIONS: Map<string, KanbanRoute> = new Map();

export function checkoutDiffPushRoute(input: {
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "checkoutDiff",
      enabled: input.enabled,
      serverId: input.serverId,
      subscriptionId: input.subscriptionId,
      cwd: input.cwd,
      compare: input.compare,
    },
  };
}

export function workspaceTerminalsPushRoute(input: {
  enabled: boolean;
  serverId: string;
  cwd: string;
  workspaceId?: string;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "workspaceTerminals",
      enabled: input.enabled,
      serverId: input.serverId,
      cwd: input.cwd,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
  };
}

export function kanbanPushRoute(input: {
  enabled: boolean;
  serverIds: readonly string[];
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "kanban",
      enabled: input.enabled,
      serverIds: [...input.serverIds],
    },
  };
}

export function invalidateServerDataQueriesAfterReconnect(input: {
  queryClient: QueryClient;
  serverId: string;
}): void {
  for (const policy of RECONNECT_REPAIR_POLICIES) {
    policy.invalidate(input);
  }
  for (const repairSubscriptions of reconnectSubscriptionRepairsByServerId.get(input.serverId) ??
    []) {
    repairSubscriptions();
  }
}

export function applyProvidersSnapshotUpdate(input: {
  serverId: string;
  queryClient: QueryClient;
  message: ProvidersSnapshotUpdate;
  cache?: ProviderSnapshotCache;
}): void {
  if (input.message.type !== "providers_snapshot_update") {
    return;
  }
  const queryKey = providersSnapshotQueryKey(input.serverId, input.message.payload.cwd);
  input.queryClient.setQueryData(queryKey, {
    entries: input.message.payload.entries,
    generatedAt: input.message.payload.generatedAt,
    requestId: "providers_snapshot_update",
  });
  const { compactSnapshot, snapshotHash } = input.message.payload;
  if (compactSnapshot && snapshotHash) {
    void (input.cache ?? providerSnapshotCache).write({
      serverId: input.serverId,
      cwd: normalizeProvidersSnapshotCwd(input.message.payload.cwd),
      hash: snapshotHash,
      generatedAt: input.message.payload.generatedAt,
      compactSnapshot,
    });
  }
  void input.queryClient.invalidateQueries({
    queryKey: agentCommandsQueryRoot(input.serverId),
    exact: false,
  });
}

export function mountServerDataPushRouter(input: PushRouterInput): () => void {
  const activeCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRoute>();
  const activeTerminalSubscriptions = new Map<string, WorkspaceTerminalsRoute>();
  const activeKanbanSubscriptions = new Map<string, KanbanRoute>();
  let disposed = false;

  function reconcileSubscriptions(
    fallbackActive: ActiveServerDataSubscriptions = {
      checkoutDiff: activeCheckoutDiffSubscriptions,
      workspaceTerminals: activeTerminalSubscriptions,
      kanban: activeKanbanSubscriptions,
    },
  ): void {
    if (disposed) {
      return;
    }

    const desiredCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRoute>();
    const desiredTerminalSubscriptions = new Map<string, WorkspaceTerminalsRoute>();
    const desiredKanbanSubscriptions = new Map<string, KanbanRoute>();
    for (const query of input.queryClient.getQueryCache().getAll()) {
      const route = getActiveServerDataRoute(query, input.serverId, {
        checkoutDiff: fallbackActive.checkoutDiff,
        workspaceTerminals: fallbackActive.workspaceTerminals,
        kanban: fallbackActive.kanban,
      });
      if (!route) {
        continue;
      }
      if (route.domain === "checkoutDiff") {
        desiredCheckoutDiffSubscriptions.set(route.subscriptionId, route);
        continue;
      }
      if (route.domain === "kanban") {
        desiredKanbanSubscriptions.set("kanban", route);
        continue;
      }
      desiredTerminalSubscriptions.set(workspaceTerminalSubscriptionKey(route), route);
    }

    reconcileCheckoutDiffSubscriptions({
      active: activeCheckoutDiffSubscriptions,
      client: input.client,
      desired: desiredCheckoutDiffSubscriptions,
      serverId: input.serverId,
    });
    reconcileTerminalSubscriptions({
      active: activeTerminalSubscriptions,
      client: input.client,
      desired: desiredTerminalSubscriptions,
    });
    reconcileKanbanSubscriptions({
      active: activeKanbanSubscriptions,
      client: input.client,
      desired: desiredKanbanSubscriptions,
      serverId: input.serverId,
    });
  }

  function resetSubscriptionsAfterReconnect(): void {
    const fallbackActive = {
      checkoutDiff: new Map(activeCheckoutDiffSubscriptions),
      workspaceTerminals: new Map(activeTerminalSubscriptions),
      kanban: new Map(activeKanbanSubscriptions),
    };
    activeCheckoutDiffSubscriptions.clear();
    activeTerminalSubscriptions.clear();
    activeKanbanSubscriptions.clear();
    reconcileSubscriptions(fallbackActive);
  }

  const unsubscribeQueryCache = input.queryClient.getQueryCache().subscribe((event) => {
    if (
      !shouldReconcileSubscriptionsForCacheEvent(event, input.serverId, {
        checkoutDiff: activeCheckoutDiffSubscriptions,
        workspaceTerminals: activeTerminalSubscriptions,
        kanban: activeKanbanSubscriptions,
      })
    ) {
      return;
    }
    reconcileSubscriptions();
  });
  const unsubscribeProviders = input.client.on("providers_snapshot_update", (message) => {
    applyProvidersSnapshotUpdate({
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  const unsubscribeDaemonConfig = input.client.on("status", (message) => {
    applyDaemonConfigStatus({ queryClient: input.queryClient, serverId: input.serverId, message });
  });
  const unsubscribeCheckoutDiffUpdate = input.client.on("checkout_diff_update", (message) => {
    applyCheckoutDiffUpdate({
      activeCheckoutDiffSubscriptions,
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  const unsubscribeCheckoutDiffResponse = input.client.on(
    "subscribe_checkout_diff_response",
    (message) => {
      applyCheckoutDiffSubscribeResponse({
        activeCheckoutDiffSubscriptions,
        queryClient: input.queryClient,
        serverId: input.serverId,
        message,
      });
    },
  );
  const unsubscribeTerminalsChanged = input.client.on("terminals_changed", (message) => {
    applyTerminalsChanged({
      activeCheckoutDiffSubscriptions,
      activeTerminalSubscriptions,
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  const unsubscribeKanbanUpdate = input.client.on("kanban.update", (message) => {
    applyKanbanUpdate({
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  let reconnectSubscriptionRepairs = reconnectSubscriptionRepairsByServerId.get(input.serverId);
  if (!reconnectSubscriptionRepairs) {
    reconnectSubscriptionRepairs = new Set();
    reconnectSubscriptionRepairsByServerId.set(input.serverId, reconnectSubscriptionRepairs);
  }
  reconnectSubscriptionRepairs.add(resetSubscriptionsAfterReconnect);

  reconcileSubscriptions();

  return () => {
    disposed = true;
    reconnectSubscriptionRepairs.delete(resetSubscriptionsAfterReconnect);
    if (reconnectSubscriptionRepairs.size === 0) {
      reconnectSubscriptionRepairsByServerId.delete(input.serverId);
    }
    unsubscribeQueryCache();
    unsubscribeProviders();
    unsubscribeDaemonConfig();
    unsubscribeCheckoutDiffUpdate();
    unsubscribeCheckoutDiffResponse();
    unsubscribeTerminalsChanged();
    unsubscribeKanbanUpdate();
    for (const subscriptionId of activeCheckoutDiffSubscriptions.keys()) {
      unsubscribeCheckoutDiff(input.client, subscriptionId);
    }
    activeCheckoutDiffSubscriptions.clear();
    for (const route of activeTerminalSubscriptions.values()) {
      input.client.unsubscribeTerminals(workspaceTerminalSubscriptionInput(route));
    }
    activeTerminalSubscriptions.clear();
    if (activeKanbanSubscriptions.has("kanban")) {
      unsubscribeKanban(input.client, input.serverId);
    }
    activeKanbanSubscriptions.clear();
  };
}

function reconcileCheckoutDiffSubscriptions(input: {
  active: Map<string, CheckoutDiffRoute>;
  client: ServerDataPushClient;
  desired: Map<string, CheckoutDiffRoute>;
  serverId: string;
}): void {
  for (const [subscriptionId, current] of input.active) {
    const desired = input.desired.get(subscriptionId);
    if (desired && areCheckoutDiffRoutesEqual(current, desired)) {
      continue;
    }
    unsubscribeCheckoutDiff(input.client, subscriptionId);
    input.active.delete(subscriptionId);
  }

  for (const [subscriptionId, desired] of input.desired) {
    if (input.active.has(subscriptionId)) {
      continue;
    }
    input.active.set(subscriptionId, desired);
    void input.client
      .subscribeCheckoutDiff(desired.cwd, desired.compare, {
        subscriptionId,
        requestId: `push-router:${input.serverId}:${subscriptionId}`,
      })
      .catch((error) => {
        if (areCheckoutDiffRoutesEqual(input.active.get(subscriptionId), desired)) {
          input.active.delete(subscriptionId);
        }
        console.error("[server-data] subscribeCheckoutDiff failed", {
          serverId: input.serverId,
          cwd: desired.cwd,
          error,
        });
      });
  }
}

function reconcileTerminalSubscriptions(input: {
  active: Map<string, WorkspaceTerminalsRoute>;
  client: ServerDataPushClient;
  desired: Map<string, WorkspaceTerminalsRoute>;
}): void {
  for (const [key, current] of input.active) {
    const desired = input.desired.get(key);
    if (desired && areWorkspaceTerminalsRoutesEqual(current, desired)) {
      continue;
    }
    input.client.unsubscribeTerminals(workspaceTerminalSubscriptionInput(current));
    input.active.delete(key);
  }

  for (const [key, desired] of input.desired) {
    if (input.active.has(key)) {
      continue;
    }
    input.active.set(key, desired);
    input.client.subscribeTerminals(workspaceTerminalSubscriptionInput(desired));
  }
}

function reconcileKanbanSubscriptions(input: {
  active: Map<string, KanbanRoute>;
  client: ServerDataPushClient;
  desired: Map<string, KanbanRoute>;
  serverId: string;
}): void {
  const current = input.active.get("kanban");
  const desired = input.desired.get("kanban");

  if (current && !desired) {
    unsubscribeKanban(input.client, input.serverId);
    input.active.delete("kanban");
  }

  if (desired && !input.active.has("kanban")) {
    input.active.set("kanban", desired);
    void input.client.kanbanSubscribe(`push-router:${input.serverId}:kanban`).catch((error) => {
      if (input.active.get("kanban") === desired) {
        input.active.delete("kanban");
      }
      console.error("[server-data] kanbanSubscribe failed", { serverId: input.serverId, error });
    });
  }
}

function applyDaemonConfigStatus(input: {
  queryClient: QueryClient;
  serverId: string;
  message: StatusMessage;
}): void {
  const payload = input.message.payload;
  if (!isDaemonConfigChangedPayload(payload)) {
    return;
  }
  input.queryClient.setQueryData<MutableDaemonConfig>(
    daemonConfigQueryKey(input.serverId),
    payload.config,
  );
  void input.queryClient.invalidateQueries({
    queryKey: daemonPairingOfferQueryKey(input.serverId),
  });
}

function applyCheckoutDiffUpdate(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: CheckoutDiffUpdateMessage;
}): void {
  setCheckoutDiffPayload({
    activeCheckoutDiffSubscriptions: input.activeCheckoutDiffSubscriptions,
    queryClient: input.queryClient,
    serverId: input.serverId,
    subscriptionId: input.message.payload.subscriptionId,
    payload: {
      cwd: input.message.payload.cwd,
      files: orderCheckoutDiffFiles(input.message.payload.files),
      error: input.message.payload.error,
      ...(input.message.payload.diffTooLarge !== undefined
        ? { diffTooLarge: input.message.payload.diffTooLarge }
        : {}),
      requestId: `subscription:${input.message.payload.subscriptionId}`,
    },
  });
}

function applyCheckoutDiffSubscribeResponse(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: SubscribeCheckoutDiffResponseMessage;
}): void {
  setCheckoutDiffPayload({
    activeCheckoutDiffSubscriptions: input.activeCheckoutDiffSubscriptions,
    queryClient: input.queryClient,
    serverId: input.serverId,
    subscriptionId: input.message.payload.subscriptionId,
    payload: {
      cwd: input.message.payload.cwd,
      files: orderCheckoutDiffFiles(input.message.payload.files),
      error: input.message.payload.error,
      ...(input.message.payload.diffTooLarge !== undefined
        ? { diffTooLarge: input.message.payload.diffTooLarge }
        : {}),
      requestId: input.message.payload.requestId,
    },
  });
}

function setCheckoutDiffPayload(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  subscriptionId: string;
  payload: CheckoutDiffCachePayload;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route =
      getServerDataRoute(query) ??
      getActiveCheckoutDiffRouteForQueryKey({
        active: input.activeCheckoutDiffSubscriptions,
        queryKey: query.queryKey,
        serverId: input.serverId,
      });
    if (
      !route ||
      route.domain !== "checkoutDiff" ||
      route.serverId !== input.serverId ||
      route.subscriptionId !== input.subscriptionId
    ) {
      continue;
    }
    input.queryClient.setQueryData<CheckoutDiffCachePayload>(query.queryKey, input.payload);
  }
}

function applyTerminalsChanged(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  activeTerminalSubscriptions: Map<string, WorkspaceTerminalsRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: TerminalsChangedMessage;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route = getActiveServerDataRoute(query, input.serverId, {
      checkoutDiff: input.activeCheckoutDiffSubscriptions,
      workspaceTerminals: input.activeTerminalSubscriptions,
      kanban: EMPTY_KANBAN_SUBSCRIPTIONS,
    });
    if (
      !route ||
      route.domain !== "workspaceTerminals" ||
      route.cwd !== input.message.payload.cwd
    ) {
      continue;
    }

    const matchingTerminals = input.message.payload.terminals.filter(
      (terminal) => terminal.workspaceId === route.workspaceId,
    );

    input.queryClient.setQueryData<ListTerminalsPayload>(query.queryKey, (current) => ({
      cwd: input.message.payload.cwd,
      terminals: matchingTerminals,
      requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
    }));
  }
}

function applyKanbanUpdate(input: {
  queryClient: QueryClient;
  serverId: string;
  message: KanbanUpdateMessage;
}): void {
  const payload = input.message.payload;

  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route = getServerDataRoute(query);
    if (
      !route ||
      route.domain !== "kanban" ||
      !route.enabled ||
      !route.serverIds.includes(input.serverId) ||
      query.queryKey[0] !== kanbansQueryBaseKey[0]
    ) {
      continue;
    }
    input.queryClient.setQueryData<FetchAggregatedKanbansState>(query.queryKey, (current) =>
      updateAggregatedKanbansData(current, (kanbans) =>
        applyKanbanUpdateToList(kanbans, input.serverId, payload),
      ),
    );
  }

  const kanbanId = payload.kind === "upsert" ? payload.kanban.id : payload.kanbanId;
  const detailKey = kanbanQueryKey(input.serverId, kanbanId);
  if (input.queryClient.getQueryCache().find({ queryKey: detailKey })) {
    input.queryClient.setQueryData<StoredKanban | null>(
      detailKey,
      payload.kind === "upsert" ? payload.kanban : null,
    );
  }
}

function applyKanbanUpdateToList(
  kanbans: AggregatedKanban[],
  serverId: string,
  payload: KanbanUpdateMessage["payload"],
): AggregatedKanban[] {
  if (payload.kind === "remove") {
    return kanbans.filter(
      (kanban) => !(kanban.serverId === serverId && kanban.id === payload.kanbanId),
    );
  }

  const summary = toKanbanSummary(payload.kanban);
  const serverName = kanbans.find((kanban) => kanban.serverId === serverId)?.serverName ?? serverId;
  const next: AggregatedKanban = { ...summary, serverId, serverName };
  const index = kanbans.findIndex(
    (kanban) => kanban.serverId === serverId && kanban.id === summary.id,
  );
  if (index === -1) {
    return [...kanbans, next];
  }
  const updated = [...kanbans];
  updated[index] = next;
  return updated;
}

function toKanbanSummary(kanban: StoredKanban): KanbanSummary {
  const { plans: _plans, ...summary } = kanban;
  return summary;
}

function getActiveServerDataRoute(
  query: Query,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): ServerDataRoute | null {
  if (query.getObserversCount() === 0) {
    return null;
  }
  const route = getServerDataRoute(query);
  if (route) {
    if (route.domain === "kanban") {
      return route.enabled && route.serverIds.includes(serverId) ? route : null;
    }
    return route.enabled && route.serverId === serverId ? route : null;
  }
  return getActiveRouteForQueryKey({
    active,
    queryKey: query.queryKey,
    serverId,
  });
}

function getActiveRouteForQueryKey(input: {
  active: ActiveServerDataSubscriptions;
  queryKey: QueryKey;
  serverId: string;
}): ServerDataRoute | null {
  return (
    getActiveTerminalRouteForQueryKey({
      active: input.active.workspaceTerminals,
      queryKey: input.queryKey,
      serverId: input.serverId,
    }) ??
    getActiveCheckoutDiffRouteForQueryKey({
      active: input.active.checkoutDiff,
      queryKey: input.queryKey,
      serverId: input.serverId,
    })
  );
}

function getActiveTerminalRouteForQueryKey(input: {
  active: Map<string, WorkspaceTerminalsRoute>;
  queryKey: QueryKey;
  serverId: string;
}): WorkspaceTerminalsRoute | null {
  if (!isQueryForServer(input.queryKey, "terminals", input.serverId)) {
    return null;
  }
  const cwd = input.queryKey[2];
  const workspaceId = input.queryKey[3];
  if (
    typeof cwd !== "string" ||
    (workspaceId !== undefined && workspaceId !== null && typeof workspaceId !== "string")
  ) {
    return null;
  }
  return input.active.get(`${cwd}\u0000${workspaceId ?? ""}`) ?? null;
}

function getActiveCheckoutDiffRouteForQueryKey(input: {
  active: Map<string, CheckoutDiffRoute>;
  queryKey: QueryKey;
  serverId: string;
}): CheckoutDiffRoute | null {
  if (!isQueryForServer(input.queryKey, "checkoutDiff", input.serverId)) {
    return null;
  }
  for (const route of input.active.values()) {
    if (isCheckoutDiffQueryKeyForRoute(input.queryKey, route)) {
      return route;
    }
  }
  return null;
}

function shouldReconcileSubscriptionsForCacheEvent(
  event: QueryCacheNotifyEvent,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): boolean {
  if (!canEventChangeDesiredSubscriptions(event.type)) {
    return false;
  }
  const route = getServerDataRoute(event.query);
  if (route?.domain === "kanban") {
    return route.enabled && route.serverIds.includes(serverId);
  }
  if (route?.serverId === serverId) {
    return true;
  }
  return (
    getActiveRouteForQueryKey({
      active,
      queryKey: event.query.queryKey,
      serverId,
    }) !== null
  );
}

function canEventChangeDesiredSubscriptions(type: QueryCacheNotifyEvent["type"]): boolean {
  return (
    type === "added" ||
    type === "removed" ||
    type === "observerAdded" ||
    type === "observerRemoved" ||
    type === "observerOptionsUpdated"
  );
}

function getServerDataRoute(query: Query): ServerDataRoute | null {
  const meta = query.meta;
  if (!isRecord(meta) || !isRecord(meta.serverData)) {
    return null;
  }
  return readServerDataRoute(meta.serverData);
}

function readServerDataRoute(value: Record<string, unknown>): ServerDataRoute | null {
  const domain = value.domain;
  const enabled = value.enabled;
  if (typeof enabled !== "boolean") {
    return null;
  }

  if (domain === "kanban") {
    const serverIds = value.serverIds;
    if (!Array.isArray(serverIds) || !serverIds.every((id) => typeof id === "string")) {
      return null;
    }
    return { domain, enabled, serverIds };
  }

  const serverId = value.serverId;
  const cwd = value.cwd;
  if (typeof serverId !== "string" || typeof cwd !== "string") {
    return null;
  }

  if (domain === "checkoutDiff") {
    const subscriptionId = value.subscriptionId;
    const compare = readCheckoutDiffCompare(value.compare);
    if (typeof subscriptionId !== "string" || !compare) {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      subscriptionId,
      cwd,
      compare,
    };
  }

  if (domain === "workspaceTerminals") {
    const workspaceId = value.workspaceId;
    if (workspaceId !== undefined && typeof workspaceId !== "string") {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      cwd,
      ...(workspaceId ? { workspaceId } : {}),
    };
  }

  return null;
}

function readCheckoutDiffCompare(value: unknown): CheckoutDiffCompare | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = value.mode;
  const baseRef = value.baseRef;
  const ignoreWhitespace = value.ignoreWhitespace;
  if (mode !== "uncommitted" && mode !== "base") {
    return null;
  }
  if (baseRef !== undefined && typeof baseRef !== "string") {
    return null;
  }
  if (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean") {
    return null;
  }
  return {
    mode,
    ...(baseRef ? { baseRef } : {}),
    ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
  };
}

function areCheckoutDiffRoutesEqual(
  left: CheckoutDiffRoute | undefined,
  right: CheckoutDiffRoute,
): boolean {
  return (
    left?.serverId === right.serverId &&
    left.subscriptionId === right.subscriptionId &&
    left.cwd === right.cwd &&
    left.compare.mode === right.compare.mode &&
    left.compare.baseRef === right.compare.baseRef &&
    left.compare.ignoreWhitespace === right.compare.ignoreWhitespace
  );
}

function isCheckoutDiffQueryKeyForRoute(queryKey: QueryKey, route: CheckoutDiffRoute): boolean {
  return (
    queryKey[0] === "checkoutDiff" &&
    queryKey[1] === route.serverId &&
    queryKey[2] === route.cwd &&
    queryKey[3] === route.compare.mode &&
    queryKey[4] === (route.compare.baseRef ?? "") &&
    queryKey[5] === (route.compare.ignoreWhitespace === true)
  );
}

function areWorkspaceTerminalsRoutesEqual(
  left: WorkspaceTerminalsRoute,
  right: WorkspaceTerminalsRoute,
): boolean {
  return (
    left.serverId === right.serverId &&
    left.cwd === right.cwd &&
    left.workspaceId === right.workspaceId
  );
}

function workspaceTerminalSubscriptionKey(route: WorkspaceTerminalsRoute): string {
  return `${route.cwd}\u0000${route.workspaceId ?? ""}`;
}

function workspaceTerminalSubscriptionInput(route: WorkspaceTerminalsRoute): {
  cwd: string;
  workspaceId?: string;
} {
  return {
    cwd: route.cwd,
    ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
  };
}

function unsubscribeCheckoutDiff(client: ServerDataPushClient, subscriptionId: string): void {
  try {
    client.unsubscribeCheckoutDiff(subscriptionId);
  } catch {
    // Disconnect cleanup can race with explicit subscription teardown.
  }
}

function unsubscribeKanban(client: ServerDataPushClient, serverId: string): void {
  void client.kanbanUnsubscribe(`push-router:${serverId}:kanban:unsubscribe`).catch((error) => {
    console.error("[server-data] kanbanUnsubscribe failed", { serverId, error });
  });
}

function isQueryForServer(queryKey: QueryKey, kind: string, serverId: string): boolean {
  return queryKey.length >= 2 && queryKey[0] === kind && queryKey[1] === serverId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDaemonConfigChangedPayload(
  payload: StatusMessage["payload"],
): payload is { status: "daemon_config_changed"; config: MutableDaemonConfig } {
  return payload.status === "daemon_config_changed" && isRecord(payload.config);
}
