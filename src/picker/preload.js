"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pickerAPI", {
  sources: () => ipcRenderer.invoke("picker:sources"),
  audioOptions: () => ipcRenderer.invoke("picker:audio-options"),
  windowAudio: (sourceId) => ipcRenderer.invoke("picker:window-audio", sourceId),
  submit: (choice) => ipcRenderer.send("picker:submit", choice),
});
