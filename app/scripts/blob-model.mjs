// Manages the private model blob that `api/model.ts` signs.
//
//   node scripts/blob-model.mjs list
//   node scripts/blob-model.mjs download [filename]   # back the live model up
//   node scripts/blob-model.mjs put                   # upload public/model/uno-flip-detector.onnx
//
// The token comes from `.env` (BLOB_READ_WRITE_TOKEN).
import { readFileSync, writeFileSync } from 'node:fs';
import { list, put, head, issueSignedToken, presignUrl } from '@vercel/blob';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const index = trimmed.indexOf('=');
  if (index === -1) continue;
  env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
}

const token = env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error('BLOB_READ_WRITE_TOKEN missing');

const PATHNAME = 'uno-flip-detector.onnx';

const action = process.argv[2] ?? 'list';

if (action === 'list') {
  const { blobs } = await list({ token, prefix: 'uno-flip' });
  for (const blob of blobs) {
    console.log(blob.pathname, blob.size, blob.uploadedAt, blob.downloadUrl);
  }
} else if (action === 'head') {
  console.log(await head(PATHNAME, { token }));
} else if (action === 'download') {
  // Saves the live model to ../weights/ so it can be put back if the new
  // one turns out to be worse.
  const target = new URL(
    `../../weights/${process.argv[3] ?? 'uno-flip-detector-backup.onnx'}`,
    import.meta.url,
  );
  const signedToken = await issueSignedToken({
    token,
    pathname: PATHNAME,
    operations: ['get'],
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: 'get',
    pathname: PATHNAME,
    access: 'private',
  });
  const response = await fetch(presignedUrl);
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  console.log('saved', target.pathname);
} else if (action === 'put') {
  const body = readFileSync(new URL('../public/model/uno-flip-detector.onnx', import.meta.url));
  const result = await put(PATHNAME, body, {
    token,
    access: 'private',
    contentType: 'application/octet-stream',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  console.log('uploaded', result.pathname);
}
