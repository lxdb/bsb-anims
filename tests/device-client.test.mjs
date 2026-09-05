import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DeviceClient,
  DeviceError,
  isDirectInstallSupported,
  normalizeDeviceOrigin,
  validateToken,
} from "../docs/modules/device-client.mjs";

const TOKEN = "a".repeat(32);

test("device origin validation is strict", () => {
  assert.equal(normalizeDeviceOrigin("http://10.0.4.20/"), "http://10.0.4.20");
  assert.equal(normalizeDeviceOrigin("https://busybar.local"), "https://busybar.local");
  assert.throws(() => normalizeDeviceOrigin("ftp://busybar.local"), /HTTP or HTTPS/);
  assert.throws(() => normalizeDeviceOrigin("http://user@busybar.local"), /plain origin/);
});

test("firmware access keys and minted tokens are valid API credentials", () => {
  for (const credential of ["1234", "0123456789", TOKEN]) {
    assert.equal(validateToken(credential), credential);
  }
  for (const credential of ["", "123", "12ab", "12345678901", "x".repeat(31), "x".repeat(33)]) {
    assert.throws(() => validateToken(credential), /4-10 digit access key or a 32-character token/);
  }
});

test("every device request carries LNA intent and the in-memory token", async () => {
  const calls = [];
  const client = new DeviceClient({
    origin: "http://10.0.4.20",
    token: TOKEN,
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ api_semver: "1.0.0" });
    },
  });

  await client.connect();

  assert.equal(calls[0].url, "http://10.0.4.20/api/version");
  assert.equal(calls[0].options.targetAddressSpace, "local");
  assert.equal(calls[0].options.headers["X-API-Token"], TOKEN);
  assert.equal(client.token, undefined);
  assert.equal(client.hasCredentials, true);
});

test("fetch is called without a DeviceClient receiver, as browser fetch requires", async () => {
  const client = new DeviceClient({
    origin: "http://10.0.4.20",
    token: TOKEN,
    fetchImpl: async function () {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return Response.json({ api_semver: "27.5.0" });
    },
  });
  assert.deepEqual(await client.connect(), { api_semver: "27.5.0" });
});

test("authorization failure clears credentials", async () => {
  const client = new DeviceClient({
    origin: "http://10.0.4.20",
    token: TOKEN,
    fetchImpl: async () => new Response("forbidden", { status: 403 }),
  });

  await assert.rejects(
    client.connect(),
    (error) => error instanceof DeviceError && error.kind === "authorization",
  );
  assert.equal(client.hasCredentials, false);
});

test("readFile maps firmware missing responses without masking other errors", async () => {
  for (const status of [400, 404]) {
    const client = new DeviceClient({
      origin: "http://10.0.4.20",
      token: TOKEN,
      fetchImpl: async () => new Response("missing", { status }),
    });
    assert.deepEqual(await client.readFile("/ext/missing.anim"), {
      exists: false,
      bytes: null,
    });
  }
});

test("ensureDirectory lists before creating only the missing leaf", async () => {
  const calls = [];
  const client = new DeviceClient({
    origin: "http://10.0.4.20",
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (url.includes("/api/storage/list")) {
        return Response.json({ list: [] });
      }
      return Response.json({ result: "ok" });
    },
  });

  await client.ensureDirectory("/ext/apps_assets/busy/themes/available");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/storage/list");
  assert.equal(calls[0].url.searchParams.get("path"), "/ext/apps_assets/busy/themes");
  assert.equal(calls[1].url.pathname, "/api/storage/mkdir");
  assert.equal(
    calls[1].url.searchParams.get("path"),
    "/ext/apps_assets/busy/themes/available",
  );
});

test("upload and write use only non-destructive firmware endpoints", async () => {
  const calls = [];
  const client = new DeviceClient({
    origin: "http://10.0.4.20",
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return Response.json({ result: "ok" });
    },
  });
  const bytes = new Uint8Array([1, 2, 3]);

  await client.uploadAnimation("available", bytes);
  await client.writeFile(
    "/ext/apps_assets/busy/themes/available/theme.json",
    bytes,
  );

  assert.equal(calls[0].url.pathname, "/api/assets/upload");
  assert.equal(calls[0].url.searchParams.get("application_name"), "custom_themes");
  assert.equal(calls[0].url.searchParams.get("file"), "animations/available.anim");
  assert.equal(calls[1].url.pathname, "/api/storage/write");
  assert.equal(calls[1].url.searchParams.get("append"), "0");
  assert.ok(calls.every((call) => !/remove|rename|delete/i.test(call.url.pathname)));
});

test("permission, timeout, and network failures are classified", async () => {
  for (const [error, kind] of [
    [new DOMException("denied", "NotAllowedError"), "permission"],
    [new TypeError("Failed to fetch"), "network"],
  ]) {
    const client = new DeviceClient({
      origin: "http://10.0.4.20",
      token: TOKEN,
      fetchImpl: async () => {
        throw error;
      },
    });
    await assert.rejects(
      client.connect(),
      (caught) => caught instanceof DeviceError && caught.kind === kind,
    );
  }

  const timeoutClient = new DeviceClient({
    origin: "http://10.0.4.20",
    token: TOKEN,
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  await assert.rejects(
    timeoutClient.connect(),
    (error) => error instanceof DeviceError && error.kind === "timeout",
  );
});

test("direct install support is limited to secure desktop Chromium", () => {
  assert.equal(
    isDirectInstallSupported({
      isSecureContext: true,
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
    }),
    true,
  );
  assert.equal(
    isDirectInstallSupported({
      isSecureContext: true,
      userAgent: "Mozilla/5.0 Edg/140.0.0.0 Chrome/140.0.0.0",
    }),
    true,
  );
  assert.equal(
    isDirectInstallSupported({
      isSecureContext: true,
      userAgent: "Mozilla/5.0 Chrome/140.0 Mobile",
    }),
    false,
  );
  assert.equal(
    isDirectInstallSupported({ isSecureContext: false, userAgent: "Chrome/140" }),
    false,
  );
  assert.equal(
    isDirectInstallSupported({ isSecureContext: true, userAgent: "Firefox/142" }),
    false,
  );
});

test("device client source does not persist or log credentials", async () => {
  const source = await readFile(
    new URL("../docs/modules/device-client.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(source, /console\./);
});
