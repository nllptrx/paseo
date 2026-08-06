import { expect, test } from "vitest";

import { observeAgentCompletion } from "./agent-completion.js";

test("finished only fires after running has been observed, then idle", () => {
  const observer = observeAgentCompletion();

  expect(observer.observeLifecycle("running")).toBeNull();
  expect(observer.observeLifecycle("idle")).toBe("finished");
});

test("idle without a prior running observation is not finished yet", () => {
  const observer = observeAgentCompletion();

  expect(observer.observeLifecycle("idle")).toBeNull();
});

test("error reports errored regardless of running history", () => {
  const observer = observeAgentCompletion();

  expect(observer.observeLifecycle("running")).toBeNull();
  expect(observer.observeLifecycle("error")).toBe("errored");
});

test("error reports errored even without having seen running first", () => {
  const observer = observeAgentCompletion();

  expect(observer.observeLifecycle("error")).toBe("errored");
});

test("closed reports closed", () => {
  const observer = observeAgentCompletion();

  expect(observer.observeLifecycle("closed")).toBe("closed");
});

test("initializing reports no outcome", () => {
  const observer = observeAgentCompletion();

  expect(observer.observeLifecycle("initializing")).toBeNull();
});
