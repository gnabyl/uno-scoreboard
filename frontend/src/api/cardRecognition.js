// Card-recognition client.
//
// Runs the UNO Flip detector (YOLOv8n, exported to ONNX with NMS baked in)
// entirely in the browser via onnxruntime-web. No server or API key needed —
// the model URL is resolved from /api/model in production and falls back
// to the local copy in /public/model for development.

import { detectCards } from './localModel';

/**
 * Recognises cards in a photo.
 *
 * @param {File|Blob} imageFile
 * @returns {Promise<{ cards: string[], detections: Array, width: number, height: number }>}
 */
export async function recognizeCards(imageFile) {
  return detectCards(imageFile);
}
