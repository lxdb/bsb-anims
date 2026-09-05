import assert from "node:assert/strict";
import test from "node:test";

import {
  CATALOG_URL,
  RAW_BASE_URL,
  artifactURL,
  fetchVerifiedArtifact,
  loadCatalog,
  sha256Hex,
} from "../docs/modules/catalog.mjs";

function catalogFixture() {
  return {
    schema_version: 1,
    application_name: "custom_themes",
    animations: [
      {
        id: "available",
        name: "Available",
        description: "Let others know you're available.",
        catalog_order: 10,
        theme_order: 150,
        width: 72,
        height: 16,
        fps: 60,
        files: {
          animation: {
            path: "animations/available/animation.anim",
            bytes: 4,
            sha256: "0".repeat(64),
          },
          theme: {
            path: "animations/available/theme.json",
            bytes: 4,
            sha256: "0".repeat(64),
          },
          framebuffer_preview: {
            path: "animations/available/framebuffer.gif",
            bytes: 4,
            sha256: "0".repeat(64),
          },
          device_preview: {
            path: "animations/available/preview.gif",
            bytes: 4,
            sha256: "0".repeat(64),
          },
        },
      },
    ],
  };
}

test("catalog and artifact URLs resolve only against raw main", () => {
  assert.equal(
    CATALOG_URL,
    "https://raw.githubusercontent.com/lxdb/bsb-anims/main/catalog.json",
  );
  assert.equal(
    artifactURL("animations/available/animation.anim"),
    `${RAW_BASE_URL}animations/available/animation.anim`,
  );
  assert.throws(() => artifactURL("../tooling/cataloggen.py"), /unsafe catalog path/);
  assert.throws(() => artifactURL("https://example.com/file.anim"), /unsafe catalog path/);
});

test("loadCatalog requests current main without a cache", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(catalogFixture()));
  };

  const catalog = await loadCatalog(fetchImpl);

  assert.equal(catalog.animations[0].id, "available");
  assert.deepEqual(calls, [{ url: CATALOG_URL, options: { cache: "no-store" } }]);
});

test("loadCatalog rejects malformed and unavailable catalogs", async () => {
  await assert.rejects(
    loadCatalog(async () => new Response("unavailable", { status: 503 })),
    /catalog request failed with HTTP 503/,
  );
  const malformed = catalogFixture();
  malformed.animations[0].files.animation.path = "../escape.anim";
  await assert.rejects(
    loadCatalog(async () => new Response(JSON.stringify(malformed))),
    /unsafe catalog path/,
  );
});

test("fetchVerifiedArtifact verifies byte count and SHA-256", async () => {
  const bytes = new TextEncoder().encode("safe artifact");
  const record = {
    path: "animations/available/animation.anim",
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
  const calls = [];
  const result = await fetchVerifiedArtifact(record, async (url, options) => {
    calls.push({ url, options });
    return new Response(bytes);
  });

  assert.deepEqual(result, bytes);
  assert.deepEqual(calls[0], {
    url: `${RAW_BASE_URL}${record.path}`,
    options: { cache: "no-store" },
  });

  await assert.rejects(
    fetchVerifiedArtifact(record, async () => new Response(new Uint8Array([1]))),
    /byte count mismatch/,
  );
  await assert.rejects(
    fetchVerifiedArtifact(
      { ...record, sha256: "f".repeat(64) },
      async () => new Response(bytes),
    ),
    /SHA-256 mismatch/,
  );
});
