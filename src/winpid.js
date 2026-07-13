"use strict";

/* Windows window helpers, backed by the bundled sable-winhelper.exe
 * (compiled at build time from win/helper.cs — see README). No runtime
 * PowerShell: EDR heuristics flag script-host P/Invoke, a static helper
 * binary making plain user32 calls is what normal desktop apps look like.
 *
 *  - windowInfo(hwnd): owning pid + process name, for per-application
 *    audio capture via the applicationLoopback:<pid> pseudo-device.
 *  - restoreIfMinimized(hwnd): SW_RESTORE before capture starts.
 *  - listMinimizedWindows(): iconified windows Chromium's enumerator
 *    skips, shown as placeholder tiles. */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

function helperPath() {
  const packaged = path.join(
    process.resourcesPath || "",
    "winhelper",
    "sable-winhelper.exe"
  );
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  // dev run from the repo
  return path.join(__dirname, "..", "build-res", "win", "sable-winhelper.exe");
}

function helper(args) {
  return new Promise((resolve) => {
    execFile(
      helperPath(),
      args,
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          console.warn("[share] winhelper failed:", err.message);
          return resolve(null);
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

const cache = new Map();

async function windowInfo(hwnd) {
  if (cache.has(hwnd)) return cache.get(hwnd);
  const out = await helper(["info", String(Number(hwnd))]);
  if (out === null) return null;
  const [pid, name] = out.split("|");
  const result = Number(pid) ? { pid: Number(pid), klass: name || null } : null;
  cache.set(hwnd, result);
  return result;
}

/** Restore the window if minimized (SW_RESTORE), so capture starts on
 * live frames instead of nothing. Returns once done. */
async function restoreIfMinimized(hwnd) {
  const out = await helper(["restore", String(Number(hwnd))]);
  return out === "restored";
}

/** Minimized top-level windows (Chromium's WGC enumerator skips them).
 * @returns {Promise<Array<{hwnd:number,title:string}>>} */
async function listMinimizedWindows() {
  const out = await helper(["list"]);
  if (out === null) return [];
  const windows = [];
  for (const line of out.split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 1) continue;
    const hwnd = Number(line.slice(0, sep));
    const title = line.slice(sep + 1).trim();
    if (hwnd && title) windows.push({ hwnd, title });
  }
  return windows;
}

module.exports = { windowInfo, restoreIfMinimized, listMinimizedWindows };
