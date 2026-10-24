/**
 * Chrome/Chromium discovery and lifecycle management.
 *
 * Deliberately resolves a *real* installed Chrome first — the whole point of
 * this library is that the browser does the layout, so we never reimplement
 * CSS. Headless shell is used as a fallback when no full browser is present.
 */

import { spawn, type Subprocess } from "bun";
import { CdpConnection } from "./cdp.ts";

export type BrowserFlavor = "chrome" | "chromium" | "chrome-headless-shell" | "edge";

export type ResolvedBrowser = {
  path: string;
  flavor: BrowserFlavor;
  version: string;
};

const CANDIDATES: Array<{ flavor: BrowserFlavor; paths: string[] }> = [
  {
    flavor: "chrome",
    paths: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    flavor: "chromium",
    paths: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    ],
  },
  {
    flavor: "edge",
    paths: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/microsoft-edge",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
];

async function readVersion(path: string): Promise<string> {
  try {
    const proc = spawn({ cmd: [path, "--version"], stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Extend discovery with extra locations (e.g. a playwright/puppeteer cache). */
export async function findBrowser(extraPaths: string[] = []): Promise<ResolvedBrowser | null> {
  const envOverride = process.env.CHROME_PATH;
  const all: Array<{ flavor: BrowserFlavor; path: string }> = [
    ...(envOverride ? [{ flavor: "chrome" as BrowserFlavor, path: envOverride }] : []),
    ...CANDIDATES.flatMap(({ flavor, paths }) => paths.map((path) => ({ flavor, path }))),
    ...extraPaths.map((path) => ({ flavor: "chrome" as BrowserFlavor, path })),
  ];

  for (const { flavor, path } of all) {
    if (await Bun.file(path).exists()) {
      return { path, flavor, version: await readVersion(path) };
    }
  }
  return null;
}

/** Pick a free TCP port without binding Chrome to a fixed one. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  return port!;
}

export type LaunchOptions = {
  /** Explicit browser binary. Falls back to auto-discovery. */
  executablePath?: string;
  /** Extra candidate paths tried during discovery. */
  extraPaths?: string[];
  /** Show a real window instead of headless. */
  headless?: boolean;
  args?: string[];
  /** Extra Chrome features to disable, merged into the single `--disable-features` flag. */
  disableFeatures?: string[];
  /** Hard timeout for browser startup. */
  timeoutMs?: number;
  /** Directory for the temporary browser profile. */
  userDataDir?: string;
};

export type BrowserSession = {
  connection: CdpConnection;
  process: Subprocess;
  port: number;
  browser: ResolvedBrowser;
  /** Create a blank page and return its target id + session id. */
  newPage(): Promise<{ targetId: string; sessionId: string }>;
  closePage(sessionId: string): Promise<void>;
  close(): Promise<void>;
};

export async function launchBrowser(options: LaunchOptions = {}): Promise<BrowserSession> {
  const resolved = options.executablePath
    ? { path: options.executablePath, flavor: "chrome" as BrowserFlavor, version: await readVersion(options.executablePath) }
    : await findBrowser(options.extraPaths);

  if (!resolved) {
    throw new Error(
      [
        "No Chrome/Chromium binary found.",
        "Install Google Chrome, or set CHROME_PATH=/path/to/chrome.",
        "On CI: `bunx playwright install chromium` and pass its path as executablePath.",
      ].join("\n"),
    );
  }

  const port = freePort();
  const headless = options.headless !== false;
  const userDataDir =
    options.userDataDir ?? `${process.env.TMPDIR ?? "/tmp"}/pdf-service-${process.pid}-${Date.now()}`;

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--disable-features=${["Translate", "MediaRouter", "OptimizationHints", ...(options.disableFeatures ?? [])].join(",")}`,
    "--disable-sync",
    "--disable-extensions",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "--allow-file-access-from-files",
    "--disable-gpu",
    // Docker's /dev/shm is 64 MB by default; large pages crash the tab without this.
    ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
    // Chrome refuses to start as root with its sandbox on, and most containers block the user
    // namespaces the sandbox needs as non-root too (CHROME_NO_SANDBOX=1).
    ...(process.getuid?.() === 0 || process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ...(headless ? ["--headless=new"] : []),
    ...(options.args ?? []),
    "about:blank",
  ];

  const proc = spawn({
    cmd: [resolved.path, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Drain output so the child never blocks on a full pipe.
  void new Response(proc.stdout).text().catch(() => "");
  const stderrText: string[] = [];
  void (async () => {
    try {
      const text = await new Response(proc.stderr).text();
      if (text) stderrText.push(text);
    } catch {
      /* ignore */
    }
  })();

  const endpoint = await waitForEndpoint(port, options.timeoutMs ?? 20_000, stderrText);
  const connection = await CdpConnection.connect(endpoint);

  try {
    const { targetId, sessionId } = await attachNewPage(connection);
    await connection.send("Target.closeTarget", { targetId }).catch(() => {});
    if (sessionId) await connection.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  } catch {
    /* non-fatal warmup */
  }

  let closed = false;

  return {
    connection,
    process: proc,
    port,
    browser: resolved,
    newPage: () => attachNewPage(connection),
    closePage: async (sessionId) => {
      await connection.send("Target.closeTarget", { targetId: sessionId }).catch(() => {});
    },
    close: async () => {
      if (closed) return;
      closed = true;
      connection.close();
      try {
        await connection.send("Browser.close").catch(() => {});
      } catch {
        /* socket may already be closed */
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      try {
        await proc.exited;
      } catch {
        /* ignore */
      }
      try {
        await Bun.$`rm -rf ${userDataDir}`.quiet();
      } catch {
        /* ignore */
      }
    },
  };
}

async function attachNewPage(
  connection: CdpConnection,
): Promise<{ targetId: string; sessionId: string }> {
  const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  // Enable the domains every render needs, in parallel.
  await Promise.all([
    connection.send("Page.enable", {}, sessionId),
    connection.send("Runtime.enable", {}, sessionId),
    connection.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {}),
  ]);

  return { targetId, sessionId };
}

async function waitForEndpoint(port: number, timeoutMs: number, stderr: string[]): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        const ws = data.webSocketDebuggerUrl;
        if (ws) return ws.replace("localhost", "127.0.0.1");
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(60);
  }

  throw new Error(
    `Chrome did not expose a DevTools endpoint on port ${port} within ${timeoutMs}ms.` +
      (stderr.length ? `\nstderr:\n${stderr.join("\n").slice(0, 2000)}` : ""),
  );
}
