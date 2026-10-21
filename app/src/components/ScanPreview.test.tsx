import { render } from '@testing-library/react';
import { vi } from 'vitest';
import ScanPreview from './ScanPreview';
import type { Detection } from '../api-helper/localModel';

function fakeContext() {
  const calls: string[] = [];
  let strokeStyle = '';
  let fillStyle = '';
  return {
    calls,
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(value: string) {
      strokeStyle = value;
      calls.push(`strokeStyle:${value}`);
    },
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
      calls.push(`fillStyle:${value}`);
    },
    lineWidth: 0,
    font: '',
    measureText: (text: string) => ({ width: text.length * 8 }),
    drawImage: () => calls.push('drawImage'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    closePath: () => calls.push('closePath'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    fillText: (text: string) => calls.push(`fillText:${text}`),
  };
}

class FakeImage {
  onload: (() => void) | null = null;
  set src(_value: string) {
    this.onload?.();
  }
}

const detection = (name: string, conf: number, x: number): Detection => ({
  name,
  conf,
  box: [x, 0, x + 40, 60],
  corners: [
    { x, y: 0 },
    { x: x + 40, y: 0 },
    { x: x + 40, y: 60 },
    { x, y: 60 },
  ],
});

const props = {
  url: 'blob:preview',
  width: 640,
  height: 480,
  label: '2 cards',
  detections: [detection('reverse', 0.96, 10), detection('draw_five', 0.5, 100)],
  alt: 'Captured cards',
};

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeContext() as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('draws the photo and the count, but no boxes', () => {
  const ctx = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );

  render(<ScanPreview {...props} showBoxes={false} />);

  expect(ctx.calls).toContain('drawImage');
  expect(ctx.calls).toContain('fillText:2 cards');
  expect(ctx.calls.filter((call) => call === 'beginPath')).toHaveLength(0);
});

test('draws one box per card when they are shown', () => {
  const ctx = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );

  render(<ScanPreview {...props} showBoxes />);

  expect(ctx.calls.filter((call) => call === 'beginPath')).toHaveLength(2);
  expect(ctx.calls).toContain('fillText:reverse 96%');
  expect(ctx.calls).toContain('fillText:draw_five 50%');
});

test('gives every box its own color', () => {
  const ctx = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );

  render(<ScanPreview {...props} showBoxes />);

  const colors = ctx.calls
    .filter((call) => call.startsWith('strokeStyle:'))
    .map((call) => call.slice('strokeStyle:'.length));
  // Two cards, two colors, plus the dark outline under each box.
  expect(new Set(colors).size).toBe(3);
});

test('redraws when the boxes are toggled', () => {
  const ctx = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );

  const { rerender } = render(<ScanPreview {...props} showBoxes={false} />);
  expect(ctx.calls.filter((call) => call === 'beginPath')).toHaveLength(0);

  rerender(<ScanPreview {...props} showBoxes />);
  expect(ctx.calls.filter((call) => call === 'beginPath')).toHaveLength(2);
});
