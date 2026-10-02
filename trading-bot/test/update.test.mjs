import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyUpdate, currentVersion, listUpdates, pendingUpdates } from "../dist/update.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();

test("a clone sees the remote's new commits, installs them and is then current", async () => {
  const root = mkdtempSync(join(tmpdir(), "update-"));
  try {
    git(root, "init", "--quiet", "--bare", "-b", "main", "remote.git");
    git(root, "init", "--quiet", "-b", "main", "dev");
    const dev = join(root, "dev");
    writeFileSync(join(dev, "a.txt"), "1");
    git(dev, "add", ".");
    git(dev, "commit", "--quiet", "-m", "inicio");
    git(dev, "remote", "add", "origin", join(root, "remote.git"));
    git(dev, "push", "--quiet", "-u", "origin", "main");
    git(root, "clone", "--quiet", "remote.git", "phone");
    const phone = join(root, "phone");

    assert.deepEqual(await pendingUpdates(phone), []);
    assert.deepEqual(await applyUpdate(phone, false), []);
    writeFileSync(join(dev, "a.txt"), "2");
    git(dev, "commit", "--quiet", "-am", "Capitulación: stop más ajustado");
    git(dev, "commit", "--quiet", "--allow-empty", "-m", "Nuevo patrón de ballenas");
    git(dev, "push", "--quiet");

    assert.deepEqual(await pendingUpdates(phone), ["Nuevo patrón de ballenas", "Capitulación: stop más ajustado"]);
    assert.equal((await applyUpdate(phone, false)).length, 2);
    assert.deepEqual(await pendingUpdates(phone), []);
    assert.equal((await currentVersion(phone))?.commit, git(dev, "log", "-1", "--format=%h"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside a git clone nothing is announced and updating explains why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nogit-"));
  try {
    assert.equal(await pendingUpdates(dir), null);
    assert.equal(await currentVersion(dir), null);
    await assert.rejects(applyUpdate(dir, false), /no pude consultar GitHub/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long update lists are cut", () => {
  assert.equal(listUpdates(["a", "b"]), "• a\n• b");
  assert.match(listUpdates(Array.from({ length: 10 }, (_, i) => `m${i}`), 3), /• m2\n… y 7 más$/);
});
