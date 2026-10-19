import type { Scoreboard } from './scoreboard';

/**
 * Canvas-drawn PNG scoreboard.
 *
 * The image is drawn by hand instead of screenshotting the DOM so it stays
 * crisp at any size, needs no extra dependency, and cannot pick up focus rings,
 * scrollbars or hover states from the live board.
 */

const FONT_STACK = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO_STACK = '"SF Mono", Consolas, Menlo, monospace';

const COLORS = {
  background: '#0b0f18',
  panel: '#151b28',
  altRow: '#121928',
  header: '#0f1521',
  total: '#101a2a',
  edge: '#2c3444',
  edgeSoft: '#202738',
  grid: '#273043',
  fg: '#e7ecf5',
  muted: '#9aa4b8',
  faint: '#5b6478',
  green: '#7dff9a',
  accent: '#4c9aff',
};

const DOT_COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#4c9aff'];

const SIZES = {
  title: 30,
  meta: 15,
  header: 14,
  body: 16,
  total: 17,
  footer: 13,
};

const LAYOUT = {
  pad: 40,
  radius: 18,
  cellPad: 16,
  headerHeight: 54,
  rowHeight: 46,
  totalHeight: 52,
  roundColumnMin: 72,
  playerColumnMin: 132,
  playerColumnMax: 220,
  dot: 10,
  dotGap: 8,
  maxCanvasPx: 12000,
};

const FONTS = {
  title: `800 ${SIZES.title}px ${FONT_STACK}`,
  meta: `600 ${SIZES.meta}px ${FONT_STACK}`,
  mono: `700 ${SIZES.meta}px ${MONO_STACK}`,
  header: `800 ${SIZES.header}px ${FONT_STACK}`,
  body: `600 ${SIZES.body}px ${FONT_STACK}`,
  total: `800 ${SIZES.total}px ${FONT_STACK}`,
  footer: `500 ${SIZES.footer}px ${FONT_STACK}`,
};

export interface ScoreboardPngLabels {
  /** Header of the round-number column, e.g. "Round". */
  round: string;
  /** Label of the totals row, e.g. "Total". */
  total: string;
}

export interface ScoreboardPngOptions {
  scoreboard: Scoreboard;
  code: string;
  /** App title, localized. */
  title: string;
  /** Localized "Generated <date>" line. */
  generated: string;
  /** Localized footer note; may contain the room code. */
  footer: string;
  labels: ScoreboardPngLabels;
}

export interface ScoreboardLayout {
  scale: number;
  cssWidth: number;
  cssHeight: number;
  titleY: number;
  metaY: number;
  tableTop: number;
  tableHeight: number;
  tableBottom: number;
  footerY: number;
  roundColumnWidth: number;
  playerColumnWidth: number;
  /** Left edge of each player column, in CSS pixels. */
  playerColumnX: number[];
  nameMaxWidth: number;
}

export type MeasureText = (text: string, font: string) => number;

/** Minimal surface needed to produce a blob; keeps the export testable. */
export interface CanvasLike {
  toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  toDataURL: (type?: string) => string;
}

export interface ScoreboardExportDeps {
  render?: (options: ScoreboardPngOptions) => CanvasLike;
  save?: (blob: Blob, filename: string) => void;
  now?: () => Date;
}

const roundTo = (value: number) => Math.round(value * 100) / 100;

/**
 * Fits text into `maxWidth`, appending an ellipsis when it has to be shortened.
 * Works on both real canvas metrics and a stub in tests.
 */
export function fitText(
  text: string,
  maxWidth: number,
  measure: MeasureText,
  font: string,
): string {
  if (maxWidth <= 0 || measure(text, font) <= maxWidth) return text;

  const ellipsis = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, mid) + ellipsis, font) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? text.slice(0, low) + ellipsis : ellipsis;
}

/** `uno-scoreboard-ABC12345-2026-10-20.png` (local date). */
export function scoreboardFilename(code: string, date: Date): string {
  const safeCode =
    String(code ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '') || 'ROOM';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `uno-scoreboard-${safeCode}-${stamp}.png`;
}

/** Computes every position before a single pixel is drawn. */
export function layoutScoreboard(
  scoreboard: Scoreboard,
  labels: ScoreboardPngLabels,
  measure: MeasureText,
): ScoreboardLayout {
  const { players, rows } = scoreboard;

  const roundColumnWidth = Math.max(
    LAYOUT.roundColumnMin,
    Math.ceil(
      Math.max(
        measure(labels.round, FONTS.header),
        measure(labels.total, FONTS.total),
        ...rows.map((row) => measure(String(row.index), FONTS.body)),
      ),
    ) +
      LAYOUT.cellPad * 2,
  );

  const requiredNameWidth =
    Math.max(0, ...players.map((player) => measure(player.name, FONTS.header))) +
    LAYOUT.dot +
    LAYOUT.dotGap +
    LAYOUT.cellPad * 2;
  const playerColumnWidth = Math.min(
    LAYOUT.playerColumnMax,
    Math.max(LAYOUT.playerColumnMin, Math.ceil(requiredNameWidth)),
  );

  const tableHeight = LAYOUT.headerHeight + rows.length * LAYOUT.rowHeight + LAYOUT.totalHeight;
  const titleY = LAYOUT.pad + SIZES.title;
  const metaY = titleY + 12 + SIZES.meta;
  const tableTop = metaY + 30;
  const tableBottom = tableTop + tableHeight;
  const footerY = tableBottom + 28;

  const cssWidth = Math.max(
    LAYOUT.pad * 2 + roundColumnWidth + playerColumnWidth * players.length,
    LAYOUT.pad * 2 + roundColumnWidth + LAYOUT.playerColumnMin,
  );
  const cssHeight = footerY + 22;

  const scale = roundTo(
    Math.max(
      0.5,
      Math.min(
        2,
        LAYOUT.maxCanvasPx / Math.max(1, cssWidth),
        LAYOUT.maxCanvasPx / Math.max(1, cssHeight),
      ),
    ),
  );

  return {
    scale,
    cssWidth,
    cssHeight,
    titleY,
    metaY,
    tableTop,
    tableHeight,
    tableBottom,
    footerY,
    roundColumnWidth,
    playerColumnWidth,
    playerColumnX: players.map(
      (_, index) => LAYOUT.pad + roundColumnWidth + index * playerColumnWidth,
    ),
    nameMaxWidth: playerColumnWidth - LAYOUT.dot - LAYOUT.dotGap - LAYOUT.cellPad * 2,
  };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }

  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string) {
  ctx.beginPath();
  ctx.arc(cx, cy, LAYOUT.dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

const centeredBaseline = (top: number, height: number, fontSize: number) =>
  top + height / 2 + fontSize * 0.35;

const formatScore = (value: number) => String(value);

function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  options: ScoreboardPngOptions,
  layout: ScoreboardLayout,
  measure: MeasureText,
) {
  const { scoreboard, code, title, generated, footer, labels } = options;
  const { rows, players } = scoreboard;
  const { roundColumnWidth, playerColumnWidth, playerColumnX } = layout;
  const pad = LAYOUT.pad;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, layout.cssWidth, layout.cssHeight);

  // ---- Header ----
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = FONTS.title;
  ctx.fillStyle = COLORS.fg;
  ctx.fillText(title, pad, layout.titleY);

  let metaX = pad;
  ctx.font = FONTS.mono;
  ctx.fillStyle = COLORS.accent;
  ctx.fillText(code, metaX, layout.metaY);
  metaX += measure(code, FONTS.mono) + 12;

  ctx.font = FONTS.meta;
  ctx.fillStyle = COLORS.faint;
  ctx.fillText('·', metaX, layout.metaY);
  metaX += 14;

  ctx.fillStyle = COLORS.muted;
  ctx.fillText(generated, metaX, layout.metaY);

  // ---- Table shell ----
  const tableX = pad;
  const tableW = layout.cssWidth - pad * 2;
  const bodyTop = layout.tableTop + LAYOUT.headerHeight;
  const totalTop = layout.tableBottom - LAYOUT.totalHeight;

  roundedRect(ctx, tableX, layout.tableTop, tableW, layout.tableHeight, LAYOUT.radius);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();

  ctx.save();
  ctx.clip();

  // Header band.
  ctx.fillStyle = COLORS.header;
  ctx.fillRect(tableX, layout.tableTop, tableW, LAYOUT.headerHeight);

  // Zebra body + totals band.
  rows.forEach((_, index) => {
    if (index % 2 === 1) {
      ctx.fillStyle = COLORS.altRow;
      ctx.fillRect(tableX, bodyTop + index * LAYOUT.rowHeight, tableW, LAYOUT.rowHeight);
    }
  });
  ctx.fillStyle = COLORS.total;
  ctx.fillRect(tableX, totalTop, tableW, LAYOUT.totalHeight);

  // Grid lines.
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let x = tableX + roundColumnWidth;
  while (x < tableX + tableW - 0.5) {
    ctx.moveTo(Math.round(x) + 0.5, layout.tableTop);
    ctx.lineTo(Math.round(x) + 0.5, layout.tableBottom);
    x += playerColumnWidth;
  }
  rows.forEach((_, index) => {
    if (index === 0) return;
    const lineY = Math.round(bodyTop + index * LAYOUT.rowHeight) + 0.5;
    ctx.moveTo(tableX, lineY);
    ctx.lineTo(tableX + tableW, lineY);
  });
  ctx.stroke();

  ctx.strokeStyle = COLORS.edge;
  ctx.beginPath();
  ctx.moveTo(tableX, Math.round(totalTop) + 0.5);
  ctx.lineTo(tableX + tableW, Math.round(totalTop) + 0.5);
  ctx.stroke();

  // ---- Header labels ----
  const headerBaseline = centeredBaseline(layout.tableTop, LAYOUT.headerHeight, SIZES.header);
  ctx.textAlign = 'center';
  ctx.font = FONTS.header;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(labels.round, tableX + roundColumnWidth / 2, headerBaseline);

  players.forEach((player, index) => {
    const columnX = playerColumnX[index];
    const name = fitText(player.name, layout.nameMaxWidth, measure, FONTS.header);
    const nameWidth = measure(name, FONTS.header);
    const groupWidth = LAYOUT.dot + LAYOUT.dotGap + nameWidth;
    const groupX = columnX + Math.max(LAYOUT.cellPad, (playerColumnWidth - groupWidth) / 2);
    const centerY = layout.tableTop + LAYOUT.headerHeight / 2;

    drawDot(ctx, groupX + LAYOUT.dot / 2, centerY, DOT_COLORS[index % DOT_COLORS.length]);

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.fg;
    ctx.fillText(name, groupX + LAYOUT.dot + LAYOUT.dotGap, headerBaseline);
  });

  // ---- Round rows ----
  rows.forEach((row, rowIndex) => {
    const top = bodyTop + rowIndex * LAYOUT.rowHeight;
    const baseline = centeredBaseline(top, LAYOUT.rowHeight, SIZES.body);
    const summary = scoreboard.byRound[row.id];

    ctx.textAlign = 'center';
    ctx.font = FONTS.body;
    ctx.fillStyle = COLORS.faint;
    ctx.fillText(String(row.index), tableX + roundColumnWidth / 2, baseline);

    row.cells.forEach((cell, columnIndex) => {
      const columnX = playerColumnX[columnIndex];
      if (cell.winner) {
        ctx.fillStyle = COLORS.green;
        ctx.font = FONTS.body;
        ctx.fillText(`+${Math.abs(summary?.sum ?? 0)}`, columnX + playerColumnWidth / 2, baseline);
      } else if (cell.value === null) {
        ctx.fillStyle = COLORS.faint;
        ctx.fillText('–', columnX + playerColumnWidth / 2, baseline);
      } else {
        ctx.fillStyle = COLORS.fg;
        ctx.fillText(formatScore(cell.value), columnX + playerColumnWidth / 2, baseline);
      }
    });
  });

  // ---- Totals row ----
  const totalBaseline = centeredBaseline(totalTop, LAYOUT.totalHeight, SIZES.total);
  ctx.textAlign = 'center';
  ctx.font = FONTS.total;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(labels.total, tableX + roundColumnWidth / 2, totalBaseline);

  players.forEach((player, index) => {
    const columnX = playerColumnX[index];
    const totalText = formatScore(player.total);
    const crown = player.leader ? '👑' : '';

    ctx.font = FONTS.total;
    const totalWidth = measure(totalText, FONTS.total);
    const crownGap = crown ? 8 : 0;
    const crownWidth = crown ? measure(crown, FONTS.total) : 0;
    const groupWidth = totalWidth + crownGap + crownWidth;
    const startX = columnX + (playerColumnWidth - groupWidth) / 2;

    ctx.textAlign = 'left';
    ctx.fillStyle = player.leader ? COLORS.green : COLORS.fg;
    ctx.fillText(totalText, startX, totalBaseline);
    if (crown) ctx.fillText(crown, startX + totalWidth + crownGap, totalBaseline);
  });

  ctx.restore();

  // Border last so it sits above the clipped fills.
  roundedRect(
    ctx,
    tableX + 0.5,
    layout.tableTop + 0.5,
    tableW - 1,
    layout.tableHeight - 1,
    LAYOUT.radius,
  );
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ---- Footer ----
  ctx.textAlign = 'left';
  ctx.font = FONTS.footer;
  ctx.fillStyle = COLORS.faint;
  ctx.fillText(footer, pad, layout.footerY);
}

/** Draws the scoreboard at device-pixel ratio 2 (or lower for very large boards). */
export function renderScoreboardCanvas(options: ScoreboardPngOptions): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const scratch = canvas.getContext('2d');
  if (!scratch) throw new Error('Canvas is not supported.');

  const measure: MeasureText = (text, font) => {
    scratch.font = font;
    return scratch.measureText(text).width;
  };

  const layout = layoutScoreboard(options.scoreboard, options.labels, measure);

  canvas.width = Math.max(1, Math.ceil(layout.cssWidth * layout.scale));
  canvas.height = Math.max(1, Math.ceil(layout.cssHeight * layout.scale));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported.');

  ctx.scale(layout.scale, layout.scale);
  // The context is reset when the canvas is resized, so rebuild the measurer.
  const drawMeasure: MeasureText = (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  drawScoreboard(ctx, options, layout, drawMeasure);

  return canvas;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** `toBlob` with a `toDataURL` fallback for older Safari. */
function canvasToBlob(canvas: CanvasLike): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))),
        'image/png',
      );
      return;
    }

    try {
      resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not create the image.'));
    }
  });
}

/** Triggers a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Renders the scoreboard and hands the PNG to the browser.
 * Returns the filename it used.
 */
export async function exportScoreboardPng(
  options: ScoreboardPngOptions,
  deps: ScoreboardExportDeps = {},
): Promise<string> {
  const render = deps.render ?? renderScoreboardCanvas;
  const save = deps.save ?? downloadBlob;
  const date = (deps.now ?? (() => new Date()))();

  const blob = await canvasToBlob(render(options));
  const filename = scoreboardFilename(options.code, date);
  save(blob, filename);
  return filename;
}
