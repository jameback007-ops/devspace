import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export const DEVSPACE_PACKAGE_VERSION = readPackageVersion();

/**
 * Generic default only. Qualified ZES deployments should set an explicit
 * DEVSPACE_MCP_SERVER_VERSION for each activated surface release.
 */
export const DEFAULT_DEVSPACE_MCP_SERVER_VERSION =
  `${DEVSPACE_PACKAGE_VERSION}-zes.1`;
