export interface BoxedDetection {
  box: number[];
}

const centerY = (box: number[]) => (box[1] + box[3]) / 2;
const height = (box: number[]) => box[3] - box[1];

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Orders detections the way a person reads a page: rows from top to bottom,
 * and cards from left to right within each row.
 *
 * Rows are detected by comparing vertical centers, with a tolerance based on
 * the median card height, so slightly rotated or fanned cards still end up on
 * the same row instead of being split by tiny differences in their top edge.
 */
export function sortByReadingOrder<T extends BoxedDetection>(detections: T[]): T[] {
  if (detections.length < 2) return [...detections];

  const rowTolerance = Math.max(median(detections.map((det) => height(det.box))) * 0.5, 1);

  const rows: Array<{ centerY: number; items: T[] }> = [];
  const byTop = [...detections].sort(
    (a, b) => centerY(a.box) - centerY(b.box) || a.box[0] - b.box[0],
  );

  for (const detection of byTop) {
    const detectionY = centerY(detection.box);
    const row = rows[rows.length - 1];
    if (row && Math.abs(detectionY - row.centerY) <= rowTolerance) {
      row.items.push(detection);
      row.centerY = row.items.reduce((sum, item) => sum + centerY(item.box), 0) / row.items.length;
    } else {
      rows.push({ centerY: detectionY, items: [detection] });
    }
  }

  return rows.flatMap((row) =>
    row.items.sort(
      (a, b) =>
        a.box[0] - b.box[0] || a.box[1] - b.box[1] || a.box[2] - b.box[2] || a.box[3] - b.box[3],
    ),
  );
}
