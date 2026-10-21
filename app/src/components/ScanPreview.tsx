import { useEffect, useRef } from 'react';
import type { Detection } from '../api-helper/localModel';

/** The dark outline under a box, so it reads on a light photo too. */
const HALO = 'rgba(8, 12, 20, 0.75)';

/**
 * A vivid color per card. The hue walks the color wheel by the golden angle,
 * so even neighbouring boxes get colors that are far apart.
 */
function colorFor(index: number) {
  const hue = (index * 137.508) % 360;
  return {
    stroke: `hsl(${hue.toFixed(1)}, 92%, 62%)`,
    fill: `hsla(${hue.toFixed(1)}, 92%, 62%, 0.16)`,
  };
}

/**
 * Draws the rotated box of one card, with its name and confidence.
 */
function drawBox(
  ctx: CanvasRenderingContext2D,
  detection: Detection,
  index: number,
  lineWidth: number,
  fontSize: number,
) {
  const points = detection.corners;
  if (points.length < 3) return;

  const color = colorFor(index);

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = color.fill;
  ctx.fill();
  // Dark halo first, then the color on top: the box stays readable over a
  // white card and over a dark table.
  ctx.strokeStyle = HALO;
  ctx.lineWidth = lineWidth * 2.2;
  ctx.stroke();
  ctx.strokeStyle = color.stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const text = `${detection.name} ${Math.round(detection.conf * 100)}%`;

  ctx.font = `800 ${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(text).width;
  // Above the box when there is room, inside it otherwise.
  const labelTop = top - fontSize - 8 >= 0 ? top - fontSize - 8 : top + 4;
  ctx.fillStyle = 'rgba(10, 14, 22, 0.9)';
  ctx.fillRect(left, labelTop, textWidth + 10, fontSize + 8);
  ctx.fillStyle = color.stroke;
  ctx.fillText(text, left + 5, labelTop + fontSize);
}

/**
 * The scan preview: the captured photo, the number of cards, and - when
 * asked for - the rotated box of every card the detector found.
 */
export default function ScanPreview({
  url,
  width,
  height,
  label,
  detections,
  showBoxes,
  alt,
}: {
  url: string;
  width: number;
  height: number;
  label: string;
  detections: Detection[];
  showBoxes: boolean;
  alt: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The image loads asynchronously. If the effect runs again before it
    // finishes, the older load must not paint over the newer one - that
    // would leave boxes on the preview that no longer match the list.
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(image, 0, 0, width, height);

      if (showBoxes) {
        const lineWidth = Math.max(2, Math.round(Math.min(width, height) / 170));
        const fontSize = Math.max(15, Math.round(Math.min(width, height) / 30));
        detections.forEach((detection, index) => {
          drawBox(ctx, detection, index, lineWidth, fontSize);
        });
      }

      const fontSize = Math.max(20, Math.round(height / 26));
      ctx.font = `700 ${fontSize}px sans-serif`;
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15, 21, 33, 0.85)';
      ctx.fillRect(8, 8, textWidth + 14, fontSize + 10);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, 15, 8 + fontSize + 2);
    };
    image.src = url;

    return () => {
      cancelled = true;
    };
  }, [url, width, height, label, detections, showBoxes]);

  // The photo keeps its own shape. A portrait photo is sized by its height,
  // so it does not sit in a wide empty frame; a landscape photo fills the
  // width. Either way the whole picture is visible - never cropped, never
  // squashed, and never taller than the modal.
  const isPortrait = height > width;
  const ratio = height > 0 ? width / height : 1;

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      role="img"
      aria-label={alt}
      style={
        isPortrait
          ? {
              height: 'var(--preview-h)',
              width: `calc(var(--preview-h) * ${ratio.toFixed(4)})`,
              maxWidth: '100%',
            }
          : { width: '100%', height: 'auto' }
      }
      className="mx-auto h-auto max-w-full rounded-xl border border-edge bg-deep object-contain [--preview-h:38vh] sm:[--preview-h:55vh]"
    />
  );
}
