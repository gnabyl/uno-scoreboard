// Card-recognition API client (Roboflow hosted inference).
//
// Sends the captured image as a base64 body with the API key in the
// Authorization header, then maps detected objects to card names that
// `computeScore` in `unoScoring.js` understands.
//
// Configure via `.env` (see `.env.example`):
//   REACT_APP_CARD_API_URL=https://serverless.roboflow.com/uno-cards/3
//   REACT_APP_ROBOFLOW_API_KEY=your-key

const API_URL =
  process.env.REACT_APP_CARD_API_URL ||
  'https://serverless.roboflow.com/uno-cards/3';

const API_KEY = process.env.REACT_APP_ROBOFLOW_API_KEY || '';

// Ignore detections below this confidence. Tune via .env if needed.
const MIN_CONFIDENCE = parseFloat(process.env.REACT_APP_MIN_CONFIDENCE || '0.5');

/**
 * Sends a photo of a player's remaining cards to the recognition API and
 * returns the list of detected card names.
 *
 * @param {File|Blob} imageFile
 * @returns {Promise<string[]>} detected card names
 */
export async function recognizeCards(imageFile) {
  if (!API_KEY) {
    throw new Error(
      'Roboflow API key is missing. Add REACT_APP_ROBOFLOW_API_KEY to your .env file.'
    );
  }

  const base64 = await fileToBase64(imageFile);

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: base64,
  });

  if (!response.ok) {
    throw new Error(`Recognition failed (${response.status})`);
  }

  const data = await response.json();
  return normalizeResponse(data);
}

/**
 * Reads an image file as a raw base64 string (no data URL prefix, no
 * whitespace), matching the `base64 < image | curl -d @-` flow.
 *
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result.split(',')[1].replace(/\s+/g, ''));
      } else {
        reject(new Error('Failed to read the image.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read the image.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Extracts an array of card-name strings from the Roboflow inference JSON.
 * Roboflow returns `predictions` with a `class` field per detection; a few
 * generic shapes are also tolerated for flexibility.
 *
 * @param {unknown} data
 * @returns {string[]}
 */
function normalizeResponse(data) {
  if (data && Array.isArray(data.predictions)) {
    return data.predictions
      .filter(
        (p) => typeof p?.confidence !== 'number' || p.confidence >= MIN_CONFIDENCE
      )
      .map((p) => p?.class ?? p?.label ?? p?.name ?? '')
      .filter((name) => name);
  }

  if (Array.isArray(data)) {
    return data.map((item) =>
      typeof item === 'string' ? item : item?.name ?? item?.label ?? ''
    );
  }

  if (data && typeof data === 'object') {
    const source =
      data.cards ?? data.detections ?? data.labels ?? data.results ?? [];
    return normalizeResponse(source);
  }

  return [];
}
