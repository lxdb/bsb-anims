import { artifactURL, loadCatalog } from "./modules/catalog.mjs";
import {
  DeviceClient,
  DeviceError,
  isDirectInstallSupported,
} from "./modules/device-client.mjs";
import {
  InstallError,
  installAnimation,
  statusForAnimation,
} from "./modules/installer.mjs";

const elements = {
  cards: document.querySelector("#catalog-grid"),
  catalogError: document.querySelector("#catalog-error"),
  closeDialog: document.querySelector("#close-dialog"),
  connectButton: document.querySelector("#connect-button"),
  connectButtonLabel: document.querySelector("#connect-button-label"),
  connectForm: document.querySelector("#connect-form"),
  connectionDialog: document.querySelector("#connection-dialog"),
  connectionError: document.querySelector("#connection-error"),
  connectionStatus: document.querySelector("#connection-status"),
  deviceUrl: document.querySelector("#device-url"),
  disconnectButton: document.querySelector("#disconnect-button"),
  notice: document.querySelector("#notice"),
  token: document.querySelector("#api-token"),
  unsupported: document.querySelector("#unsupported-browser"),
};

const state = {
  catalog: null,
  client: null,
  cards: new Map(),
  directInstall: isDirectInstallSupported({
    isSecureContext: globalThis.isSecureContext,
    userAgent: navigator.userAgent,
  }),
};

const buttonCopy = {
  checking: "Checking...",
  install: "Install",
  installed: "Installed",
  installing: "Installing...",
  retry: "Retry status",
  update: "Update",
};

function setNotice(message, tone = "neutral") {
  elements.notice.textContent = message;
  elements.notice.dataset.tone = tone;
  elements.notice.hidden = message === "";
}

function setConnectionError(message) {
  elements.connectionError.textContent = message;
  elements.connectionError.hidden = message === "";
}

function setCardState(animation, cardState) {
  const card = state.cards.get(animation.id);
  if (!card) {
    return;
  }
  card.button.dataset.state = cardState;
  card.button.textContent = buttonCopy[cardState];
  card.button.setAttribute(
    "aria-label",
    `${buttonCopy[cardState]} ${animation.name}`,
  );
  card.button.disabled = ["checking", "installed", "installing"].includes(cardState);
}

function errorMessage(error) {
  if (error instanceof InstallError && error.partial) {
    return "The device was partially updated. Retry to reconcile its file hashes.";
  }
  if (error instanceof DeviceError) {
    if (error.kind === "authorization") {
      return "The BUSY Bar rejected that API token. Connect again with a valid token.";
    }
    if (error.kind === "permission") {
      return "Local-network access was denied. Allow it in the browser and retry.";
    }
    if (error.kind === "timeout") {
      return "The BUSY Bar did not respond before the request timed out.";
    }
    if (error.kind === "network") {
      return "The BUSY Bar could not be reached. Check its URL, local-network permission, and CORS.";
    }
  }
  return error instanceof Error ? error.message : "The request failed.";
}

function openConnectionDialog() {
  setConnectionError("");
  if (typeof elements.connectionDialog.showModal === "function") {
    elements.connectionDialog.showModal();
  } else {
    elements.connectionDialog.setAttribute("open", "");
  }
}

function renderCard(animation, eager) {
  const card = document.createElement("article");
  card.className = "animation-card";

  const preview = document.createElement("img");
  preview.className = "animation-preview";
  preview.src = artifactURL(animation.files.device_preview.path);
  preview.alt = `${animation.name} animation on a BUSY Bar`;
  preview.width = 768;
  preview.height = 248;
  preview.loading = eager ? "eager" : "lazy";
  preview.fetchPriority = eager ? "high" : "low";

  const heading = document.createElement("h2");
  heading.textContent = animation.name;

  const description = document.createElement("p");
  description.textContent = animation.description;

  const footer = document.createElement("div");
  footer.className = "card-footer";

  const dimensions = document.createElement("span");
  dimensions.className = "dimensions";
  dimensions.textContent = `${animation.width} x ${animation.height}`;

  let action;
  if (state.directInstall) {
    action = document.createElement("button");
    action.type = "button";
    action.className = "primary-action";
    action.textContent = buttonCopy.install;
    action.setAttribute("aria-label", `Install ${animation.name}`);
    action.dataset.state = "install";
    action.addEventListener("click", () => handleCardAction(animation));
  } else {
    action = document.createElement("a");
    action.className = "primary-action";
    action.href = artifactURL(animation.files.animation.path);
    action.download = `${animation.id}.anim`;
    action.textContent = "Download";
    action.setAttribute("aria-label", `Download ${animation.name} animation`);
  }

  footer.append(dimensions, action);
  card.append(preview, heading, description, footer);
  elements.cards.append(card);
  state.cards.set(animation.id, { card, button: action });
}

async function refreshAnimationStatus(animation) {
  if (!state.client) {
    setCardState(animation, "install");
    return;
  }
  setCardState(animation, "checking");
  try {
    setCardState(animation, await statusForAnimation(state.client, animation));
  } catch (error) {
    setCardState(animation, "retry");
    setNotice(errorMessage(error), "error");
    if (!state.client.hasCredentials) {
      disconnect();
    }
  }
}

async function refreshAllStatuses() {
  setNotice("");
  await Promise.all(
    state.catalog.animations.map((animation) => refreshAnimationStatus(animation)),
  );
}

async function handleCardAction(animation) {
  if (!state.client) {
    openConnectionDialog();
    return;
  }
  const cardState = state.cards.get(animation.id).button.dataset.state;
  if (cardState === "retry") {
    await refreshAnimationStatus(animation);
    return;
  }
  setCardState(animation, "installing");
  setNotice("");
  try {
    await installAnimation(state.client, animation);
    setCardState(animation, "installed");
    setNotice(`${animation.name} is installed and verified.`, "success");
  } catch (error) {
    setCardState(animation, "retry");
    setNotice(errorMessage(error), "error");
    if (!state.client.hasCredentials) {
      disconnect();
    }
  }
}

function updateConnectionUI(connected) {
  elements.connectButton.classList.toggle("connected", connected);
  elements.connectButtonLabel.textContent = connected
    ? "BUSY Bar connected"
    : "Connect BUSY Bar";
  elements.connectionStatus.textContent = connected
    ? "Connected. Device files are compared by SHA-256."
    : "Credentials are kept only for this page session.";
  elements.disconnectButton.hidden = !connected;
  elements.connectionDialog.dataset.connected = String(connected);
}

function disconnect() {
  state.client?.disconnect();
  state.client = null;
  elements.token.value = "";
  updateConnectionUI(false);
  if (state.catalog) {
    for (const animation of state.catalog.animations) {
      setCardState(animation, "install");
    }
  }
}

function resetConnectionSession() {
  disconnect();
  elements.connectForm.reset();
  setConnectionError("");
  setNotice("");
  if (elements.connectionDialog.open) {
    elements.connectionDialog.close();
  }
}

window.addEventListener("pagehide", resetConnectionSession);
window.addEventListener("pageshow", resetConnectionSession);

elements.connectButton.addEventListener("click", openConnectionDialog);
elements.closeDialog.addEventListener("click", () => elements.connectionDialog.close());
elements.disconnectButton.addEventListener("click", () => {
  disconnect();
  elements.connectionDialog.close();
  setNotice("Disconnected. The URL and token were cleared from memory.", "neutral");
});
elements.connectionDialog.addEventListener("click", (event) => {
  if (event.target === elements.connectionDialog) {
    elements.connectionDialog.close();
  }
});

elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setConnectionError("");
  const token = elements.token.value;
  elements.token.value = "";
  let client;
  try {
    client = new DeviceClient({
      origin: elements.deviceUrl.value,
      token,
    });
    await client.connect();
    state.client?.disconnect();
    state.client = client;
    updateConnectionUI(true);
    elements.connectionDialog.close();
    setNotice("Connected. Checking installed animation hashes...", "success");
    await refreshAllStatuses();
  } catch (error) {
    client?.disconnect();
    state.client = null;
    updateConnectionUI(false);
    setConnectionError(errorMessage(error));
  }
});

async function start() {
  resetConnectionSession();
  elements.unsupported.hidden = state.directInstall;
  if (!state.directInstall) {
    elements.connectButton.hidden = true;
  }
  try {
    state.catalog = await loadCatalog();
    const animations = [...state.catalog.animations].sort(
      (left, right) => left.catalog_order - right.catalog_order,
    );
    animations.forEach((animation, index) => renderCard(animation, index === 0));
  } catch (error) {
    elements.catalogError.hidden = false;
    elements.catalogError.textContent = `The animation catalog could not be loaded: ${errorMessage(error)}`;
  }
}

start();
