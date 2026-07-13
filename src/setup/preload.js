"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setupAPI", {
  submit: (url) => ipcRenderer.send("setup:submit", url),
  onError: (callback) =>
    ipcRenderer.on("setup:error", (_event, message) => callback(message)),
});
