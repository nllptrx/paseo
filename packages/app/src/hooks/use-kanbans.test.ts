import { describe, expect, it } from "vitest";
import { kanbansQueryKey } from "@/hooks/use-kanbans";

describe("kanbansQueryKey", () => {
  it("uses only the sorted host identity", () => {
    expect(kanbansQueryKey(["laptop", "local"])).toEqual(["kanbans", "laptop|local"]);
    expect(kanbansQueryKey(["local", "laptop"])).toEqual(["kanbans", "laptop|local"]);
  });
});
