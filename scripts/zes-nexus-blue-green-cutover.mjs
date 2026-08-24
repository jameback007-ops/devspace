import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULTS = Object.freeze({
  activePort: 7677,
  candidatePort: 7679,
  upstreamFile: "/etc/caddy/zes-nexus-upstream.caddy",
  caddyfile: "/etc/caddy/Caddyfile",
  caddyBin: "/usr/bin/caddy",
  publicUrl: "https://mcp.zesnexus.com",
});

export function assessCutover(active, candidate) {
  const reasons = [];
  if (active?.state !== "READY" || active?.ok !== true) {
    reasons.push("active_not_ready");
  }
  if (active?.restartSafety?.state !== "safe") {
    reasons.push("active_restart_safety_not_safe");
  }
  if (candidate?.state !== "READY" || candidate?.ok !== true) {
    reasons.push("candidate_not_ready");
  }
  if (!candidate?.backendInstanceRef) {
    reasons.push("candidate_backend_identity_missing");
  }
  if (!candidate?.toolSurfaceFingerprintSha256) {
    reasons.push("candidate_tool_surface_fingerprint_missing");
  }
  if (
    Number(candidate?.toolSurface?.toolCount ?? 0)
    < Number(active?.toolSurface?.toolCount ?? 0)
  ) {
    reasons.push("candidate_tool_surface_regressed");
  }
  if (
    Number(candidate?.database?.latestMigrationVersion ?? 0)
    < Number(active?.database?.latestMigrationVersion ?? 0)
  ) {
    reasons.push("candidate_database_migration_regressed");
  }
  return {
    ok: reasons.length === 0,
    reasons,
  };
}

export function assessOAuthMetadata(authorizationMetadata, resourceMetadata) {
  const authorizationScopes = authorizationMetadata?.scopes_supported;
  const resourceScopes = resourceMetadata?.scopes_supported;
  const reasons = [];
  if (!Array.isArray(authorizationScopes) || !authorizationScopes.includes("offline_access")) {
    reasons.push("authorization_server_missing_offline_access");
  }
  if (!Array.isArray(resourceScopes) || !resourceScopes.includes("offline_access")) {
    reasons.push("protected_resource_missing_offline_access");
  }
  if (typeof resourceMetadata?.resource !== "string" || !resourceMetadata.resource.endsWith("/mcp")) {
    reasons.push("protected_resource_identity_invalid");
  }
  return { ok: reasons.length === 0, reasons };
}

export function renderUpstream(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid upstream port: ${port}`);
  }
  return `reverse_proxy 127.0.0.1:${port}\n`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
}

async function validateAndReloadCaddy(caddyBin, caddyfile) {
  await execFileAsync(caddyBin, ["validate", "--config", caddyfile]);
  await execFileAsync(caddyBin, ["reload", "--config", caddyfile]);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value after ${argument}`);
      index += 1;
      return value;
    };
    if (argument === "--active-port") options.activePort = Number(next());
    else if (argument === "--candidate-port") options.candidatePort = Number(next());
    else if (argument === "--upstream-file") options.upstreamFile = next();
    else if (argument === "--caddyfile") options.caddyfile = next();
    else if (argument === "--caddy-bin") options.caddyBin = next();
    else if (argument === "--public-url") options.publicUrl = next().replace(/\/$/, "");
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  renderUpstream(options.activePort);
  renderUpstream(options.candidatePort);
  if (options.activePort === options.candidatePort) {
    throw new Error("Active and candidate ports must differ");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const activeBase = `http://127.0.0.1:${options.activePort}`;
  const candidateBase = `http://127.0.0.1:${options.candidatePort}`;

  const [active, candidate, authorizationMetadata, resourceMetadata] = await Promise.all([
    fetchJson(`${activeBase}/readyz`),
    fetchJson(`${candidateBase}/readyz`),
    fetchJson(`${candidateBase}/.well-known/oauth-authorization-server`),
    fetchJson(`${candidateBase}/.well-known/oauth-protected-resource/mcp`),
  ]);
  const cutover = assessCutover(active, candidate);
  const oauth = assessOAuthMetadata(authorizationMetadata, resourceMetadata);
  const result = {
    active: {
      port: options.activePort,
      backendInstanceRef: active.backendInstanceRef,
      restartSafety: active.restartSafety,
      surfaceEpoch: active.surfaceEpoch,
    },
    candidate: {
      port: options.candidatePort,
      backendInstanceRef: candidate.backendInstanceRef,
      restartSafety: candidate.restartSafety,
      surfaceEpoch: candidate.surfaceEpoch,
    },
    cutover,
    oauth,
    dryRun: options.dryRun,
  };

  if (!cutover.ok || !oauth.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }
  if (options.dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let previousUpstream;
  try {
    previousUpstream = await readFile(options.upstreamFile, "utf8");
  } catch {
    previousUpstream = renderUpstream(options.activePort);
  }
  const candidateUpstream = renderUpstream(options.candidatePort);
  await writeAtomic(options.upstreamFile, candidateUpstream);

  try {
    await validateAndReloadCaddy(options.caddyBin, options.caddyfile);
    const publicReadiness = await fetchJson(`${options.publicUrl}/readyz`);
    if (publicReadiness.backendInstanceRef !== candidate.backendInstanceRef) {
      throw new Error("Public endpoint did not converge on the candidate backend");
    }
    result.publicReadback = {
      backendInstanceRef: publicReadiness.backendInstanceRef,
      surfaceEpoch: publicReadiness.surfaceEpoch,
    };
    result.switched = true;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeAtomic(options.upstreamFile, previousUpstream);
    await validateAndReloadCaddy(options.caddyBin, options.caddyfile).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
