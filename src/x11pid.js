"use strict";

/* X11 helpers (pure-JS client, npm: x11; Linux only, fails soft):
 *  - windowInfo(xid): owning pid + WM_CLASS, to match a picked window to
 *    its PipeWire streams by application.process.id (host pids on both
 *    sides, works from inside the flatpak).
 *  - listMinimizedWindows(): iconified windows, which Chromium's
 *    enumerator skips — shown as placeholder tiles in the picker.
 *  - activateWindow(xid): EWMH _NET_ACTIVE_WINDOW restore, so picking a
 *    minimized window un-minimizes it and capture starts on live frames.
 * Properties are read as raw bytes (no Xutf8 conversion — immune to the
 * locale trap that hides SDL windows from webrtc). */

let clientPromise = null;

function getDisplay() {
  if (!clientPromise) {
    clientPromise = new Promise((resolve, reject) => {
      const client = require("x11").createClient((err, dpy) => {
        if (err) reject(err);
        else resolve(dpy);
      });
      client.on("error", () => {}); // dead-window queries etc.
    }).catch((err) => {
      console.warn("[share] X11 client unavailable:", err.message);
      return null;
    });
  }
  return clientPromise;
}

const atomCache = new Map();
function atom(X, name) {
  if (!atomCache.has(name)) {
    atomCache.set(
      name,
      new Promise((resolve) => {
        X.InternAtom(false, name, (err, a) => resolve(err ? null : a));
      })
    );
  }
  return atomCache.get(name);
}

function getProperty(X, wid, name) {
  return new Promise((resolve) => {
    atom(X, name).then((a) => {
      if (!a) return resolve(null);
      // type 0 = AnyPropertyType
      X.GetProperty(0, wid, a, 0, 0, 1 << 16, (err, prop) => {
        if (err || !prop || !prop.data || prop.data.length === 0) {
          return resolve(null);
        }
        resolve(prop);
      });
    });
  });
}

function uint32s(buffer) {
  const out = [];
  for (let i = 0; i + 4 <= buffer.length; i += 4) out.push(buffer.readUInt32LE(i));
  return out;
}

/** @returns {Promise<{pid: number|null, klass: string|null}|null>} */
async function windowInfo(xid) {
  const dpy = await getDisplay();
  if (!dpy) return null;
  const X = dpy.client;
  try {
    const pidProp = await getProperty(X, xid, "_NET_WM_PID");
    const clsProp = await getProperty(X, xid, "WM_CLASS");
    const pid =
      pidProp && pidProp.data.length >= 4 ? pidProp.data.readUInt32LE(0) : null;
    let klass = null;
    if (clsProp) {
      const parts = clsProp.data.toString("latin1").split("\0").filter(Boolean);
      klass = parts[1] || parts[0] || null;
    }
    return { pid, klass };
  } catch (err) {
    console.warn("[share] window info failed:", err.message);
    return null;
  }
}

async function windowTitle(X, xid) {
  const net = await getProperty(X, xid, "_NET_WM_NAME");
  if (net) return net.data.toString("utf8");
  const legacy = await getProperty(X, xid, "WM_NAME");
  if (legacy) return legacy.data.toString("utf8");
  return null;
}

/** Iconified, taskbar-worthy windows across all X screens.
 * @returns {Promise<Array<{xid:number,title:string}>>} */
async function listMinimizedWindows() {
  const dpy = await getDisplay();
  if (!dpy) return [];
  const X = dpy.client;
  const results = [];
  try {
    const typeNormal = await atom(X, "_NET_WM_WINDOW_TYPE_NORMAL");
    const skipTaskbar = await atom(X, "_NET_WM_STATE_SKIP_TASKBAR");
    for (const screen of dpy.screen) {
      const list = await getProperty(X, screen.root, "_NET_CLIENT_LIST");
      if (!list) continue;
      for (const xid of uint32s(list.data)) {
        const wmState = await getProperty(X, xid, "WM_STATE");
        // WM_STATE state field: 1 = Normal, 3 = Iconic
        if (!wmState || wmState.data.readUInt32LE(0) !== 3) continue;
        const type = await getProperty(X, xid, "_NET_WM_WINDOW_TYPE");
        if (type && !uint32s(type.data).includes(typeNormal)) continue;
        const state = await getProperty(X, xid, "_NET_WM_STATE");
        if (state && uint32s(state.data).includes(skipTaskbar)) continue;
        const title = await windowTitle(X, xid);
        if (title) results.push({ xid, title });
      }
    }
  } catch (err) {
    console.warn("[share] minimized-window listing failed:", err.message);
  }
  return results;
}

/** EWMH-activate (restore + raise + focus) a window. */
async function activateWindow(xid) {
  const dpy = await getDisplay();
  if (!dpy) return false;
  const X = dpy.client;
  try {
    const active = await atom(X, "_NET_ACTIVE_WINDOW");
    if (!active) return false;
    for (const screen of dpy.screen) {
      const event = Buffer.alloc(32);
      event.writeUInt8(33, 0); // ClientMessage
      event.writeUInt8(32, 1); // format 32
      event.writeUInt32LE(xid, 4);
      event.writeUInt32LE(active, 8);
      event.writeUInt32LE(1, 12); // source indication: application
      // SubstructureRedirect | SubstructureNotify
      X.SendEvent(screen.root, 0, 0x180000, event);
    }
    return true;
  } catch (err) {
    console.warn("[share] activate failed:", err.message);
    return false;
  }
}

module.exports = { windowInfo, listMinimizedWindows, activateWindow };
