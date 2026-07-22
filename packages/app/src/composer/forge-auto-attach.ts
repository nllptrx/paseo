import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { extractForgeRefs, type ForgeRef } from "@/git/forge-refs";
import { buildForgeSearchQueryOptions, type ForgeSearchClient } from "@/git/use-forge-search-query";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import { isAttachmentSelectedForForgeItem, toggleForgeAttachment } from "./actions";

const AUTO_ATTACH_DEBOUNCE_MS = 300;

interface ComposerForgeAutoAttachInput {
  text: string;
  remoteUrl: string | null | undefined;
  attachments: UserComposerAttachment[];
  client: ForgeSearchClient | null;
  isConnected: boolean;
  serverId: string;
  cwd: string;
  supportsForgeSearch?: boolean;
  setAttachments: Dispatch<SetStateAction<UserComposerAttachment[]>>;
  onChangeRequestDetected?: () => void;
  onChangeRequestAdded?: (item: ForgeSearchItem) => void;
}

interface ComposerForgeAutoAttachResult {
  isResolving: boolean;
  markForgeAttachmentRemoved: (attachment: ComposerAttachment | undefined) => void;
}

export function useComposerForgeAutoAttach(
  params: ComposerForgeAutoAttachInput,
): ComposerForgeAutoAttachResult {
  const queryClient = useQueryClient();
  const latestRef = useRef(params);
  const removedRefKeysRef = useRef(new Set<string>());
  const pendingRefKeysRef = useRef(new Set<string>());
  const presentChangeRequestKeysRef = useRef(new Set<string>());
  const previousTargetRef = useRef({ serverId: params.serverId, cwd: params.cwd });
  const [resolvingRefCounts, setResolvingRefCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  latestRef.current = params;

  useEffect(() => {
    suppressRefsCarriedAcrossTargets({
      params: latestRef.current,
      previousTargetRef,
      removedRefKeys: removedRefKeysRef.current,
    });
    notifyNewChangeRequestRefs({
      params: latestRef.current,
      presentChangeRequestKeysRef,
    });
    const refs = refsReadyForLookup({
      params: latestRef.current,
      removedRefKeys: removedRefKeysRef.current,
      pendingRefKeys: pendingRefKeysRef.current,
    });
    if (refs.length === 0) {
      return;
    }

    const refKeys = refs.map(forgeRefKey);
    setResolvingRefCounts((current) => addKeys(current, refKeys));
    let resolvingReleased = false;
    const releaseResolving = () => {
      if (resolvingReleased) return;
      resolvingReleased = true;
      clearResolvingKeys(setResolvingRefCounts, refKeys);
    };

    const timerId = setTimeout(() => {
      void attachRefs({
        refs,
        queryClient,
        latestRef,
        removedRefKeys: removedRefKeysRef.current,
        pendingRefKeys: pendingRefKeysRef.current,
      }).finally(releaseResolving);
    }, AUTO_ATTACH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
      releaseResolving();
    };
  }, [
    params.text,
    params.remoteUrl,
    params.attachments,
    params.client,
    params.isConnected,
    params.serverId,
    params.cwd,
    params.supportsForgeSearch,
    queryClient,
  ]);

  const markForgeAttachmentRemoved = useCallback((attachment: ComposerAttachment | undefined) => {
    const key = attachmentKey(attachment);
    if (key) {
      removedRefKeysRef.current.add(key);
    }
  }, []);

  return useMemo(
    () => ({
      isResolving: resolvingRefCounts.size > 0,
      markForgeAttachmentRemoved,
    }),
    [markForgeAttachmentRemoved, resolvingRefCounts.size],
  );
}

function suppressRefsCarriedAcrossTargets({
  params,
  previousTargetRef,
  removedRefKeys,
}: {
  params: ComposerForgeAutoAttachInput;
  previousTargetRef: RefObject<{ serverId: string; cwd: string }>;
  removedRefKeys: Set<string>;
}): void {
  const previous = previousTargetRef.current;
  const targetChanged =
    previous.cwd.trim().length > 0 &&
    params.cwd.trim().length > 0 &&
    (previous.serverId !== params.serverId || previous.cwd !== params.cwd);
  previousTargetRef.current = { serverId: params.serverId, cwd: params.cwd };
  if (!targetChanged) return;

  for (const ref of extractForgeRefs(params.text, params.remoteUrl)) {
    removedRefKeys.add(forgeRefKey(ref));
  }
}

function notifyNewChangeRequestRefs({
  params,
  presentChangeRequestKeysRef,
}: {
  params: ComposerForgeAutoAttachInput;
  presentChangeRequestKeysRef: RefObject<Set<string>>;
}): void {
  const currentKeys = new Set(
    extractForgeRefs(params.text, params.remoteUrl)
      .filter((ref) => ref.kind === "change_request")
      .map(forgeRefKey),
  );
  for (const key of currentKeys) {
    if (!presentChangeRequestKeysRef.current.has(key)) {
      params.onChangeRequestDetected?.();
    }
  }
  presentChangeRequestKeysRef.current = currentKeys;
}

function addKeys(
  current: ReadonlyMap<string, number>,
  keys: readonly string[],
): ReadonlyMap<string, number> {
  const nextCounts = new Map(current);
  for (const key of keys) nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1);
  return nextCounts;
}

function removeKeys(
  current: ReadonlyMap<string, number>,
  keys: readonly string[],
): ReadonlyMap<string, number> {
  const next = new Map(current);
  for (const key of keys) {
    const count = next.get(key) ?? 0;
    if (count <= 1) next.delete(key);
    else next.set(key, count - 1);
  }
  return next;
}

function clearResolvingKeys(
  setResolvingRefCounts: Dispatch<SetStateAction<ReadonlyMap<string, number>>>,
  keys: readonly string[],
): void {
  setResolvingRefCounts((current) => removeKeys(current, keys));
}

async function attachRefs({
  refs,
  queryClient,
  latestRef,
  removedRefKeys,
  pendingRefKeys,
}: {
  refs: ForgeRef[];
  queryClient: QueryClient;
  latestRef: RefObject<ComposerForgeAutoAttachInput>;
  removedRefKeys: Set<string>;
  pendingRefKeys: Set<string>;
}): Promise<void> {
  for (const ref of refs) {
    const key = forgeRefKey(ref);
    if (pendingRefKeys.has(key)) {
      continue;
    }
    pendingRefKeys.add(key);
    try {
      await attachRef({ ref, key, queryClient, latestRef, removedRefKeys });
    } finally {
      pendingRefKeys.delete(key);
    }
  }
}

async function attachRef({
  ref,
  key,
  queryClient,
  latestRef,
  removedRefKeys,
}: {
  ref: ForgeRef;
  key: string;
  queryClient: QueryClient;
  latestRef: RefObject<ComposerForgeAutoAttachInput>;
  removedRefKeys: Set<string>;
}): Promise<void> {
  const snapshot = latestRef.current;
  if (!snapshot.client || !snapshot.isConnected || !isRefStillPresent(ref, snapshot)) {
    return;
  }

  const search = await fetchForgeRefSearch({ ref, snapshot, queryClient });
  if (!search) {
    return;
  }
  const item = search.items.find((candidate) => forgeItemMatchesRef(candidate, ref));
  const current = latestRef.current;
  if (
    !item ||
    removedRefKeys.has(key) ||
    !isSameLookupTarget(snapshot, current) ||
    !isRefStillPresent(ref, current)
  ) {
    return;
  }

  if (isAttachmentSelectedForForgeItem(current.attachments, item)) {
    return;
  }
  current.setAttachments((attachments) => {
    if (removedRefKeys.has(key) || isAttachmentSelectedForForgeItem(attachments, item)) {
      return attachments;
    }
    return toggleForgeAttachment(attachments, item);
  });
  if (item.kind === "change_request") {
    current.onChangeRequestAdded?.(item);
  }
}

function refsReadyForLookup({
  params,
  removedRefKeys,
  pendingRefKeys,
}: {
  params: ComposerForgeAutoAttachInput;
  removedRefKeys: Set<string>;
  pendingRefKeys: Set<string>;
}): ForgeRef[] {
  if (!params.client || !params.isConnected || params.cwd.trim().length === 0) {
    return [];
  }

  return extractForgeRefs(params.text, params.remoteUrl).filter((ref) => {
    const key = forgeRefKey(ref);
    return (
      !removedRefKeys.has(key) &&
      !pendingRefKeys.has(key) &&
      !hasForgeAttachment(params.attachments, ref)
    );
  });
}

async function fetchForgeRefSearch({
  ref,
  snapshot,
  queryClient,
}: {
  ref: ForgeRef;
  snapshot: ComposerForgeAutoAttachInput;
  queryClient: QueryClient;
}) {
  if (!snapshot.client) {
    return null;
  }

  try {
    return await queryClient.fetchQuery(
      buildForgeSearchQueryOptions({
        client: snapshot.client,
        serverId: snapshot.serverId,
        cwd: snapshot.cwd,
        query: String(ref.number),
        supportsForgeSearch: snapshot.supportsForgeSearch,
        enabled: true,
      }),
    );
  } catch {
    return null;
  }
}

function isRefStillPresent(ref: ForgeRef, params: ComposerForgeAutoAttachInput): boolean {
  return extractForgeRefs(params.text, params.remoteUrl).some(
    (candidate) => forgeRefKey(candidate) === forgeRefKey(ref),
  );
}

function isSameLookupTarget(
  initial: ComposerForgeAutoAttachInput,
  current: ComposerForgeAutoAttachInput,
): boolean {
  return (
    initial.serverId === current.serverId &&
    initial.cwd === current.cwd &&
    initial.remoteUrl === current.remoteUrl
  );
}

function hasForgeAttachment(attachments: UserComposerAttachment[], ref: ForgeRef): boolean {
  return attachments.some((attachment) => attachmentKey(attachment) === forgeRefKey(ref));
}

function forgeItemMatchesRef(item: ForgeSearchItem, ref: ForgeRef): boolean {
  return item.kind === ref.kind && item.number === ref.number;
}

function forgeRefKey(ref: ForgeRef): string {
  return `${ref.kind}:${ref.number}`;
}

function attachmentKey(attachment: ComposerAttachment | undefined): string | null {
  if (
    !attachment ||
    attachment.kind === "image" ||
    (attachment.kind !== "forge_change_request" &&
      attachment.kind !== "forge_issue" &&
      attachment.kind !== "github_pr" &&
      attachment.kind !== "github_issue")
  ) {
    return null;
  }
  return `${attachment.item.kind}:${attachment.item.number}`;
}
