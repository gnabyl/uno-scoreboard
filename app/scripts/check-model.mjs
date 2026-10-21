// One-off check: can onnxruntime-web (the runtime the app uses) create a
// session for the exported model and run it?
//
//   node scripts/check-model.mjs [letterboxed-pixels.rgb]
//
// The optional file is a raw 640x640x3 RGB dump (as the app letterboxes it),
// which prints the detections the graph returns.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-web');

const dist = join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist');
ort.env.wasm.wasmPaths = new URL(`file:///${dist.replace(/\\/g, '/')}/`).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const model = readFileSync(join(process.cwd(), 'public', 'model', 'uno-flip-detector.onnx'));

const session = await ort.InferenceSession.create(model, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
console.log('session created');
console.log('inputs', session.inputNames, 'outputs', session.outputNames);

const input = new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
const started = Date.now();
const results = await session.run({ [session.inputNames[0]]: input });
const output = results[session.outputNames[0]];
console.log('ran in', Date.now() - started, 'ms');
console.log('output dims', output.dims);

// With an image: the letterboxed pixels, dumped by the python helper.
const image = process.argv[2];
if (image) {
  const pixels = readFileSync(image);
  const data = new Float32Array(3 * 640 * 640);
  for (let i = 0; i < 640 * 640; i++) {
    data[i] = pixels[i * 3] / 255;
    data[640 * 640 + i] = pixels[i * 3 + 1] / 255;
    data[2 * 640 * 640 + i] = pixels[i * 3 + 2] / 255;
  }
  const real = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, 640, 640]),
  });
  const rows = real[session.outputNames[0]].data;
  const kept = [];
  for (let i = 0; i < 300; i++) {
    const o = i * 7;
    if (rows[o + 4] > 0.25) kept.push([...rows.slice(o, o + 7)].map((v) => Number(v.toFixed(3))));
  }
  console.log('detections (cx, cy, w, h, conf, cls, angle):');
  for (const row of kept) console.log(' ', row.join('\t'));
}
