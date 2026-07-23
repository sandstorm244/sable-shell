"use strict";

/* Sable shell: a thin Electron wrapper around the Sable web client.
 *
 * The web app is loaded from the server (always current, nothing bundled);
 * everything in this repo is the native layer the browser sandbox can't
 * provide: a graphical screen-share picker and share audio —
 *   - Linux: per-application capture via venmic (PipeWire; display server
 *     irrelevant, X11 works fine)
 *   - Windows: system-wide loopback (Chromium WASAPI)
 */

const {
  app,
  BrowserWindow,
  crashReporter,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} = require("electron");
const fs = require("fs");
const path = require("path");

// ---- single instance --------------------------------------------------------
// Close hides to the tray, so users often "reopen" the app from the launcher
// while it is still running, ending up with several full Electron processes.
// Only one instance may run: a second launch just surfaces the window of the
// running instance and exits. (File → Change server stays safe: app.relaunch
// starts the new process only after this one exits and releases the lock.)
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
  } else {
    // e.g. still on the first-run server prompt
    const win = BrowserWindow.getAllWindows()[0];
    if (win) surfaceWindow(win);
  }
});

// Local minidumps (never uploaded) — land in userData/Crashpad. The
// child-process-gone log below usually identifies the culprit already.
crashReporter.start({ uploadToServer: false });

app.on("child-process-gone", (_event, details) => {
  console.error("[shell] child process gone:", JSON.stringify(details));
});
app.on("render-process-gone", (_event, _contents, details) => {
  console.error("[shell] renderer gone:", JSON.stringify(details));
});

const PATCH_JS = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8");

// Optional build-time default deployment ("defaultUrl" in package.json):
// when set, first launch skips the welcome prompt and lands directly on
// that deployment's login screen (users can still pick a different
// homeserver inside it, and File → Change server overrides the client).
const DEFAULT_URL = require("../package.json").defaultUrl || null;

// ---- server address ---------------------------------------------------------
// Nothing is hardwired: SABLE_URL env wins, then the saved config; with
// neither, a first-run window asks and stores the answer.

function configFile() {
  return path.join(app.getPath("userData"), "config.json");
}

function savedUrl() {
  // undefined = no config yet (build default may apply);
  // "" = user explicitly asked to choose (Change server…)
  try {
    const url = JSON.parse(fs.readFileSync(configFile(), "utf8")).url;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

function saveUrl(url) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ url }, null, 2) + "\n");
}

// Reachability probe for the welcome screen: any HTTP response below 500
// counts — we only need to know a web server answers there.
async function probeServer(url) {
  const { net } = require("electron");
  try {
    const response = await net.fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 500) return `HTTP ${response.status}`;
    return null;
  } catch (err) {
    return err.cause?.message || err.message || "unreachable";
  }
}

function askForServer() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 380,
      resizable: false,
      autoHideMenuBar: true,
      title: "Sable — connect",
      backgroundColor: "#1a1a1e",
      icon: path.join(__dirname, "icon.png"),
      webPreferences: {
        preload: path.join(__dirname, "setup", "preload.js"),
      },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("setup:submit", onSubmit);
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    const onSubmit = async (event, url) => {
      if (event.sender !== win.webContents) return;
      const problem = await probeServer(url);
      if (settled) return;
      if (problem) {
        if (!win.isDestroyed()) win.webContents.send("setup:error", problem);
        return;
      }
      finish(url);
    };
    ipcMain.on("setup:submit", onSubmit);
    win.once("closed", () => finish(null));
    win.loadFile(path.join(__dirname, "setup", "setup.html"));
  });
}

// ---- venmic: per-application audio on Linux/PipeWire ----------------------

let bay = null;
let venmicBroken = false;

function venmic() {
  if (process.platform !== "linux" || venmicBroken) return null;
  if (bay === null) {
    try {
      // Source-built addon vendored at build time (see README) — the
      // @vencord/venmic npm package itself is only a devDependency.
      const { PatchBay } = require(path.join(__dirname, "..", "vendor", "venmic"));
      if (!PatchBay.hasPipeWire()) throw new Error("PipeWire is not running");
      bay = new PatchBay();
    } catch (err) {
      console.warn("[share] per-app audio unavailable:", err.message);
      venmicBroken = true;
      return null;
    }
  }
  return bay;
}

// Our own audio must never be captured (echo): venmic filters it out by
// the renderer Audio Service pid, same trick Vesktop uses.
function audioServicePid() {
  return (
    app
      .getAppMetrics()
      .find((proc) => proc.name === "Audio Service")
      ?.pid?.toString() ?? "-"
  );
}

function venmicExcludes() {
  return [
    { "application.process.id": audioServicePid() },
    // Never capture other capture streams (microphones etc.)
    { "media.class": "Stream/Input/Audio" },
  ];
}

// Apps seen producing audio since launch. Streams are ephemeral (Chromium
// drops its stream seconds after pausing), but venmic links by properties,
// so an "idle" app is still a valid pick — audio starts when it plays.
const seenAudioApps = new Set();

function listAudioApps() {
  const pb = venmic();
  if (!pb) return null; // feature unavailable
  try {
    const pid = audioServicePid();
    const nodes = pb.list(["node.name", "application.name", "application.process.id", "media.class"]);
    const live = new Set();
    for (const node of nodes) {
      if (node["application.process.id"] === pid) continue;
      if (node["media.class"] === "Stream/Input/Audio") continue;
      const name = node["application.name"] || node["node.name"];
      if (!name) continue;
      // Background services that keep permanently-registered (and silent)
      // streams — noise in a "what do you want to share" list.
      if (/^speech-dispatcher/i.test(name) || name === "sd_dummy") continue;
      live.add(name);
      seenAudioApps.add(name);
    }
    return [...seenAudioApps].map((name) => ({ name, live: live.has(name) }));
  } catch (err) {
    console.warn("[share] venmic list failed:", err.message);
    return null;
  }
}

function startPidAudio(pid, klass) {
  const pb = venmic();
  if (!pb) return false;
  // Match by process id AND by the window class/app name: apps can own
  // several streams and some carry no process props at all (TF2's active
  // stream, for one) — any of these keys hitting links the stream.
  const include = [{ "application.process.id": String(pid) }];
  if (klass) {
    include.push({ "application.name": klass }, { "node.name": klass });
  }
  try {
    return pb.link({
      include,
      exclude: venmicExcludes(),
      ignore_devices: true,
      only_speakers: false,
      only_default_speakers: false,
    });
  } catch (err) {
    console.warn("[share] venmic link failed:", err.message);
    return false;
  }
}

function startAppAudio(appName) {
  const pb = venmic();
  if (!pb) return false;
  try {
    return pb.link({
      // Either prop may carry the app's name depending on the client
      include: [{ "application.name": appName }, { "node.name": appName }],
      exclude: venmicExcludes(),
      ignore_devices: true,
      // Don't require the app to play to the default speaker — the user
      // picked it explicitly, capture it wherever it plays.
      only_speakers: false,
      only_default_speakers: false,
    });
  } catch (err) {
    console.warn("[share] venmic link failed:", err.message);
    return false;
  }
}

function startSystemAudio() {
  const pb = venmic();
  if (!pb) return false;
  try {
    return pb.link({
      include: [],
      exclude: venmicExcludes(),
      ignore_devices: true,
      only_speakers: true,
      only_default_speakers: false,
    });
  } catch (err) {
    console.warn("[share] venmic link failed:", err.message);
    return false;
  }
}

function stopAudio() {
  try {
    if (bay) bay.unlink();
  } catch {
    /* not linked */
  }
}

// ---- graphical share picker ------------------------------------------------

// What the current/last share does about audio; the renderer patch asks for
// this after getDisplayMedia resolves ('venmic' = attach the virtual mic).
let audioPlan = "none";

function runPicker(parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 760,
      height: 600,
      resizable: false,
      minimizable: false,
      autoHideMenuBar: true,
      title: "Share your screen",
      backgroundColor: "#1a1a1e",
      webPreferences: {
        preload: path.join(__dirname, "picker", "preload.js"),
      },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("picker:submit", onSubmit);
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    const onSubmit = (event, choice) => {
      if (event.sender === win.webContents) finish(choice);
    };
    ipcMain.on("picker:submit", onSubmit);
    win.once("closed", () => finish(null));
    win.loadFile(path.join(__dirname, "picker", "picker.html"));
  });
}

function registerShareHandler(ses, getParent) {
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const choice = await runPicker(getParent());
        if (!choice || !choice.sourceId) {
          callback(null); // user cancelled
          return;
        }

        // Minimized windows can't be captured (they aren't rendered) —
        // restore the picked window first, then capture live frames.
        const nativeWindowId = Number(String(choice.sourceId).split(":")[1]);
        if (choice.sourceId.startsWith("window:") && nativeWindowId) {
          if (process.platform === "win32") {
            await require("./winpid").restoreIfMinimized(nativeWindowId);
          }
        }
        let source = null;
        for (let attempt = 0; attempt < 10 && !source; attempt++) {
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
          });
          source = sources.find((s) => s.id === choice.sourceId) || null;
          if (source) break;
          // Not enumerable yet — on Linux that means it's iconified:
          // EWMH-activate it and give the WM a moment to map it.
          if (process.platform === "linux" && choice.sourceId.startsWith("window:")) {
            await require("./x11pid").activateWindow(nativeWindowId);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!source) {
          console.warn("[share] source never became capturable:", choice.sourceId);
          callback(null);
          return;
        }

        stopAudio();
        audioPlan = "none";
        const streams = { video: source };
        if (choice.audio === "loopback") {
          // Windows system audio EXCLUDING our own output (the call!) —
          // Chromium pseudo-device via WASAPI process loopback, else
          // remote participants hear themselves echoed. Undocumented in
          // Electron but any string passes through as the device id
          // (electron_browser_context.cc's explicit escape hatch);
          // "loopbackWithoutChrome" is a stable Chromium constant.
          // Needs Win10 2004+.
          streams.audio = "loopbackWithoutChrome";
        } else if (choice.audio === "system") {
          if (startSystemAudio()) audioPlan = "venmic";
        } else if (choice.audio && choice.audio.startsWith("pid:")) {
          const [pid, klass] = choice.audio.slice(4).split("|");
          if (process.platform === "win32") {
            // Per-application WASAPI process loopback (includes the app's
            // child processes — browsers play audio in a child). Same
            // Chromium pseudo-device family as loopbackWithoutChrome, and
            // inherently echo-safe: only that app's tree is captured.
            streams.audio = `applicationLoopback:${Number(pid)}`;
          } else if (startPidAudio(Number(pid), klass || null)) {
            audioPlan = "venmic";
          }
        } else if (choice.audio && choice.audio.startsWith("app:")) {
          if (startAppAudio(choice.audio.slice(4))) audioPlan = "venmic";
        }
        console.log("[sable-shell] share:", choice.sourceId, "audio plan:", audioPlan);
        // Deliver the plan to every frame as a plain global — the
        // requesting frame may lack the preload bridge (widget iframes).
        const wc = getParent()?.webContents;
        if (wc) {
          for (const frame of wc.mainFrame.framesInSubtree) {
            frame
              .executeJavaScript(
                `window.__sableSharePlan = ${JSON.stringify(audioPlan)};`
              )
              .catch(() => {});
          }
        }
        callback(streams);
      } catch (err) {
        console.error("[share] picker failed:", err);
        try {
          callback(null);
        } catch {
          /* already called */
        }
      }
    },
    { useSystemPicker: false }
  );
}

// ---- IPC used by the picker window and the injected patch ------------------

ipcMain.handle("picker:sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  const result = sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith("screen") ? "screen" : "window",
    thumbnail: s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    minimized: false,
  }));
  // Chromium's enumerators (X11 and WGC alike) skip minimized windows;
  // list them ourselves as placeholders (picking one restores it at
  // share time).
  try {
    const seen = new Set(result.map((s) => Number(String(s.id).split(":")[1])));
    let extra = [];
    if (process.platform === "linux") {
      extra = (await require("./x11pid").listMinimizedWindows()).map((w) => ({
        nativeId: w.xid,
        title: w.title,
      }));
    } else if (process.platform === "win32") {
      extra = (await require("./winpid").listMinimizedWindows()).map((w) => ({
        nativeId: w.hwnd,
        title: w.title,
      }));
    }
    for (const win of extra) {
      if (seen.has(win.nativeId)) continue;
      result.push({
        id: `window:${win.nativeId}:0`,
        name: win.title,
        kind: "window",
        thumbnail: null,
        icon: null,
        minimized: true,
      });
    }
  } catch (err) {
    console.warn("[share] minimized enumeration failed:", err.message);
  }
  return result;
});

ipcMain.handle("picker:audio-options", () => {
  if (process.platform === "win32") return { kind: "loopback" };
  const apps = listAudioApps();
  if (apps === null) return { kind: "none" };
  return { kind: "venmic", apps };
});

// PID (+ class/process name) of a picked window, for name-free audio
// matching. Linux: X11 _NET_WM_PID; Windows: HWND via PowerShell.
ipcMain.handle("picker:window-audio", async (_event, sourceId) => {
  const parts = String(sourceId).split(":");
  const nativeId = Number(parts[1]);
  if (!nativeId) return null;
  if (process.platform === "linux") {
    return require("./x11pid").windowInfo(nativeId);
  }
  if (process.platform === "win32") {
    return require("./winpid").windowInfo(nativeId);
  }
  return null;
});

ipcMain.handle("share:audio-plan", () => audioPlan);
ipcMain.on("share:ended", () => stopAudio());

// ---- main window ------------------------------------------------------------

// The getDisplayMedia patch must exist in every frame (SableCall runs as an
// embedded iframe); injected into the main world on each frame's dom-ready.
function injectPatch(contents) {
  const inject = (frame) => {
    if (!frame) return;
    frame
      .executeJavaScript(PATCH_JS)
      .then(() => console.log("[sable-shell] patch injected:", frame.url))
      .catch((err) =>
        console.warn("[sable-shell] patch injection FAILED:", frame.url, err.message)
      );
  };
  contents.on("frame-created", (_event, { frame }) => {
    if (frame) frame.once("dom-ready", () => inject(frame));
  });
  contents.on("dom-ready", () => inject(contents.mainFrame));
}

// ---- tray -------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let quitting = false;

function surfaceWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Compositors with focus-stealing prevention (native Wayland) may refuse
  // the raise; request attention until the window actually gets focus.
  if (!win.isFocused()) {
    win.flashFrame(true);
    win.once("focus", () => {
      if (!win.isDestroyed()) win.flashFrame(false);
    });
  }
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) surfaceWindow(mainWindow);
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, "icon.png"))
    .resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip("Sable");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Sable", click: showMainWindow },
      { type: "separator" },
      { role: "quit" },
    ])
  );
  tray.on("click", showMainWindow);
}

function createWindow(appUrl) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    autoHideMenuBar: true,
    backgroundColor: "#1a1a1e",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // the bridge must exist inside the SableCall iframe too
      nodeIntegrationInSubFrames: true,
    },
  });

  // External links go to the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Close hides to the tray; quit via tray menu or File → Quit
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  injectPatch(win.webContents);
  win.loadURL(appUrl);
  return win;
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Change server…",
            click: () => {
              // "" beats the build-time default: forces the prompt
              saveUrl("");
              app.relaunch();
              app.exit(0);
            },
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ])
  );
}

app.whenReady().then(async () => {
  buildMenu();

  const saved = savedUrl();
  let appUrl = process.env.SABLE_URL || saved;
  if (appUrl === undefined) appUrl = DEFAULT_URL; // fresh install only
  if (!appUrl) {
    appUrl = await askForServer();
    if (!appUrl) {
      app.quit(); // window closed without choosing
      return;
    }
    saveUrl(appUrl);
  }

  const ses = session.defaultSession;
  const appOrigin = new URL(appUrl).origin;

  // Mic/camera/capture: allowed for anything this window loaded — the call
  // widget may live on a different origin than the app (elementCallUrl),
  // and requests sometimes arrive without a requestingUrl. External links
  // never render here (they open in the real browser), so "anything
  // loaded" means the app and the widgets it embeds. Everything else
  // stays scoped to the app origin.
  const MEDIA = ["media", "display-capture"];
  const APP_ONLY = [
    "notifications",
    "fullscreen",
    "clipboard-read",
    "clipboard-sanitized-write",
  ];

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (MEDIA.includes(permission)) return callback(true);
    const fromApp = (details.requestingUrl || "").startsWith(appOrigin);
    callback(fromApp && APP_ONLY.includes(permission));
  });
  // Chromium also does synchronous permission *checks* (device labels,
  // permissions.query) — without this handler those can report "denied"
  // even when requests would be granted.
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (MEDIA.includes(permission)) return true;
    return (origin || "").startsWith(appOrigin);
  });

  mainWindow = createWindow(appUrl);
  createTray();
  registerShareHandler(ses, () => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(appUrl);
    } else {
      showMainWindow();
    }
  });
});

app.on("before-quit", () => {
  quitting = true;
  stopAudio();
});

app.on("window-all-closed", () => {
  // reached only while quitting (close otherwise hides to tray)
  app.quit();
});
