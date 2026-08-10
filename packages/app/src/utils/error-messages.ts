const GIT_FAILURE_PREFIX = "Git command failed:";
const GIT_COMMAND_LINE = /^Git command failed: (.+?)(?: \(exit code:.*)?$/;
const GIT_DETAIL_PREFIX = /^(?:fatal|error|warning):\s*/i;
const NO_STDERR = "(no stderr)";

/**
 * The one place raw failures become something a person can read. Git speaks in
 * exit codes and echoed command lines; a toast has room for the sentence that
 * says what went wrong.
 */
export function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  if (!trimmed.startsWith(GIT_FAILURE_PREFIX)) {
    return trimmed;
  }
  return formatGitFailure(trimmed);
}

function formatGitFailure(message: string): string {
  const [commandLine, ...rest] = message.split("\n");
  const detail = selectGitDetail(rest);
  if (detail) {
    return capitalize(detail.replace(GIT_DETAIL_PREFIX, ""));
  }
  const command = GIT_COMMAND_LINE.exec(commandLine)?.[1];
  return command ? `Git failed running ${command}` : "Git command failed";
}

function selectGitDetail(lines: readonly string[]): string | null {
  const candidates = lines.map((line) => line.trim()).filter((line) => line && line !== NO_STDERR);
  return candidates.find((line) => GIT_DETAIL_PREFIX.test(line)) ?? candidates[0] ?? null;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}
