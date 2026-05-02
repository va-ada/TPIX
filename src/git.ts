import { simpleGit, type SimpleGit } from "simple-git";
import { logger } from "./logger.ts";
import { getProject } from "./repos/projects.ts";

const PUSH_REMOTE = "origin";
const PUSH_BRANCH = "main";

const TIME_BETWEEN_AUTOCOMMITS_MS = 5 * 60 * 1000; // 5 minutes
const TASKS_BETWEEN_AUTOCOMMITS = 3;

interface ProjectGitState {
  lastCommitAt: number;
  tasksSinceCommit: number;
}

const projectState = new Map<string, ProjectGitState>();

function gitClient(): SimpleGit {
  // Resolve cwd per call so tests can chdir into a tmp repo without re-importing.
  return simpleGit(process.cwd());
}

export async function commitIfWorthIt(args: {
  projectId: string;
  reason: string;
  force: boolean;
  authorRole?: string;
}): Promise<{ committed: boolean; pushed: boolean; sha?: string; reason?: string }> {
  const { projectId, reason, force, authorRole } = args;
  const project = getProject(projectId);
  if (!project) {
    return { committed: false, pushed: false, reason: "project not found" };
  }

  const projectPath = `projects/${project.slug}`;
  const git = gitClient();

  // Check if there are any changes to commit under projects/<slug>/
  const status = await git.status([projectPath]);
  const hasChanges =
    status.modified.length > 0 ||
    status.not_added.length > 0 ||
    status.created.length > 0 ||
    status.deleted.length > 0 ||
    status.renamed.length > 0;

  if (!hasChanges) {
    return { committed: false, pushed: false, reason: "no changes" };
  }

  if (!force && !shouldAutoCommit(projectId)) {
    return { committed: false, pushed: false, reason: "below auto-commit threshold" };
  }

  const author = authorRole ?? "tpix";
  const message = formatCommitMessage(project.slug, reason, force);

  try {
    await git.add([projectPath]);
    await git
      .env("GIT_AUTHOR_NAME", `TPIX ${author}`)
      .env("GIT_AUTHOR_EMAIL", "tpix-bot@local")
      .env("GIT_COMMITTER_NAME", `TPIX ${author}`)
      .env("GIT_COMMITTER_EMAIL", "tpix-bot@local")
      .commit(message);
    const head = await git.revparse(["HEAD"]);

    bumpState(projectId);

    // Push asynchronously with retry; never block the caller on push
    void pushWithRetry().catch((err) =>
      logger.error({ err: (err as Error).message }, "git push failed after retries"),
    );

    logger.info({ projectId, sha: head, message }, "committed");
    return { committed: true, pushed: false, sha: head };
  } catch (err) {
    logger.error({ err: (err as Error).message, projectId }, "git commit failed");
    return { committed: false, pushed: false, reason: (err as Error).message };
  }
}

function shouldAutoCommit(projectId: string): boolean {
  const state = projectState.get(projectId);
  if (!state) return true; // first commit for this project, go ahead
  if (Date.now() - state.lastCommitAt >= TIME_BETWEEN_AUTOCOMMITS_MS) return true;
  if (state.tasksSinceCommit >= TASKS_BETWEEN_AUTOCOMMITS) return true;
  return false;
}

export function noteTaskCompleted(projectId: string): void {
  const state = projectState.get(projectId) ?? { lastCommitAt: 0, tasksSinceCommit: 0 };
  state.tasksSinceCommit += 1;
  projectState.set(projectId, state);
}

function bumpState(projectId: string): void {
  projectState.set(projectId, { lastCommitAt: Date.now(), tasksSinceCommit: 0 });
}

function formatCommitMessage(slug: string, reason: string, force: boolean): string {
  const tag = force ? "snapshot before user prompt" : "auto";
  return `${slug}: ${tag} — ${reason}`;
}

async function pushWithRetry(maxAttempts = 3): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await gitClient().push(PUSH_REMOTE, PUSH_BRANCH);
      logger.info({ attempt }, "git push ok");
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt, err: (err as Error).message },
        "git push failed, will retry",
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(2_000 * attempt);
    }
  }
  throw lastErr ?? new Error("push failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Reset the per-process state — useful for tests.
 */
export function _resetGitState(): void {
  projectState.clear();
}
