export type FilterMenuPositionInput = {
  anchor: { left: number; right: number; top: number; bottom: number };
  viewport: {
    width: number;
    height: number;
    offsetLeft?: number;
    offsetTop?: number;
  };
  panelHeight: number;
  panelWidth?: number;
  margin?: number;
  gap?: number;
};

export type FilterMenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "top" | "bottom";
};

export function computeFilterMenuPosition(input: FilterMenuPositionInput): FilterMenuPosition {
  const { anchor, viewport } = input;
  const margin = Math.max(0, input.margin ?? 12);
  const gap = Math.max(0, input.gap ?? 8);
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);
  const insetX = Math.min(margin, viewportWidth / 2);
  const insetY = Math.min(margin, viewportHeight / 2);
  const leftEdge = (viewport.offsetLeft ?? 0) + insetX;
  const rightEdge = (viewport.offsetLeft ?? 0) + viewportWidth - insetX;
  const topEdge = (viewport.offsetTop ?? 0) + insetY;
  const bottomEdge = (viewport.offsetTop ?? 0) + viewportHeight - insetY;
  const width = Math.min(Math.max(0, input.panelWidth ?? 230), rightEdge - leftEdge);
  const height = Math.max(0, input.panelHeight);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const belowTop = clamp(anchor.bottom + gap, topEdge, bottomEdge);
  const aboveBottom = clamp(anchor.top - gap, topEdge, bottomEdge);
  const belowSpace = bottomEdge - belowTop;
  const aboveSpace = aboveBottom - topEdge;
  // Prefer below when it fits; otherwise use the side with the most room.
  const side = height <= belowSpace || belowSpace >= aboveSpace ? "bottom" : "top";
  const maxHeight = side === "bottom" ? belowSpace : aboveSpace;
  return {
    left: clamp(anchor.right - width, leftEdge, rightEdge - width),
    top: side === "bottom" ? belowTop : aboveBottom - Math.min(height, maxHeight),
    width,
    maxHeight,
    side,
  };
}
