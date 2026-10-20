// Start / stop recording (screen via Rust, camera via MediaRecorder).
import { invoke, currentWindow, LogicalPosition } from "../tauri.js";
import { $, state, showError, hooks, anyLoading } from "./state.js";
import { showBar, resizeBar } from "./window.js";
import { closeMenu, isMenuOpen } from "./menu.js";
import { getPreview, openCameraStream, startDrawLoop, syncPreview } from "./preview.js";
import { syncMeters } from "./meters.js";
import { guardAudio } from "./audioguard.js";

let cameraRec = null;
let cameraStartedMs = null;
let micRec = null;
let micStartedMs = null;
let timerHandle = null;
let writeChain = Promise.resolve();
let micChain = Promise.resolve();

/** Record the microphone on its own so its level can be mixed independently of system audio. */
async function startMic() {
  if (!window.MediaRecorder) throw new Error("this web view cannot record audio");
  await guardAudio({ force: true }); // keeps Bluetooth headphones in stereo while the microphone is open
  let deviceId;
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    deviceId = devs.find((d) => state.micName && d.label && d.label.includes(state.micName.slice(0, 10)))?.deviceId;
  } catch {}
  const stream = await Promise.race([
    navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { ideal: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
      video: false,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Microphone timed out")), 8000)),
  ]);
  // Always record two channels: a mono microphone is duplicated to left and right.
  const raw = stream;
  let recStream = raw;
  let ctx = null;
  try {
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const src = ctx.createMediaStreamSource(raw);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    dest.channelCountMode = "explicit";
    dest.channelInterpretation = "speakers";
    // laptop mics record very quietly: lift the level, with a limiter against clipping
    const boost = ctx.createGain();
    boost.gain.value = 4;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    // average the channels (many mics leave one empty) and send the result to both ears
    boost.channelCount = 1;
    boost.channelCountMode = "explicit";
    boost.channelInterpretation = "speakers";
    src.connect(boost).connect(lim).connect(dest);
    recStream = dest.stream;
  } catch {
    ctx?.close?.().catch?.(() => {});
    ctx = null;
    recStream = raw;
  }
  const handle = {
    getTracks: () => [
      ...raw.getTracks(),
      { stop: () => ctx?.close?.().catch?.(() => {}) },
    ],
  };
  const mime = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  let rec;
  try {
    rec = new MediaRecorder(recStream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : {});
  } catch (e) {
    handle.getTracks().forEach((t) => t.stop());
    throw e;
  }
  return { stream: handle, rec, ext: mime.includes("mp4") ? "m4a" : "webm" };
}

async function startCamera() {
  if (!window.MediaRecorder) throw new Error("this web view cannot record camera video");
  const shared = getPreview();
  const stream = shared || (await openCameraStream());
  const candidates = [
    ["video/mp4;codecs=avc1", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm", "webm"],
  ];
  const pick = candidates.find(([m]) => MediaRecorder.isTypeSupported(m)) || ["", "webm"];
  let rec;
  try {
    rec = new MediaRecorder(stream, pick[0] ? { mimeType: pick[0], videoBitsPerSecond: 6_000_000 } : {});
  } catch (e) {
    if (!shared) stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  return { stream, rec, ext: pick[1], shared: !!shared };
}

async function ensurePermissions() {
  const p = await invoke("permission_status");
  if (!p.screen) {
    await invoke("show_permissions");
    return false;
  }
  if (state.camera && ["denied", "restricted"].includes(p.camera)) {
    showError("Camera access is off. Open Permissions from the menu-bar icon to fix it.");
    return false;
  }
  if (state.mic && ["denied", "restricted"].includes(p.microphone)) {
    showError("Microphone access is off. Open Permissions from the menu-bar icon to fix it.");
    return false;
  }
  return true;
}

export async function beginRecording() {
  if (state.phase !== "idle") return;
  if (anyLoading()) return; // inputs are still starting up
  if (!(await ensurePermissions())) return;
  if (isMenuOpen()) await closeMenu();
  if (state.mode === "window" && !state.windowId) return hooks.chooseMode("window");
  if (state.mode === "area" && !state.area) return hooks.chooseMode("area");

  let cam = null;
  let cameraNote = "";
  if (state.camera) {
    try {
      cam = await startCamera();
    } catch (e) {
      cameraNote = `Camera unavailable (${e?.message || e}) — recording without it.`;
    }
  }

  let mic = null;
  if (state.mic) {
    try {
      mic = await startMic();
    } catch (e) {
      cameraNote += (cameraNote ? " " : "") + `Microphone unavailable (${e?.message || e}).`;
    }
  }

  state.phase = "countdown";
  const run = ++countdownRun;
  document.body.classList.add("countdown");
  $("hudLeft").style.display = "none";
  // during the countdown the Stop button becomes Cancel (Escape does the same)
  $("btnStop").textContent = "Cancel";
  $("btnStop").style.display = "block";
  $("count").style.display = "block";
  $("count").style.width = "auto";
  $("count").style.flex = "1";
  await resizeBar(240, 60);
  const cancelled = () => run !== countdownRun || state.phase !== "countdown";
  for (let i = 3; i > 0; i--) {
    $("count").textContent = String(i);
    for (let w = 0; w < 10 && !cancelled(); w++) await new Promise((r) => setTimeout(r, 100));
    if (cancelled()) {
      if (cam && !cam.shared) cam.stream.getTracks().forEach((t) => t.stop());
      mic?.stream.getTracks().forEach((t) => t.stop());
      return;
    }
  }
  $("count").style.display = "none";
  $("btnStop").textContent = "Stop";
  $("btnStop").style.display = "none";

  try {
    await invoke("start_recording", {
      args: {
        mode: state.mode,
        displayId: state.displayId,
        windowId: state.mode === "window" ? state.windowId : null,
        area: state.mode === "area" ? state.area : null,
        systemAudio: state.sys,
        microphone: false, // the mic is recorded separately (see startMic)
        microphoneId: null,
        fps: state.fps,
        maxLongSide: state.resolution || null,
      },
    });
  } catch (e) {
    if (cam && !cam.shared) cam.stream.getTracks().forEach((t) => t.stop());
    mic?.stream.getTracks().forEach((t) => t.stop());
    showError(String(e));
    return resetUI();
  }

  if (mic) {
    await invoke("mic_begin", { ext: mic.ext });
    mic.rec.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      micChain = micChain.then(async () => invoke("mic_chunk", await ev.data.arrayBuffer()));
    };
    micStartedMs = Date.now();
    mic.rec.start(500);
    micRec = mic;
  }

  if (cam) {
    await invoke("camera_begin", { ext: cam.ext });
    cam.rec.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      writeChain = writeChain.then(async () => invoke("camera_chunk", await ev.data.arrayBuffer()));
    };
    cameraStartedMs = Date.now();
    cam.rec.start(500);
    cameraRec = cam;
    if (!cam.shared) {
      $("camSrc").srcObject = cam.stream;
      $("camSrc").play().catch(() => {});
      startDrawLoop();
    }
    $("hudCam").classList.add("on");
    document.body.classList.add("hudcam");
  } else {
    $("hudCam").classList.remove("on");
    document.body.classList.remove("hudcam");
  }

  state.phase = "recording";
  if (cameraNote) showError(cameraNote);
  document.body.classList.remove("countdown");
  document.body.classList.add("hud");
  $("hudLeft").style.display = "flex";
  $("btnStop").style.display = "block";
  await resizeBar(...hudSize(!!cam));
  await placeHudNearArea();
  const t0 = performance.now();
  const paint = () => {
    const s = Math.floor((performance.now() - t0) / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    $("timer").textContent = t;
    invoke("set_tray_recording", { active: true, title: `● ${t}` }).catch(() => {});
  };
  paint();
  timerHandle = setInterval(paint, 1000);
  if (state.mode === "area" && state.area) {
    invoke("show_area_frame", { rect: state.area, displayId: state.displayId, style: "rec" }).catch(() => {});
  }
}

/** In area mode the Stop HUD sits just outside the area's border, where you are looking. */
async function placeHudNearArea() {
  if (state.mode !== "area" || !state.area) return;
  try {
    const a = state.area;
    const [w, h] = hudSize(!!cameraRec), gap = 10;
    const srcs = state.sources?.displays || [];
    const d = srcs.find((x) => x.id === state.displayId) || srcs[0];
    const top = d ? d.y : 0, bottom = d ? d.y + d.height : 1080;
    let y = a.y + a.height + gap;
    if (y + h > bottom - 4) y = a.y - h - gap;           // no room below: above the area
    if (y < top + 4) y = a.y + a.height - h - gap;       // no room either side: inside, bottom edge
    const x = Math.max((d ? d.x : 0) + 4, a.x + a.width - w);
    await currentWindow().setPosition(new LogicalPosition(x, y));
  } catch {}
}

let countdownRun = 0;

/** Stop a MediaRecorder and wait for it, without ever hanging (it may already be inactive). */
function stopRecorder(rec) {
  return new Promise((res) => {
    if (!rec || rec.state === "inactive") return res();
    const done = setTimeout(res, 4000);
    rec.onstop = () => { clearTimeout(done); res(); };
    try { rec.stop(); } catch { clearTimeout(done); res(); }
  });
}

/** Stop the camera and microphone recorders and flush their chunks. Never throws. */
/** Recording HUD window size: compact, or tall enough for the big camera preview on the left
 *  (the discard confirmation hides the preview, so it stays compact). */
const hudSize = (cam, confirm = false) => (confirm ? [420, 60] : cam ? [520, 188] : [340, 60]);

async function stopSideRecorders() {
  try {
    if (cameraRec) {
      await stopRecorder(cameraRec.rec);
      if (!cameraRec.shared) cameraRec.stream.getTracks().forEach((t) => t.stop());
      $("hudCam").classList.remove("on");
      document.body.classList.remove("hudcam");
      await writeChain;
    }
  } catch {}
  try {
    if (micRec) {
      await stopRecorder(micRec.rec);
      micRec.stream.getTracks().forEach((t) => t.stop());
      await micChain;
    }
  } catch {}
}

function endRecordingUi() {
  clearInterval(timerHandle);
  document.body.classList.remove("confirm");
  invoke("set_tray_recording", { active: false, title: "" }).catch(() => {});
  invoke("hide_area_frame").catch(() => {});
}

export async function finishRecording() {
  if (state.phase === "countdown") {
    // cancel before anything was started
    countdownRun++;
    state.phase = "idle";
    $("btnStop").textContent = "Stop";
    $("count").style.flex = "";
    $("count").style.width = "";
    return resetUI();
  }
  if (state.phase !== "recording") return;
  state.phase = "finishing";
  clearInterval(timerHandle);
  $("timer").textContent = "Saving…";
  await stopSideRecorders();
  let dir = null;
  try {
    dir = await invoke("stop_recording", {
      cameraStartedUnixMs: cameraRec ? cameraStartedMs : null,
      micStartedUnixMs: micRec ? micStartedMs : null,
    });
  } catch (e) {
    showError(`Could not stop the recording: ${e}`);
  }
  cameraRec = null;
  micRec = null;
  endRecordingUi();
  if (dir) {
    try { await invoke("open_editor", { dir }); } catch (e) { showError(String(e)); }
  }
  resetUI();
}

/** Scrap the recording: stop everything and delete the project. Asks first (see btnTrash). */
export async function discardRecording() {
  if (state.phase !== "recording") return;
  state.phase = "finishing";
  clearInterval(timerHandle);
  document.body.classList.remove("confirm");
  $("timer").textContent = "Discarding…";
  await resizeBar(...hudSize(!!cameraRec));
  await stopSideRecorders();
  try {
    const dir = await invoke("stop_recording", { cameraStartedUnixMs: null, micStartedUnixMs: null });
    if (dir) await invoke("discard_project", { dir });
  } catch (e) {
    showError(`Could not discard the recording: ${e}`);
  }
  cameraRec = null;
  micRec = null;
  endRecordingUi();
  resetUI();
}

/** Ask before scrapping: the HUD turns into a small confirmation. */
export async function askDiscard() {
  if (state.phase !== "recording") return;
  document.body.classList.add("confirm");
  await resizeBar(...hudSize(!!cameraRec, true));
}
export async function cancelDiscard() {
  document.body.classList.remove("confirm");
  await resizeBar(...hudSize(!!cameraRec));
}

async function resetUI() {
  state.phase = "idle";
  document.body.classList.remove("hud", "countdown");
  $("timer").textContent = "0:00";
  $("hudLeft").style.display = "flex";
  $("btnStop").style.display = "block";
  $("count").style.display = "none";
  await showBar();
  hooks.render();
  syncPreview();
  syncMeters();
}
