import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const SERVICE_PROCESS_OBSERVATION_SCHEMA =
  "zes.service-process-observation.v1" as const;

export interface ServiceProcessObservation {
  schemaVersion: typeof SERVICE_PROCESS_OBSERVATION_SCHEMA;
  state: "observed" | "unavailable";
  childProcessCount: number;
  cgroupIdentityDigestSha256?: string;
  errorKind?: string;
  errorDigestSha256?: string;
  policy: {
    currentProcessCgroupOnly: true;
    mainProcessExcluded: true;
    rawCgroupPathExcluded: true;
    rawErrorExcluded: true;
  };
}

export interface ServiceProcessObservationOptions {
  pid?: number;
  cgroupRoot?: string;
  readText?: (path: string) => string;
}

function normalizedErrorKind(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `${error.name}:${code ?? "unknown"}`.slice(0, 128);
  }
  return `${typeof error}:unknown`.slice(0, 128);
}

function normalizedErrorDigest(error: unknown): string {
  const text = error instanceof Error
    ? `${error.name}:${(error as NodeJS.ErrnoException).code ?? ""}:${error.message}`
    : String(error);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function observationPolicy(): ServiceProcessObservation["policy"] {
  return {
    currentProcessCgroupOnly: true,
    mainProcessExcluded: true,
    rawCgroupPathExcluded: true,
    rawErrorExcluded: true,
  };
}

function unifiedCgroupPath(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3).trim();
    if (!path.startsWith("/") || path.includes("\0")) {
      throw new Error("The current unified cgroup path is invalid.");
    }
    return path;
  }
  throw new Error("The current process has no observable unified cgroup.");
}

export function observeCurrentServiceChildProcesses(
  options: ServiceProcessObservationOptions = {},
): ServiceProcessObservation {
  const pid = options.pid ?? process.pid;
  const cgroupRoot = resolve(options.cgroupRoot ?? "/sys/fs/cgroup");
  const readText = options.readText ?? ((path) => readFileSync(path, "utf8"));
  try {
    const cgroupPath = unifiedCgroupPath(readText("/proc/self/cgroup"));
    const relative = cgroupPath.replace(/^\/+/, "");
    const cgroupDirectory = resolve(cgroupRoot, relative);
    if (
      cgroupDirectory !== cgroupRoot
      && !cgroupDirectory.startsWith(`${cgroupRoot}${sep}`)
    ) {
      throw new Error("The current cgroup escaped the configured cgroup root.");
    }
    const pids = new Set(
      readText(resolve(cgroupDirectory, "cgroup.procs"))
        .split(/\s+/)
        .filter(Boolean)
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    );
    pids.delete(pid);
    return {
      schemaVersion: SERVICE_PROCESS_OBSERVATION_SCHEMA,
      state: "observed",
      childProcessCount: pids.size,
      cgroupIdentityDigestSha256: createHash("sha256")
        .update(cgroupPath, "utf8")
        .digest("hex"),
      policy: observationPolicy(),
    };
  } catch (error) {
    return {
      schemaVersion: SERVICE_PROCESS_OBSERVATION_SCHEMA,
      state: "unavailable",
      childProcessCount: 0,
      errorKind: normalizedErrorKind(error),
      errorDigestSha256: normalizedErrorDigest(error),
      policy: observationPolicy(),
    };
  }
}
