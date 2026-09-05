import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../docs/modules/catalog.mjs";
import {
  InstallError,
  devicePaths,
  installAnimation,
  statusForAnimation,
} from "../docs/modules/installer.mjs";

async function fixture() {
  const animationBytes = new TextEncoder().encode("animation");
  const themeBytes = new TextEncoder().encode("theme");
  return {
    entry: {
      id: "available",
      files: {
        animation: {
          path: "animations/available/animation.anim",
          bytes: animationBytes.byteLength,
          sha256: await sha256Hex(animationBytes),
        },
        theme: {
          path: "animations/available/theme.json",
          bytes: themeBytes.byteLength,
          sha256: await sha256Hex(themeBytes),
        },
      },
    },
    animationBytes,
    themeBytes,
  };
}

class FakeClient {
  constructor(remote = new Map()) {
    this.remote = remote;
    this.actions = [];
    this.failWrite = false;
  }

  async readFile(path) {
    this.actions.push(["read", path]);
    return this.remote.has(path)
      ? { exists: true, bytes: this.remote.get(path) }
      : { exists: false, bytes: null };
  }

  async uploadAnimation(id, bytes) {
    this.actions.push(["upload", id]);
    this.remote.set(devicePaths(id).animation, bytes);
  }

  async ensureDirectory(path) {
    this.actions.push(["mkdir", path]);
  }

  async writeFile(path, bytes) {
    this.actions.push(["write", path]);
    if (this.failWrite) {
      throw new Error("write failed");
    }
    this.remote.set(path, bytes);
  }
}

function artifactFetch(animationBytes, themeBytes) {
  return async (url) => {
    if (url.endsWith("animation.anim")) {
      return new Response(animationBytes);
    }
    if (url.endsWith("theme.json")) {
      return new Response(themeBytes);
    }
    return new Response("missing", { status: 404 });
  };
}

test("status maps exact device hashes to Install, Installed, and Update", async () => {
  const { entry, animationBytes, themeBytes } = await fixture();
  const paths = devicePaths(entry.id);

  assert.equal(await statusForAnimation(new FakeClient(), entry), "install");
  assert.equal(
    await statusForAnimation(
      new FakeClient(new Map([
        [paths.animation, animationBytes],
        [paths.theme, themeBytes],
      ])),
      entry,
    ),
    "installed",
  );
  assert.equal(
    await statusForAnimation(
      new FakeClient(new Map([
        [paths.animation, new Uint8Array([0])],
        [paths.theme, themeBytes],
      ])),
      entry,
    ),
    "update",
  );
});

test("install verifies downloads, writes missing files, and reads each back", async () => {
  const { entry, animationBytes, themeBytes } = await fixture();
  const client = new FakeClient();

  const result = await installAnimation(
    client,
    entry,
    artifactFetch(animationBytes, themeBytes),
  );

  assert.equal(result, "installed");
  assert.deepEqual(client.actions.map((action) => action[0]), [
    "read",
    "read",
    "upload",
    "read",
    "mkdir",
    "write",
    "read",
  ]);
  assert.equal(await statusForAnimation(client, entry), "installed");
});

test("update writes only the mismatched record and installed is a no-op", async () => {
  const { entry, animationBytes, themeBytes } = await fixture();
  const paths = devicePaths(entry.id);
  const client = new FakeClient(new Map([
    [paths.animation, animationBytes],
    [paths.theme, new Uint8Array([0])],
  ]));

  await installAnimation(client, entry, artifactFetch(animationBytes, themeBytes));

  assert.equal(client.actions.some(([kind]) => kind === "upload"), false);
  assert.equal(client.actions.filter(([kind]) => kind === "write").length, 1);

  client.actions.length = 0;
  await installAnimation(client, entry, artifactFetch(animationBytes, themeBytes));
  assert.equal(client.actions.some(([kind]) => ["upload", "write"].includes(kind)), false);
});

test("a partial update is safe to retry from device hashes", async () => {
  const { entry, animationBytes, themeBytes } = await fixture();
  const client = new FakeClient();
  client.failWrite = true;

  await assert.rejects(
    installAnimation(client, entry, artifactFetch(animationBytes, themeBytes)),
    (error) => error instanceof InstallError && error.partial === true,
  );
  assert.equal(client.actions.filter(([kind]) => kind === "upload").length, 1);

  client.failWrite = false;
  client.actions.length = 0;
  await installAnimation(client, entry, artifactFetch(animationBytes, themeBytes));
  assert.equal(client.actions.some(([kind]) => kind === "upload"), false);
  assert.equal(client.actions.filter(([kind]) => kind === "write").length, 1);
});

test("bad catalog artifacts fail before any device request", async () => {
  const { entry, themeBytes } = await fixture();
  const client = new FakeClient();

  await assert.rejects(
    installAnimation(
      client,
      entry,
      artifactFetch(new Uint8Array([0]), themeBytes),
    ),
    /byte count mismatch/,
  );
  assert.deepEqual(client.actions, []);
});
