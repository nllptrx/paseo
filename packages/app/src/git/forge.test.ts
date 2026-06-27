import { describe, expect, it } from "vitest";
import {
  buildForgeSignInCommand,
  forgeFromRemoteUrl,
  getForgePresentation,
  normalizeForge,
} from "./forge";

describe("normalizeForge", () => {
  it("maps the gitlab discriminant to gitlab", () => {
    expect(normalizeForge("gitlab")).toBe("gitlab");
  });

  it("keeps registered tea forges and defaults unknown or absent values to github", () => {
    expect(normalizeForge("github")).toBe("github");
    expect(normalizeForge("gitea")).toBe("gitea");
    expect(normalizeForge("forgejo")).toBe("forgejo");
    expect(normalizeForge(undefined)).toBe("github");
    expect(normalizeForge(null)).toBe("github");
    expect(normalizeForge("bitbucket")).toBe("github");
  });
});

describe("getForgePresentation", () => {
  it("keeps GitHub on the pull-request noun and the # prefix", () => {
    const github = getForgePresentation("github");
    expect(github.brandLabel).toBe("GitHub");
    expect(github.changeRequestAbbrev).toBe("PR");
    expect(github.numberPrefix).toBe("#");
    expect(github.issueNumberPrefix).toBe("#");
    expect(github.composer).toEqual({
      addIssueOrChangeRequestKey: "composer.attachments.addIssueOrPr",
      searchPlaceholderKey: "composer.github.searchPlaceholder",
      titleKey: "composer.github.title",
    });
  });

  it("relabels GitLab to the merge-request noun and the ! prefix", () => {
    const gitlab = getForgePresentation("gitlab");
    expect(gitlab.brandLabel).toBe("GitLab");
    expect(gitlab.changeRequestAbbrev).toBe("MR");
    expect(gitlab.numberPrefix).toBe("!");
    expect(gitlab.issueNumberPrefix).toBe("#");
    expect(gitlab.composer).toEqual({
      addIssueOrChangeRequestKey: "composer.attachments.addIssueOrMr",
      searchPlaceholderKey: "composer.github.searchPlaceholderMr",
      titleKey: "composer.github.titleMr",
    });
  });

  it("presents Gitea and Forgejo with GitHub nouns and the tea CLI", () => {
    expect(getForgePresentation("gitea")).toMatchObject({
      forge: "gitea",
      icon: "gitea",
      brandLabel: "Gitea",
      changeRequestAbbrev: "PR",
      numberPrefix: "#",
      issueNumberPrefix: "#",
      cli: "tea",
    });
    expect(getForgePresentation("forgejo")).toMatchObject({
      forge: "forgejo",
      icon: "forgejo",
      brandLabel: "Forgejo",
      changeRequestAbbrev: "PR",
      cli: "tea",
    });
  });
});

describe("forgeFromRemoteUrl", () => {
  it("detects Forgejo before Gitea, including codeberg.org", () => {
    expect(forgeFromRemoteUrl("https://codeberg.org/example/repo.git")).toBe("forgejo");
    expect(forgeFromRemoteUrl("git@forgejo.example.org:example/repo.git")).toBe("forgejo");
    expect(forgeFromRemoteUrl("https://gitea.com/example/repo.git")).toBe("gitea");
  });
});

describe("buildForgeSignInCommand", () => {
  it("uses tea login add for both Gitea-family presentations", () => {
    expect(buildForgeSignInCommand("gitea", "gitea.com")).toBe("tea login add");
    expect(buildForgeSignInCommand("forgejo", "codeberg.org")).toBe("tea login add");
  });
});
