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
export type Forge = "github" | "gitlab";

export function normalizeForge(raw: string | null | undefined): Forge {
  return raw === "gitlab" ? "gitlab" : "github";
}

export interface ForgePresentation {
  forge: Forge;
  icon: "github" | "gitlab";
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

const PRESENTATION: Record<Forge, ForgePresentation> = {
  github: {
    forge: "github",
    icon: "github",
    brandLabel: "GitHub",
    changeRequestAbbrev: "PR",
    changeRequestNoun: "pull request",
    numberPrefix: "#",
    issueNumberPrefix: "#",
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
    composer: {
      addIssueOrChangeRequestKey: "composer.attachments.addIssueOrMr",
      searchPlaceholderKey: "composer.github.searchPlaceholderMr",
      titleKey: "composer.github.titleMr",
    },
  },
};

export function getForgePresentation(forge: Forge): ForgePresentation {
  return PRESENTATION[forge];
}
