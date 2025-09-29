// Fingerprint to confirm the file actually loaded
console.log("BOOT FINGERPRINT", new Date().toISOString(), import.meta.url);

import {
  FaceLandmarker,
  FilesetResolver,
} from "./vendor/tasks-vision/vision_bundle.js";

/* ---------- Config (match your local file structure) ---------- */
const WASM_ROOT = "./vendor/tasks-vision/wasm"; // folder copied from @mediapipe/tasks-vision/wasm
const MODEL_TASK_URL = "./assets/face_landmarker.task"; // your local task file

/* ---------- DOM ---------- */
const app = document.getElementById("app");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const btnStart = document.getElementById("btnStart");
const btnFS = document.getElementById("btnFS");
const controls = document.getElementById("controls");
const tips = document.getElementById("tips");

/* ---------- State ---------- */
let video = null;
let landmarker = null;
let running = false;

/* ---------- Emoji logic (no calibration) ---------- */
const EMOJI_SET = {
  neutral: "😐",
  smile: "🙂",
  surprise: "😮",
  frown: "😡",
  cheeky: "😜",
};
const EMOTION_THRESHOLDS = {
  smile: 0.25,
  surprise: 0.28,
  frown: 0.2,
  cheeky: 0.22,
};
const nowMs = () => performance.now();

function blendMap(blend) {
  const out = {};
  for (const c of blend?.categories ?? []) out[c.categoryName] = c.score;
  return out;
}

function pickEmoji(blend) {
  if (!blend) return EMOJI_SET.neutral;
  const get = (k) => blend[k] ?? 0;

  const expressionScores = {
    smile: Math.max(get("mouthSmileLeft"), get("mouthSmileRight")),
    surprise: get("jawOpen") * 0.9 + get("mouthPucker") * 0.4,
    frown: Math.max(get("mouthFrownLeft"), get("mouthFrownRight")),
    cheeky:
      Math.max(get("cheekPuffLeft"), get("cheekPuffRight")) + get("tongueOut"),
  };

  let best = "neutral",
    bestScore = 0.15;
  for (const [name, score] of Object.entries(expressionScores)) {
    const th = EMOTION_THRESHOLDS[name];
    if (score > th && score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return EMOJI_SET[best];
}

/* ---------- Sizing & drawing helpers ---------- */
// Ensure the canvas's internal pixel buffer matches its displayed CSS size (HiDPI crisp)
function resizeCanvasToContainer() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(1, Math.floor(canvas.clientWidth));
  const cssH = Math.max(1, Math.floor(canvas.clientHeight));

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  // Draw in CSS pixels by scaling the context
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}

// Draw the video letterboxed within the canvas (no distortion)
function drawVideoContained(videoEl) {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const ar = (videoEl.videoWidth || 16) / (videoEl.videoHeight || 9);

  let dw = cw;
  let dh = dw / ar;
  if (dh > ch) {
    dh = ch;
    dw = dh * ar;
  }

  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;

  ctx.drawImage(videoEl, dx, dy, dw, dh);
}

function drawEmoji(emoji) {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const size = Math.min(cw, ch) * 0.3;
  ctx.font = `${Math.floor(
    size
  )}px system-ui, Apple Color Emoji, Segoe UI Emoji`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, cw / 2, ch / 2 + size * 0.05);
}

/* ---------- Init model & camera ---------- */
async function setupModel() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_TASK_URL },
    runningMode: "VIDEO",
    outputFaceBlendshapes: true,
    numFaces: 1,
  });
}

async function setupCamera() {
  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true;

  // start permissive and let the browser choose the best camera
  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });
  v.srcObject = stream;

  // wait for metadata to ensure correct dimensions
  await new Promise((res) =>
    v.addEventListener("loadedmetadata", res, { once: true })
  );
  await v.play();

  video = v;

  // Sync canvas internal buffer to its displayed size
  resizeCanvasToContainer();
}

/* ---------- Main loop ---------- */
function loop() {
  if (!running) return;
  const t = nowMs();

  if (video && landmarker) {
    // Clear frame (optional: keep as is since we fully cover with video)
    // ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    drawVideoContained(video);
    const res = landmarker.detectForVideo(video, t);
    const blend = blendMap(res?.faceBlendshapes?.[0]);
    drawEmoji(pickEmoji(blend));
  }

  requestAnimationFrame(loop);
}

/* ---------- UI handlers ---------- */
btnStart.onclick = async () => {
  btnStart.disabled = true;
  try {
    if (!location.origin.startsWith("http")) {
      throw new Error("Run on http(s), not file://");
    }
    await setupModel(); // fails if .task/.wasm paths or MIME are wrong
    await setupCamera(); // fails on permissions or device busy
    running = true;
    loop();
  } catch (e) {
    console.error("Init failed:", e);
    alert("Camera/model failed to start.\nReason: " + (e?.message || e));
    btnStart.disabled = false;
  }
};

btnFS.onclick = () => {
  if (!document.fullscreenElement) {
    canvas
      .requestFullscreen()
      .then(resizeCanvasToContainer)
      .catch(() => {});
  } else {
    document
      .exitFullscreen()
      .then(resizeCanvasToContainer)
      .catch(() => {});
  }
};

/* ---------- Resize handling ---------- */
window.addEventListener("resize", () => {
  if (!canvas) return;
  resizeCanvasToContainer();
});
document.addEventListener("fullscreenchange", () => {
  // Recompute canvas buffer when entering/exiting fullscreen
  resizeCanvasToContainer();
});
