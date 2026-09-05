# bsb-anims site

This orphan branch owns the static GitHub Pages catalog and direct BUSY Bar installer. It reads catalog metadata and artifacts from the repository's `main` branch at runtime; this branch does not duplicate animation files or generator code.

## Run locally

Serve the repository root with any static HTTP server, then open `/docs/` in desktop Chrome or Edge. Direct device requests require a secure browser context and local-network permission; a local static server is useful for visual and unit testing but does not prove the production permission flow.

Run the dependency-free JavaScript suite with Node 24:

```sh
node --test tests/*.test.mjs
```

The production site expects the default catalog at `https://raw.githubusercontent.com/lxdb/bsb-anims/main/catalog.json`.

## Security boundary

The installer accepts either the firmware's 4-10 digit access key or a 32-character access token. It keeps the device URL and credential in JavaScript memory only, verifies downloaded artifacts and device read-backs with SHA-256, updates only mismatched files, and does not expose delete, rename, reboot, or force-install operations.
