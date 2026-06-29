import type { GitHubSearchRequest, GitHubSearchResponse } from "@getpaseo/protocol/messages";
import {
  buildForgeSearchQueryOptions,
  FORGE_SEARCH_STALE_TIME,
  forgeSearchQueryKey,
  useForgeSearchQuery,
  type ForgeSearchClient,
} from "@/git/use-forge-search-query";

export const GITHUB_SEARCH_STALE_TIME = FORGE_SEARCH_STALE_TIME;
export { buildForgeSearchQueryOptions, forgeSearchQueryKey };
export type { ForgeSearchClient };
export type GitHubSearchPayload = GitHubSearchResponse["payload"];

export interface GitHubSearchClient {
  searchGitHub: (
    options: {
      cwd: string;
      query: string;
      limit?: number;
      kinds?: GitHubSearchRequest["kinds"];
    },
    requestId?: string,
  ) => Promise<GitHubSearchPayload>;
}

export const githubSearchQueryKey = forgeSearchQueryKey;

export function buildGithubSearchQueryOptions(input: {
  client: GitHubSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: GitHubSearchRequest["kinds"];
  enabled: boolean;
  hostDisconnectedMessage?: string;
}) {
  const client: ForgeSearchClient | null = input.client
    ? {
        searchGitHub: input.client.searchGitHub,
        searchForge: async (options, requestId) =>
          input.client?.searchGitHub(options, requestId) ??
          Promise.resolve({
            items: [],
            featuresEnabled: false,
            authState: "no_remote",
            githubFeaturesEnabled: false,
            error: "Host disconnected",
            requestId: requestId ?? "",
          }),
      }
    : null;
  return buildForgeSearchQueryOptions({ ...input, client, supportsForgeSearch: false });
}

export function useGithubSearchQuery(input: Parameters<typeof useForgeSearchQuery>[0]) {
  return useForgeSearchQuery(input);
}
