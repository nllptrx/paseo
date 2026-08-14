import { expect, test } from "vitest";

import { observeAgentCompletion } from "./agent-completion.js";

function idle(hasPendingPermissions = false) {
  return { lifecycle: "idle" as const, hasPendingPermissions };
}

function running(hasPendingPermissions = false) {
  return { lifecycle: "running" as const, hasPendingPermissions };
}

test("finished only fires after running has been observed, then idle", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe(running())).toBeNull();
  expect(observer.observe(idle())).toBe("finished");
});

test("idle without a prior running observation is not finished yet", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe(idle())).toBeNull();
});

test("error reports errored regardless of running history", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe(running())).toBeNull();
  expect(observer.observe({ lifecycle: "error", hasPendingPermissions: false })).toBe("errored");
});

test("error reports errored even without having seen running first", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe({ lifecycle: "error", hasPendingPermissions: false })).toBe("errored");
});

test("closed reports closed", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe({ lifecycle: "closed", hasPendingPermissions: false })).toBe("closed");
});

test("initializing reports no outcome", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe({ lifecycle: "initializing", hasPendingPermissions: false })).toBeNull();
});

test("a run that stops for a permission is not finished when it goes idle", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe(running())).toBeNull();
  expect(observer.observe(running(true))).toBeNull();
  expect(observer.observe(idle(true))).toBeNull();
  // The follow-up run starts up and reaches idle before it has run again.
  expect(observer.observe(idle())).toBeNull();
});

test("finished fires once the run resumed after a permission reaches idle", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe(running())).toBeNull();
  expect(observer.observe(idle(true))).toBeNull();
  expect(observer.observe(running())).toBeNull();
  expect(observer.observe(idle())).toBe("finished");
});

test("a terminal lifecycle still reports while a permission is pending", () => {
  const observer = observeAgentCompletion();

  expect(observer.observe({ lifecycle: "error", hasPendingPermissions: true })).toBe("errored");
  expect(observer.observe({ lifecycle: "closed", hasPendingPermissions: true })).toBe("closed");
});
