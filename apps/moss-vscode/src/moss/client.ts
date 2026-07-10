import { fork, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DocumentInfo, MutationOptions, QueryOptions, SearchResult } from "@moss-dev/moss";
import type { MossCredentials } from "./config";
import { workspaceSessionName } from "./config";

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export interface LocalMossSession {
  readonly docCount: number;
  addDocs(
    docs: DocumentInfo[],
    options?: MutationOptions,
  ): Promise<{ added: number; updated: number }>;
  deleteDocs(docIds: string[]): Promise<number>;
  query(query: string, options?: QueryOptions): Promise<SearchResult>;
  saveToDisk(cachePath: string): Promise<void>;
  loadFromDisk(cachePath: string): Promise<number>;
}

export class MossSessionManager {
  private worker: ChildProcess | undefined;
  private session: WorkerBackedSession | undefined;
  private ready = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(
    private readonly extensionPath: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  get isReady(): boolean {
    return this.ready && !!this.session;
  }

  getSession(): LocalMossSession {
    if (!this.session) {
      throw new Error("Moss session is not initialized");
    }
    return this.session;
  }

  async initialize(credentials: MossCredentials): Promise<LocalMossSession> {
    this.ready = false;
    this.ensureWorker();
    const name = workspaceSessionName();
    const result = await this.call<{ docCount: number }>("initialize", {
      projectId: credentials.projectId,
      projectKey: credentials.projectKey,
      name,
      modelId: "moss-minilm",
    });
    this.session = new WorkerBackedSession(
      result.docCount,
      (method, args) => this.call(method, args),
    );
    this.ready = true;
    return this.session;
  }

  dispose(): void {
    this.ready = false;
    this.session = undefined;
    for (const { reject } of this.pending.values()) {
      reject(new Error("Moss worker was disposed"));
    }
    this.pending.clear();
    this.worker?.kill();
    this.worker = undefined;
  }

  private ensureWorker(): void {
    if (this.worker && !this.worker.killed) {
      return;
    }

    const workerPath = path.join(this.extensionPath, "dist", "mossWorker.js");
    const execPath = findNodeBinary();
    this.log(`Starting Moss worker: ${workerPath}`);
    this.log(`Moss worker execPath: ${execPath}`);
    this.worker = fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });

    this.worker.stdout?.on("data", (chunk: Buffer) => {
      this.log(`[worker] ${chunk.toString().trimEnd()}`);
    });
    this.worker.stderr?.on("data", (chunk: Buffer) => {
      this.log(`[worker:stderr] ${chunk.toString().trimEnd()}`);
    });
    this.worker.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
    });
    this.worker.on("exit", (code, signal) => {
      const detail = `Moss worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.log(detail);
      this.ready = false;
      this.session = undefined;
      this.worker = undefined;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`${detail}. The native Moss runtime may have crashed.`));
      }
      this.pending.clear();
    });
    this.worker.on("error", (err) => {
      this.log(`Moss worker error: ${err.message}`);
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });
  }

  private call<T>(method: string, args: unknown): Promise<T> {
    this.ensureWorker();
    const worker = this.worker;
    if (!worker || !worker.connected) {
      return Promise.reject(new Error("Moss worker is not connected"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.send({ id, method, args }, (err) => {
        if (!err) {
          return;
        }
        this.pending.delete(id);
        reject(err);
      });
    });
  }
}

function findNodeBinary(): string {
  const candidates = [
    process.env.NODE_BINARY,
    process.env.npm_node_execpath,
    process.env.npm_execpath?.endsWith("npm-cli.js")
      ? path.join(path.dirname(path.dirname(process.env.npm_execpath)), "bin", "node")
      : undefined,
    spawnSync("which", ["node"], { encoding: "utf8" }).stdout?.trim(),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return process.execPath;
}

class WorkerBackedSession implements LocalMossSession {
  constructor(
    private count: number,
    private readonly call: <T>(method: string, args: unknown) => Promise<T>,
  ) {}

  get docCount(): number {
    return this.count;
  }

  async addDocs(
    docs: DocumentInfo[],
    options?: MutationOptions,
  ): Promise<{ added: number; updated: number }> {
    const result = await this.call<{ added: number; updated: number; docCount: number }>(
      "addDocs",
      { docs, options },
    );
    this.count = result.docCount;
    return { added: result.added, updated: result.updated };
  }

  async deleteDocs(docIds: string[]): Promise<number> {
    const result = await this.call<{ deleted: number; docCount: number }>("deleteDocs", {
      docIds,
    });
    this.count = result.docCount;
    return result.deleted;
  }

  async query(query: string, options?: QueryOptions): Promise<SearchResult> {
    return this.call<SearchResult>("query", { query, options });
  }

  async saveToDisk(cachePath: string): Promise<void> {
    const result = await this.call<{ docCount: number }>("saveToDisk", { cachePath });
    this.count = result.docCount;
  }

  async loadFromDisk(cachePath: string): Promise<number> {
    const result = await this.call<{ loaded: number; docCount: number }>("loadFromDisk", {
      cachePath,
    });
    this.count = result.docCount;
    return result.loaded;
  }
}
