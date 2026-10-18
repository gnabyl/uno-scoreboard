// UNO Flip scoring rules:
//   Number cards (0-9)  -> face value
//   Skip / Skip All / Reverse / Flip / Draw One / Draw Five -> 20 points
//   Wild / Wild Draw Two / Wild Draw Until -> 50 points
//
// Card names come from the in-browser detector (src/api/localModel.js) as
// class names like "7", "skip", "wild_color", "draw_five". Matching below is
// deliberately tolerant (hyphens, spaces, colour prefixes, "+2", etc.).

/**
 * Returns the point value for a single detected card name.
 *
 * @param {string} name
 * @returns {number}
 */
export function scoreForCard(name: string): number {
  const raw = String(name ?? '').trim();
  if (!raw) return 0;

  const text = raw.toLowerCase().replace(/[-_/]+/g, ' ');

  // Wild cards are 50 points (check before action cards, since
  // "wild draw four" also contains the word "draw").
  if (/wild|\+4|draw\s*four|draw\s*4/.test(text)) return 50;

  // Action cards are 20 points (check before numbers, since
  // "draw 2" contains a digit).
  if (/skip|reverse|flip|draw\s*(one|two|five|1|2|5)|\+2/.test(text)) return 20;

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
export function computeScore(cardNames: string[]): number {
  if (!Array.isArray(cardNames)) return 0;
  return cardNames.reduce((total, name) => total + scoreForCard(name), 0);
}
