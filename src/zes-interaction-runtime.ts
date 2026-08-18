import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  interactionPolicy,
  type InteractionAdapterDescriptor,
} from "./interaction-harness.js";

const execFile = promisify(execFileCallback);

const PLAYWRIGHT_WRAPPER = "/usr/local/bin/zes-playwright-mcp";
const PLAYWRIGHT_BINARY = "/opt/node-v24.18.1-linux-x64/bin/playwright-mcp";
const PLAYWRIGHT_TOKEN_FILE = "/etc/devspace/playwright-extension.token";
const PLAYWRIGHT_OUTPUT_DIR = "/home/zes-owner/.local/state/playwright-mcp-output";
const DISPLAY_SOCKET = "/tmp/.X11-unix/X10";
const DISPLAY_REF = ":10";
const PROBE_TIMEOUT_MS = 2_500;

export interface ZesInteractionProbeEvidence {
  observedAt: string;
  xrdpActive: boolean;
  displaySocketPresent: boolean;
  xorgSessionCount: number;
  cinnamonSessionCount: number;
  browserProcessCount: number;
  playwrightProcessCount: number;
  playwrightWrapperExecutable: boolean;
  playwrightWrapperSha256?: string;
  playwrightBinaryExecutable: boolean;
  playwrightTokenReadable: boolean;
  playwrightOutputDirectoryPresent: boolean;
  playwrightOutputDirectoryOwnedByZesOwner: boolean;
}

export interface ZesInteractionRuntimeSnapshot {
  schemaVersion: 1;
  observedAt: string;
  gui: {
    displayRef: typeof DISPLAY_REF;
    xrdpActive: boolean;
    displaySocketPresent: boolean;
    xorgSessionCount: number;
    cinnamonSessionCount: number;
    transportReady: boolean;
    automationAdapterReady: boolean;
  };
  playwright: {
    mode: "browser_extension";
    wrapperRef: typeof PLAYWRIGHT_WRAPPER;
    binaryRef: typeof PLAYWRIGHT_BINARY;
    outputDirectoryRef: typeof PLAYWRIGHT_OUTPUT_DIR;
    wrapperSha256?: string;
    configured: boolean;
    runtimeReady: boolean;
    activeClientCount: number;
    browserProcessCount: number;
    exclusiveClientBusy: boolean;
    rawExtensionTokenCaptured: false;
    visionCapabilityEnabled: false;
    brokerRequired: true;
  };
  adapters: InteractionAdapterDescriptor[];
  findings: Array<{
    code: string;
    severity: "info" | "warning" | "blocking";
    message: string;
    action?: string;
  }>;
  policy: ReturnType<typeof interactionPolicy> & {
    runtimeProbeOnly: true;
    arbitraryPathInputAccepted: false;
    arbitraryCommandInputAccepted: false;
    credentialValuesCaptured: false;
  };
}

export interface ZesInteractionRuntimeProbeOptions {
  now?: () => number;
  accessPath?: (path: string, mode: number) => Promise<void>;
  readPath?: (path: string) => Promise<Buffer>;
  statPath?: (path: string) => Promise<{ uid: number; isDirectory(): boolean }>;
  runFixedCommand?: (
    executable: string,
    args: string[],
  ) => Promise<{ stdout: string; exitCode: number }>;
}

export async function probeZesInteractionRuntime(
  options: ZesInteractionRuntimeProbeOptions = {},
): Promise<ZesInteractionRuntimeSnapshot> {
  const now = options.now ?? Date.now;
  const accessPath = options.accessPath ?? access;
  const readPath = options.readPath ?? readFile;
  const statPath = options.statPath ?? stat;
  const runFixedCommand = options.runFixedCommand ?? defaultFixedCommand;

  const [
    xrdpActive,
    displaySocketPresent,
    xorgSessionCount,
    cinnamonSessionCount,
    browserProcessCount,
    playwrightProcessCount,
    playwrightWrapperExecutable,
    playwrightBinaryExecutable,
    playwrightTokenReadable,
    playwrightOutputDirectoryPresent,
    playwrightOutputDirectoryOwnedByZesOwner,
    playwrightWrapperSha256,
  ] = await Promise.all([
    commandPassed(runFixedCommand, "systemctl", ["is-active", "--quiet", "xrdp"]),
    pathAccessible(accessPath, DISPLAY_SOCKET, fsConstants.F_OK),
    processCount(runFixedCommand, "/usr/bin/pgrep", [
      "-f",
      "/usr/lib/xorg/Xorg :10",
    ]),
    processCount(runFixedCommand, "/usr/bin/pgrep", [
      "-f",
      "cinnamon-session.*cinnamon2d|/usr/bin/cinnamon2d|(^|/)cinnamon$",
    ]),
    processCount(runFixedCommand, "/usr/bin/pgrep", [
      "-f",
      "(google-chrome|chrome|chromium).*(--type=browser|--remote-debugging|playwright)",
    ]),
    processCount(runFixedCommand, "/usr/bin/pgrep", [
      "-f",
      "^node /opt/node-v24.18.1-linux-x64/bin/playwright-mcp( |$)",
    ]),
    pathAccessible(accessPath, PLAYWRIGHT_WRAPPER, fsConstants.X_OK),
    pathAccessible(accessPath, PLAYWRIGHT_BINARY, fsConstants.X_OK),
    pathAccessible(accessPath, PLAYWRIGHT_TOKEN_FILE, fsConstants.R_OK),
    pathAccessible(accessPath, PLAYWRIGHT_OUTPUT_DIR, fsConstants.F_OK),
    directoryOwnedBy(statPath, PLAYWRIGHT_OUTPUT_DIR, 6110),
    fileSha256(readPath, PLAYWRIGHT_WRAPPER),
  ]);

  return classifyZesInteractionRuntime({
    observedAt: new Date(now()).toISOString(),
    xrdpActive,
    displaySocketPresent,
    xorgSessionCount,
    cinnamonSessionCount,
    browserProcessCount,
    playwrightProcessCount,
    playwrightWrapperExecutable,
    ...(playwrightWrapperSha256 ? { playwrightWrapperSha256 } : {}),
    playwrightBinaryExecutable,
    playwrightTokenReadable,
    playwrightOutputDirectoryPresent,
    playwrightOutputDirectoryOwnedByZesOwner,
  });
}

export function classifyZesInteractionRuntime(
  evidence: ZesInteractionProbeEvidence,
): ZesInteractionRuntimeSnapshot {
  const transportReady = evidence.xrdpActive
    && evidence.displaySocketPresent
    && evidence.xorgSessionCount > 0
    && evidence.cinnamonSessionCount > 0;
  const playwrightConfigured = evidence.playwrightWrapperExecutable
    && evidence.playwrightBinaryExecutable
    && evidence.playwrightTokenReadable
    && evidence.playwrightOutputDirectoryPresent
    && evidence.playwrightOutputDirectoryOwnedByZesOwner;
  const playwrightRuntimeReady = transportReady && playwrightConfigured;
  const exclusiveClientBusy = evidence.playwrightProcessCount > 0;

  const findings: ZesInteractionRuntimeSnapshot["findings"] = [];
  if (transportReady) {
    findings.push({
      code: "GUI_TRANSPORT_READY",
      severity: "info",
      message: "XRDP, Xorg :10, the X11 socket, and Cinnamon are present as one visible desktop transport.",
    });
  } else {
    findings.push({
      code: "GUI_TRANSPORT_INCOMPLETE",
      severity: "blocking",
      message: "The fixed ZES desktop transport is incomplete; browser-extension and desktop adapters must remain unavailable.",
      action: "restore_xrdp_xorg_cinnamon_display_10",
    });
  }
  if (playwrightRuntimeReady) {
    findings.push({
      code: "PLAYWRIGHT_EXTENSION_RUNTIME_REUSABLE",
      severity: "info",
      message: "The existing Codex Playwright extension bridge can be reused behind a DevSpace interaction adapter without rebuilding the browser or GUI stack.",
    });
  } else {
    findings.push({
      code: "PLAYWRIGHT_EXTENSION_RUNTIME_INCOMPLETE",
      severity: "blocking",
      message: "The fixed wrapper, extension credential reference, output directory, binary, and visible desktop must all be healthy before activation.",
      action: "repair_existing_playwright_extension_bridge",
    });
  }
  if (exclusiveClientBusy) {
    findings.push({
      code: "PLAYWRIGHT_EXCLUSIVE_CLIENT_BUSY",
      severity: "warning",
      message: "A Playwright MCP client is already active. DevSpace must serialize access through one broker instead of spawning a competing client.",
      action: "route_through_single_interaction_broker",
    });
  }
  findings.push({
    code: "DESKTOP_TRANSPORT_IS_NOT_AUTOMATION",
    severity: "warning",
    message: "XRDP exposes a display but does not itself provide semantic accessibility control, verified pointer actions, or effect reconciliation.",
    action: "add_desktop_accessibility_or_verified_pointer_adapter_only_when_needed",
  });

  const playwrightAdapter: InteractionAdapterDescriptor = {
    id: "zes-playwright-extension",
    surface: "playwright",
    available: playwrightRuntimeReady,
    targetKinds: ["browser"],
    supportedActionKinds: [
      "inspect",
      "navigate",
      "click",
      "type",
      "select",
      "upload",
      "download",
      "window_control",
    ],
    minimumEffectClassByAction: {
      inspect: "read_only",
      navigate: "reversible",
      click: "reversible",
      type: "reversible",
      select: "reversible",
      upload: "irreversible",
      download: "reversible",
      window_control: "reversible",
    },
    capabilities: {
      observe: true,
      semanticTargeting: true,
      coordinateTargeting: false,
      verify: true,
      boundedTimeout: true,
      screenshotEvidence: true,
      traceEvidence: false,
      persistentSession: true,
      isolatedSession: false,
      visibleUi: true,
      fileTransfer: true,
    },
    concurrency: "exclusive",
    busy: exclusiveClientBusy,
    sessionRef: "display-10-playwright-extension",
    ...(playwrightRuntimeReady
      ? {}
      : { unavailableReason: "existing_playwright_extension_runtime_incomplete" }),
  };

  const desktopAccessibilityAdapter: InteractionAdapterDescriptor = {
    id: "zes-desktop-accessibility",
    surface: "desktop_accessibility",
    available: false,
    targetKinds: ["native_desktop", "remote_desktop"],
    supportedActionKinds: [
      "inspect",
      "click",
      "type",
      "select",
      "window_control",
    ],
    minimumEffectClassByAction: {
      inspect: "read_only",
      click: "reversible",
      type: "reversible",
      select: "reversible",
      window_control: "reversible",
    },
    capabilities: {
      observe: false,
      semanticTargeting: false,
      coordinateTargeting: false,
      verify: false,
      boundedTimeout: false,
      screenshotEvidence: false,
      traceEvidence: false,
      persistentSession: transportReady,
      isolatedSession: false,
      visibleUi: transportReady,
      fileTransfer: false,
    },
    concurrency: "exclusive",
    busy: false,
    sessionRef: "display-10-cinnamon",
    unavailableReason: "desktop_transport_present_without_accessibility_control_adapter",
  };

  const visionPointerAdapter: InteractionAdapterDescriptor = {
    id: "zes-verified-vision-pointer",
    surface: "vision_pointer",
    available: false,
    targetKinds: ["browser", "native_desktop", "remote_desktop"],
    supportedActionKinds: ["inspect", "click", "type", "window_control"],
    minimumEffectClassByAction: {
      inspect: "read_only",
      click: "reversible",
      type: "reversible",
      window_control: "reversible",
    },
    capabilities: {
      observe: false,
      semanticTargeting: false,
      coordinateTargeting: false,
      verify: false,
      boundedTimeout: false,
      screenshotEvidence: transportReady,
      traceEvidence: false,
      persistentSession: transportReady,
      isolatedSession: false,
      visibleUi: transportReady,
      fileTransfer: false,
    },
    concurrency: "exclusive",
    busy: false,
    sessionRef: "display-10-cinnamon",
    unavailableReason: "desktop_transport_present_without_verified_input_bridge",
  };

  return {
    schemaVersion: 1,
    observedAt: normalizedTimestamp(evidence.observedAt),
    gui: {
      displayRef: DISPLAY_REF,
      xrdpActive: evidence.xrdpActive,
      displaySocketPresent: evidence.displaySocketPresent,
      xorgSessionCount: boundedCount(evidence.xorgSessionCount),
      cinnamonSessionCount: boundedCount(evidence.cinnamonSessionCount),
      transportReady,
      automationAdapterReady: false,
    },
    playwright: {
      mode: "browser_extension",
      wrapperRef: PLAYWRIGHT_WRAPPER,
      binaryRef: PLAYWRIGHT_BINARY,
      outputDirectoryRef: PLAYWRIGHT_OUTPUT_DIR,
      ...(evidence.playwrightWrapperSha256
        ? { wrapperSha256: normalizedSha256(evidence.playwrightWrapperSha256) }
        : {}),
      configured: playwrightConfigured,
      runtimeReady: playwrightRuntimeReady,
      activeClientCount: boundedCount(evidence.playwrightProcessCount),
      browserProcessCount: boundedCount(evidence.browserProcessCount),
      exclusiveClientBusy,
      rawExtensionTokenCaptured: false,
      visionCapabilityEnabled: false,
      brokerRequired: true,
    },
    adapters: [
      playwrightAdapter,
      desktopAccessibilityAdapter,
      visionPointerAdapter,
    ],
    findings,
    policy: {
      ...interactionPolicy(),
      runtimeProbeOnly: true,
      arbitraryPathInputAccepted: false,
      arbitraryCommandInputAccepted: false,
      credentialValuesCaptured: false,
    },
  };
}

async function defaultFixedCommand(
  executable: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await execFile(executable, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    return { stdout: String(result.stdout ?? ""), exitCode: 0 };
  } catch (error) {
    const candidate = error as { stdout?: string | Buffer; code?: number | string };
    return {
      stdout: String(candidate.stdout ?? ""),
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
    };
  }
}

async function commandPassed(
  run: NonNullable<ZesInteractionRuntimeProbeOptions["runFixedCommand"]>,
  executable: string,
  args: string[],
): Promise<boolean> {
  return (await run(executable, args)).exitCode === 0;
}

async function processCount(
  run: NonNullable<ZesInteractionRuntimeProbeOptions["runFixedCommand"]>,
  executable: string,
  args: string[],
): Promise<number> {
  const result = await run(executable, args);
  if (result.exitCode !== 0 || !result.stdout.trim()) return 0;
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry)).length;
}

async function pathAccessible(
  check: NonNullable<ZesInteractionRuntimeProbeOptions["accessPath"]>,
  path: string,
  mode: number,
): Promise<boolean> {
  try {
    await check(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function directoryOwnedBy(
  inspect: NonNullable<ZesInteractionRuntimeProbeOptions["statPath"]>,
  path: string,
  expectedUid: number,
): Promise<boolean> {
  try {
    const result = await inspect(path);
    return result.isDirectory() && result.uid === expectedUid;
  } catch {
    return false;
  }
}

async function fileSha256(
  read: NonNullable<ZesInteractionRuntimeProbeOptions["readPath"]>,
  path: string,
): Promise<string | undefined> {
  try {
    const contents = await read(path);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return undefined;
  }
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error("Interaction runtime process counts must be bounded non-negative integers.");
  }
  return value;
}

function normalizedSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Interaction runtime digest must be lowercase SHA-256.");
  }
  return value;
}

function normalizedTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Interaction runtime observation timestamp is invalid.");
  }
  return new Date(parsed).toISOString();
}
