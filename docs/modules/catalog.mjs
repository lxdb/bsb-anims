export const RAW_BASE_URL =
  "https://raw.githubusercontent.com/lxdb/bsb-anims/main/";
export const CATALOG_URL = `${RAW_BASE_URL}catalog.json`;

const FILE_KINDS = [
  "animation",
  "theme",
  "framebuffer_preview",
  "device_preview",
];
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]*$/;

function objectWithKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export function artifactURL(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe catalog path: ${String(path)}`);
  }
  const url = new URL(path, RAW_BASE_URL);
  if (!url.href.startsWith(RAW_BASE_URL)) {
    throw new Error(`unsafe catalog path: ${path}`);
  }
  return url.href;
}

function validateFileRecord(record, animationId, filename) {
  if (!objectWithKeys(record, ["path", "bytes", "sha256"])) {
    throw new Error(`invalid ${filename} record for ${animationId}`);
  }
  const expectedPath = `animations/${animationId}/${filename}`;
  if (record.path !== expectedPath) {
    artifactURL(record.path);
    throw new Error(`${animationId} ${filename} path must be ${expectedPath}`);
  }
  artifactURL(record.path);
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) {
    throw new Error(`invalid byte count for ${record.path}`);
  }
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    throw new Error(`invalid SHA-256 for ${record.path}`);
  }
}

export function validateCatalog(value) {
  if (!objectWithKeys(value, ["schema_version", "application_name", "animations"])) {
    throw new Error("invalid catalog fields");
  }
  if (value.schema_version !== 1 || value.application_name !== "custom_themes") {
    throw new Error("unsupported catalog contract");
  }
  if (!Array.isArray(value.animations) || value.animations.length === 0) {
    throw new Error("catalog contains no animations");
  }
  const ids = new Set();
  const catalogOrders = new Set();
  const themeOrders = new Set();
  for (const animation of value.animations) {
    if (
      !objectWithKeys(animation, [
        "id",
        "name",
        "description",
        "catalog_order",
        "theme_order",
        "width",
        "height",
        "fps",
        "files",
      ])
    ) {
      throw new Error("invalid animation fields");
    }
    if (!ID.test(animation.id) || animation.id === "busy" || ids.has(animation.id)) {
      throw new Error(`invalid or duplicate animation ID: ${animation.id}`);
    }
    ids.add(animation.id);
    if (
      typeof animation.name !== "string" ||
      animation.name.trim() === "" ||
      typeof animation.description !== "string" ||
      animation.description.trim() === "" ||
      animation.width !== 72 ||
      animation.height !== 16 ||
      animation.fps !== 60
    ) {
      throw new Error(`invalid metadata for ${animation.id}`);
    }
    if (
      !Number.isSafeInteger(animation.catalog_order) ||
      !Number.isSafeInteger(animation.theme_order) ||
      catalogOrders.has(animation.catalog_order) ||
      themeOrders.has(animation.theme_order)
    ) {
      throw new Error(`invalid or duplicate order for ${animation.id}`);
    }
    catalogOrders.add(animation.catalog_order);
    themeOrders.add(animation.theme_order);
    if (!objectWithKeys(animation.files, FILE_KINDS)) {
      throw new Error(`invalid file records for ${animation.id}`);
    }
    validateFileRecord(animation.files.animation, animation.id, "animation.anim");
    validateFileRecord(animation.files.theme, animation.id, "theme.json");
    validateFileRecord(
      animation.files.framebuffer_preview,
      animation.id,
      "framebuffer.gif",
    );
    validateFileRecord(
      animation.files.device_preview,
      animation.id,
      "preview.gif",
    );
  }
  return value;
}

export async function loadCatalog(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(CATALOG_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`catalog request failed with HTTP ${response.status}`);
  }
  let value;
  try {
    value = await response.json();
  } catch (error) {
    throw new Error("catalog response is not valid JSON", { cause: error });
  }
  return validateCatalog(value);
}

export async function sha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchVerifiedArtifact(record, fetchImpl = globalThis.fetch) {
  const url = artifactURL(record.path);
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${record.path} request failed with HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== record.bytes) {
    throw new Error(`${record.path} byte count mismatch`);
  }
  if ((await sha256Hex(bytes)) !== record.sha256) {
    throw new Error(`${record.path} SHA-256 mismatch`);
  }
  return bytes;
}
