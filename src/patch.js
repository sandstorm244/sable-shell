"use strict";

/* Injected into the main world of every frame. Wraps getDisplayMedia so
 * that when the picker chose venmic audio, the virtual PipeWire microphone
 * ("vencord-screen-share", created by venmic in the main process) is
 * attached to the share stream as its audio track — same technique as
 * Vesktop's screenShareFixes. */

(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__sablePatched) return;
  md.__sablePatched = true;
  console.warn("[sable-shell] getDisplayMedia wrapped in", location.href);

  const original = md.getDisplayMedia.bind(md);

  md.getDisplayMedia = async (opts = {}) => {
    // Ensure audio is requested (on Windows the loopback track arrives
    // through the display-media handler). Honor explicit constraint
    // objects from the app (upstream EC/livekit disable processing that
    // way) — but a bare `true` gets Chrome's DEFAULT voice processing,
    // which pumps and gates shared music/game audio, so substitute the
    // processing-off trio in that case.
    const audio =
      opts.audio && typeof opts.audio === "object"
        ? opts.audio
        : {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          };
    const stream = await original({ ...opts, audio });
    try {
      // The plan is pushed into this frame as a plain global by the main
      // process at share time — no preload bridge required (widget
      // iframes may not get one).
      const plan = window.__sableSharePlan || "none";
      if (plan === "venmic") {
        // The virtual node takes a moment to appear in pipewire-pulse
        // after venmic links — poll instead of looking exactly once.
        let virtmic = null;
        for (let attempt = 0; attempt < 12 && !virtmic; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
          const devices = await md.enumerateDevices();
          virtmic = devices.find(
            (d) => d.kind === "audioinput" && d.label === "vencord-screen-share"
          );
        }
        if (virtmic) {
          const mic = await md.getUserMedia({
            audio: {
              deviceId: { exact: virtmic.deviceId },
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
            },
          });
          for (const track of mic.getAudioTracks()) stream.addTrack(track);
          console.warn(
            "[sable-shell] venmic audio attached; stream now has",
            stream.getAudioTracks().length,
            "audio track(s)"
          );
        } else {
          const inputs = (await md.enumerateDevices())
            .filter((d) => d.kind === "audioinput")
            .map((d) => d.label || "(no label)");
          console.warn(
            "[sable-shell] venmic virtual mic not found; audio inputs:",
            JSON.stringify(inputs)
          );
        }
      } else {
        console.warn("[sable-shell] audio plan:", plan);
      }
      const video = stream.getVideoTracks()[0];
      if (video && window.__sableShare) {
        video.addEventListener("ended", () => window.__sableShare.ended(), {
          once: true,
        });
      }
    } catch (err) {
      console.warn("[sable-shell] share audio attach failed:", err);
    }
    return stream;
  };
})();
