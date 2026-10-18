import { getDownloadUrl } from '@vercel/blob';

export default async function handler(req, res) {
  // Vercel Blob store subdomain is the store id minus the `store_` prefix,
  // lowercased. e.g. `store_jUoqfwEFha3GrMGK` -> `juoqfwefha3grmgk`.
  const store = (process.env.BLOB_STORE_ID || '')
    .replace(/^store_/, '')
    .toLowerCase();
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!store || !token) {
    return res.status(500).json({
      error: 'Blob env vars missing (BLOB_STORE_ID / BLOB_READ_WRITE_TOKEN)',
    });
  }

  const url = `https://${store}.private.blob.vercel-storage.com/uno-flip-detector.onnx`;

  try {
    const signedUrl = await getDownloadUrl(url, {
      token,
      expiresIn: 3600, // seconds (1 hour)
    });
    return res.status(200).json({ url: signedUrl });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to sign model URL' });
  }
}