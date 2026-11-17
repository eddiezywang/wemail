export interface ComposeRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface ComposeViewport {
	width: number;
	height: number;
}

export const FLOATING_COMPOSE_MARGIN = 16;
export const MIN_FLOATING_COMPOSE_WIDTH = 320;
export const MIN_FLOATING_COMPOSE_HEIGHT = 260;

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

export function clampComposeRect(
	rect: ComposeRect,
	viewport: ComposeViewport,
): ComposeRect {
	const maxWidth = Math.max(1, viewport.width - FLOATING_COMPOSE_MARGIN * 2);
	const maxHeight = Math.max(1, viewport.height - FLOATING_COMPOSE_MARGIN * 2);
	const minWidth = Math.min(MIN_FLOATING_COMPOSE_WIDTH, maxWidth);
	const minHeight = Math.min(MIN_FLOATING_COMPOSE_HEIGHT, maxHeight);
	const width = clamp(rect.width, minWidth, maxWidth);
	const height = clamp(rect.height, minHeight, maxHeight);
	const maxX = Math.max(FLOATING_COMPOSE_MARGIN, viewport.width - FLOATING_COMPOSE_MARGIN - width);
	const maxY = Math.max(FLOATING_COMPOSE_MARGIN, viewport.height - FLOATING_COMPOSE_MARGIN - height);

	return {
		x: clamp(rect.x, FLOATING_COMPOSE_MARGIN, maxX),
		y: clamp(rect.y, FLOATING_COMPOSE_MARGIN, maxY),
		width,
		height,
	};
}

export function resizeComposeRect(
	start: ComposeRect,
	direction: ResizeDirection,
	deltaX: number,
	deltaY: number,
	viewport: ComposeViewport,
): ComposeRect {
	let { x, y, width, height } = start;

	if (direction.includes("e")) {
		width = Math.max(MIN_FLOATING_COMPOSE_WIDTH, start.width + deltaX);
	}
	if (direction.includes("w")) {
		width = Math.max(MIN_FLOATING_COMPOSE_WIDTH, start.width - deltaX);
		x = start.x + start.width - width;
	}
	if (direction.includes("s")) {
		height = Math.max(MIN_FLOATING_COMPOSE_HEIGHT, start.height + deltaY);
	}
	if (direction.includes("n")) {
		height = Math.max(MIN_FLOATING_COMPOSE_HEIGHT, start.height - deltaY);
		y = start.y + start.height - height;
	}

	return clampComposeRect({ x, y, width, height }, viewport);
}
