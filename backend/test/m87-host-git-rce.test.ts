/**
 * M87 security — repository-controlled Git configuration never executes on
 * the Veyra host.
 *
 * Every test plants the attack the way an untrusted collaborator can: from
 * inside the project sandbox (their terminal), writing `.git/config`,
 * attributes, hooks, includes, nested repositories. Then a Veyra Git API
 * call runs. `.m87/payload.sh` writes a HOST marker when executed outside a
 * sandbox container and a log line under /workspace when executed inside
 * one, so each test proves both "not on the host" and, where the vector is
 * live, "contained in the sandbox" (the operation really triggered it).
 *
 * Before M87 (Git on the host) the filter / textconv / external-diff /
 * include / nested-repository tests fail: the host marker is created.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sandboxGitAvailable } from "./helpers.js";
import { makeM87Fixture, type M87Fixture } from "./m87-fixture.js";

const SANDBOX_GIT = sandboxGitAvailable();
const P = "sh .m87/payload.sh";

describe.skipIf(!SANDBOX_GIT)(
  "M87 — repository-controlled Git config never runs on the host",
  () => {
    let f: M87Fixture;

    beforeEach(async () => {
      f = await makeM87Fixture();
      const init = await f.api.request("POST", f.g("/init"), {
        token: f.ownerToken,
      });
      expect(init.status).toBe(200);
      await f.plantPayload();
    });

    afterEach(async () => {
      await f.close();
    });

    const post = (p: string, body: unknown = {}) =>
      f.api.request("POST", f.g(p), { token: f.editorToken, body });
    const get = (p: string) =>
      f.api.request("GET", f.g(p), { token: f.editorToken });
    /** Commit from the attacker's terminal, then forget what ran there. */
    const terminalCommit = (msg: string) =>
      f.sh(
        `git add -A && git -c user.name=t -c user.email=t@t commit -qm '${msg}' && rm -f .m87/ran-in-sandbox`,
      );

    it("a clean filter runs in the sandbox on stage — never on the host, never with backend env", async () => {
      process.env.M87_BACKEND_ONLY_SECRET = "backend-env-must-not-leak-7f3a";
      try {
        await f.sh(
          `git config filter.m87.clean "${P}" && git config filter.m87.smudge "${P}" ` +
            `&& printf '*.txt filter=m87\\n' > .gitattributes && echo data > a.txt`,
        );
        const r = await post("/stage", { all: true });
        expect(r.status).toBe(200);
        expect(f.hostRan()).toBe(false);
        expect(await f.sandboxRan()).toContain("ran");

        const env = await f.sh("cat .m87/sandbox-env");
        expect(env).not.toContain("backend-env-must-not-leak-7f3a");
        expect(env).not.toMatch(/SECRETS?_MASTER|DATABASE_PATH|ADMIN_PASSWORD/);
        expect(env).toMatch(/^HOME=\/tmp$/m);
        expect(env).toMatch(/^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
        expect(env).toMatch(/^GIT_DIR=\/workspace\/\.git$/m);
        expect(env).toMatch(/^GIT_ALLOW_PROTOCOL=$/m);

        const st = await get("/status");
        expect(st.status).toBe(200);
        expect(st.data.staged.map((e: { path: string }) => e.path)).toContain(
          "a.txt",
        );
      } finally {
        delete process.env.M87_BACKEND_ONLY_SECRET;
      }
    });

    it("a smudge filter runs in the sandbox on checkout", async () => {
      await f.sh(
        `git config filter.m87.clean "${P}" && git config filter.m87.smudge "${P}" ` +
          `&& printf '*.txt filter=m87\\n' > .gitattributes && echo one > a.txt`,
      );
      await terminalCommit("base");
      await f.sh("git branch feat && git checkout -q feat && echo two > a.txt");
      await terminalCommit("feat");
      await f.sh("git checkout -q main && rm -f .m87/ran-in-sandbox");

      const r = await post("/checkout", { name: "feat", dirtyOpenPaths: [] });
      expect(r.status).toBe(200);
      expect(r.data.changedPaths).toContain("a.txt");
      expect(f.hostRan()).toBe(false);
      expect(await f.sandboxRan()).toContain("ran");
    });

    it("textconv and diff.external run in the sandbox on diff", async () => {
      await f.sh(
        `git config diff.m87.textconv "${P}" && printf '*.txt diff=m87\\n' > .gitattributes ` +
          "&& echo one > a.txt",
      );
      await terminalCommit("base");
      await f.sh("echo two > a.txt");

      const textconv = await get("/diff/file?path=a.txt");
      expect(textconv.status).toBe(200);
      expect(f.hostRan()).toBe(false);
      expect(await f.sandboxRan()).toContain("ran");

      await f.sh(`rm -f .m87/ran-in-sandbox && git config diff.external "${P}"`);
      const external = await get("/diff/file?path=a.txt");
      expect(external.status).toBe(200);
      expect(f.hostRan()).toBe(false);
      expect(await f.sandboxRan()).toContain("ran");
    });

    it("include.path and includeIf cannot smuggle a filter onto the host", async () => {
      await f.sh(
        `printf '[filter "m87"]\\n\\tclean = ${P}\\n' > .m87/evil.inc ` +
          `&& printf '[filter "m87b"]\\n\\tclean = ${P}\\n' > .m87/evil-if.inc ` +
          "&& git config include.path ../.m87/evil.inc " +
          "&& git config includeIf.gitdir:/workspace/.git.path ../.m87/evil-if.inc " +
          `&& printf 'a.txt filter=m87\\nb.txt filter=m87b\\n' > .gitattributes ` +
          "&& echo a > a.txt && echo b > b.txt",
      );
      const r = await post("/stage", { all: true });
      expect(r.status).toBe(200);
      expect(f.hostRan()).toBe(false);
      const ran = await f.sandboxRan();
      expect(ran.match(/ran/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it("hooks and core.hooksPath never run for Veyra Git operations", async () => {
      const hooks = [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "post-checkout",
        "reference-transaction",
        "post-index-change",
      ];
      const script = `#!/bin/sh\\nexec ${P} "$@" </dev/null >/dev/null\\n`;
      await f.sh(
        "mkdir -p .git/hooks .m87/hooks && " +
          hooks
            .map(
              (h) =>
                `printf '${script}' > .git/hooks/${h} && printf '${script}' > .m87/hooks/${h}`,
            )
            .join(" && ") +
          " && chmod 755 .git/hooks/* .m87/hooks/* && echo x > a.txt",
      );
      expect((await post("/stage", { all: true })).status).toBe(200);
      expect((await post("/commit", { message: "c1" })).status).toBe(200);
      expect((await post("/branches", { name: "side" })).status).toBe(200);
      expect(
        (await post("/checkout", { name: "side", dirtyOpenPaths: [] })).status,
      ).toBe(200);

      await f.sh("git config core.hooksPath .m87/hooks && echo y > b.txt");
      expect((await post("/stage", { all: true })).status).toBe(200);
      expect((await post("/commit", { message: "c2" })).status).toBe(200);
      expect(
        (await post("/checkout", { name: "main", dirtyOpenPaths: [] })).status,
      ).toBe(200);

      expect(f.hostRan()).toBe(false);
      expect(await f.sandboxRan()).toBe("");
    });

    it("fsmonitor, pager, editor, askpass, credential helper, sshCommand, gpg, and aliases are inert", async () => {
      const keys = [
        "core.fsmonitor",
        "core.pager",
        "pager.status",
        "pager.log",
        "pager.diff",
        "core.editor",
        "sequence.editor",
        "core.askPass",
        "core.sshCommand",
        "core.gitProxy",
        "gpg.program",
        "diff.guitool",
        "merge.tool",
      ];
      await f.sh(
        keys.map((k) => `git config ${k} "${P}"`).join(" && ") +
          ` && git config credential.helper "!${P}"` +
          " && git config commit.gpgSign true && git config tag.gpgSign true" +
          ` && git config alias.status "!${P}" && git config alias.commit "!${P}"` +
          ` && git config alias.add "!${P}" && git config alias.log "!${P}"` +
          ` && git config core.untrackedCache true && git config uploadpack.packObjectsHook "${P}"` +
          " && echo x > a.txt",
      );
      expect((await get("/status")).status).toBe(200);
      expect((await post("/stage", { all: true })).status).toBe(200);
      expect((await post("/commit", { message: "signed?" })).status).toBe(200);
      expect((await get("/log")).status).toBe(200);
      expect((await get("/branches")).status).toBe(200);
      expect((await get("/diff")).status).toBe(200);

      expect(f.hostRan()).toBe(false);
      expect(await f.sandboxRan()).toBe("");
      // The commit is unsigned despite commit.gpgSign=true.
      const raw = await f.sh("git cat-file commit HEAD");
      expect(raw).not.toContain("gpgsig");
    });

    it("nested repositories and submodules stay inside the sandbox", async () => {
      await f.sh(
        "mkdir sub && cd sub && git init -q -b main " +
          `&& git config core.fsmonitor "sh ../.m87/payload.sh" ` +
          `&& git config filter.m87.clean "sh ../.m87/payload.sh" ` +
          `&& printf '* filter=m87\\n' > .gitattributes && echo x > f ` +
          "&& git add -A && git -c user.name=t -c user.email=t@t commit -qm s " +
          "&& cd .. " +
          `&& printf '[submodule "sub"]\\n\\tpath = sub\\n\\turl = ./sub\\n' > .gitmodules ` +
          "&& rm -f .m87/ran-in-sandbox",
      );
      const staged = await post("/stage", { all: true });
      expect(staged.status).toBe(200);
      const committed = await post("/commit", { message: "with nested" });
      expect(committed.status).toBe(200);
      // Dirty the nested repository so status has to look inside it.
      await f.sh("echo y >> sub/f");
      const st = await get("/status");
      expect(st.status).toBe(200);
      // The nested repository is one gitlink entry, never walked as files.
      const all = [...st.data.staged, ...st.data.unstaged].map(
        (e: { path: string }) => e.path,
      );
      expect(all.some((p: string) => p.startsWith("sub/"))).toBe(false);
      expect((await get("/diff")).status).toBe(200);

      // A command-valued submodule update is refused by Git itself: the
      // operation fails safely instead of running anything anywhere.
      await f.sh(
        `printf '[submodule "sub"]\\n\\tpath = sub\\n\\turl = ./sub\\n\\tupdate = !${P}\\n' > .gitmodules`,
      );
      expect([200, 422]).toContain((await get("/status")).status);
      expect([200, 422]).toContain(
        (await post("/stage", { all: true })).status,
      );
      expect(f.hostRan()).toBe(false);
    });

    it("a .git gitfile or symlink is not treated as the project repository", async () => {
      await f.sh("rm -rf .git && printf 'gitdir: /tmp/elsewhere\\n' > .git");
      const st = await get("/status");
      expect(st.status).toBe(200);
      expect(st.data.initialized).toBe(false);
      const stage = await post("/stage", { all: true });
      expect(stage.status).toBe(409);
      expect(stage.data.error.code).toBe("not_a_repo");

      await f.sh("rm -f .git && mkdir -p /tmp/realrepo && git init -q /tmp/realrepo && ln -s /tmp/realrepo/.git .git");
      const st2 = await get("/status");
      expect(st2.status).toBe(200);
      expect(st2.data.initialized).toBe(false);
      expect(f.hostRan()).toBe(false);
    });

    it("only editors can make Veyra run Git writes; outsiders learn nothing", async () => {
      await f.sh(`git config filter.m87.clean "${P}" && printf '* filter=m87\\n' > .gitattributes && echo z > z.txt`);
      const viewer = await f.api.request("POST", f.g("/stage"), {
        token: f.viewerToken,
        body: { all: true },
      });
      expect(viewer.status).toBe(403);
      const outsider = await f.api.request("GET", f.g("/status"), {
        token: f.outsiderToken,
      });
      expect(outsider.status).toBe(404);
      const anon = await f.api.request("POST", f.g("/stage"), {
        body: { all: true },
      });
      expect(anon.status).toBe(401);
      expect(await f.sandboxRan()).toBe("");
      expect(f.hostRan()).toBe(false);
    });
  },
);
