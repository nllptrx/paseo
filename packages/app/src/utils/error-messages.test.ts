import { describe, expect, it } from "vitest";
import { toErrorMessage } from "./error-messages";

describe("toErrorMessage", () => {
  it("reduces a git failure to the reason git gave", () => {
    const error = new Error(
      "Git command failed: git branch paseo/tasks/tes-1 main (exit code: 128, signal: none)\nfatal: not a valid object name: 'main'",
    );

    expect(toErrorMessage(error)).toBe("Not a valid object name: 'main'");
  });

  it("skips git progress noise and reports the failing line", () => {
    const error = new Error(
      "Git command failed: git merge feature (exit code: 1, signal: none)\nAuto-merging README.md\nCONFLICT (content): Merge conflict in README.md\nerror: could not apply the merge",
    );

    expect(toErrorMessage(error)).toBe("Could not apply the merge");
  });

  it("names the command when git said nothing on stderr", () => {
    const error = new Error(
      "Git command failed: git status --porcelain (exit code: 128, signal: none)\n(no stderr)",
    );

    expect(toErrorMessage(error)).toBe("Git failed running git status --porcelain");
  });

  it("leaves a plain message untouched", () => {
    expect(toErrorMessage(new Error("Unable to remove host"))).toBe("Unable to remove host");
  });

  it("stringifies a thrown non-error", () => {
    expect(toErrorMessage("boom")).toBe("boom");
  });
});
