import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyUpdate, confirmUpdate, currentVersion, FAILED_FILE, failedUpdate, listUpdates, NOTICE_FILE, pendingUpdates, PREVIOUS_FILE, takeRollbackNotice } from "../dist/update.js";

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

test("a version that does not build is undone on the spot and marked, so it is not installed again by itself", async () => {
  const root = mkdtempSync(join(tmpdir(), "update-"));
  try {
    git(root, "init", "--quiet", "--bare", "-b", "main", "remote.git");
    git(root, "init", "--quiet", "-b", "main", "dev");
    const dev = join(root, "dev");
    // The build fails while a file named "roto" exists.
    const pkg = { name: "x", version: "1.0.0", private: true, scripts: { prepare: "node -e \"process.exit(require('fs').existsSync('roto') ? 1 : 0)\"" } };
    writeFileSync(join(dev, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(dev, ".gitignore"), "node_modules\npackage-lock.json\n.actualizacion-*\n");
    git(dev, "add", ".");
    git(dev, "commit", "--quiet", "-m", "inicio");
    git(dev, "remote", "add", "origin", join(root, "remote.git"));
    git(dev, "push", "--quiet", "-u", "origin", "main");
    git(root, "clone", "--quiet", "remote.git", "phone");
    const phone = join(root, "phone");
    const first = git(phone, "rev-parse", "HEAD");

    writeFileSync(join(dev, "a.txt"), "ok");
    git(dev, "add", ".");
    git(dev, "commit", "--quiet", "-m", "Mejora que compila");
    git(dev, "push", "--quiet");
    assert.deepEqual(await applyUpdate(phone), ["Mejora que compila"]);
    assert.equal(readFileSync(join(phone, PREVIOUS_FILE), "utf8"), first); // the supervisor's way back
    confirmUpdate(phone);
    assert.equal(existsSync(join(phone, PREVIOUS_FILE)), false);

    const good = git(phone, "rev-parse", "HEAD");
    writeFileSync(join(dev, "roto"), "");
    git(dev, "add", ".");
    git(dev, "commit", "--quiet", "-m", "Mejora rota");
    git(dev, "push", "--quiet");
    await assert.rejects(applyUpdate(phone), /no se pudo instalar y sigo con la anterior/);
    assert.equal(git(phone, "rev-parse", "HEAD"), good);
    assert.equal(await failedUpdate(phone), git(dev, "rev-parse", "HEAD"));
    // A newer commit (the fix) is no longer blocked.
    git(dev, "rm", "--quiet", "roto");
    git(dev, "commit", "--quiet", "-m", "Corrección");
    git(dev, "push", "--quiet");
    await pendingUpdates(phone);
    assert.equal(await failedUpdate(phone), null);
    assert.equal((await applyUpdate(phone)).length, 2);

    writeFileSync(join(phone, NOTICE_FILE), "La versión abc se cayó al arrancar y volví a la anterior.\n");
    assert.match(takeRollbackNotice(phone), /volví a la anterior/);
    assert.equal(takeRollbackNotice(phone), null); // told once
    assert.ok(existsSync(join(phone, FAILED_FILE)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
