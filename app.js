// Fingerprint to confirm the file actually loaded
console.log("BOOT FINGERPRINT", new Date().toISOString(), import.meta.url);

import {
  FaceLandmarker,
  FilesetResolver,
} from "./vendor/tasks-vision/vision_bundle.js";

/* ---------- Config (match your local file structure) ---------- */
const WASM_ROOT = "./vendor/tasks-vision/wasm"; // from @mediapipe/tasks-vision/wasm
const MODEL_TASK_URL = "./assets/face_landmarker.task"; // your local task file

/* ---------- DOM ---------- */
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const btnCamera = document.getElementById("btnCamera");
const emojiList = document.getElementById("emojiList");
const currentEmojiEl = document.getElementById("currentEmoji");

/* ---------- State ---------- */
let video = null;
let landmarker = null;
let modelReady = false;
let running = false;
let lastEmoji = "😐";

/* ---------- Expressions / Emojis ---------- */
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

/* ---------- Helpers ---------- */
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

// Ensure the canvas internal pixel buffer matches displayed size (HiDPI crisp)
function resizeCanvasToContainer() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(1, Math.floor(canvas.clientWidth));
  const cssH = Math.max(1, Math.floor(canvas.clientHeight));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
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

  // Clear to black to prevent ghosting on resizes
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  ctx.drawImage(videoEl, dx, dy, dw, dh);
}

// Placeholder (same space before/after start → no layout shift)
function drawPlaceholder() {
  const cw = canvas.clientWidth,
    ch = canvas.clientHeight;

  const grad = ctx.createLinearGradient(0, 0, cw, ch);
  grad.addColorStop(0, "rgba(18, 22, 32, 0.95)");
  grad.addColorStop(1, "rgba(28, 34, 48, 0.95)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);

  ctx.fillStyle = "#c9d2e3";
  ctx.font = "16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Camera is off", cw / 2, ch / 2 - 12);

  ctx.font = "14px system-ui, sans-serif";
  ctx.fillStyle = "#9aa5b5";
  ctx.fillText("Click “Turn Camera On” to start", cw / 2, ch / 2 + 10);
}

// Compatibility wrapper for camera
async function getUserMediaCompat(constraints) {
  if (navigator.mediaDevices?.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacy =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia;
  if (legacy) {
    return new Promise((res, rej) =>
      legacy.call(navigator, constraints, res, rej)
    );
  }
  throw new Error(
    "Camera API unavailable. Use HTTPS (or localhost) in a modern browser."
  );
}

/* ---------- Model & Camera ---------- */
async function ensureModel() {
  if (modelReady && landmarker) return;
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_TASK_URL },
    runningMode: "VIDEO",
    outputFaceBlendshapes: true,
    numFaces: 1,
  });
  modelReady = true;
}

async function startCamera() {
  await ensureModel();

  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true;

  const stream = await getUserMediaCompat({ video: true, audio: false });
  v.srcObject = stream;

  await new Promise((res) =>
    v.addEventListener("loadedmetadata", res, { once: true })
  );
  await v.play();

  video = v;
  running = true;

  resizeCanvasToContainer();
  loop(); // kick off render
}

function stopCamera() {
  running = false;

  if (video?.srcObject) {
    try {
      const tracks = video.srcObject.getTracks();
      tracks.forEach((t) => t.stop());
    } catch {}
  }
  video = null;

  resizeCanvasToContainer();
  drawPlaceholder();

  lastEmoji = EMOJI_SET.neutral;
  currentEmojiEl.textContent = lastEmoji;
}

/* ---------- Main loop ---------- */
function loop() {
  if (!running) return;

  const t = nowMs();

  if (video && landmarker) {
    drawVideoContained(video);

    const res = landmarker.detectForVideo(video, t);
    const blend = blendMap(res?.faceBlendshapes?.[0]);
    const emoji = pickEmoji(blend);
    lastEmoji = emoji;

    // Only update the right-side box (no overlay on canvas)
    currentEmojiEl.textContent = emoji;
  }

  requestAnimationFrame(loop);
}

/* ---------- UI wiring ---------- */
function setCameraButton(on) {
  if (on) {
    btnCamera.classList.remove("off");
    btnCamera.classList.add("on");
    btnCamera.setAttribute("aria-pressed", "true");
    btnCamera.textContent = "Turn Camera Off";
  } else {
    btnCamera.classList.remove("on");
    btnCamera.classList.add("off");
    btnCamera.setAttribute("aria-pressed", "false");
    btnCamera.textContent = "Turn Camera On";
  }
}

btnCamera.onclick = async () => {
  btnCamera.disabled = true;
  try {
    if (!running) {
      if (!location.origin.startsWith("http")) {
        throw new Error("Run on http(s), not file://");
      }
      await startCamera();
      setCameraButton(true);
    } else {
      stopCamera();
      setCameraButton(false);
    }
  } catch (e) {
    console.error("Camera toggle failed:", e);
    alert("Camera/model failed to start.\nReason: " + (e?.message || e));
    setCameraButton(false);
  } finally {
    btnCamera.disabled = false;
  }
};

/* ---------- Populate emoji list ---------- */
(function renderEmojiList() {
  const frag = document.createDocumentFragment();
  for (const [name, glyph] of Object.entries(EMOJI_SET)) {
    const span = document.createElement("span");
    span.className = "emoji-chip";
    span.title = name;
    span.textContent = glyph;
    frag.appendChild(span);
  }
  emojiList.appendChild(frag);
})();

/* ---------- Initial sizing & placeholder ---------- */
window.addEventListener("resize", () => {
  resizeCanvasToContainer();
  if (!running) drawPlaceholder();
});
resizeCanvasToContainer();
drawPlaceholder();
currentEmojiEl.textContent = lastEmoji;
