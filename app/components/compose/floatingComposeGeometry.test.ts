import { describe, expect, it } from "vitest";
import {
	clampComposeRect,
	resizeComposeRect,
	type ComposeRect,
	type ResizeDirection,
} from "./floatingComposeGeometry";

const start: ComposeRect = { x: 100, y: 100, width: 600, height: 520 };
const viewport = { width: 1200, height: 900 };

describe("floating compose geometry", () => {
	it.each<[ResizeDirection, number, number, ComposeRect]>([
		["e", 80, 0, { x: 100, y: 100, width: 680, height: 520 }],
		["w", -50, 0, { x: 50, y: 100, width: 650, height: 520 }],
		["n", 0, -40, { x: 100, y: 60, width: 600, height: 560 }],
		["s", 0, 60, { x: 100, y: 100, width: 600, height: 580 }],
		["ne", 40, -30, { x: 100, y: 70, width: 640, height: 550 }],
		["nw", -30, -20, { x: 70, y: 80, width: 630, height: 540 }],
		["se", 50, 40, { x: 100, y: 100, width: 650, height: 560 }],
		["sw", -20, 30, { x: 80, y: 100, width: 620, height: 550 }],
	])("resizes %s from the corresponding edges", (direction, dx, dy, expected) => {
		expect(resizeComposeRect(start, direction, dx, dy, viewport)).toEqual(expected);
	});

	it("preserves the opposite edge when clamping to minimum size", () => {
		expect(resizeComposeRect(start, "w", 500, 0, viewport)).toEqual({
			x: 380,
			y: 100,
			width: 320,
			height: 520,
		});
		expect(resizeComposeRect(start, "n", 0, 400, viewport)).toEqual({
			x: 100,
			y: 360,
			width: 600,
			height: 260,
		});
	});

	it("keeps a window visible when the viewport shrinks", () => {
		expect(
			clampComposeRect(
				{ x: 900, y: 700, width: 600, height: 520 },
				{ width: 800, height: 600 },
			),
		).toEqual({ x: 184, y: 64, width: 600, height: 520 });
	});
});
