// In-browser UNO Flip card detection via onnxruntime-web.
//
// The model was exported from ultralytics with `nms=True`, so its output is
// already a flat list of detections: shape (1, 300, 6) where each row is
// [x1, y1, x2, y2, confidence, class_index] in 640x640 input space.
//
// We letterbox-resize the image to 640x640 (same as training), run the
// session, then map boxes back to the original image coordinates and apply a
// class-agnostic NMS pass to collapse duplicate labels on the same card.

import * as ort from 'onnxruntime-web';

import { log } from './debugLog';

const INPUT_SIZE = 640;
const DEFAULT_CONFIDENCE = 0.25;
const NMS_IOU = 0.5;

// Must match `CLASSES` order in data/compose_hands.py (see data/classes.txt).
const CLASS_NAMES = [
  'wild_color',
  'wild_draw_two',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'flip',
  'draw_one',
  'skip',
  'reverse',
  'wild_draw_until',
  'draw_five',
  'skip_all',
];

const MIN_CONFIDENCE = parseFloat(
  process.env.REACT_APP_MIN_CONFIDENCE || String(DEFAULT_CONFIDENCE)
);

let sessionPromise = null;

async function fetchModelBuffer() {
  // Production: ask the Vercel function for a fresh signed URL, then download
  // the bytes ourselves. We fetch explicitly (rather than handing the signed
  // URL to onnxruntime-web) because onnxruntime-web rewrites the URL's query
  // string, which destroys the Vercel Blob signature.
  try {
    const res = await fetch('/api/model');
    if (res.ok) {
      const data = await res.json();
      if (typeof data.url === 'string' && data.url) {
        log('signed model URL received from /api/model');
        return await downloadModel(data.url);
      }
    }
    log('no signed URL from /api/model, falling back to local file');
  } catch (err) {
    log('failed to fetch /api/model', { error: err.message });
  }
  // Development (plain `npm start`): the file is served from public/.
  const localUrl = `${process.env.PUBLIC_URL || ''}/model/uno-flip-detector.onnx`;
  return downloadModel(localUrl);
}

async function downloadModel(url) {
  log('downloading model…');
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`model download failed (HTTP ${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  log('model downloaded', { bytes: buffer.byteLength });
  return buffer;
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // The ~20 MB of WASM runtime files are fetched from the pinned CDN so
      // they don't need to be committed to the repo.
      ort.env.wasm.wasmPaths =
        'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
      const buffer = await fetchModelBuffer();
      log('loading ONNX session…', { providers: ['webgl', 'wasm'] });
      try {
        const session = await ort.InferenceSession.create(buffer, {
          executionProviders: ['webgl', 'wasm'],
          graphOptimizationLevel: 'all',
        });
        log('ONNX session ready');
        return session;
      } catch (err) {
        log('ONNX session failed', { error: err.message });
        throw err;
      }
    })();
  }
  return sessionPromise;
}

/**
 * Starts loading the ONNX model immediately (rather than waiting for the
 * first scan). Safe to call multiple times — the session is cached.
 */
export function preloadModel() {
  getSession().catch((err) => {
    log('model preload failed', { error: err.message });
  });
}

async function bitmapToTensor(bitmap) {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = INPUT_SIZE / Math.max(srcW, srcH);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const padX = Math.floor((INPUT_SIZE - w) / 2);
  const padY = Math.floor((INPUT_SIZE - h) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Ultralytics letterbox padding colour (114, 114, 114).
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(bitmap, padX, padY, w, h);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const n = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = i * 4; // RGBA
    input[i] = data[p] / 255; // R
    input[n + i] = data[p + 1] / 255; // G
    input[2 * n + i] = data[p + 2] / 255; // B
  }

  return {
    tensor: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    scale,
    padX,
    padY,
  };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter || 1);
}

/**
 * Detects card types in an image file and returns their class names.
 *
 * @param {File|Blob} file
 * @returns {Promise<string[]>}
 */
export async function detectCards(file) {
  const session = await getSession();
  const bitmap = await createImageBitmap(file);
  try {
    const { tensor, scale, padX, padY } = await bitmapToTensor(bitmap);
    log('running inference…', { image: `${bitmap.width}x${bitmap.height}` });
    const results = await session.run({ [session.inputNames[0]]: tensor });
    const output = results[session.outputNames[0]]; // [1, 300, 6]
    const data = output.data;

    const detections = [];
    const count = output.dims[1] || 0;
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      const x1 = data[o];
      const y1 = data[o + 1];
      const x2 = data[o + 2];
      const y2 = data[o + 3];
      const conf = data[o + 4];
      const cls = Math.round(data[o + 5]);
      if (conf < MIN_CONFIDENCE || x2 <= x1 || y2 <= y1) continue;

      detections.push({
        cls,
        conf,
        box: [
          (x1 - padX) / scale,
          (y1 - padY) / scale,
          (x2 - padX) / scale,
          (y2 - padY) / scale,
        ],
      });
    }

    // Highest confidence first, then class-agnostic NMS to drop duplicate
    // labels that land on the same card (e.g. flip vs wild_draw_until).
    detections.sort((a, b) => b.conf - a.conf);
    const kept = [];
    for (const det of detections) {
      if (!kept.some((k) => iou(k.box, det.box) > NMS_IOU)) {
        kept.push(det);
      }
    }

    const names = kept.map((det) => CLASS_NAMES[det.cls] ?? String(det.cls));
    log('detection complete', { count: names.length, cards: names });
    return names;
  } catch (err) {
    log('inference failed', { error: err.message });
    throw err;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
