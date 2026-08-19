import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as z from "zod/v4";

export const WORKSPACE_SYSTEM_INDEX_SCHEMA =
  "devspace.workspace-system-index.v1" as const;

const MAX_INDEX_FILES = 8;
const MAX_INDEX_FILE_BYTES = 128 * 1024;
const MAX_RENDERED_INDEX_CHARACTERS = 30_000;

const boundedString = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

const markerPathSchema = boundedString(512).refine(
  (value) =>
    !isAbsolute(value)
    && value !== "."
    && value.split(/[\\/]/u).every((segment) => segment !== ".."),
  "marker paths must be relative and may not traverse outside the workspace",
);

const workspaceMatcherSchema = z.object({
  allMarkerPaths: z.array(markerPathSchema).min(1).max(16),
  anyMarkerPaths: z.array(markerPathSchema).min(1).max(16).optional(),
}).strict();

const sourceFileIdentitySchema = z.object({
  path: boundedString(1_024),
  digestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byteCount: z.number().int().nonnegative(),
}).strict();

const sourceIdentitySchema = z.object({
  authorityRef: boundedString(2_000),
  files: z.array(sourceFileIdentitySchema).min(1).max(32),
}).strict();

const systemStackEntrySchema = z.object({
  id: boundedString(256),
  name: boundedString(256),
  role: boundedString(700),
  authorityLimit: boundedString(700).optional(),
  detailRef: boundedString(2_000).optional(),
}).strict();

const systemCapabilityEntrySchema = z.object({
  id: boundedString(256),
  name: boundedString(256),
  purpose: boundedString(700),
  useWhen: boundedString(700),
  authorityLimit: boundedString(700).optional(),
  detailRef: boundedString(2_000).optional(),
}).strict();

const workspaceSystemIndexSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SYSTEM_INDEX_SCHEMA),
  indexId: boundedString(256),
  title: boundedString(512),
  summary: boundedString(2_000),
  matchers: z.array(workspaceMatcherSchema).min(1).max(16),
  sourceIdentity: sourceIdentitySchema,
  stack: z.array(systemStackEntrySchema).max(32),
  capabilities: z.array(systemCapabilityEntrySchema).max(64),
  authorityNotes: z.array(boundedString(1_000)).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (value.stack.length === 0 && value.capabilities.length === 0) {
    context.addIssue({
      code: "custom",
      message: "at least one stack or capability entry is required",
      path: ["stack"],
    });
  }
});

export type WorkspaceSystemIndexDocument = z.infer<
  typeof workspaceSystemIndexSchema
>;
export type WorkspaceSystemStackEntry = z.infer<
  typeof systemStackEntrySchema
>;
export type WorkspaceSystemCapabilityEntry = z.infer<
  typeof systemCapabilityEntrySchema
>;

interface LoadedWorkspaceSystemIndex {
  document: WorkspaceSystemIndexDocument;
  digestSha256: string;
  byteCount: number;
}

export interface WorkspaceSystemIndexProjection {
  schemaVersion: typeof WORKSPACE_SYSTEM_INDEX_SCHEMA;
  indexId: string;
  title: string;
  summary: string;
  manifestDigestSha256: string;
  manifestByteCount: number;
  sourceIdentity: WorkspaceSystemIndexDocument["sourceIdentity"];
  stack: WorkspaceSystemStackEntry[];
  capabilities: WorkspaceSystemCapabilityEntry[];
  authorityNotes: string[];
}

export class WorkspaceSystemIndexRegistry {
  private readonly indexes: LoadedWorkspaceSystemIndex[];

  constructor(paths: readonly string[]) {
    if (paths.length > MAX_INDEX_FILES) {
      throw new Error(
        `At most ${MAX_INDEX_FILES} workspace system index files may be configured`,
      );
    }

    this.indexes = paths.map(loadWorkspaceSystemIndex);
    const indexIds = new Set<string>();
    for (const loaded of this.indexes) {
      const { indexId } = loaded.document;
      if (indexIds.has(indexId)) {
        throw new Error(`Duplicate workspace system index id: ${indexId}`);
      }
      indexIds.add(indexId);
    }
  }

  forWorkspace(
    root: string,
    sourceRoot?: string,
  ): WorkspaceSystemIndexProjection[] {
    const candidateRoots = [...new Set([root, sourceRoot].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ))];

    const matched = this.indexes
      .filter(({ document }) => document.matchers.some((matcher) =>
        candidateRoots.some((candidateRoot) => matcherApplies(candidateRoot, matcher))))
      .map(projectWorkspaceSystemIndex);
    const rendered = renderWorkspaceSystemIndexes(matched);
    if ((rendered?.length ?? 0) > MAX_RENDERED_INDEX_CHARACTERS) {
      throw new Error(
        `Matching workspace system indexes exceed ${MAX_RENDERED_INDEX_CHARACTERS} rendered characters`,
      );
    }
    return matched;
  }
}

export function renderWorkspaceSystemIndexes(
  indexes: readonly WorkspaceSystemIndexProjection[],
): string | undefined {
  if (indexes.length === 0) return undefined;

  return indexes.map((index) => {
    const lines = [
      `Mandatory system index: ${index.title}`,
      `Index identity: ${index.indexId} @ sha256:${index.manifestDigestSha256}`,
      index.summary,
    ];

    if (index.stack.length > 0) {
      lines.push("System stack:");
      for (const entry of index.stack) {
        lines.push(formatStackEntry(entry));
      }
    }

    if (index.capabilities.length > 0) {
      lines.push("Engineering capabilities:");
      for (const entry of index.capabilities) {
        lines.push(formatCapabilityEntry(entry));
      }
    }

    lines.push("Authority notes:");
    for (const note of index.authorityNotes) lines.push(`- ${note}`);
    return lines.join("\n");
  }).join("\n\n");
}

function loadWorkspaceSystemIndex(path: string): LoadedWorkspaceSystemIndex {
  let content: Buffer;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new Error("configured path is not a regular file");
    }
    if (stats.size > MAX_INDEX_FILE_BYTES) {
      throw new Error(
        `file exceeds the ${MAX_INDEX_FILE_BYTES}-byte limit`,
      );
    }
    content = readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load workspace system index ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid workspace system index JSON ${path}: ${reason}`);
  }

  const result = workspaceSystemIndexSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid workspace system index ${path}: ${z.prettifyError(result.error)}`,
    );
  }

  const loaded = {
    document: result.data,
    digestSha256: createHash("sha256").update(content).digest("hex"),
    byteCount: content.byteLength,
  };
  const rendered = renderWorkspaceSystemIndexes([
    projectWorkspaceSystemIndex(loaded),
  ]);
  if ((rendered?.length ?? 0) > MAX_RENDERED_INDEX_CHARACTERS) {
    throw new Error(
      `Invalid workspace system index ${path}: rendered index exceeds ${MAX_RENDERED_INDEX_CHARACTERS} characters`,
    );
  }
  return loaded;
}

function projectWorkspaceSystemIndex(
  loaded: LoadedWorkspaceSystemIndex,
): WorkspaceSystemIndexProjection {
  const { document } = loaded;
  return {
    schemaVersion: document.schemaVersion,
    indexId: document.indexId,
    title: document.title,
    summary: document.summary,
    manifestDigestSha256: loaded.digestSha256,
    manifestByteCount: loaded.byteCount,
    sourceIdentity: structuredClone(document.sourceIdentity),
    stack: structuredClone(document.stack),
    capabilities: structuredClone(document.capabilities),
    authorityNotes: [...document.authorityNotes],
  };
}

function matcherApplies(
  root: string,
  matcher: WorkspaceSystemIndexDocument["matchers"][number],
): boolean {
  if (!matcher.allMarkerPaths.every((path) => markerExists(root, path))) {
    return false;
  }
  return matcher.anyMarkerPaths === undefined
    || matcher.anyMarkerPaths.some((path) => markerExists(root, path));
}

function markerExists(root: string, markerPath: string): boolean {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, markerPath);
  if (!pathIsInside(candidate, resolvedRoot)) {
    return false;
  }
  try {
    if (!lstatSync(candidate).isFile()) return false;
    return pathIsInside(
      realpathSync(candidate),
      realpathSync(resolvedRoot),
    );
  } catch {
    return false;
  }
}

function pathIsInside(candidate: string, root: string): boolean {
  const outside = relative(root, candidate);
  return outside.length > 0
    && !isAbsolute(outside)
    && outside !== ".."
    && !outside.startsWith(`..${sep}`);
}

function formatStackEntry(entry: WorkspaceSystemStackEntry): string {
  return [
    `- ${entry.name} — ${entry.role}`,
    entry.authorityLimit ? `Authority limit: ${entry.authorityLimit}` : undefined,
    entry.detailRef ? `Details: ${entry.detailRef}` : undefined,
  ].filter(Boolean).join(" ");
}

function formatCapabilityEntry(entry: WorkspaceSystemCapabilityEntry): string {
  return [
    `- ${entry.name} — ${entry.purpose} Use when ${entry.useWhen}`,
    entry.authorityLimit ? `Authority limit: ${entry.authorityLimit}` : undefined,
    entry.detailRef ? `Details: ${entry.detailRef}` : undefined,
  ].filter(Boolean).join(" ");
}
