import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  ForgeSearchKind,
  ForgeSearchRequest,
  ForgeSearchResponse,
} from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

export const FORGE_SEARCH_STALE_TIME = 30_000;

export type ForgeSearchPayload = ForgeSearchResponse["payload"];

export interface ForgeSearchClient {
  searchForge: (
    options: {
      cwd: string;
      query: string;
      limit?: number;
      kinds?: ForgeSearchRequest["kinds"];
    },
    requestId?: string,
  ) => Promise<ForgeSearchPayload>;
  searchGitHub?: (
    options: {
      cwd: string;
      query: string;
      limit?: number;
      kinds?: ForgeSearchRequest["kinds"];
    },
    requestId?: string,
  ) => Promise<ForgeSearchPayload>;
}

type LegacyGitHubSearchKind = "github-issue" | "github-pr";

interface ForgeSearchQueryInput {
  client: ForgeSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: ForgeSearchRequest["kinds"];
  enabled: boolean;
  supportsForgeSearch?: boolean;
  hostDisconnectedMessage?: string;
}

export function forgeSearchQueryKey(
  serverId: string,
  cwd: string,
  query: string,
  kinds?: ForgeSearchRequest["kinds"],
  transport: "forge" | "github" = "forge",
) {
  const trimmedQuery = query.trim();
  if (!kinds) {
    return ["forge-search", serverId, cwd, transport, trimmedQuery] as const;
  }
  return [
    "forge-search",
    serverId,
    cwd,
    transport,
    trimmedQuery,
    [...kinds].sort().join(","),
  ] as const;
}

export function buildForgeSearchQueryOptions(input: ForgeSearchQueryInput) {
  const query = input.query.trim();
  const transport = input.supportsForgeSearch === true ? "forge" : "github";

  return {
    queryKey: forgeSearchQueryKey(input.serverId, input.cwd, query, input.kinds, transport),
    queryFn: async (): Promise<ForgeSearchPayload> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const request = input.kinds
        ? { cwd: input.cwd, query, limit: 20, kinds: input.kinds }
        : { cwd: input.cwd, query, limit: 20 };
      if (transport === "github" && input.client.searchGitHub) {
        return input.client.searchGitHub(toLegacyGitHubSearchRequest(request));
      }
      return input.client.searchForge(request);
    },
    enabled: input.enabled && Boolean(input.client),
    staleTime: FORGE_SEARCH_STALE_TIME,
  };
}

function toLegacyGitHubSearchKind(kind: ForgeSearchKind): LegacyGitHubSearchKind {
  return kind === "change_request" ? "github-pr" : "github-issue";
}

function toLegacyGitHubSearchRequest<T extends { kinds?: ForgeSearchRequest["kinds"] }>(
  request: T,
): T {
  if (!request.kinds) {
    return request;
  }
  return {
    ...request,
    kinds: request.kinds.map(toLegacyGitHubSearchKind),
  } as T;
}

export function useForgeSearchQuery(input: ForgeSearchQueryInput) {
  const { t } = useTranslation();
  return useQuery(
    buildForgeSearchQueryOptions({
      ...input,
      hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );
}
