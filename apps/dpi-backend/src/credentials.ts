// File-backed pi-ai credential store: <DPI_HOME>/auth.json, the same shape `pi-ai login` writes
// ({ "<providerId>": { type: "oauth" | "api_key", ... } }). Used for subscription OAuth such as
// Anthropic Claude Pro/Max; OAuth refreshes are persisted here so a restart keeps the session.
//
//   cd ~/.dpi && npx --prefix <checkout>/apps/dpi-backend pi-ai login anthropic
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";

type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;

export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  /** Re-read on every call so a `pi-ai login` run while the backend is up is picked up. */
  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Credential>) {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  has(providerId: string) {
    return this.load()[providerId] !== undefined;
  }

  async read(providerId: string) {
    return this.load()[providerId];
  }

  async list() {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.enqueue(async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next;
      this.save(all);
      return next;
    });
  }

  delete(providerId: string) {
    return this.enqueue(async () => {
      const all = this.load();
      delete all[providerId];
      this.save(all);
    });
  }
}
