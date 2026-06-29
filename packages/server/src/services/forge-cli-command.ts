import { z } from "zod";

interface CommandFailureLike {
  code?: string | number | null;
  killed?: boolean;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  message?: string;
}

interface CliCommandErrorShape extends Error {
  stderr: string;
}

interface NormalizeCliCommandErrorOptions {
  error: unknown;
  args: string[];
  cwd: string;
  commandName: string;
  timeoutMs?: number;
  isAlreadyClassified: (error: unknown) => boolean;
  isCommandError: (error: unknown) => error is CliCommandErrorShape;
  isAuthFailureText: (text: string) => boolean;
  createAuthError: (stderr: string) => Error;
  createMissingError: () => Error;
  createCommandError: (params: {
    args: string[];
    cwd: string;
    exitCode: number | null;
    stderr: string;
  }) => Error;
}

interface ParseCliJsonOutputOptions<T> {
  commandName: string;
  args: string[];
  cwd: string;
  stdout: string;
  schema: z.ZodType<T>;
  createCommandError: NormalizeCliCommandErrorOptions["createCommandError"];
}

export function bufferOrStringToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

export function normalizeCliCommandError(options: NormalizeCliCommandErrorOptions): Error {
  if (options.isAlreadyClassified(options.error)) {
    return options.error as Error;
  }
  if (options.isCommandError(options.error)) {
    if (options.isAuthFailureText(options.error.stderr)) {
      return options.createAuthError(options.error.stderr);
    }
    return options.error as Error;
  }
  const failure = toCommandFailureLike(options.error);
  if (failure.code === "ENOENT") {
    return options.createMissingError();
  }
  const stderr = bufferOrStringToString(failure.stderr);
  const message = failure.message ?? "";
  if (options.isAuthFailureText(stderr) || options.isAuthFailureText(message)) {
    return options.createAuthError(stderr);
  }
  if (failure.killed === true && options.timeoutMs !== undefined) {
    return options.createCommandError({
      args: options.args,
      cwd: options.cwd,
      exitCode: null,
      stderr:
        stderr ||
        `${options.commandName} was terminated before completing (timed out after ${options.timeoutMs}ms or exceeded the output limit)`,
    });
  }
  return options.createCommandError({
    args: options.args,
    cwd: options.cwd,
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderr: stderr || message,
  });
}

export function parseCliJsonOutput<T>(options: ParseCliJsonOutputOptions<T>): T {
  let data: unknown;
  try {
    data = JSON.parse(options.stdout);
  } catch {
    throw options.createCommandError({
      args: options.args,
      cwd: options.cwd,
      exitCode: null,
      stderr: `${options.commandName} did not return valid JSON (${options.stdout.length} bytes)`,
    });
  }
  const parsed = options.schema.safeParse(data);
  if (!parsed.success) {
    throw options.createCommandError({
      args: options.args,
      cwd: options.cwd,
      exitCode: null,
      stderr: `${options.commandName} JSON did not match the expected schema: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

function toCommandFailureLike(error: unknown): CommandFailureLike {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const record = error as Record<string, unknown>;
  return {
    code:
      typeof record.code === "string" || typeof record.code === "number" || record.code === null
        ? record.code
        : undefined,
    killed: typeof record.killed === "boolean" ? record.killed : undefined,
    stderr:
      typeof record.stderr === "string" || Buffer.isBuffer(record.stderr)
        ? record.stderr
        : undefined,
    stdout:
      typeof record.stdout === "string" || Buffer.isBuffer(record.stdout)
        ? record.stdout
        : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}
