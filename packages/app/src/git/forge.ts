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
  /** Human brand name, e.g. for "Open on GitLab". */
  brandLabel: string;
  /** Short change-request noun: "PR" for GitHub, "MR" for GitLab. */
  changeRequestAbbrev: string;
  /** Prefix the forge puts before a change-request number: "#" vs "!". */
  numberPrefix: string;
}

const PRESENTATION: Record<Forge, ForgePresentation> = {
  github: {
    forge: "github",
    brandLabel: "GitHub",
    changeRequestAbbrev: "PR",
    numberPrefix: "#",
  },
  gitlab: {
    forge: "gitlab",
    brandLabel: "GitLab",
    changeRequestAbbrev: "MR",
    numberPrefix: "!",
  },
};

export function getForgePresentation(forge: Forge): ForgePresentation {
  return PRESENTATION[forge];
}
