import * as vscode from "vscode";
import type { IndexStatus } from "../indexer/indexer";
import type { SearchHit } from "../search/search";

export type SidebarCallbacks = {
  onQuery: (query: string) => Promise<SearchHit[]>;
  onOpen: (hit: SearchHit) => Promise<void>;
  onCreateIndex: () => Promise<void>;
};

export class MossSearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "moss.searchView";

  private view?: vscode.WebviewView;
  private status: IndexStatus = { state: "unindexed" };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly callbacks: SidebarCallbacks,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    this.postStatus(this.status);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== "object") {
        return;
      }
      try {
        if (message.type === "query" && typeof message.text === "string") {
          if (this.status.state !== "ready") {
            this.postResults([]);
            return;
          }
          const hits = await this.callbacks.onQuery(message.text);
          this.postResults(hits);
        }
        if (message.type === "createIndex") {
          await this.callbacks.onCreateIndex();
        }
        if (message.type === "open" && message.hit) {
          await this.callbacks.onOpen(message.hit as SearchHit);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.postError(error);
      }
    });
  }

  setStatus(status: IndexStatus): void {
    this.status = status;
    this.postStatus(status);
  }

  private postStatus(status: IndexStatus): void {
    this.view?.webview.postMessage({ type: "status", status });
  }

  private postResults(hits: SearchHit[]): void {
    this.view?.webview.postMessage({ type: "results", hits });
  }

  private postError(error: string): void {
    this.view?.webview.postMessage({ type: "error", error });
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"),
    );
    const wordmarkLightUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "moss_wordmark_light.png"),
    );
    const wordmarkDarkUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "moss_wordmark_dark.png"),
    );
    const avatarUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "moss_avatar_core.png"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Moss Search</title>
</head>
<body>
  <div class="container">
    <header class="brand-header">
      <img class="brand-wordmark brand-wordmark-dark" src="${wordmarkDarkUri}" alt="Moss" />
      <img class="brand-wordmark brand-wordmark-light" src="${wordmarkLightUri}" alt="Moss" />
    </header>
    <p class="brand-tagline">Semantic code search</p>
    <div id="index-panel" class="index-panel">
      <p class="index-hint">Index this workspace to enable semantic search.</p>
      <button id="create-index" type="button" class="primary-btn">Create Index</button>
    </div>
    <div class="search-row">
      <input id="query" type="search" placeholder="Semantic search…" autocomplete="off" disabled />
    </div>
    <div class="status-row">
      <img id="status-avatar" class="status-avatar" src="${avatarUri}" alt="" />
      <div id="status">Not indexed</div>
    </div>
    <ul id="results"></ul>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('query');
    const statusEl = document.getElementById('status');
    const statusAvatar = document.getElementById('status-avatar');
    const resultsEl = document.getElementById('results');
    const indexPanel = document.getElementById('index-panel');
    const createBtn = document.getElementById('create-index');
    let timer;

    function formatStatus(status) {
      if (!status) return 'Not indexed';
      if (status.state === 'indexing') {
        return 'Indexing ' + status.processed + '/' + status.total + '…';
      }
      if (status.state === 'ready') {
        return 'Ready — ' + status.files + ' files, ' + status.chunks + ' chunks';
      }
      if (status.state === 'error') {
        return 'Error: ' + status.message;
      }
      if (status.state === 'unindexed') {
        return 'Not indexed — click Create Index';
      }
      return 'Not indexed';
    }

    function applyStatus(status) {
      const ready = status && status.state === 'ready';
      const indexing = status && status.state === 'indexing';
      input.disabled = !ready;
      indexPanel.style.display = ready || indexing ? 'none' : 'block';
      createBtn.disabled = indexing;
      createBtn.textContent = indexing ? 'Indexing…' : 'Create Index';
      statusEl.textContent = formatStatus(status);
      statusAvatar.classList.toggle('visible', !!ready);
      if (!ready && !input.value.trim()) {
        renderHits([]);
      }
    }

    function renderHits(hits) {
      resultsEl.innerHTML = '';
      if (input.disabled) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'Create an index first, then search your codebase.';
        resultsEl.appendChild(empty);
        return;
      }
      if (!hits || !hits.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = input.value.trim() ? 'No results' : 'Type to search your codebase';
        resultsEl.appendChild(empty);
        return;
      }
      for (const hit of hits) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'result';
        btn.type = 'button';
        const header = document.createElement('div');
        header.className = 'result-header';
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = hit.filePath + ':' + hit.startLine;
        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = (hit.score ?? 0).toFixed(3);
        header.appendChild(path);
        header.appendChild(score);
        const preview = document.createElement('div');
        preview.className = 'preview';
        preview.textContent = (hit.text || '').trim();
        btn.appendChild(header);
        btn.appendChild(preview);
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'open', hit });
        });
        li.appendChild(btn);
        resultsEl.appendChild(li);
      }
    }

    createBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'createIndex' });
    });

    input.addEventListener('input', () => {
      if (input.disabled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        vscode.postMessage({ type: 'query', text: input.value });
      }, 250);
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'status') {
        applyStatus(msg.status);
      }
      if (msg.type === 'results') {
        renderHits(msg.hits || []);
      }
      if (msg.type === 'error') {
        statusEl.textContent = 'Search error: ' + msg.error;
        statusAvatar.classList.remove('visible');
      }
    });

    applyStatus({ state: 'unindexed' });
    renderHits([]);
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
