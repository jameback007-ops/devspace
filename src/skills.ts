import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export type SkillExposure = "auto" | "contextual" | "on-demand";

export interface WorkspaceSkill extends Skill {
  exposure: SkillExposure;
  workspaceMarkers: string[];
  autoAdvertised: boolean;
}

export interface LoadedSkills {
  /** Skills advertised automatically by open_workspace. */
  skills: WorkspaceSkill[];
  /** Complete workspace-scoped catalog, including on-demand host skills. */
  catalog: WorkspaceSkill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

const SUBAGENT_DELEGATION_NAME = "subagent-delegation";
const SUBAGENT_DELEGATION_SKILL = join(SUBAGENT_DELEGATION_NAME, "SKILL.md");
const DEVSPACE_METADATA_KEY = "x-devspace";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "find",
  "for",
  "how",
  "in",
  "need",
  "of",
  "on",
  "the",
  "to",
  "use",
  "using",
  "with",
]);

interface DevspaceSkillMetadata {
  exposure?: SkillExposure;
  workspaceMarkers: string[];
}

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function hasSubagentDelegationSkill(skillDir: string): boolean {
  return existsSync(join(skillDir, SUBAGENT_DELEGATION_SKILL));
}

export function effectiveSkillPaths(config: ServerConfig, cwd: string): string[] {
  const bundledSkills = bundledSkillsDir();
  const defaultPathCandidates = [
    join(homedir(), ".agents", "skills"),
    resolve(cwd, ".agents", "skills"),
    config.devspaceSkillsDir,
    join(config.agentDir, "skills"),
    config.subagents && !hasSubagentDelegationSkill(config.devspaceSkillsDir)
      ? bundledSkills
      : undefined,
  ];
  const defaultPaths = defaultPathCandidates.filter(
    (path): path is string => path !== undefined && existsSync(path),
  );

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) {
    return { skills: [], catalog: [], diagnostics: [] };
  }

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  const filtered = config.subagents
    ? result
    : {
        skills: result.skills.filter(
          (skill) => skill.name !== SUBAGENT_DELEGATION_NAME,
        ),
        diagnostics: result.diagnostics.filter((diagnostic) => {
          const collision = diagnostic.collision;
          return !(
            collision?.resourceType === "skill" &&
            collision.name === SUBAGENT_DELEGATION_NAME
          );
        }),
      };

  const catalog = filtered.skills.map((skill) =>
    workspaceSkill(skill, config, cwd)
  );

  return {
    skills: catalog.filter(
      (skill) => skill.autoAdvertised && !skill.disableModelInvocation,
    ),
    catalog,
    diagnostics: filtered.diagnostics,
  };
}

function workspaceSkill(
  skill: Skill,
  config: ServerConfig,
  cwd: string,
): WorkspaceSkill {
  const metadata = readDevspaceSkillMetadata(skill.filePath);
  const exposure = metadata.exposure ?? defaultSkillExposure(skill, config, cwd);
  const workspaceMarkers = metadata.workspaceMarkers;
  const markersMatch = workspaceMarkers.length > 0 && workspaceMarkers.every(
    (marker) => workspaceMarkerMatches(cwd, marker),
  );
  const autoAdvertised = exposure === "auto" ||
    (exposure === "contextual" && markersMatch);

  return {
    ...skill,
    exposure,
    workspaceMarkers,
    autoAdvertised,
  };
}

function defaultSkillExposure(
  skill: Skill,
  config: ServerConfig,
  cwd: string,
): SkillExposure {
  if (isPathInsideRoot(skill.filePath, cwd)) return "auto";
  if (isPathInsideRoot(skill.filePath, bundledSkillsDir())) return "auto";
  if (skill.name === SUBAGENT_DELEGATION_NAME && config.subagents) return "auto";
  if (
    config.skillPaths.some((path) =>
      isPathInsideRoot(skill.filePath, resolveSkillPath(path, cwd))
    )
  ) {
    return "auto";
  }

  // Host-global skills cannot assume relevance to every opened project. They
  // remain searchable, but do not consume the default workspace context.
  return "on-demand";
}

function readDevspaceSkillMetadata(filePath: string): DevspaceSkillMetadata {
  try {
    const raw = readFileSync(filePath, "utf8");
    const match = raw.match(FRONTMATTER);
    if (!match?.[1]) return { workspaceMarkers: [] };
    const frontmatter = parseYaml(match[1]) as unknown;
    if (!isRecord(frontmatter)) return { workspaceMarkers: [] };
    const extension = frontmatter[DEVSPACE_METADATA_KEY];
    if (!isRecord(extension)) return { workspaceMarkers: [] };

    const rawExposure = extension.exposure;
    const exposure = rawExposure === "auto" ||
        rawExposure === "contextual" ||
        rawExposure === "on-demand"
      ? rawExposure
      : undefined;
    const rawMarkers = extension["workspace-markers"];
    const workspaceMarkers = Array.isArray(rawMarkers)
      ? rawMarkers
          .filter((marker): marker is string => typeof marker === "string")
          .map((marker) => marker.trim())
          .filter(Boolean)
      : [];

    return {
      exposure: exposure ?? (workspaceMarkers.length > 0 ? "contextual" : undefined),
      workspaceMarkers,
    };
  } catch {
    return { workspaceMarkers: [] };
  }
}

function workspaceMarkerMatches(cwd: string, marker: string): boolean {
  try {
    if (isAbsolute(marker)) return false;
    const markerPath = resolve(cwd, marker);
    return isPathInsideRoot(markerPath, cwd) && existsSync(markerPath);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function searchWorkspaceSkills(
  catalog: WorkspaceSkill[],
  query: string,
  limit = 10,
): WorkspaceSkill[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const rawTokens = normalizedQuery.split(" ").filter(Boolean);
  const meaningfulTokens = rawTokens.filter(
    (token) => !SEARCH_STOP_WORDS.has(token),
  );
  const tokens = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;
  const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit)));

  return catalog
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => ({ skill, score: skillSearchScore(skill, normalizedQuery, tokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.skill.name.localeCompare(right.skill.name)
    )
    .slice(0, boundedLimit)
    .map((candidate) => candidate.skill);
}

function skillSearchScore(
  skill: WorkspaceSkill,
  query: string,
  tokens: string[],
): number {
  const name = normalizeSearchText(skill.name.replaceAll("-", " "));
  const description = normalizeSearchText(skill.description);
  const combined = `${name} ${description}`;
  if (!tokens.every((token) => combined.includes(token))) return 0;

  let score = 25;
  if (name === query) score += 1_000;
  else if (name.startsWith(query)) score += 600;
  else if (name.includes(query)) score += 400;
  if (description.includes(query)) score += 250;
  for (const token of tokens) {
    if (name.split(" ").includes(token)) score += 80;
    else if (name.includes(token)) score += 45;
    if (description.includes(token)) score += 10;
  }
  if (skill.autoAdvertised) score += 5;
  return score;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}
