// In-browser UNO Flip card detection via onnxruntime-web.
//
// The model was exported from ultralytics with `nms=True`, so its output is
// already a flat list of detections: shape (1, 300, 7) where each row is
// [cx, cy, w, h, confidence, class_index, angle] in 640x640 input space. The
// boxes are rotated (OBB), because the cards in a hand are fanned.
//
// We letterbox-resize the image to 640x640 (same as training), run the
// session, then map boxes back to the original image coordinates. The NMS
// baked into the graph is class-wise, so one card read as two different
// classes survives twice; a class-agnostic pass over the rotated boxes
// collapses those into a single card.
//
// The older axis-aligned model (6 columns per row) is still understood, so
// the app keeps working against either export.

import * as ort from 'onnxruntime-web';

import { log, progress } from './debugLog';
import { sortByReadingOrder } from '../lib/cardOrdering';
import { dedupeDetections, readDetections } from '../lib/detections';
import {
  clearModelCache,
  getCachedModel,
  modelVersion,
  putCachedModel,
  shouldUseCachedModel,
} from '../lib/modelCache';
import { bounds, type Point } from '../lib/rotatedBox';
import { bitmapToJpeg, decodePhoto } from '../lib/photo';

const INPUT_SIZE = 640;
const DEFAULT_CONFIDENCE = 0.25;

/** The model bytes, and where they came from. */
interface ModelBytes {
  bytes: Uint8Array;
  /** True when the bytes came from the browser's cache. */
  fromCache: boolean;
}

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
  import.meta.env.VITE_MIN_CONFIDENCE || String(DEFAULT_CONFIDENCE),
);

/** One detected card, with its box mapped back to original image coordinates. */
export interface Detection {
  name: string;
  conf: number;
  /** Axis-aligned bounds in original image coordinates: [x1, y1, x2, y2]. */
  box: number[];
  /** The four corners of the card, in original image coordinates. */
  corners: Point[];
}

export interface DetectionResult {
  cards: string[];
  detections: Detection[];
  width: number;
  height: number;
  /**
   * The photo that was analysed, scaled down to a size a phone can hold.
   * Reuse it for the preview so the preview shows exactly what was read.
   */
  image?: Blob;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function fetchModelBuffer(): Promise<ModelBytes> {
  // Production: ask the Vercel function for a fresh signed URL, then download
  // the bytes ourselves. Fetching explicitly keeps the signed query string
  // intact and lets us log download progress before handing bytes to
  // onnxruntime-web.
  let remote: { url: string; size: number; version: string } | null = null;
  try {
    const res = await fetch('/api/model');
    if (res.ok) {
      const data = await res.json();
      if (typeof data.url === 'string' && data.url) {
        log('signed model URL received from /api/model');
        remote = {
          url: data.url,
          size: data.size,
          version: modelVersion(data.uploadedAt, data.size),
        };
      }
    } else {
      log('no signed URL from /api/model, falling back to local file');
    }
  } catch (err) {
    log('failed to fetch /api/model', { error: err.message });
  }

  // The model is 10 MB, so it is worth keeping: reuse the cached copy when
  // the server offers the same version.
  const cached = await getCachedModel();
  if (remote && cached && shouldUseCachedModel(cached.version, remote.version)) {
    log('model loaded from cache', { bytes: cached.bytes.byteLength });
    return { bytes: new Uint8Array(cached.bytes), fromCache: true };
  }

  if (remote) {
    const bytes = await downloadModel(remote.url, remote.size);
    await putCachedModel(remote.version, toArrayBuffer(bytes));
    return { bytes, fromCache: false };
  }

  // Development (plain `npm start`): the file is served from public/.
  const localUrl = `${import.meta.env.PUBLIC_URL || ''}/model/uno-flip-detector.onnx`;
  const version = await localModelVersion(localUrl);
  if (cached && shouldUseCachedModel(cached.version, version)) {
    log('model loaded from cache', { bytes: cached.bytes.byteLength });
    return { bytes: new Uint8Array(cached.bytes), fromCache: true };
  }
  const bytes = await downloadModel(localUrl);
  if (version) await putCachedModel(version, toArrayBuffer(bytes));
  return { bytes, fromCache: false };
}

/** The size of the local model file, used as its version in development. */
async function localModelVersion(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return '';
    const length = Number(res.headers.get('Content-Length')) || 0;
    return length ? modelVersion('dev', length) : '';
  } catch {
    return '';
  }
}

/** A standalone copy of the bytes, so it can be stored in IndexedDB. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function downloadModel(url: string, knownSize: number | string = 0) {
  progress('download', 'downloading model…');
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`model download failed (HTTP ${res.status})`);
  }

  // Total size: prefer Content-Length, fall back to the size returned by
  // /api/model (blob metadata) so we can always show a percentage.
  const total = Number(res.headers.get('Content-Length')) || Number(knownSize) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastPct = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        progress('download', 'downloading model…', { progress: `${pct}%` });
      }
    }
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  log('model downloaded', { bytes: buffer.byteLength });
  return buffer;
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // TEMP (for testing): force a load failure by visiting ?simulateError=1
      if (typeof window !== 'undefined' && window.location.search.includes('simulateError')) {
        throw new Error('Simulated model load failure');
      }
      // The ~20 MB of WASM runtime files are fetched from the pinned CDN so
      // they don't need to be committed to the repo.
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
      const { bytes, fromCache } = await fetchModelBuffer();
      progress('session', 'loading ONNX session…', {
        providers: ['webgl', 'wasm'],
      });
      const t0 = performance.now();
      // Heartbeat: onnxruntime-web downloads its WASM runtime inside
      // create() and doesn't expose progress, so tick elapsed time to show
      // the app isn't stuck.
      const heartbeat = window.setInterval(() => {
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        progress('session', 'loading ONNX session…', { elapsed: `${secs}s` });
      }, 500);
      try {
        const session = await createSession(bytes);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        log('ONNX session ready', { time: `${secs}s` });
        return session;
      } catch (err) {
        if (!fromCache) {
          log('ONNX session failed', { error: err.message });
          throw err;
        }
        // The cached copy may be truncated or corrupt: drop it and fetch the
        // model again before giving up.
        log('cached model failed to load, downloading it again', { error: err.message });
        await clearModelCache();
        const fresh = await fetchModelBuffer();
        const session = await createSession(fresh.bytes);
        log('ONNX session ready', { time: `${((performance.now() - t0) / 1000).toFixed(1)}s` });
        return session;
      } finally {
        window.clearInterval(heartbeat);
      }
    })();
  }
  return sessionPromise;
}

function createSession(bytes: Uint8Array) {
  return ort.InferenceSession.create(bytes, {
    executionProviders: ['webgl', 'wasm'],
    graphOptimizationLevel: 'all',
  });
}

/**
 * Starts loading the ONNX model immediately (rather than waiting for the
 * first scan). Safe to call multiple times - the session is cached.
 * Resolves once the session is ready, or rejects if loading failed.
 */
export function preloadModel() {
  return getSession();
}

async function bitmapToTensor(bitmap: ImageBitmap) {
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

/**
 * Detects card types in an image file.
 */
export async function detectCards(file: Blob): Promise<DetectionResult> {
  const session = await getSession();
  // The photo is decoded straight to a bounded size: a full-resolution camera
  // shot is ~48 MB of pixels, which is enough to get the browser killed on a
  // phone - the user would see the page reload instead of the result.
  const bitmap = await decodePhoto(file);
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    const { tensor, scale, padX, padY } = await bitmapToTensor(bitmap);
    log('running inference…', { image: `${bitmap.width}x${bitmap.height}` });
    const results = await session.run({ [session.inputNames[0]]: tensor });
    // The output is a float32 tensor of shape [1, 300, 7] (rotated model).
    const output = results[session.outputNames[0]] as ort.TypedTensor<'float32'>;
    const data = output.data;
    const columns = output.dims[2] || 6;

    const raw = dedupeDetections(
      readDetections(data, output.dims[1] || 0, columns, MIN_CONFIDENCE),
    );

    // Map the corners back to the original image. The letterbox scales both
    // axes by the same factor, so the rotation is unchanged.
    const detections = raw.map((detection) => {
      const points = detection.corners.map((point) => ({
        x: (point.x - padX) / scale,
        y: (point.y - padY) / scale,
      }));
      return {
        cls: detection.cls,
        conf: detection.conf,
        box: bounds(points),
        corners: points,
      };
    });

    // Present cards in reading order (rows top to bottom, cards left to
    // right) so the scan list matches how they appear in the photo. Each
    // detection is one full card.
    const ordered = sortByReadingOrder(detections);

    const annotations = ordered.map((det) => ({
      name: CLASS_NAMES[det.cls] ?? String(det.cls),
      conf: det.conf,
      box: det.box,
      corners: det.corners,
    }));
    const cards = annotations.map((det) => det.name);
    // The preview reuses this copy, so the full-resolution photo never has to
    // be decoded a second time. A preview that cannot be encoded is not
    // worth losing the detection over.
    let image: Blob | undefined;
    try {
      image = await bitmapToJpeg(bitmap);
    } catch (err) {
      log('could not encode the preview image', { error: err.message });
    }
    log('detection complete', { count: cards.length, cards });
    return { cards, detections: annotations, width, height, image };
  } catch (err) {
    log('inference failed', { error: err.message });
    throw err;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
