import { head, issueSignedToken, presignUrl } from '@vercel/blob';

const MODEL_PATH = 'uno-flip-detector.onnx';

export default async function handler(req: any, res: any) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN env var missing' });
  }

  try {
    // Mint a short-lived read delegation, then presign the GET URL. Note:
    // `getDownloadUrl` does NOT sign - it only appends ?download=1, so we use
    // issueSignedToken + presignUrl for private blobs.
    const signedToken = await issueSignedToken({
      token,
      pathname: MODEL_PATH,
      operations: ['get'],
    });
    const { presignedUrl } = await presignUrl(signedToken, {
      operation: 'get',
      pathname: MODEL_PATH,
      access: 'private',
    });
    const { size, uploadedAt } = await head(MODEL_PATH, { token });
    // `uploadedAt` + `size` are the model's version: the browser caches the
    // download under it, so uploading a new model invalidates the cache
    // without anyone having to bump a number.
    return res.status(200).json({ url: presignedUrl, size, uploadedAt });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to sign model URL' });
  }
}
