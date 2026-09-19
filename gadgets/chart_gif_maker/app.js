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
/** 「保存配置」写入浏览器本地的键名（只存与具体视频无关的输出偏好） */
const STORAGE_KEY = 'chart_gif_maker.prefs.v1';

/** config/gif.json 读不到时使用的兜底值（与仓库里的默认配置一致） */
const DEFAULTS = {
  version: '0.0',
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
/** 输出参数的默认值（用户没设置过、也没有保存过的偏好时使用） */
const DEFAULT_SIZE = 240;
const DEFAULT_FPS = 6;
/** 默认裁剪区域：画面中心的最大内切正方形 */
/** 默认时间区间：从视频 40% 处开始，长度取「总长的 20%」与「30s」里较小的那个 */
const DEFAULT_TIME_START_RATIO = 0.4;
const DEFAULT_TIME_LENGTH_RATIO = 0.2;
const DEFAULT_TIME_MAX_LENGTH = 30;

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), dzHint: $('dzHint'),
  viewer: $('viewer'), frame: $('frame'), video: $('video'), overlay: $('overlay'), rect: $('rect'),
  playBtn: $('playBtn'), scrub: $('scrub'), timeLabel: $('timeLabel'),
  metaInfo: $('metaInfo'), cropInfo: $('cropInfo'), changeFileBtn: $('changeFileBtn'),
  x1: $('x1'), y1: $('y1'), x2: $('x2'), y2: $('y2'), selectAllBtn: $('selectAllBtn'),
  startMin: $('startMin'), startSec: $('startSec'), endMin: $('endMin'), endSec: $('endSec'),
  startNowBtn: $('startNowBtn'), endNowBtn: $('endNowBtn'), loopSel: $('loopSel'),
  mode: $('mode'), size: $('size'), fps: $('fps'), fpsHint: $('fpsHint'),
  planInfo: $('planInfo'), limitInfo: $('limitInfo'),
  renderBtn: $('renderBtn'), saveConfigBtn: $('saveConfigBtn'), cancelBtn: $('cancelBtn'), status: $('status'),
  progress: $('progress'), progressBar: $('progressBar'), progressText: $('progressText'),
  resultPanel: $('resultPanel'), resultImg: $('resultImg'), resultInfo: $('resultInfo'),
  resultNotes: $('resultNotes'), downloadLink: $('downloadLink'),
  appTitle: $('appTitle'),
};

const state = {
  config: { ...DEFAULTS },
  configLoaded: false,
  /** 用户手动设置的帧率（整数，1 ~ config.fps） */
  fps: DEFAULT_FPS,
  /** 输出偏好，可从 localStorage 恢复 / 由「保存配置」写入 */
  prefs: null,
  /** 用户本次是否手动改过这些输出参数（改过之后载入新视频不再覆盖） */
  userEdited: { mode: false, size: false, fps: false },
  file: null,
  videoUrl: null,
  videoWidth: 0,
  videoHeight: 0,
  duration: 0,
  sel: { x: 0, y: 0, w: 0, h: 0 },
  start: 0,
  end: 0,
  /** 时间输入框里"最后一次有效"的四个数值（分量 / 秒分开存，输入到一半时不会被清成 0） */
  time: { startMin: 0, startSec: 0, endMin: 0, endSec: 0 },
  /** 正在输入中的草稿值（只有提交时才写回 state.time） */
  timeDraft: { startMin: 0, startSec: 0, endMin: 0, endSec: 0 },
  /** 时间输入被自动修正的说明，用于界面提示与控制台输出 */
  timeNotices: [],
  /** 帧率输入被自动修正的说明 */
  fpsNotices: [],
  mode: 'width',
  size: DEFAULT_SIZE,
  busy: false,
  cancel: false,
  resultUrl: null,
  drag: null,
  raf: 0,
};

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 规范化用户敲进输入框的数字文本：全角数字、全角小数点、逗号都当作普通数字处理。
 * 直接用 <input type="number"> 时，浏览器会把 "1,5" 这类内容悄悄清成空串，
 * JS 再读就变成了 0，于是"时间区间设置无效"。这里改成自己解析文本，避免这种静默丢失。
 */
function normalizeNumberText(text) {
  return String(text ?? '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF0E\uFF0C，、,]/g, '.')
    .trim();
}

/** 解析输入框数字；空、非法、负数一律返回 null（调用方沿用上一个有效值） */
function parseNumberText(text) {
  const raw = normalizeNumberText(text);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** config 里的 fps 既是默认值，也是用户能设置的上限 */
const fpsCap = () => Math.max(1, Math.floor(state.config.fps));
const clampFps = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fpsCap();
  return Math.min(Math.max(1, Math.floor(n)), fpsCap());
};

class Cancelled extends Error {}

function setStatus(text, kind = '') {
  el.status.textContent = text || '';
  el.status.className = `status ${kind}`.trim();
}

/* ---------- 配置 ---------- */

async function loadConfig() {
  try {
    // 带上时间戳：否则浏览器 / CDN 可能继续用旧的 gif.json，改完刷新看不到效果
    const res = await fetch(`${CONFIG_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    for (const key of Object.keys(DEFAULTS)) {
      const value = raw[key];
      if (typeof DEFAULTS[key] === 'number' && Number.isFinite(Number(value)) && Number(value) > 0) {
        state.config[key] = Number(value);
      } else if (typeof DEFAULTS[key] === 'boolean' && typeof value === 'boolean') {
        state.config[key] = value;
      } else if (typeof DEFAULTS[key] === 'string') {
        // 字符串参数（例如 version）：空值 / 读不到时继续用兜底值
        const text = typeof value === 'string' ? value.trim() : (Number.isFinite(Number(value)) ? String(value) : '');
        if (text) state.config[key] = text;
      }
    }
    state.configLoaded = true;
  } catch (err) {
    console.warn(`[config] 读取 ${CONFIG_URL} 失败，使用内置默认值：${err.message}`);
  }
  applyTitle();
  console.log(`[chart_gif_maker] 标题版本：v${state.config.version}`
    + `（${state.configLoaded ? `来自 ${CONFIG_URL}` : '未能读取配置文件，使用内置默认值'}）`);
  el.limitInfo.textContent = state.configLoaded
    ? `上限（可在 config/gif.json 调整）：${state.config.maxWidth}×${state.config.maxHeight}px、`
      + `${state.config.maxDurationSeconds}s、${fpsCap()}fps；超出时自动等比缩小 / 截断时长。`
    : `未能读取 config/gif.json，本次使用内置默认值：${DEFAULTS.maxWidth}×${DEFAULTS.maxHeight}px、`
      + `${DEFAULTS.maxDurationSeconds}s、${fpsCap()}fps。`;
  if (!state.configLoaded) setStatus('未能读取 config/gif.json（用 file:// 直接打开会这样，请通过网站地址访问）', 'warn');
  el.dzHint.textContent = `单个文件不超过 ${state.config.maxFileSizeMB}MB`;
  state.fps = clampFps(DEFAULT_FPS);
  state.size = Math.max(1, Math.min(DEFAULT_SIZE, Math.round(state.config.maxWidth)));
  el.size.value = String(state.size);
  syncFpsInput();
}

/** 页面标题：视频生成GIF小工具 v<version>（version 来自 config，读不到时是 0.0） */
function applyTitle() {
  const title = `视频生成GIF小工具 v${state.config.version}`;
  el.appTitle.textContent = title;
  document.title = title;
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

/**
 * 默认裁剪区域：画面中心的最大内切正方形。
 * 例：1920×1080 → 420,0 ~ 1500,1080；320×240 → 40,0 ~ 280,240。
 */
function defaultCrop(width, height) {
  const side = Math.max(1, Math.min(width, height));
  const x = Math.round((width - side) / 2);
  const y = Math.round((height - side) / 2);
  return { x, y, w: side, h: side };
}

/**
 * 默认时间区间：从视频 40% 处开始，长度取「总长的 20%」与「30s」里较小的那个。
 * 例：60s → 24.00 ~ 36.00s；300s → 120.00 ~ 150.00s；10s → 4.00 ~ 6.00s。
 */
function defaultTimeRange(duration) {
  const length = clamp(
    Math.min(duration * DEFAULT_TIME_LENGTH_RATIO, DEFAULT_TIME_MAX_LENGTH),
    MIN_DURATION,
    Math.max(MIN_DURATION, duration),
  );
  const start = clamp(duration * DEFAULT_TIME_START_RATIO, 0, Math.max(0, duration - length));
  return { start, end: start + length, length };
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

  // 默认：画面中心的最大内切正方形 + 视频 40% 处起、20%（最多 30s）长度 + 默认目标宽度
  //（帧率 / 尺寸 / 目标若保存过就沿用保存值；用户已经手动改过的则保留用户的设置）
  state.sel = defaultCrop(state.videoWidth, state.videoHeight);
  const range = defaultTimeRange(state.duration);
  state.start = range.start;
  state.end = range.end;
  if (!state.userEdited.mode) state.mode = state.prefs?.mode ?? state.mode;
  if (!state.userEdited.size) {
    state.size = state.prefs?.size ?? Math.max(1, Math.min(DEFAULT_SIZE, Math.round(cfg.maxWidth)));
  }
  if (!state.userEdited.fps) state.fps = clampFps(state.prefs?.fps ?? DEFAULT_FPS);
  el.size.value = String(state.size);
  el.mode.value = state.mode;
  syncFpsInput();

  syncCropInputs();
  syncTimeInputs();
  syncTransport();
  renderMeta();
  updatePlanPreview();
  setStatus(`已载入视频：默认裁剪画面中心 ${state.sel.w}×${state.sel.h} 的正方形，`
    + `时间 ${f2(state.start)}s ~ ${f2(state.end)}s；可直接在画面上拖拽调整`, 'ok');
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
  state.time = {
    startMin: start.minutes,
    startSec: Number(start.seconds.toFixed(2)),
    endMin: end.minutes,
    endSec: Number(end.seconds.toFixed(2)),
  };
  state.timeDraft = { ...state.time };
  for (const input of [el.startMin, el.startSec, el.endMin, el.endSec]) {
    input.setAttribute('aria-invalid', 'false');
  }
}

function splitTime(seconds) {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  return { minutes, seconds: total - minutes * 60 };
}

/**
 * 读取时间区间。
 *
 * 这里刻意不直接 Number(input.value)：输入框为空、或者写了「1,5」这种内容时，
 * 旧写法会把它当成 0，用户设好的区间就被悄悄清空了（表现就是「时间区间设置无效 / 总是导出最长时间」）。
 * 现在这类输入会沿用该字段上一次的有效值，并把「做了什么修正」记下来，供界面和控制台查看。
 */
function readTimeInputs({ canonicalize = true } = {}) {
  const notices = [];
  const read = (input, key, label) => {
    const value = parseNumberText(input.value);
    if (value !== null) {
      state.timeDraft[key] = value;
      input.setAttribute('aria-invalid', 'false');
      return value;
    }
    const raw = normalizeNumberText(input.value);
    input.setAttribute('aria-invalid', raw ? 'true' : 'false');
    if (canonicalize) {
      // 提交时才提示：输入框空着 / 不是数字时，沿用上一次的有效值（而不是悄悄变成 0）
      notices.push(`「${label}」${raw ? '不是有效数字' : '为空'}，沿用上一个有效值 ${f2(state.time[key])}`);
    } else {
      state.timeDraft[key] = state.time[key];
    }
    return state.time[key];
  };

  const startMin = read(el.startMin, 'startMin', '起始 分');
  const startSec = read(el.startSec, 'startSec', '起始 秒');
  const endMin = read(el.endMin, 'endMin', '结束 分');
  const endSec = read(el.endSec, 'endSec', '结束 秒');

  const askedStart = startMin * 60 + startSec;
  const askedEnd = endMin * 60 + endSec;
  state.start = clamp(askedStart, 0, Math.max(0, state.duration - MIN_DURATION));
  state.end = clamp(askedEnd, 0, state.duration);
  if (askedStart > state.start + 0.001) {
    notices.push(`起始时间 ${f2(askedStart)}s 超出可用范围，已收敛到 ${f2(state.start)}s`);
  }
  if (askedEnd > state.end + 0.001) {
    notices.push(`结束时间 ${f2(askedEnd)}s 超过视频长度，已收敛到 ${f2(state.end)}s`);
  }
  if (state.end <= state.start) {
    state.end = Math.min(state.duration, state.start + MIN_DURATION);
    notices.push(`结束时间不晚于起始时间，已改为 ${f2(state.end)}s（起始 + ${MIN_DURATION}s）`);
  }

  state.timeNotices = notices;
  if (canonicalize) syncTimeInputs();
  updatePlanPreview();
}

/**
 * 文本输入框的通用绑定：
 * 打字时实时更新状态（live），失焦 / 回车提交一次（commit）。
 * 浏览器在失焦时会先派发 change 再派发 blur，所以这里用一个"脏标记"保证只提交一次——
 * 否则第二次读取会把第一次的「自动修正」提示冲掉。
 */
function bindTextField(input, { live, commit }) {
  const submit = () => {
    if (input.dataset.dirty !== '1') return;
    delete input.dataset.dirty;
    commit();
  };
  input.addEventListener('input', () => {
    input.dataset.dirty = '1';
    live();
  });
  input.addEventListener('change', submit);
  input.addEventListener('blur', submit);
}

/** 合并多份「自动修正」说明并去重 */
const mergeNotices = (...lists) => [...new Set(lists.flat().filter(Boolean))];

function bindTime() {
  for (const input of [el.startMin, el.startSec, el.endMin, el.endSec]) {
    bindTextField(input, {
      live: () => readTimeInputs({ canonicalize: false }),
      commit: () => readTimeInputs(),
    });
  }
  el.startNowBtn.addEventListener('click', () => {
    readTimeInputs({ canonicalize: false });
    state.start = clamp(el.video.currentTime, 0, Math.max(0, state.duration - MIN_DURATION));
    if (state.end <= state.start) {
      state.end = Math.min(state.duration, state.start + state.config.maxDurationSeconds);
    }
    syncTimeInputs();
    updatePlanPreview();
  });
  el.endNowBtn.addEventListener('click', () => {
    readTimeInputs({ canonicalize: false });
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
  const fps = clampFps(state.fps);
  const frames = Math.max(1, Math.round(allowedDuration * fps));
  const duration = Math.round((frames / fps) * 1000) / 1000;

  return {
    width,
    height,
    frames,
    duration,
    fps,
    start: Math.round(clamp(state.start, 0, Math.max(0, state.duration - MIN_DURATION)) * 1000) / 1000,
    crop: { x: state.sel.x, y: state.sel.y, w: state.sel.w, h: state.sel.h },
    requestedDuration,
    sizeClamped,
    durationClamped: requestedDuration - allowedDuration > 0.001,
    tooShort: requestedDuration < MIN_DURATION,
  };
}

function updatePlanPreview() {
  const out = computeOutput();
  const canRender = Boolean(state.file && out && !out.tooShort);
  el.renderBtn.disabled = !canRender || state.busy;

  const notes = [...state.timeNotices, ...state.fpsNotices];
  if (!out) {
    el.planInfo.textContent = notes.length ? `输入提示：${notes.join('；')}` : '';
    return;
  }
  if (out.tooShort) {
    el.planInfo.textContent = `时间区间过短（至少约 ${MIN_DURATION}s）`
      + (notes.length ? `\n输入提示：${notes.join('；')}` : '');
    return;
  }
  const marks = [];
  if (out.sizeClamped) marks.push('尺寸已按上限缩小');
  if (out.durationClamped) {
    marks.push(`时长已按上限截断：所选 ${f2(out.requestedDuration)}s → 实际 ${f2(out.duration)}s`
      + `（上限 ${state.config.maxDurationSeconds}s 来自 config/gif.json）`);
  }
  el.planInfo.textContent =
    `实际输出 ${out.width}×${out.height}px · ${out.frames} 帧 · ${out.fps}fps · ${f2(out.duration)}s`
    + (marks.length ? `（${marks.join('、')}）` : '')
    + (notes.length ? `\n输入提示：${notes.join('；')}` : '');
}

function bindOutput() {
  el.mode.addEventListener('change', () => {
    state.mode = el.mode.value;
    state.userEdited.mode = true;
    updatePlanPreview();
  });
  bindTextField(el.size, {
    live: () => { state.userEdited.size = true; readSizeInput({ canonicalize: false }); },
    commit: () => readSizeInput(),
  });
  bindTextField(el.fps, {
    live: () => { state.userEdited.fps = true; readFpsInput({ canonicalize: false }); },
    commit: () => readFpsInput(),
  });
}

/** 目标像素：只要 1 以上的数字，别的输入沿用上一个有效值 */
function readSizeInput({ canonicalize = true } = {}) {
  const value = parseNumberText(el.size.value);
  if (value !== null && value >= 1) state.size = Math.max(1, Math.round(value));
  if (canonicalize) el.size.value = String(state.size);
  updatePlanPreview();
}

/**
 * 帧率输入：只接受整数，不低于 1，高于 config 里的上限时取上限。
 * 上限值本身来自 config/gif.json，改配置刷新页面即可生效。
 */
function readFpsInput({ canonicalize = true } = {}) {
  const cap = fpsCap();
  const asked = parseNumberText(el.fps.value);
  const notices = [];
  let fps = state.fps;

  if (asked === null) {
    notices.push(`帧率输入无效，沿用上一个有效值 ${state.fps}fps`);
  } else {
    const integer = Math.floor(asked);
    fps = integer;
    if (asked > integer + 0.0001) notices.push(`帧率只接受整数，${asked} 已取整为 ${integer}fps`);
    if (fps < 1) {
      fps = 1;
      notices.push('帧率不能低于 1fps，已设为 1fps');
    }
    if (fps > cap) {
      fps = cap;
      notices.push(`帧率 ${integer} 超过上限 ${cap}fps，已取上限`);
    }
  }

  state.fps = fps;
  state.fpsNotices = canonicalize ? notices : [];
  if (canonicalize) el.fps.value = String(fps);
  updatePlanPreview();
}

/** 把 config 上限、界面读到的值和最终输出整理成一份可复制的对象，供控制台 / 排查问题用 */
function configSnapshot() {
  const out = computeOutput();
  const num = (input) => (input.value.trim() === '' ? null : normalizeNumberText(input.value));
  return {
    配置文件: state.configLoaded ? CONFIG_URL : `未能读取 ${CONFIG_URL}，本次使用内置默认值`,
    config上限: { ...state.config },
    视频: state.file
      ? {
        名称: state.file.name,
        大小MB: Number((state.file.size / 1048576).toFixed(2)),
        分辨率: `${state.videoWidth}×${state.videoHeight}`,
        时长秒: Number(state.duration.toFixed(3)),
      }
      : null,
    界面读到的时间区间: {
      '起始 分': num(el.startMin),
      '起始 秒': num(el.startSec),
      '结束 分': num(el.endMin),
      '结束 秒': num(el.endSec),
      换算: { start: state.start, end: state.end, duration: Math.max(0, state.end - state.start) },
    },
    界面读到的裁剪区域: { ...state.sel, x2: Math.round(state.sel.x + state.sel.w), y2: Math.round(state.sel.y + state.sel.h) },
    界面读到的输出参数: {
      目标: state.mode,
      像素: state.size,
      帧率: state.fps,
      帧率上限: fpsCap(),
    },
    实际输出: out
      ? {
        宽: out.width,
        高: out.height,
        帧数: out.frames,
        帧率: out.fps,
        时长秒: out.duration,
        起始秒: out.start,
        尺寸按上限缩小: out.sizeClamped,
        时长按上限截断: out.durationClamped,
      }
      : null,
    自动修正: [...state.timeNotices, ...state.fpsNotices],
  };
}

/** 保存配置：写入浏览器本地存储 + 弹窗提示 + 把读取到的配置输出到控制台 */
function saveConfig() {
  // 先记下当前已有的"自动修正"提示，再重新读一遍输入框（重新读会刷新提示）
  const before = mergeNotices(state.timeNotices, state.fpsNotices);
  readCropInputs();
  readTimeInputs();
  readSizeInput();
  readFpsInput();

  const snapshot = configSnapshot();
  snapshot.自动修正 = mergeNotices(before, state.timeNotices, state.fpsNotices);
  const saved = { fps: snapshot.界面读到的输出参数.帧率, size: snapshot.界面读到的输出参数.像素, mode: snapshot.界面读到的输出参数.目标 };
  let localSaved = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch (err) {
    localSaved = false;
    console.warn(`[chart_gif_maker] 写入 localStorage 失败：${err.message}`);
  }

  console.log('[chart_gif_maker] 已保存配置 / 当前读取到的配置：', snapshot);
  console.log('[chart_gif_maker] 写入浏览器本地的偏好（下次打开自动套用）：', saved);

  state.prefs = { ...saved };
  alert(localSaved ? '保存成功' : '保存成功（浏览器禁止本地存储，本次仅在控制台输出）');
  setStatus('配置已保存，并把读取到的配置输出到浏览器控制台（F12 → Console）', 'ok');
}

function restoreSavedConfig() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object') return;
  state.prefs = {
    fps: Number.isFinite(Number(saved.fps)) ? clampFps(saved.fps) : null,
    size: Number.isFinite(Number(saved.size)) && Number(saved.size) >= 1 ? Math.round(Number(saved.size)) : null,
    mode: saved.mode === 'height' ? 'height' : 'width',
  };
  state.mode = state.prefs.mode;
  if (state.prefs.size) {
    state.size = state.prefs.size;
    el.size.value = String(state.size);
  }
  if (state.prefs.fps) state.fps = state.prefs.fps;
  el.mode.value = state.mode;
  syncFpsInput();
}

/** 帧率输入框的显示与提示文案 */
function syncFpsInput() {
  const cap = fpsCap();
  state.fps = clampFps(state.fps);
  el.fps.value = String(state.fps);
  el.fpsHint.textContent = `1 ~ ${cap} fps（默认 ${Math.min(DEFAULT_FPS, cap)}）`;
  el.fpsHint.title = `上限 ${cap}fps 来自 config/gif.json；帧率越高，GIF 体积越大。`;
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
  // 生成过程中不要弹窗：alert 会卡住取帧用的播放
  el.saveConfigBtn.disabled = busy;
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
  const inputNotices = mergeNotices(state.timeNotices, state.fpsNotices);
  // 生成前重新读一遍界面上的输入：不依赖"上次读到"的状态，避免界面与状态不一致
  readCropInputs();
  readTimeInputs();
  readSizeInput();
  readFpsInput();
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
    const notes = [];
    if (plan.sizeClamped) notes.push('目标尺寸超过上限，已等比缩小');
    if (plan.durationClamped) {
      notes.push(`所选区间 ${f2(plan.requestedDuration)}s 超过时长上限 `
        + `${state.config.maxDurationSeconds}s，只输出了前 ${f2(plan.duration)}s`);
    }
    notes.push(...mergeNotices(inputNotices, state.timeNotices, state.fpsNotices));
    showResult(blob, {
      ...plan,
      notes,
      gifFrames: gifFrames.length,
      elapsedMs: Math.round(performance.now() - started),
    });
    if (notes.length) console.log('[chart_gif_maker] 本次生成自动调整：', notes);
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
  el.saveConfigBtn.addEventListener('click', saveConfig);
  el.cancelBtn.addEventListener('click', () => { state.cancel = true; });
  window.addEventListener('resize', resizeFrame);
  await loadConfig();
  restoreSavedConfig();
  updatePlanPreview();
}

init();
