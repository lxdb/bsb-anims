import { fetchVerifiedArtifact, sha256Hex } from "./catalog.mjs";

const ID = /^[a-z0-9][a-z0-9._-]*$/;

export class InstallError extends Error {
  constructor(message, { partial = false, cause } = {}) {
    super(message, { cause });
    this.name = "InstallError";
    this.partial = partial;
  }
}

export function devicePaths(id) {
  if (!ID.test(id) || id === "busy") {
    throw new InstallError("Invalid animation ID.");
  }
  return {
    animation: `/ext/user_assets/custom_themes/animations/${id}.anim`,
    themeDirectory: `/ext/apps_assets/busy/themes/${id}`,
    theme: `/ext/apps_assets/busy/themes/${id}/theme.json`,
  };
}

async function recordMatches(readResult, record) {
  return (
    readResult.exists &&
    readResult.bytes.byteLength === record.bytes &&
    (await sha256Hex(readResult.bytes)) === record.sha256
  );
}

async function readState(client, animation) {
  const paths = devicePaths(animation.id);
  const [animationFile, themeFile] = await Promise.all([
    client.readFile(paths.animation),
    client.readFile(paths.theme),
  ]);
  return {
    paths,
    animationExists: animationFile.exists,
    themeExists: themeFile.exists,
    animationMatches: await recordMatches(
      animationFile,
      animation.files.animation,
    ),
    themeMatches: await recordMatches(themeFile, animation.files.theme),
  };
}

export async function statusForAnimation(client, animation) {
  const state = await readState(client, animation);
  if (state.animationMatches && state.themeMatches) {
    return "installed";
  }
  return !state.animationExists && !state.themeExists ? "install" : "update";
}

export async function installAnimation(
  client,
  animation,
  fetchImpl = globalThis.fetch,
) {
  const [animationBytes, themeBytes] = await Promise.all([
    fetchVerifiedArtifact(animation.files.animation, fetchImpl),
    fetchVerifiedArtifact(animation.files.theme, fetchImpl),
  ]);
  const state = await readState(client, animation);
  if (state.animationMatches && state.themeMatches) {
    return "installed";
  }

  let wroteRecord = false;
  try {
    if (!state.animationMatches) {
      await client.uploadAnimation(animation.id, animationBytes);
      wroteRecord = true;
      const readBack = await client.readFile(state.paths.animation);
      if (!(await recordMatches(readBack, animation.files.animation))) {
        throw new InstallError("Animation read-back verification failed.", {
          partial: true,
        });
      }
    }
    if (!state.themeMatches) {
      await client.ensureDirectory(state.paths.themeDirectory);
      await client.writeFile(state.paths.theme, themeBytes);
      wroteRecord = true;
      const readBack = await client.readFile(state.paths.theme);
      if (!(await recordMatches(readBack, animation.files.theme))) {
        throw new InstallError("Theme read-back verification failed.", {
          partial: true,
        });
      }
    }
  } catch (error) {
    if (error instanceof InstallError) {
      throw error;
    }
    throw new InstallError(
      wroteRecord
        ? "The device was partially updated. Retry to reconcile it."
        : "The device was not updated.",
      { partial: wroteRecord, cause: error },
    );
  }
  return "installed";
}
