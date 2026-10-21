// Photo helpers shared by the camera capture and the detector.
//
// A phone camera photo is 3-12 megapixels: decoded to RGBA that is up to
// ~48 MB of pixels. Together with the detector's model and WASM runtime that
// is enough for the browser to be killed on a low-memory phone - and the user
// sees it as the page reloading the moment the camera closes. Every photo is
// therefore scaled down to MAX_PHOTO_EDGE before anything else touches it.

/** The long edge of the photo that gets analysed, in pixels. */
export const MAX_PHOTO_EDGE = 1280;

/**
 * The size a photo is scaled to so that it fits in a `maxEdge` box. The
 * aspect ratio is kept and photos that already fit are left alone.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_PHOTO_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decodes a photo file into a bitmap that is at most `maxEdge` pixels on its
 * long edge. The browser scales while decoding, so the full-resolution pixels
 * are never held in memory.
 */
export async function decodePhoto(
  file: Blob,
  maxEdge: number = MAX_PHOTO_EDGE,
): Promise<ImageBitmap> {
  try {
    // Only resizeWidth is given, so the height follows from the aspect ratio.
    return await createImageBitmap(file, { resizeWidth: maxEdge, resizeQuality: 'high' });
  } catch {
    // Browsers that do not know the resize options (or that reject them)
    // decode the photo as it is.
    return await createImageBitmap(file);
  }
}

/** Encodes a bitmap as a JPEG blob, for the preview and for re-use. */
export function bitmapToJpeg(bitmap: ImageBitmap, quality = 0.9): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('2D canvas is not available'));
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the photo'))),
      'image/jpeg',
      quality,
    );
  });
}
