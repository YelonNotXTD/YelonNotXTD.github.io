/**
 * 视频区间 → GIF（纯静态版）
 *
 * 流水线全部跑在浏览器里：
 *   <video> 逐帧定位 → canvas / createImageBitmap 裁剪+缩放 → gifenc 编码 GIF
 *
 * 可调参数集中在 config/gif.json，本文件里的 DEFAULTS 只是读取失败时的兜底。
 */
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

const CONFIG_URL = './config/gif.json';

/** config/gif.json 读不到时使用的兜底值（与仓库里的默认配置一致） */
const DEFAULTS = {
  fps: 12,
  maxWidth: 325,
  maxHeight: 325,
  maxDurationSeconds: 3.25,
  maxFileSizeMB: 512,
  minCropSize: 8,
  maxColors: 256,
  optimizeTransparency: true,
  transparencyThreshold: 0.8,
};

const MIN_DURATION = 0.04;
const SEEK_TIMEOUT_MS = 4000;

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), dzHint: $('dzHint'),
  viewer: $('viewer'), frame: $('frame'), video: $('video'), overlay: $('overlay'), rect: $('rect'),
  playBtn: $('playBtn'), scrub: $('scrub'), timeLabel: $('timeLabel'),
  metaInfo: $('metaInfo'), cropInfo: $('cropInfo'), changeFileBtn: $('changeFileBtn'),
  x1: $('x1'), y1: $('y1'), x2: $('x2'), y2: $('y2'), selectAllBtn: $('selectAllBtn'),
  startMin: $('startMin'), startSec: $('startSec'), endMin: $('endMin'), endSec: $('endSec'),
  startNowBtn: $('startNowBtn'), endNowBtn: $('endNowBtn'), loopSel: $('loopSel'),
  mode: $('mode'), size: $('size'), planInfo: $('planInfo'), limitInfo: $('limitInfo'),
  renderBtn: $('renderBtn'), cancelBtn: $('cancelBtn'), status: $('status'),
  progress: $('progress'), progressBar: $('progressBar'), progressText: $('progressText'),
  resultPanel: $('resultPanel'), resultImg: $('resultImg'), resultInfo: $('resultInfo'),
  resultNotes: $('resultNotes'), downloadLink: $('downloadLink'),
};

const state = {
  config: { ...DEFAULTS },
  configLoaded: false,
  file: null,
  videoUrl: null,
  videoWidth: 0,
  videoHeight: 0,
  duration: 0,
  sel: { x: 0, y: 0, w: 0, h: 0 },
  start: 0,
  end: 0,
  mode: 'width',
  size: 325,
  busy: false,
  cancel: false,
  resultUrl: null,
  drag: null,
  raf: 0,
};

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

class Cancelled extends Error {}

function setStatus(text, kind = '') {
  el.status.textContent = text || '';
  el.status.className = `status ${kind}`.trim();
}

/* ---------- 配置 ---------- */

async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    for (const key of Object.keys(DEFAULTS)) {
      const value = raw[key];
      if (typeof DEFAULTS[key] === 'number' && Number.isFinite(Number(value)) && Number(value) > 0) {
        state.config[key] = Number(value);
      } else if (typeof DEFAULTS[key] === 'boolean' && typeof value === 'boolean') {
        state.config[key] = value;
      }
    }
    state.configLoaded = true;
  } catch (err) {
    console.warn(`[config] 读取 ${CONFIG_URL} 失败，使用内置默认值：${err.message}`);
  }
  el.limitInfo.textContent = state.configLoaded
    ? `上限（可在 config/gif.json 调整）：${state.config.maxWidth}×${state.config.maxHeight}px、`
      + `${state.config.maxDurationSeconds}s、${state.config.fps}fps；超出时自动等比缩小 / 截断时长。`
    : `未能读取 config/gif.json，本次使用内置默认值：${DEFAULTS.maxWidth}×${DEFAULTS.maxHeight}px、`
      + `${DEFAULTS.maxDurationSeconds}s、${DEFAULTS.fps}fps。`;
  if (!state.configLoaded) setStatus('未能读取 config/gif.json（用 file:// 直接打开会这样，请通过网站地址访问）', 'warn');
  el.dzHint.textContent = `单个文件不超过 ${state.config.maxFileSizeMB}MB`;
}

/* ---------- 文件与预览 ---------- */

function bindDropzone() {
  const pickFile = () => {
    el.fileInput.value = '';
    el.fileInput.click();
  };
  el.dropzone.addEventListener('click', pickFile);
  el.changeFileBtn.addEventListener('click', pickFile);
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); }
  });
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files?.[0];
    if (file) openFile(file);
  });
  for (const type of ['dragenter', 'dragover']) {
    el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'dragend']) {
    el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('over'));
  }
  el.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  });
}

function openFile(file) {
  const maxBytes = state.config.maxFileSizeMB * 1024 * 1024;
  if (file.size > maxBytes) {
    setStatus(`文件 ${(file.size / 1048576).toFixed(1)}MB 超过上限 ${state.config.maxFileSizeMB}MB`, 'error');
    return;
  }
  if (file.type && !file.type.startsWith('video/')) {
    setStatus('请选择视频文件（如 mp4 / webm / mov）', 'warn');
    return;
  }

  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  el.video.pause();
  state.file = file;
  state.videoUrl = URL.createObjectURL(file);
  el.video.src = state.videoUrl;
  el.video.load();

  el.dropzone.hidden = true;
  el.viewer.hidden = false;
  setStatus('正在读取视频信息…', 'busy');
}

function onMetadata() {
  const video = el.video;
  state.videoWidth = video.videoWidth;
  state.videoHeight = video.videoHeight;
  state.duration = Number.isFinite(video.duration) ? video.duration : 0;

  if (!state.videoWidth || !state.videoHeight || !state.duration) {
    setStatus('无法读取视频分辨率或时长：这个文件可能编码不受浏览器支持，或只有音轨', 'error');
    return;
  }

  const cfg = state.config;
  el.scrub.max = String(state.duration);
  resizeFrame();

  // 默认：整幅画面 + 视频开头 + 上限内的目标宽度
  state.sel = { x: 0, y: 0, w: state.videoWidth, h: state.videoHeight };
  state.start = 0;
  state.end = Math.min(state.duration, cfg.maxDurationSeconds);
  state.size = Math.max(1, Math.min(Math.round(cfg.maxWidth), state.videoWidth));
  el.size.value = String(state.size);
  el.mode.value = state.mode;

  syncCropInputs();
  syncTimeInputs();
  syncTransport();
  renderMeta();
  updatePlanPreview();
  setStatus('已载入视频，可在画面上拖拽框选区域', 'ok');
}

function renderMeta() {
  const mb = state.file ? (state.file.size / 1048576).toFixed(1) : '0';
  el.metaInfo.textContent =
    `分辨率 ${state.videoWidth}×${state.videoHeight} · 总时长 ${f2(state.duration)}s `
    + `(${formatClock(state.duration)}) · 文件 ${mb}MB`;
}

function formatClock(seconds) {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/* ---------- 预览尺寸自适应 ---------- */

function resizeFrame() {
  if (!state.videoWidth) return;
  const container = el.viewer.parentElement ?? document.body;
  const available = Math.max(200, container.clientWidth - 28);
  const maxHeight = Math.max(220, Math.round(window.innerHeight * 0.56));
  const aspect = state.videoWidth / state.videoHeight;
  const width = Math.min(available, maxHeight * aspect);
  const height = width / aspect;
  el.frame.style.width = `${Math.round(width)}px`;
  el.frame.style.height = `${Math.round(height)}px`;
  drawRect();
}

/* ---------- 框选 ---------- */

const overlayRect = () => el.overlay.getBoundingClientRect();

function toSourcePoint(event) {
  const box = overlayRect();
  const x = ((event.clientX - box.left) / box.width) * state.videoWidth;
  const y = ((event.clientY - box.top) / box.height) * state.videoHeight;
  return { x: clamp(x, 0, state.videoWidth), y: clamp(y, 0, state.videoHeight) };
}

function drawRect() {
  if (!state.videoWidth) return;
  const box = overlayRect();
  if (!box.width) return;
  const kx = box.width / state.videoWidth;
  const ky = box.height / state.videoHeight;
  el.rect.style.left = `${state.sel.x * kx}px`;
  el.rect.style.top = `${state.sel.y * ky}px`;
  el.rect.style.width = `${state.sel.w * kx}px`;
  el.rect.style.height = `${state.sel.h * ky}px`;
  el.cropInfo.textContent = `选区 ${Math.round(state.sel.w)}×${Math.round(state.sel.h)} px @ `
    + `${Math.round(state.sel.x)},${Math.round(state.sel.y)}`;
}

function setSelection(sel) {
  const minSize = Math.min(state.config.minCropSize, state.videoWidth, state.videoHeight);
  let x1 = clamp(Math.min(sel.x, sel.x + sel.w), 0, state.videoWidth);
  let x2 = clamp(Math.max(sel.x, sel.x + sel.w), 0, state.videoWidth);
  let y1 = clamp(Math.min(sel.y, sel.y + sel.h), 0, state.videoHeight);
  let y2 = clamp(Math.max(sel.y, sel.y + sel.h), 0, state.videoHeight);
  if (x2 - x1 < minSize) x2 = Math.min(state.videoWidth, x1 + minSize);
  if (y2 - y1 < minSize) y2 = Math.min(state.videoHeight, y1 + minSize);
  state.sel = { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
  syncCropInputs();
  drawRect();
  updatePlanPreview();
}

function syncCropInputs() {
  const { x, y, w, h } = state.sel;
  el.x1.value = String(Math.round(x));
  el.y1.value = String(Math.round(y));
  el.x2.value = String(Math.round(x + w));
  el.y2.value = String(Math.round(y + h));
}

function readCropInputs() {
  const x1 = Number(el.x1.value);
  const y1 = Number(el.y1.value);
  const x2 = Number(el.x2.value);
  const y2 = Number(el.y2.value);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return;
  setSelection({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
}

function fixedCorner(sel, corner) {
  const left = sel.x;
  const right = sel.x + sel.w;
  const top = sel.y;
  const bottom = sel.y + sel.h;
  switch (corner) {
    case 'nw': return { x: right, y: bottom };
    case 'ne': return { x: left, y: bottom };
    case 'sw': return { x: right, y: top };
    default: return { x: left, y: top };
  }
}

function bindCrop() {
  el.overlay.addEventListener('pointerdown', (e) => {
    if (!state.videoWidth || state.busy) return;
    el.overlay.setPointerCapture(e.pointerId);
    const point = toSourcePoint(e);
    const corner = e.target.dataset?.corner;
    if (corner) {
      state.drag = { mode: 'resize', anchor: fixedCorner(state.sel, corner) };
    } else if (e.target === el.rect) {
      state.drag = { mode: 'move', origin: { ...point }, sel: { ...state.sel } };
    } else {
      state.drag = { mode: 'new', anchor: point };
      setSelection({ x: point.x, y: point.y, w: 0, h: 0 });
    }
    e.preventDefault();
  });

  el.overlay.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    const point = toSourcePoint(e);
    if (state.drag.mode === 'move') {
      const dx = point.x - state.drag.origin.x;
      const dy = point.y - state.drag.origin.y;
      const { w, h } = state.drag.sel;
      setSelection({
        x: clamp(state.drag.sel.x + dx, 0, state.videoWidth - w),
        y: clamp(state.drag.sel.y + dy, 0, state.videoHeight - h),
        w,
        h,
      });
    } else {
      const a = state.drag.anchor;
      setSelection({
        x: Math.min(a.x, point.x),
        y: Math.min(a.y, point.y),
        w: Math.abs(point.x - a.x),
        h: Math.abs(point.y - a.y),
      });
    }
    e.preventDefault();
  });

  const endDrag = (e) => {
    if (!state.drag) return;
    state.drag = null;
    el.overlay.releasePointerCapture?.(e.pointerId);
  };
  el.overlay.addEventListener('pointerup', endDrag);
  el.overlay.addEventListener('pointercancel', endDrag);

  for (const input of [el.x1, el.y1, el.x2, el.y2]) {
    input.addEventListener('change', readCropInputs);
    input.addEventListener('blur', readCropInputs);
  }

  el.selectAllBtn.addEventListener('click', () => {
    if (!state.videoWidth) return;
    setSelection({ x: 0, y: 0, w: state.videoWidth, h: state.videoHeight });
  });
}

/* ---------- 时间区间 ---------- */

function syncTimeInputs() {
  const start = splitTime(state.start);
  const end = splitTime(state.end);
  el.startMin.value = String(start.minutes);
  el.startSec.value = start.seconds.toFixed(2);
  el.endMin.value = String(end.minutes);
  el.endSec.value = end.seconds.toFixed(2);
}

function splitTime(seconds) {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  return { minutes, seconds: total - minutes * 60 };
}

function readTimeInputs() {
  const start = Number(el.startMin.value) * 60 + Number(el.startSec.value);
  const end = Number(el.endMin.value) * 60 + Number(el.endSec.value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  state.start = clamp(start, 0, Math.max(0, state.duration - MIN_DURATION));
  state.end = clamp(end, 0, state.duration);
  if (state.end <= state.start) state.end = Math.min(state.duration, state.start + MIN_DURATION);
  syncTimeInputs();
  updatePlanPreview();
}

function bindTime() {
  for (const input of [el.startMin, el.startSec, el.endMin, el.endSec]) {
    input.addEventListener('change', readTimeInputs);
    input.addEventListener('blur', readTimeInputs);
  }
  el.startNowBtn.addEventListener('click', () => {
    state.start = clamp(el.video.currentTime, 0, Math.max(0, state.duration - MIN_DURATION));
    if (state.end <= state.start) {
      state.end = Math.min(state.duration, state.start + state.config.maxDurationSeconds);
    }
    syncTimeInputs();
    updatePlanPreview();
  });
  el.endNowBtn.addEventListener('click', () => {
    state.end = clamp(el.video.currentTime, 0, state.duration);
    if (state.end <= state.start) state.start = Math.max(0, state.end - MIN_DURATION);
    syncTimeInputs();
    updatePlanPreview();
  });
}

/* ---------- 播放控制 ---------- */

function syncTransport() {
  el.scrub.value = String(clamp(el.video.currentTime, 0, state.duration || 0));
  el.timeLabel.textContent = `${f2(el.video.currentTime)} / ${f2(state.duration)} s`;
}

function tick() {
  if (el.video.paused) return;
  // 生成过程中是"顺序播放取帧"，此时不能被预览循环把播放头拉回去
  if (!state.busy && el.loopSel.checked && state.end > state.start && el.video.currentTime >= state.end) {
    el.video.currentTime = state.start;
  }
  syncTransport();
  state.raf = requestAnimationFrame(tick);
}

function bindTransport() {
  el.playBtn.addEventListener('click', () => {
    if (!state.file) return;
    if (el.video.paused) el.video.play().catch(() => {});
    else el.video.pause();
  });
  el.scrub.addEventListener('input', () => {
    el.video.currentTime = Number(el.scrub.value);
    syncTransport();
  });
  el.video.addEventListener('play', () => {
    el.playBtn.textContent = '❚❚';
    tick();
  });
  el.video.addEventListener('pause', () => {
    el.playBtn.textContent = '▶';
    cancelAnimationFrame(state.raf);
    syncTransport();
  });
  el.video.addEventListener('seeked', syncTransport);
  el.video.addEventListener('loadedmetadata', onMetadata);
}

/* ---------- 输出参数（含上限收敛） ---------- */

function computeOutput() {
  const cfg = state.config;
  const { videoWidth, videoHeight } = state;
  const { w: cropW, h: cropH } = state.sel;
  if (!videoWidth || !videoHeight || cropW < 1 || cropH < 1) return null;

  const aspect = cropW / cropH;
  const target = Math.max(1, Math.round(state.size));
  let width;
  let height;
  if (state.mode === 'width') {
    width = target;
    height = Math.max(1, Math.round(width / aspect));
  } else {
    height = target;
    width = Math.max(1, Math.round(height * aspect));
  }

  let sizeClamped = false;
  const fit = Math.min(1, cfg.maxWidth / width, cfg.maxHeight / height);
  if (fit < 1) {
    width = Math.max(1, Math.floor(width * fit));
    height = Math.max(1, Math.floor(height * fit));
    sizeClamped = true;
  }

  const requestedDuration = Math.max(0, state.end - state.start);
  const allowedDuration = Math.min(requestedDuration, cfg.maxDurationSeconds);
  const frames = Math.max(1, Math.round(allowedDuration * cfg.fps));
  const duration = Math.round((frames / cfg.fps) * 1000) / 1000;

  return {
    width,
    height,
    frames,
    duration,
    fps: cfg.fps,
    start: Math.round(clamp(state.start, 0, Math.max(0, state.duration - MIN_DURATION)) * 1000) / 1000,
    crop: { x: state.sel.x, y: state.sel.y, w: state.sel.w, h: state.sel.h },
    sizeClamped,
    durationClamped: requestedDuration - allowedDuration > 0.001,
    tooShort: requestedDuration < MIN_DURATION,
  };
}

function updatePlanPreview() {
  const out = computeOutput();
  const canRender = Boolean(state.file && out && !out.tooShort);
  el.renderBtn.disabled = !canRender || state.busy;

  if (!out) {
    el.planInfo.textContent = '';
    return;
  }
  if (out.tooShort) {
    el.planInfo.textContent = `时间区间过短（至少约 ${MIN_DURATION}s）`;
    return;
  }
  const marks = [];
  if (out.sizeClamped) marks.push('尺寸已按上限缩小');
  if (out.durationClamped) marks.push('时长已按上限截断');
  el.planInfo.textContent =
    `实际输出 ${out.width}×${out.height}px · ${out.frames} 帧 · ${out.fps}fps · ${f2(out.duration)}s`
    + (marks.length ? `（${marks.join('、')}）` : '');
}

function bindOutput() {
  el.mode.addEventListener('change', () => { state.mode = el.mode.value; updatePlanPreview(); });
  el.size.addEventListener('input', () => {
    const value = Number(el.size.value);
    if (Number.isFinite(value) && value >= 1) {
      state.size = value;
      updatePlanPreview();
    }
  });
}

/* ---------- 取帧 ---------- */

function seekTo(time) {
  return new Promise((resolve) => {
    const video = el.video;
    if (video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.001) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', finish);
    video.currentTime = time;
  });
}

let canResizeBitmap = typeof createImageBitmap === 'function';

function frameCanvas(width, height) {
  const ctx = frameCanvas.ctx
    ?? (frameCanvas.ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true }));
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
  }
  return ctx;
}

/** 同步抓取当前视频帧（播放取帧的回调里必须同步完成，异步会错过这一帧）。 */
function grabFrameSync(plan) {
  const { crop, width, height } = plan;
  const ctx = frameCanvas(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(el.video, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** 把当前视频帧按裁剪区域缩放绘制到 canvas，并取回像素。 */
async function captureFrame(plan) {
  const { crop, width, height } = plan;
  const ctx = frameCanvas(width, height);

  // createImageBitmap 的 resizeQuality:'high' 比 drawImage 缩放更干净
  if (canResizeBitmap) {
    try {
      const bitmap = await createImageBitmap(el.video, crop.x, crop.y, crop.w, crop.h, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, width, height);
    } catch {
      canResizeBitmap = false;
    }
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(el.video, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * 播放一遍选区、在帧呈现时抓取需要的采样帧。
 *
 * 逐帧 seek 会反复从关键帧重解码：GOP 长的视频（例如 x264 默认 250 帧）慢到不可用。
 * 顺序播放则每帧只解码一次，耗时基本等于"选区时长 + 编码时间"，与 GOP 长短无关。
 * 抓帧只做同步的 drawImage/getImageData，颜色统计与编码留到播放结束后再跑，避免掉帧。
 */
function captureByPlayback(plan, times, shots, onProgress) {
  const video = el.video;
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve(false);

  video.pause();
  return new Promise((resolve) => {
    let next = 0;
    let prev = null;
    let settled = false;
    let watchdog = null;

    const fillRemaining = (shot) => {
      while (shot && next < times.length) {
        shots[next] = shot.data;
        next++;
        setProgress(next, times.length, '取帧');
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      video.removeEventListener('ended', onEnded);
      video.pause();
      resolve(true);
    };
    const onEnded = () => {
      fillRemaining(prev); // 视频到头：剩下的目标点都用最后一帧
      finish();
    };
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(finish, 2000);
    };

    const onFrame = (now, meta) => {
      if (settled) return;
      if (state.cancel) {
        finish();
        return;
      }
      const time = meta.mediaTime;
      // 一帧显示到下一帧出现为止：目标点落在两帧中点的哪一侧，就属于那一帧
      if (prev) {
        const mid = (prev.time + time) / 2;
        while (next < times.length && times[next] < mid) {
          shots[next] = prev.data;
          next++;
          setProgress(next, times.length, '取帧');
        }
      }
      if (next >= times.length) {
        finish();
        return;
      }
      prev = { time, data: grabFrameSync(plan) };
      arm();
      video.requestVideoFrameCallback(onFrame);
    };

    video.addEventListener('ended', onEnded);
    arm();
    video.requestVideoFrameCallback(onFrame);
    seekTo(plan.start).then(() => video.play()).catch(() => finish());
  });
}

/* ---------- 调色板与索引 ---------- */

/**
 * 一帧 → 索引数组 + 调色板。
 * 颜色数不超过上限时走「精确调色板」：无损且体积小（图表、界面截图几乎都命中）；
 * 超过时才交给 gifenc 的量化器。
 */
function encodeFrame(imageData, prev, cfg) {
  const { data, width, height } = imageData;
  const total = width * height;
  const u32 = new Uint32Array(data.buffer);
  const keyMask = 0xffffff; // 视频帧不透明，忽略 alpha 通道

  let changed = null;
  let changedCount = 0;
  if (prev && prev.length === total) {
    changed = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if ((u32[i] & keyMask) !== (prev[i] & keyMask)) {
        changed[i] = 1;
        changedCount++;
      }
    }
  }

  const identical = Boolean(changed) && changedCount === 0;
  const useTransparent = Boolean(changed)
    && changedCount > 0
    && changedCount / total < cfg.transparencyThreshold;
  const maxPalette = Math.max(2, Math.min(256, Math.floor(cfg.maxColors)) - (useTransparent ? 1 : 0));

  // 统计颜色（存在变化像素时只统计变化部分，调色板留给真正需要编码的像素）
  const colors = new Map(); // 键 → { count, offset }
  let overflow = false;
  for (let i = 0; i < total; i++) {
    if (useTransparent && !changed[i]) continue;
    const key = u32[i] & keyMask;
    const entry = colors.get(key);
    if (entry) entry.count++;
    else {
      colors.set(key, { count: 1, offset: i * 4 });
      if (colors.size > maxPalette) { overflow = true; break; }
    }
  }

  const offset = useTransparent ? 1 : 0;

  if (!overflow && colors.size > 0) {
    const sorted = [...colors.entries()].sort((a, b) => b[1].count - a[1].count);
    const palette = offset ? [[0, 0, 0]] : [];
    const lookup = new Map();
    for (const [key, entry] of sorted) {
      lookup.set(key, palette.length);
      palette.push([data[entry.offset], data[entry.offset + 1], data[entry.offset + 2]]);
    }
    const index = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if (useTransparent && !changed[i]) continue; // 保持 0 = 透明
      index[i] = lookup.get(u32[i] & keyMask);
    }
    return { index, palette, transparent: useTransparent, changedCount, identical };
  }

  // 颜色过多：交给 gifenc 的 PNN 量化器（rgb565 分箱，索引缓存也在它内部）
  const rgba = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  const realPalette = quantize(rgba, maxPalette, { format: 'rgb565' });
  const realIndex = applyPalette(rgba, realPalette, 'rgb565');
  const palette = offset ? [[0, 0, 0], ...realPalette] : realPalette;
  const index = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (useTransparent && !changed[i]) continue;
    index[i] = realIndex[i] + offset;
  }
  return { index, palette, transparent: useTransparent, changedCount, identical };
}

/** GIF 的帧间隔是 1/100 秒，逐帧取整会丢失时间；用累计取整保证平均帧率准确。 */
const delayForFrame = (i, fps) => Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps);

/**
 * 画面完全没变的帧并进**上一帧**的显示时长。
 * 合并方向必须是"并入前一帧"：GIF 里第 k 帧从累计时长处开始显示，
 * 若把重复帧的时长加给下一帧，整段时间轴会向后偏移。
 */
function mergeStaticFrames(frames) {
  const merged = [];
  for (const frame of frames) {
    const last = merged[merged.length - 1];
    if (frame.identical && last) {
      last.delayCs += frame.delayCs;
      continue;
    }
    merged.push({ ...frame });
  }
  return merged;
}

const bitDepthFor = (paletteLength) => Math.min(8, Math.max(2, Math.ceil(Math.log2(Math.max(2, paletteLength)))));

/* ---------- 生成 ---------- */

function setBusy(busy) {
  state.busy = busy;
  el.cancelBtn.hidden = !busy;
  el.progress.hidden = !busy;
  el.playBtn.disabled = busy;
  if (!busy) {
    el.progressBar.style.width = '0%';
    el.progressText.textContent = '';
  }
  updatePlanPreview();
}

function setProgress(done, total, stage) {
  el.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
  el.progressText.textContent = `${stage} ${done}/${total} 帧`;
}

async function generate() {
  if (state.busy) return;
  const plan = computeOutput();
  if (!state.file || !plan || plan.tooShort) return;
  if (!plan.crop.w || !plan.crop.h) return;

  el.video.pause();
  state.cancel = false;
  setBusy(true);
  setStatus('正在取帧并编码…', 'busy');

  const started = performance.now();
  try {
    const times = [];
    for (let i = 0; i < plan.frames; i++) {
      times.push(Math.min(plan.start + i / plan.fps, Math.max(0, state.duration - 0.001)));
    }

    // 1) 先播放一遍选区，按时间戳抓取采样帧（快，且不受 GOP 长度影响）
    const shots = new Array(plan.frames).fill(null);
    await captureByPlayback(plan, times, shots, setProgress);
    if (state.cancel) throw new Cancelled();

    // 2) 编码；播放没覆盖到的采样点（浏览器不支持 rVFC、播放被中断等）再用 seek 补齐
    const frames = [];
    let prev = null;
    for (let i = 0; i < plan.frames; i++) {
      if (state.cancel) throw new Cancelled();
      let imageData = shots[i];
      if (!imageData) {
        await seekTo(times[i]);
        imageData = await captureFrame(plan);
      }
      const frame = encodeFrame(imageData, prev, state.config);
      frame.delayCs = delayForFrame(i, plan.fps);
      frames.push(frame);
      prev = new Uint32Array(imageData.data.buffer);
      shots[i] = null; // 及时释放
      setProgress(i + 1, plan.frames, '编码');
      await nextTick();
    }

    const gifFrames = mergeStaticFrames(frames);
    const encoder = GIFEncoder({ initialCapacity: 1 << 18 });
    for (const frame of gifFrames) {
      const options = {
        palette: frame.palette,
        delay: frame.delayCs * 10, // gifenc 内部按 1/100 秒取整
        colorDepth: bitDepthFor(frame.palette.length),
      };
      if (frame.transparent) {
        options.transparent = true;
        options.transparentIndex = 0;
        options.dispose = 1; // 保留上一帧，未变化区域靠透明像素透出来
      }
      encoder.writeFrame(frame.index, plan.width, plan.height, options);
    }
    encoder.finish();

    const blob = new Blob([encoder.bytesView()], { type: 'image/gif' });
    showResult(blob, {
      ...plan,
      gifFrames: gifFrames.length,
      elapsedMs: Math.round(performance.now() - started),
    });
    setStatus(`生成完成，用时 ${((performance.now() - started) / 1000).toFixed(1)}s`, 'ok');
  } catch (err) {
    if (err instanceof Cancelled) setStatus('已取消生成', 'warn');
    else {
      console.error(err);
      setStatus(`生成失败：${err.message || err}`, 'error');
    }
  } finally {
    setBusy(false);
  }
}

function showResult(blob, info) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  el.resultPanel.hidden = false;
  el.resultImg.src = state.resultUrl;

  const merged = info.gifFrames && info.gifFrames !== info.frames ? `（静止帧合并后 ${info.gifFrames} 帧）` : '';
  el.resultInfo.textContent =
    `${info.width}×${info.height}px · ${info.frames} 帧${merged} · ${f2(info.duration)}s · `
    + `${(blob.size / 1024).toFixed(1)} KB`;
  el.resultNotes.textContent = info.notes?.length ? `已自动调整：${info.notes.join('；')}` : '';

  const base = (state.file?.name || 'clip').replace(/\.[^.]+$/, '').slice(0, 40);
  el.downloadLink.href = state.resultUrl;
  el.downloadLink.download = `${base}_${info.start.toFixed(2)}s_${info.width}x${info.height}_${info.fps}fps.gif`;
}

/* ---------- 启动 ---------- */

async function init() {
  bindDropzone();
  bindCrop();
  bindTime();
  bindTransport();
  bindOutput();
  el.renderBtn.addEventListener('click', generate);
  el.cancelBtn.addEventListener('click', () => { state.cancel = true; });
  window.addEventListener('resize', resizeFrame);
  await loadConfig();
  updatePlanPreview();
}

init();
