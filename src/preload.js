"use strict";

/* Runs in every frame of the web app (nodeIntegrationInSubFrames). Exposes
 * the minimal bridge the injected getDisplayMedia patch needs — nothing
 * else from the shell is reachable by page code. */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__sableShare", {
  // 'venmic' | 'loopback' | 'none' — decided by the picker for this share
  audioPlan: () => ipcRenderer.invoke("share:audio-plan"),
  // called when the share's video track ends, so venmic can unlink
  ended: () => ipcRenderer.send("share:ended"),
});
