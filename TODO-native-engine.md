# native-engine: faster underneath, identical on top

Goal: keep the 0.3 look, feel, flow and every feature (Tauri + web UI, WebView2 and all).
Replace slow or fragile internals with the native Rust engines already built on the
`native-egui` branch. No visual or UX change. Do not merge to `main` until the owner says so.

## Ground rules
- The web UI (`ui/`) stays. Changes happen behind existing Tauri commands in `src-tauri`.
- Every swap is opt-in behind a setting or env var first, compared against the old path,
  and only becomes default when output and speed are verified.
- Reuse crates from `native-egui` (cherry-pick or copy): `crates/encode`, `crates/audio`,
  `crates/capture`, `crates/engine`, `crates/render`.

## Candidate swaps, roughly by value / risk

1. **Preview without a proxy** (high value, medium risk)
   Replace the JPEG proxy strip (2-3 MB per second of disk, a "Preparing preview" wait)
   with direct H.264 decode (`screencraft-engine::VideoSource`, OpenH264 / VideoToolbox)
   served over the existing `sc://` frame scheme. Keep the proxy as a fallback for HEVC.
2. **Export pipeline in Rust** (high value, higher risk)
   Today: web canvas paint + WebCodecs + JS mp4 muxer. Option A: keep the canvas compositor
   but feed it from the native decoder (cheap win). Option B: move compositing to the wgpu
   shader (`crates/render`). Needs parity for everything the canvas draws: annotations,
   captions, key display, device frames, transitions, camera bubble, watermark, motion blur.
   Do A first; B only per-feature as the shader gains parity.
3. **Muxing / codecs** (medium value, low risk)
   Swap the bundled JS muxer for the sans-I/O MP4 / WebM muxers; add AV1 / VP9 / WebM
   export options as extra entries in the existing Codec row. Keep H.264 / HEVC / GIF.
4. **Recording path** (medium value, medium risk)
   Keep SCRecordingOutput on macOS if it is already hardware-fast; evaluate the raw-frame
   `Capturer` + VideoToolbox path for constant frame rate and separate time-aligned audio
   tracks. On Windows evaluate DXGI Desktop Duplication vs the current WGC.
5. **Audio** (medium value, low risk)
   `StreamAligner` for mic / system sync and drift; keep the current leveling and ducking.
6. **Compressor and GIF** (low risk)
   Compressor: re-encode with the native pipeline instead of AVFoundation-only (also gives
   Windows a compressor). GIF: native quantiser/encoder in place of the JS gifenc.
7. **Captions** (already native: whisper.cpp). Nothing to do beyond audio decode reuse.
8. **Linux** (new platform, optional)
   PipeWire / portal capture exists on `native-egui`; the web UI would need WebKitGTK.
   Parked unless wanted.

## Not changing
Window chrome, panels, rail, timeline, colours, fonts, shortcuts, project format
(`.screencraft`, `project.json`), updater flow, installers.

## First steps when we start
- [ ] Add the reusable crates to the workspace and make `src-tauri` depend on them.
- [ ] Add a benchmark harness: open / scrub / export time on 1 min 1440p and 10 min 1080p
      recordings, old vs new path.
- [ ] Ship swap 1 (native preview frames) behind a setting.
- [ ] Re-measure, then decide the export plan (2A vs 2B).
