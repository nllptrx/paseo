import type { ClientForgeLogicModule } from "@/git/client-forge-module";
import { githubForgeLogic } from "./github";
import { gitlabForgeLogic } from "./gitlab";

/**
 * Pure logic registry. Import this (never the view registry) from URL builders,
 * merge-capability, and native-check derivations so those paths — and the
 * Node-based e2e harness that transitively imports them — stay free of the
 * client rendering stack (react-native, react-native-svg, unistyles).
 */
export const CLIENT_FORGE_LOGIC_MODULES: readonly ClientForgeLogicModule[] = [
  githubForgeLogic,
  gitlabForgeLogic,
];

export function getClientForgeLogicModule(id: string): ClientForgeLogicModule | null {
  return CLIENT_FORGE_LOGIC_MODULES.find((module) => module.id === id) ?? null;
}
