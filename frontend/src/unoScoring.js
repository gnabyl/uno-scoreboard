// UNO scoring rules (standard):
//   Number cards (0-9)  -> face value
//   Skip / Reverse / Draw Two -> 20 points
//   Wild / Wild Draw Four -> 50 points
//
// The Roboflow "uno-cards" model returns numeric labels "0"-"14":
//   0-9   -> number cards (face value)
//   10-14 -> special cards (mapped below)
const SPECIAL_CLASS_POINTS = {
  10: 50, // Wild Draw Four
  11: 20, // Draw Two
  12: 20, // Reverse
  13: 20, // Skip
  14: 50, // Wild (change color)
};

/**
 * Returns the point value for a single detected card name.
 * The name can be anything the recognition API returns, e.g.
 * "red 7", "blue skip", "wild draw four", "yellow draw 2".
 *
 * @param {string} name
 * @returns {number}
 */
export function scoreForCard(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return 0;

  // Numeric special-card labels from the model (e.g. "10", "14").
  const special = SPECIAL_CLASS_POINTS[raw];
  if (special !== undefined) return special;

  const text = raw.toLowerCase().replace(/[-_/]+/g, ' ');

  // Wild cards are 50 points (check before action cards, since
  // "wild draw four" also contains the word "draw").
  if (/wild|\+4|draw\s*four|draw\s*4/.test(text)) return 50;

  // Action cards are 20 points (check before numbers, since
  // "draw 2" contains a digit).
  if (/skip|reverse|draw\s*two|draw\s*2|\+2/.test(text)) return 20;

  // Number cards score their face value.
  const digit = text.match(/\b(\d)\b/) || text.match(/(\d)/);
  if (digit) return Number(digit[1]);

  return 0;
}

/**
 * Sums the point values of a list of detected card names.
 *
 * @param {string[]} cardNames
 * @returns {number}
 */
export function computeScore(cardNames) {
  if (!Array.isArray(cardNames)) return 0;
  return cardNames.reduce((total, name) => total + scoreForCard(name), 0);
}
