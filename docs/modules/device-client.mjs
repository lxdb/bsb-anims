const STORAGE_PATH = /^\/ext(?:\/[a-zA-Z0-9._-]+)+$/;
const ANIMATION_ID = /^[a-z0-9][a-z0-9._-]*$/;

export class DeviceError extends Error {
  constructor(message, { kind = "device", status = null, cause } = {}) {
    super(message, { cause });
    this.name = "DeviceError";
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeDeviceOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new DeviceError("Enter a valid BUSY Bar URL.", {
      kind: "validation",
      cause: error,
    });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new DeviceError("The BUSY Bar URL must use HTTP or HTTPS.", {
      kind: "validation",
    });
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new DeviceError("Enter a plain origin without credentials, path, or query.", {
      kind: "validation",
    });
  }
  return url.origin;
}

export function validateToken(value) {
  const valid =
    typeof value === "string" &&
    (/^[0-9]{4,10}$/.test(value) || value.length === 32);
  if (!valid) {
    throw new DeviceError(
      "Enter a 4-10 digit access key or a 32-character token.",
      { kind: "validation" },
    );
  }
  return value;
}

export function isDirectInstallSupported({ isSecureContext, userAgent }) {
  return Boolean(
    isSecureContext &&
      /(?:Chrome|Chromium|Edg)\//.test(userAgent) &&
      !/(?:Android|Mobile|CriOS|EdgiOS|OPR(?:\/|\b))/.test(userAgent),
  );
}

function validateStoragePath(path) {
  if (typeof path !== "string" || !STORAGE_PATH.test(path)) {
    throw new DeviceError("Invalid BUSY Bar storage path.", { kind: "validation" });
  }
  return path;
}

function classifyFetchError(error) {
  if (error instanceof DeviceError) {
    return error;
  }
  if (error?.name === "NotAllowedError") {
    return new DeviceError("Local-network access was not allowed.", {
      kind: "permission",
      cause: error,
    });
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new DeviceError("The BUSY Bar request timed out.", {
      kind: "timeout",
      cause: error,
    });
  }
  return new DeviceError(
    "The BUSY Bar could not be reached. Check local-network permission and CORS.",
    { kind: "network", cause: error },
  );
}

export class DeviceClient {
  #fetch;
  #origin;
  #timeoutMs;
  #token;

  constructor({ origin, token, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
    this.#origin = normalizeDeviceOrigin(origin);
    this.#token = validateToken(token);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  get hasCredentials() {
    return Boolean(this.#origin && this.#token);
  }

  disconnect() {
    this.#origin = "";
    this.#token = "";
  }

  async #request(path, options = {}) {
    if (!this.hasCredentials) {
      throw new DeviceError("Connect to the BUSY Bar first.", { kind: "connection" });
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      this.#timeoutMs,
    );
    let response;
    try {
      const fetchImpl = this.#fetch;
      response = await fetchImpl(`${this.#origin}${path}`, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          "X-API-Token": this.#token,
        },
        signal: controller.signal,
        targetAddressSpace: "local",
      });
    } catch (error) {
      throw classifyFetchError(error);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 403) {
      this.disconnect();
      throw new DeviceError("The BUSY Bar rejected the API token.", {
        kind: "authorization",
        status: 403,
      });
    }
    return response;
  }

  async #requireSuccess(path, options) {
    const response = await this.#request(path, options);
    if (!response.ok) {
      throw new DeviceError(`BUSY Bar request failed with HTTP ${response.status}.`, {
        kind: "http",
        status: response.status,
      });
    }
    return response;
  }

  async connect() {
    const response = await this.#requireSuccess("/api/version", { method: "GET" });
    try {
      return await response.json();
    } catch (error) {
      throw new DeviceError("The BUSY Bar returned an invalid version response.", {
        kind: "protocol",
        cause: error,
      });
    }
  }

  async readFile(path) {
    validateStoragePath(path);
    const query = new URLSearchParams({ path });
    const response = await this.#request(`/api/storage/read?${query}`, {
      method: "GET",
    });
    if (response.status === 400 || response.status === 404) {
      return { exists: false, bytes: null };
    }
    if (!response.ok) {
      throw new DeviceError(`BUSY Bar read failed with HTTP ${response.status}.`, {
        kind: "http",
        status: response.status,
      });
    }
    return {
      exists: true,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async ensureDirectory(path) {
    validateStoragePath(path);
    const separator = path.lastIndexOf("/");
    const parent = path.slice(0, separator);
    const name = path.slice(separator + 1);
    const query = new URLSearchParams({ path: parent });
    const response = await this.#requireSuccess(`/api/storage/list?${query}`, {
      method: "GET",
    });
    const payload = await response.json();
    if (!Array.isArray(payload?.list)) {
      throw new DeviceError("The BUSY Bar returned an invalid directory listing.", {
        kind: "protocol",
      });
    }
    const existing = payload.list.find((entry) => entry?.name === name);
    if (existing?.type === "dir") {
      return;
    }
    if (existing) {
      throw new DeviceError("A file blocks the target theme directory.", {
        kind: "conflict",
      });
    }
    const mkdirQuery = new URLSearchParams({ path });
    await this.#requireSuccess(`/api/storage/mkdir?${mkdirQuery}`, {
      method: "POST",
      body: new Uint8Array(),
    });
  }

  async uploadAnimation(id, bytes) {
    if (!ANIMATION_ID.test(id) || id === "busy") {
      throw new DeviceError("Invalid animation ID.", { kind: "validation" });
    }
    const query = new URLSearchParams({
      application_name: "custom_themes",
      file: `animations/${id}.anim`,
    });
    await this.#requireSuccess(`/api/assets/upload?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
  }

  async writeFile(path, bytes) {
    validateStoragePath(path);
    const query = new URLSearchParams({ path, append: "0" });
    await this.#requireSuccess(`/api/storage/write?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
  }
}
