import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORKSPACE_SYSTEM_INDEX_SCHEMA,
  WorkspaceSystemIndexRegistry,
  renderWorkspaceSystemIndexes,
} from "./workspace-system-index.js";

test("workspace system indexes match configured repository markers and expose bounded provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-system-index-"));
  const sourceRoot = join(root, "source");
  const worktreeRoot = join(root, "worktree");
  const unrelatedRoot = join(root, "unrelated");
  await mkdir(join(sourceRoot, "architecture"), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(unrelatedRoot, { recursive: true });
  await writeFile(
    join(sourceRoot, "architecture", "module-package-deployment.yaml"),
    "selected_native_components: []\n",
  );
  await writeFile(join(sourceRoot, "AGENTS.md"), "instructions\n");

  const indexPath = join(root, "zes-system-index.json");
  await writeFile(indexPath, JSON.stringify(sampleIndex(), null, 2) + "\n");

  const registry = new WorkspaceSystemIndexRegistry([indexPath]);
  assert.deepEqual(registry.forWorkspace(unrelatedRoot), []);

  const indexes = registry.forWorkspace(worktreeRoot, sourceRoot);
  assert.equal(indexes.length, 1);
  assert.equal(indexes[0]?.indexId, "zes-system-capabilities");
  assert.equal(indexes[0]?.manifestDigestSha256.length, 64);
  assert.ok((indexes[0]?.manifestByteCount ?? 0) > 0);
  assert.equal(indexes[0]?.sourceIdentity.authorityRef, "git:zes@example");
  assert.equal(indexes[0]?.stack[0]?.name, "Hermes Agent");
  assert.equal(indexes[0]?.capabilities[0]?.name, "ZES Execution Accelerator");

  const rendered = renderWorkspaceSystemIndexes(indexes);
  assert.match(rendered ?? "", /Mandatory system index: ZES System Index/);
  assert.match(rendered ?? "", /Hermes Agent/);
  assert.match(rendered ?? "", /ZES Execution Accelerator/);
  assert.match(rendered ?? "", /orientation only/);
  assert.doesNotMatch(rendered ?? "", /allMarkerPaths/);
});

test("workspace system index configuration fails closed for duplicate ids and unsafe marker paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-system-index-invalid-"));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await writeFile(first, JSON.stringify(sampleIndex()) + "\n");
  await writeFile(second, JSON.stringify(sampleIndex()) + "\n");

  assert.throws(
    () => new WorkspaceSystemIndexRegistry([first, second]),
    /Duplicate workspace system index id/,
  );

  const unsafe = sampleIndex();
  unsafe.matchers = [{ allMarkerPaths: ["../outside"] }];
  const unsafePath = join(root, "unsafe.json");
  await writeFile(unsafePath, JSON.stringify(unsafe) + "\n");
  assert.throws(
    () => new WorkspaceSystemIndexRegistry([unsafePath]),
    /marker paths must be relative/,
  );
});

test("workspace system index configuration rejects missing and excessive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-system-index-limits-"));
  assert.throws(
    () => new WorkspaceSystemIndexRegistry([join(root, "missing.json")]),
    /Unable to load workspace system index/,
  );
  assert.throws(
    () => new WorkspaceSystemIndexRegistry(
      Array.from({ length: 9 }, (_, index) => join(root, `${index}.json`)),
    ),
    /At most 8 workspace system index files/,
  );
});

test("workspace system index matching rejects symlink markers and oversized aggregate context", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-system-index-bounds-"));
  const source = join(root, "source");
  const outside = join(root, "outside-marker");
  await mkdir(join(source, "architecture"), { recursive: true });
  await writeFile(outside, "outside\n");
  await symlink(outside, join(source, "AGENTS.md"));
  await writeFile(
    join(source, "architecture", "module-package-deployment.yaml"),
    "selected_native_components: []\n",
  );

  const first = sampleIndex();
  const firstPath = join(root, "first.json");
  await writeFile(firstPath, JSON.stringify(first) + "\n");
  const markerRegistry = new WorkspaceSystemIndexRegistry([firstPath]);
  assert.deepEqual(markerRegistry.forWorkspace(source), []);

  await unlink(join(source, "AGENTS.md"));
  await writeFile(join(source, "AGENTS.md"), "real marker\n");
  const outsideArchitecture = join(root, "outside-architecture");
  await mkdir(outsideArchitecture, { recursive: true });
  await writeFile(
    join(outsideArchitecture, "module-package-deployment.yaml"),
    "selected_native_components: []\n",
  );
  await rm(join(source, "architecture"), { recursive: true });
  await symlink(outsideArchitecture, join(source, "architecture"));
  assert.deepEqual(markerRegistry.forWorkspace(source), []);

  await rm(join(source, "architecture"));
  await mkdir(join(source, "architecture"), { recursive: true });
  await writeFile(
    join(source, "architecture", "module-package-deployment.yaml"),
    "selected_native_components: []\n",
  );
  first.capabilities = longCapabilities("first");
  const second = sampleIndex();
  second.indexId = "zes-system-capabilities-second";
  second.capabilities = longCapabilities("second");
  const secondPath = join(root, "second.json");
  await writeFile(firstPath, JSON.stringify(first) + "\n");
  await writeFile(secondPath, JSON.stringify(second) + "\n");
  const aggregateRegistry = new WorkspaceSystemIndexRegistry([
    firstPath,
    secondPath,
  ]);
  assert.throws(
    () => aggregateRegistry.forWorkspace(source),
    /exceed 30000 rendered characters/,
  );
});

function sampleIndex() {
  return {
    schemaVersion: WORKSPACE_SYSTEM_INDEX_SCHEMA,
    indexId: "zes-system-capabilities",
    title: "ZES System Index",
    summary: "Compact mandatory orientation for ZES product and engineering work.",
    matchers: [
      {
        allMarkerPaths: [
          "AGENTS.md",
          "architecture/module-package-deployment.yaml",
        ],
      },
    ],
    sourceIdentity: {
      authorityRef: "git:zes@example",
      files: [
        {
          path: "architecture/module-package-deployment.yaml",
          digestSha256: "a".repeat(64),
          byteCount: 42,
        },
      ],
    },
    stack: [
      {
        id: "COMP-HERMES",
        name: "Hermes Agent",
        role: "Root cognitive runtime and scoped native coordination.",
        authorityLimit: "Board coordination is not canonical material work.",
      },
    ],
    capabilities: [
      {
        id: "zes-execution-accelerator",
        name: "ZES Execution Accelerator",
        purpose: "Routes bounded AOQ engineering work to the best available capability.",
        useWhen: "selecting the strongest bounded engineering route.",
        authorityLimit: "Routing evidence does not grant writer or effect authority.",
      },
    ],
    authorityNotes: [
      "This index is orientation only; resolve current state through rightful authorities.",
    ],
  };
}

function longCapabilities(prefix: string) {
  return Array.from({ length: 32 }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix} capability ${index}`,
    purpose: "p".repeat(420),
    useWhen: "u".repeat(120),
    authorityLimit: "evidence only",
  }));
}
