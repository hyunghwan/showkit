import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ShowKitError, EXIT_CODES } from "./errors.js";
import { writeJsonAtomic, writeFileAtomic } from "./json.js";
import { CaptureSourceSchema, StorySpecSchema, type CaptureSource, type StorySpec } from "./schemas.js";

const ProjectSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    projectId: z.string().min(1),
    createdAt: z.string().datetime(),
    latestCaptureRunId: z.string().min(1).optional(),
    latestStoryId: z.string().min(1).optional(),
    latestStoryVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    latestArtifactVersion: z.string().regex(/^[a-f0-9]{64}$/).optional()
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

export function projectRoot(): string {
  return path.resolve(process.env.SHOWKIT_PROJECT_ROOT ?? process.cwd());
}

export function showkitPath(...parts: string[]): string {
  return path.join(projectRoot(), ".showkit", ...parts);
}

export async function initializeProject(): Promise<{ created: boolean; project: Project }> {
  const projectFile = showkitPath("project.json");
  try {
    const project = ProjectSchema.parse(JSON.parse(await readFile(projectFile, "utf8")));
    return { created: false, project };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await Promise.all(
    ["runs", "stories", "assets", "artifacts", "logs"].map((directory) =>
      mkdir(showkitPath(directory), { recursive: true })
    )
  );
  const project: Project = {
    schemaVersion: "0.1",
    projectId: `project-${randomUUID()}`,
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(projectFile, project);
  await writeFileAtomic(
    showkitPath(".gitignore"),
    [
      "artifacts/",
      "logs/",
      "support/",
      "auth/",
      "credentials/",
      "debug/",
      "runs/*/trace.zip",
      "runs/*/diagnostics/",
      "runs/*/environment.json",
      "runs/*/verification.json",
      ""
    ].join("\n")
  );
  return { created: true, project };
}

export async function loadProject(): Promise<Project> {
  try {
    return ProjectSchema.parse(JSON.parse(await readFile(showkitPath("project.json"), "utf8")));
  } catch {
    throw new ShowKitError({
      code: "ProjectNotInitialized",
      message: "This project has not been initialized.",
      exitCode: EXIT_CODES.environment,
      recovery: "Run `showkit init --json` in the project."
    });
  }
}

export async function saveProject(project: Project): Promise<void> {
  await writeJsonAtomic(showkitPath("project.json"), ProjectSchema.parse(project));
}

export async function loadLatestCapture(): Promise<{ capture: CaptureSource; runId: string }> {
  const project = await loadProject();
  if (!project.latestCaptureRunId) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "No captured product flow is available.",
      recovery:
        "Import a supported static or browser-session envelope, or run an optional Playwright source flow."
    });
  }

  const filePath = showkitPath("runs", project.latestCaptureRunId, "capture.json");
  try {
    return {
      capture: CaptureSourceSchema.parse(JSON.parse(await readFile(filePath, "utf8"))),
      runId: project.latestCaptureRunId
    };
  } catch {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "The latest captured product flow is missing or invalid.",
      recovery: "Capture the source flow again."
    });
  }
}

export async function loadStoryForCapture(capture: CaptureSource): Promise<StorySpec | undefined> {
  const project = await loadProject();
  if (!project.latestStoryId) {
    return undefined;
  }
  const candidate = project.latestStoryVersion
    ? showkitPath(
        "stories",
        project.latestStoryId,
        project.latestStoryVersion,
        "story.json"
      )
    : showkitPath("stories", `${project.latestStoryId}.json`);
  try {
    const story = StorySpecSchema.parse(JSON.parse(await readFile(candidate, "utf8")));
    return story.sourceCaptureId === capture.captureId ? story : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ShowKitError({
      code: "StorySpecInvalid",
      message: "The saved demo content is invalid.",
      recovery: "Run `showkit story apply <story.json> --json` with a valid StorySpec."
    });
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
