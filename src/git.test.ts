import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { db } from "./db.ts";
import { createProject } from "./repos/projects.ts";
import { _resetGitState, commitIfWorthIt, noteTaskCompleted } from "./git.ts";

function reset() {
  db.prepare("DELETE FROM projects").run();
  _resetGitState();
}

describe("commitIfWorthIt", () => {
  let originalCwd: string;
  let tempRepo: string;

  beforeEach(() => {
    reset();
    originalCwd = process.cwd();
    tempRepo = mkdtempSync(join(tmpdir(), "tpix-git-"));
    execSync("git init -q && git config user.email t@t && git config user.name T", { cwd: tempRepo });
    process.chdir(tempRepo);
    // Set up a dummy initial commit so subsequent commits work
    writeFileSync(join(tempRepo, "README.md"), "# test\n");
    execSync("git add README.md && git commit -q -m initial", { cwd: tempRepo });
  });

  it("returns 'no changes' when projects/<slug>/ has no diff", async () => {
    const p = createProject("git no-change test");
    mkdirSync(join(tempRepo, "projects", p.slug), { recursive: true });
    const res = await commitIfWorthIt({ projectId: p.id, reason: "nada", force: false });
    expect(res.committed).toBe(false);
    expect(res.reason).toBe("no changes");
    cleanup(tempRepo, originalCwd);
  });

  it("commits when force=true and there are changes (push fails silently because no remote)", async () => {
    const p = createProject("git force commit test");
    const dir = join(tempRepo, "projects", p.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hello.txt"), "hi\n");

    const res = await commitIfWorthIt({
      projectId: p.id,
      reason: "first artifact",
      force: true,
      authorRole: "tester",
    });
    expect(res.committed).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);

    // Inspect the commit
    const log = execSync("git log -1 --pretty=%an::%s", { cwd: tempRepo, encoding: "utf8" }).trim();
    expect(log).toContain("TPIX tester::");
    expect(log).toContain(p.slug);
    expect(log).toContain("first artifact");
    cleanup(tempRepo, originalCwd);
  });

  it("respects auto-commit threshold when force=false", async () => {
    const p = createProject("git threshold test");
    const dir = join(tempRepo, "projects", p.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a\n");

    // First call: no prior state → should commit (state.lastCommitAt is 0)
    const r1 = await commitIfWorthIt({ projectId: p.id, reason: "first", force: false });
    expect(r1.committed).toBe(true);

    // Add another change
    writeFileSync(join(dir, "b.txt"), "b\n");
    // Second call almost immediately, only 1 task elapsed → should NOT commit yet
    const r2 = await commitIfWorthIt({ projectId: p.id, reason: "second too soon", force: false });
    expect(r2.committed).toBe(false);
    expect(r2.reason).toBe("below auto-commit threshold");

    // After 3 noted tasks elapsed, should commit
    noteTaskCompleted(p.id);
    noteTaskCompleted(p.id);
    noteTaskCompleted(p.id);
    const r3 = await commitIfWorthIt({ projectId: p.id, reason: "after 3 tasks", force: false });
    expect(r3.committed).toBe(true);

    cleanup(tempRepo, originalCwd);
  });
});

function cleanup(tempRepo: string, originalCwd: string) {
  process.chdir(originalCwd);
  rmSync(tempRepo, { recursive: true, force: true });
}
