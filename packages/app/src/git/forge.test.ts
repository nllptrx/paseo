import { describe, expect, it } from "vitest";
import { getForgePresentation, normalizeForge } from "./forge";

describe("normalizeForge", () => {
  it("maps the gitlab discriminant to gitlab", () => {
    expect(normalizeForge("gitlab")).toBe("gitlab");
  });

  it("defaults unknown, absent, and github values to github", () => {
    expect(normalizeForge("github")).toBe("github");
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
  });

  it("relabels GitLab to the merge-request noun and the ! prefix", () => {
    const gitlab = getForgePresentation("gitlab");
    expect(gitlab.brandLabel).toBe("GitLab");
    expect(gitlab.changeRequestAbbrev).toBe("MR");
    expect(gitlab.numberPrefix).toBe("!");
  });
});
