import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyZesInteractionRuntime,
  probeZesInteractionRuntime,
  type ZesInteractionProbeEvidence,
} from "./zes-interaction-runtime.js";

const baseEvidence: ZesInteractionProbeEvidence = {
  observedAt: "2026-08-18T05:15:00.000Z",
  xrdpActive: true,
  displaySocketPresent: true,
  xorgSessionCount: 1,
  cinnamonSessionCount: 1,
  browserProcessCount: 1,
  playwrightProcessCount: 0,
  playwrightWrapperExecutable: true,
  playwrightWrapperSha256: "a".repeat(64),
  playwrightBinaryExecutable: true,
  playwrightTokenReadable: true,
  playwrightOutputDirectoryPresent: true,
  playwrightOutputDirectoryOwnedByZesOwner: true,
};

test("classifies the existing GUI and Playwright extension bridge without claiming desktop automation", () => {
  const snapshot = classifyZesInteractionRuntime(baseEvidence);
  assert.equal(snapshot.gui.transportReady, true);
  assert.equal(snapshot.gui.automationAdapterReady, false);
  assert.equal(snapshot.playwright.configured, true);
  assert.equal(snapshot.playwright.runtimeReady, true);
  assert.equal(snapshot.playwright.exclusiveClientBusy, false);
  assert.equal(snapshot.playwright.rawExtensionTokenCaptured, false);
  assert.equal(snapshot.playwright.visionCapabilityEnabled, false);

  const playwright = snapshot.adapters.find(
    (adapter) => adapter.id === "zes-playwright-extension",
  );
  assert.equal(playwright?.available, true);
  assert.equal(playwright?.capabilities.semanticTargeting, true);
  assert.equal(playwright?.capabilities.coordinateTargeting, false);

  const desktop = snapshot.adapters.find(
    (adapter) => adapter.id === "zes-desktop-accessibility",
  );
  assert.equal(desktop?.available, false);
  assert.equal(
    desktop?.unavailableReason,
    "desktop_transport_present_without_accessibility_control_adapter",
  );
  assert.match(
    snapshot.findings.map((finding) => finding.code).join(" "),
    /DESKTOP_TRANSPORT_IS_NOT_AUTOMATION/,
  );
});

test("marks an active Playwright MCP client as exclusive busy instead of authorizing a competing process", () => {
  const snapshot = classifyZesInteractionRuntime({
    ...baseEvidence,
    playwrightProcessCount: 1,
  });
  assert.equal(snapshot.playwright.runtimeReady, true);
  assert.equal(snapshot.playwright.exclusiveClientBusy, true);
  assert.equal(
    snapshot.adapters.find((adapter) => adapter.id === "zes-playwright-extension")?.busy,
    true,
  );
  assert.match(
    snapshot.findings.map((finding) => finding.code).join(" "),
    /PLAYWRIGHT_EXCLUSIVE_CLIENT_BUSY/,
  );
});

test("missing extension credential reference fails closed without exposing credential content", () => {
  const snapshot = classifyZesInteractionRuntime({
    ...baseEvidence,
    playwrightTokenReadable: false,
  });
  assert.equal(snapshot.playwright.configured, false);
  assert.equal(snapshot.playwright.runtimeReady, false);
  assert.equal(
    snapshot.adapters.find((adapter) => adapter.id === "zes-playwright-extension")?.available,
    false,
  );
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /extension-token-value|PLAYWRIGHT_MCP_EXTENSION_TOKEN=/);
  assert.equal(snapshot.policy.credentialValuesCaptured, false);
});

test("an incomplete display prevents browser-extension activation even when binaries exist", () => {
  const snapshot = classifyZesInteractionRuntime({
    ...baseEvidence,
    displaySocketPresent: false,
  });
  assert.equal(snapshot.gui.transportReady, false);
  assert.equal(snapshot.playwright.configured, true);
  assert.equal(snapshot.playwright.runtimeReady, false);
  assert.match(
    snapshot.findings.map((finding) => finding.code).join(" "),
    /GUI_TRANSPORT_INCOMPLETE/,
  );
});

test("the live probe accepts only fixed paths and commands and returns bounded counts", async () => {
  const accessed: Array<[string, number]> = [];
  const commands: Array<[string, string[]]> = [];
  const snapshot = await probeZesInteractionRuntime({
    now: () => Date.parse("2026-08-18T05:20:00.000Z"),
    async accessPath(path, mode) {
      accessed.push([path, mode]);
      if (path === "/tmp/.X11-unix/X10") return;
      if (path === "/usr/local/bin/zes-playwright-mcp") return;
      if (path === "/opt/node-v24.18.1-linux-x64/bin/playwright-mcp") return;
      if (path === "/etc/devspace/playwright-extension.token") return;
      if (path === "/home/zes-owner/.local/state/playwright-mcp-output") return;
      throw new Error("missing");
    },
    async readPath(path) {
      assert.equal(path, "/usr/local/bin/zes-playwright-mcp");
      return Buffer.from("fixed wrapper");
    },
    async statPath(path) {
      assert.equal(path, "/home/zes-owner/.local/state/playwright-mcp-output");
      return { uid: 6110, isDirectory: () => true };
    },
    async runFixedCommand(executable, args) {
      commands.push([executable, args]);
      if (executable === "systemctl") return { stdout: "", exitCode: 0 };
      const pattern = args.at(-1) ?? "";
      if (pattern.includes("Xorg")) return { stdout: "101\n", exitCode: 0 };
      if (pattern.includes("cinnamon")) return { stdout: "102\n", exitCode: 0 };
      if (pattern.includes("playwright-mcp")) return { stdout: "", exitCode: 1 };
      if (pattern.includes("google-chrome")) return { stdout: "103\n", exitCode: 0 };
      return { stdout: "", exitCode: 1 };
    },
  });

  assert.equal(snapshot.observedAt, "2026-08-18T05:20:00.000Z");
  assert.equal(snapshot.gui.xorgSessionCount, 1);
  assert.equal(snapshot.gui.cinnamonSessionCount, 1);
  assert.equal(snapshot.playwright.activeClientCount, 0);
  assert.equal(snapshot.playwright.browserProcessCount, 1);
  assert.ok(accessed.every(([path]) => path.startsWith("/")));
  assert.ok(commands.every(([command]) => command === "systemctl" || command === "/usr/bin/pgrep"));
  assert.equal(snapshot.policy.arbitraryPathInputAccepted, false);
  assert.equal(snapshot.policy.arbitraryCommandInputAccepted, false);
});
