export type RectLike = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  groupId?: string;
};

export type SelectionBounds = {
  x: number;
  y: number;
  w: number;
  h: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

export type AlignMode =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom";

export type DistributeAxis = "horizontal" | "vertical";

export function selectionBounds<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>
): SelectionBounds | null {
  const selected = new Set(ids);
  const items = elements.filter((element) => selected.has(element.id));
  if (!items.length) return null;

  const x = Math.min(...items.map((item) => item.x));
  const y = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.w));
  const bottom = Math.max(...items.map((item) => item.y + item.h));

  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
    right,
    bottom,
    centerX: (x + right) / 2,
    centerY: (y + bottom) / 2
  };
}

export function expandSelectionForGroups<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>
): string[] {
  const selected = new Set(ids);
  const groups = new Set(
    elements
      .filter((element) => selected.has(element.id) && element.groupId)
      .map((element) => element.groupId as string)
  );

  if (!groups.size) return [...selected];

  for (const element of elements) {
    if (element.groupId && groups.has(element.groupId)) selected.add(element.id);
  }
  return [...selected];
}

export function selectionFromClickedElement<T extends RectLike>(
  elements: T[],
  clickedId: string
): string[] {
  const clicked = elements.find((element) => element.id === clickedId);
  if (!clicked?.groupId) return [clickedId];
  return elements
    .filter((element) => element.groupId === clicked.groupId)
    .map((element) => element.id);
}

export function alignSelection<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>,
  mode: AlignMode,
  frame = { x: 0, y: 0, w: 960, h: 540 }
): T[] {
  const selected = new Set(ids);
  if (!selected.size) return elements;

  const bounds = selectionBounds(elements, selected);
  if (!bounds) return elements;

  return elements.map((element) => {
    if (!selected.has(element.id)) return element;

    let x = element.x;
    let y = element.y;

    if (mode === "left") x = bounds.x;
    if (mode === "center") x = bounds.centerX - element.w / 2;
    if (mode === "right") x = bounds.right - element.w;
    if (mode === "top") y = bounds.y;
    if (mode === "middle") y = bounds.centerY - element.h / 2;
    if (mode === "bottom") y = bounds.bottom - element.h;

    return {
      ...element,
      x: Math.max(frame.x, Math.min(frame.x + frame.w - element.w, x)),
      y: Math.max(frame.y, Math.min(frame.y + frame.h - element.h, y))
    };
  });
}

export function alignSelectionToSlide<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>,
  mode: AlignMode,
  frame = { x: 0, y: 0, w: 960, h: 540 }
): T[] {
  const selected = new Set(ids);
  if (!selected.size) return elements;

  return elements.map((element) => {
    if (!selected.has(element.id)) return element;

    let x = element.x;
    let y = element.y;

    if (mode === "left") x = frame.x;
    if (mode === "center") x = frame.x + (frame.w - element.w) / 2;
    if (mode === "right") x = frame.x + frame.w - element.w;
    if (mode === "top") y = frame.y;
    if (mode === "middle") y = frame.y + (frame.h - element.h) / 2;
    if (mode === "bottom") y = frame.y + frame.h - element.h;

    return { ...element, x, y };
  });
}

export function distributeSelection<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>,
  axis: DistributeAxis
): T[] {
  const selected = new Set(ids);
  const items = elements
    .filter((element) => selected.has(element.id))
    .sort((a, b) => axis === "horizontal" ? a.x - b.x : a.y - b.y);

  if (items.length < 3) return elements;

  const first = items[0];
  const last = items[items.length - 1];
  const occupied = items.reduce(
    (sum, item) => sum + (axis === "horizontal" ? item.w : item.h),
    0
  );
  const span = axis === "horizontal"
    ? last.x + last.w - first.x
    : last.y + last.h - first.y;
  const gap = (span - occupied) / (items.length - 1);

  const positions = new Map<string, number>();
  let cursor = axis === "horizontal" ? first.x : first.y;

  for (const item of items) {
    positions.set(item.id, cursor);
    cursor += (axis === "horizontal" ? item.w : item.h) + gap;
  }

  return elements.map((element) => {
    const position = positions.get(element.id);
    if (position === undefined) return element;
    return axis === "horizontal"
      ? { ...element, x: position }
      : { ...element, y: position };
  });
}

export function groupSelection<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>,
  groupId: string
): T[] {
  const selected = new Set(ids);
  return elements.map((element) =>
    selected.has(element.id) ? { ...element, groupId } : element
  );
}

export function ungroupSelection<T extends RectLike>(
  elements: T[],
  ids: Iterable<string>
): T[] {
  const selected = new Set(ids);
  const groupIds = new Set(
    elements
      .filter((element) => selected.has(element.id) && element.groupId)
      .map((element) => element.groupId as string)
  );

  return elements.map((element) =>
    element.groupId && groupIds.has(element.groupId)
      ? { ...element, groupId: undefined }
      : element
  );
}

export function clampRectToFrame<T extends RectLike>(
  element: T,
  frame = { x: 0, y: 0, w: 960, h: 540 }
): T {
  const w = Math.max(1, Math.min(frame.w, element.w));
  const h = Math.max(1, Math.min(frame.h, element.h));
  return {
    ...element,
    w,
    h,
    x: Math.max(frame.x, Math.min(frame.x + frame.w - w, element.x)),
    y: Math.max(frame.y, Math.min(frame.y + frame.h - h, element.y))
  };
}
