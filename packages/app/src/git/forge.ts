/**
 * Forge-neutral presentation layer for the git-hosting UI.
 *
 * The daemon resolves which forge backs a workspace and reports it on the wire
 * (`CheckoutPrStatusResponse.payload.forge`). The model keeps the `PullRequest`
 * noun in code and types; the PR↔MR relabel, the number prefix, and the brand
 * mark are a UI concern driven entirely by this value. Unknown/absent forges
 * fall back to GitHub so old daemons (which never send a forge) render exactly
 * as before.
 */
import { isGitHubHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";

export type Forge = "github" | "gitlab" | "gitea" | "forgejo";
export type ForgeIconKind = "github" | "gitlab" | "gitea" | "forgejo";

export function normalizeForge(raw: string | null | undefined): Forge {
  if (raw === "gitlab" || raw === "gitea" || raw === "forgejo") {
    return raw;
  }
  return "github";
}

export function forgeFromRemoteUrl(remoteUrl: string | null | undefined): Forge | null {
  if (!remoteUrl) {
    return null;
  }
  const host = parseGitRemoteLocation(remoteUrl)?.host;
  if (!host) {
    return null;
  }
  if (isGitHubHost(host)) {
    return "github";
  }
  if (/gitlab/i.test(host)) {
    return "gitlab";
  }
  if (/forgejo/i.test(host) || /(^|\.)codeberg\.org$/i.test(host)) {
    return "forgejo";
  }
  if (/gitea/i.test(host)) {
    return "gitea";
  }
  return null;
}

export interface ForgePresentation {
  forge: Forge;
  icon: ForgeIconKind;
  /** Human brand name, e.g. for "Open on GitLab". */
  brandLabel: string;
  /** Short change-request noun: "PR" for GitHub, "MR" for GitLab. */
  changeRequestAbbrev: string;
  /** Full change-request noun: "pull request" for GitHub, "merge request" for GitLab. */
  changeRequestNoun: string;
  /** Prefix the forge puts before a change-request number: "#" vs "!". */
  numberPrefix: string;
  /** Prefix the forge puts before an issue number ("#" on both supported forges). */
  issueNumberPrefix: string;
  cli: "gh" | "glab" | "tea";
  composer: {
    addIssueOrChangeRequestKey:
      | "composer.attachments.addIssueOrPr"
      | "composer.attachments.addIssueOrMr";
    searchPlaceholderKey:
      | "composer.github.searchPlaceholder"
      | "composer.github.searchPlaceholderMr";
    titleKey: "composer.github.title" | "composer.github.titleMr";
  };
}

function buildTeaForgePresentation(
  forge: Extract<Forge, "gitea" | "forgejo">,
  brandLabel: string,
  icon: Extract<ForgeIconKind, "gitea" | "forgejo">,
): ForgePresentation {
  return {
    forge,
    icon,
    brandLabel,
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    numberPrefix: "#",
    issueNumberPrefix: "#",
    cli: "tea",
    composer: {
      addIssueOrChangeRequestKey: "composer.attachments.addIssueOrPr",
      searchPlaceholderKey: "composer.github.searchPlaceholder",
      titleKey: "composer.github.title",
    },
  };
}

const PRESENTATION: Record<Forge, ForgePresentation> = {
  github: {
    forge: "github",
    icon: "github",
    brandLabel: "GitHub",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    numberPrefix: "#",
    issueNumberPrefix: "#",
    cli: "gh",
    composer: {
      addIssueOrChangeRequestKey: "composer.attachments.addIssueOrPr",
      searchPlaceholderKey: "composer.github.searchPlaceholder",
      titleKey: "composer.github.title",
    },
  },
  gitlab: {
    forge: "gitlab",
    icon: "gitlab",
    brandLabel: "GitLab",
    changeRequestAbbrev: "MR",
    changeRequestNoun: "merge request",
    numberPrefix: "!",
    issueNumberPrefix: "#",
    cli: "glab",
    composer: {
      addIssueOrChangeRequestKey: "composer.attachments.addIssueOrMr",
      searchPlaceholderKey: "composer.github.searchPlaceholderMr",
      titleKey: "composer.github.titleMr",
    },
  },
  gitea: buildTeaForgePresentation("gitea", "Gitea", "gitea"),
  forgejo: buildTeaForgePresentation("forgejo", "Forgejo", "forgejo"),
};

export function getForgePresentation(forge: Forge): ForgePresentation {
  return PRESENTATION[forge];
}

export function buildForgeSignInCommand(forge: Forge, host: string | null): string {
  if (forge === "gitlab") {
    return host ? `glab auth login --hostname ${host}` : "glab auth login";
  }
  if (forge === "gitea" || forge === "forgejo") {
    return "tea login add";
  }
  return "gh auth login";
}
