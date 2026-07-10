<p align="center">
  <img src="media/moss_avatar_core.png" alt="Moss" width="96" />
</p>

# Moss Code Search (VS Code)

Semantic search over your open workspace, powered by [Moss](https://moss.dev) — local-first, sub-10ms retrieval via `SessionIndex`.

## Features

- **Manual indexing** — click **Create Index** in the sidebar the first time
- **Persisted indexes** — reopening the same folder restores the saved index (no full rebuild)
- Sidebar with live (debounced) semantic search after indexing
- Click a result to jump to file + line
- Incremental re-index on save / create / delete / rename (also saved to disk)
- Credentials via `.env`, VS Code settings, or Secret Storage

## Setup

```bash
cd apps/moss-vscode
cp .env.example .env   # fill in MOSS_PROJECT_ID / MOSS_PROJECT_KEY
npm install
npm run build
```

Open this monorepo in VS Code / Cursor, then **Run and Debug → Run Extension** (F5).

Or from the Command Palette after installing a `.vsix`:

1. `Moss: Configure Credentials`
2. Open a workspace and wait for indexing
3. Open the **Moss Search** activity bar icon and type a query

## Commands

| Command | Description |
|---------|-------------|
| `Moss: Focus Search` | Focus the semantic search sidebar |
| `Moss: Create Index` | Index the open workspace (required before search) |
| `Moss: Rebuild Index` | Re-scan and re-index the workspace |
| `Moss: Configure Credentials` | Store project ID / key in Secret Storage |
| `Moss: Show Logs` | Open the Moss Code Search output channel |

## Settings

- `moss.projectId` / `moss.projectKey` — optional overrides
- `moss.includeGlobs` / `moss.excludeGlobs` — what to index
- `moss.topK` — result count (default 20)
- `moss.alpha` — hybrid blend (default 0.7; 1.0 = semantic)

## Architecture

Extension host owns UI and file scanning. Moss native runtime runs in a separate Node worker (`dist/mossWorker.js`) so a native crash cannot take down VS Code. Sessions are named `vscode-{workspaceHash}`. Files are chunked into `DocumentInfo` records (`{path}#chunk-{n}`) with metadata for navigation.

After **Create Index**, the session is written with Moss `saveToDisk` under the extension global storage (`indexes/{workspaceHash}/`), plus a `meta.json` map of file → chunk counts. Reopening that folder loads the cache with `loadFromDisk` so search works immediately. Use **Moss: Rebuild Index** to force a full reindex.

Native modules (`@moss-dev/moss`, `@moss-dev/moss-core`) are left external by esbuild and loaded from `node_modules` at runtime in the worker.
