/**
 * Minimal, dependency-free CDP (Chrome DevTools Protocol) client.
 *
 * Works on Bun's global WebSocket. Supports flat session routing so a single
 * socket can drive many pages, plus event subscriptions with wildcards.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type CdpParams = Record<string, unknown>;
export type CdpEvent = { method: string; params: any; sessionId?: string };

type Pending = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly cdpCode?: number,
    readonly data?: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpConnection {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#onMessage(event));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  /** Connect to a browser-level or page-level DevTools websocket URL. */
  static connect(url: string, timeoutMs = 20_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Timed out connecting to DevTools socket: ${url}`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        const detail = (event as any)?.message ?? "unknown error";
        reject(new Error(`Failed to open DevTools socket (${detail}): ${url}`));
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a command and await its result. */
  send<T = any>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("CDP connection is closed"));

    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`CDP command timed out after 60s: ${method}`, method));
      }, 60_000);

      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Subscribe to CDP events. Use `*` as a suffix wildcard, e.g. `Page.*`. */
  on(method: string, listener: (event: CdpEvent) => void): () => void {
    let set = this.#listeners.get(method);
    if (!set) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#listeners.delete(method);
    };
  }

  /** Resolve once an event matching `method` arrives. */
  once<T = any>(method: string, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event: ${method}`));
      }, timeoutMs);

      const off = this.on(method, (event) => {
        if (sessionId && event.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(event.params as T);
      });
    });
  }

  close(reason = "client closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CDP connection closed before ${pending.method} completed`));
      this.#pending.delete(id);
    }
    try {
      this.#ws.close(1000, reason);
    } catch {
      /* ignore */
    }
  }

  #onMessage(event: MessageEvent): void {
    const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
    if (!raw) return;

    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(
          new CdpError(
            `${message.error.message ?? "CDP error"} (${pending.method})`,
            pending.method,
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === "string") {
      this.#emit(message.method, {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId,
      });
      const star = message.method.indexOf(".");
      if (star > 0) this.#emit(`${message.method.slice(0, star)}.*`, {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId,
      });
    }
  }

  #emit(method: string, event: CdpEvent): void {
    const set = this.#listeners.get(method);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not kill the socket */
      }
    }
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CDP connection closed before ${pending.method} completed`));
      this.#pending.delete(id);
    }
    this.#listeners.clear();
  }
}
