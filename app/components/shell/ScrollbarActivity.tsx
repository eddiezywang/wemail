// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";

const SCROLLBAR_IDLE_DELAY_MS = 800;
const SCROLL_KEYS = new Set([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"End",
	"Home",
	"PageDown",
	"PageUp",
	" ",
]);

function nearestScrollableElement(target: EventTarget | null): HTMLElement | null {
	let current = target instanceof HTMLElement ? target : null;
	while (current) {
		const { overflowX, overflowY } = window.getComputedStyle(current);
		const canScroll = /(auto|scroll|overlay)/.test(`${overflowX} ${overflowY}`);
		if (
			canScroll &&
			(current.scrollHeight > current.clientHeight ||
				current.scrollWidth > current.clientWidth)
		) {
			return current;
		}
		current = current.parentElement;
	}

	return document.scrollingElement instanceof HTMLElement
		? document.scrollingElement
		: null;
}

export default function ScrollbarActivity() {
	useEffect(() => {
		const idleTimers = new Map<HTMLElement, number>();

		const markActive = (element: HTMLElement | null) => {
			if (!element) return;
			element.dataset.scrollbarActive = "true";
			const previousTimer = idleTimers.get(element);
			if (previousTimer !== undefined) window.clearTimeout(previousTimer);
			idleTimers.set(
				element,
				window.setTimeout(() => {
					delete element.dataset.scrollbarActive;
					idleTimers.delete(element);
				}, SCROLLBAR_IDLE_DELAY_MS),
			);
		};

		const handleWheel = (event: WheelEvent) => {
			markActive(nearestScrollableElement(event.target));
		};
		const handleTouchMove = (event: TouchEvent) => {
			markActive(nearestScrollableElement(event.target));
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!SCROLL_KEYS.has(event.key)) return;
			markActive(nearestScrollableElement(event.target));
		};
		const handleScroll = (event: Event) => {
			const target = event.target;
			if (target instanceof HTMLElement) {
				markActive(target);
				return;
			}

			if (target === document) {
				markActive(
					document.scrollingElement instanceof HTMLElement
						? document.scrollingElement
						: null,
				);
			}
		};

		document.addEventListener("wheel", handleWheel, {
			capture: true,
			passive: true,
		});
		document.addEventListener("touchmove", handleTouchMove, {
			capture: true,
			passive: true,
		});
		document.addEventListener("keydown", handleKeyDown, true);
		document.addEventListener("scroll", handleScroll, {
			capture: true,
			passive: true,
		});

		return () => {
			document.removeEventListener("wheel", handleWheel, true);
			document.removeEventListener("touchmove", handleTouchMove, true);
			document.removeEventListener("keydown", handleKeyDown, true);
			document.removeEventListener("scroll", handleScroll, true);
			for (const [element, timer] of idleTimers) {
				window.clearTimeout(timer);
				delete element.dataset.scrollbarActive;
			}
			idleTimers.clear();
		};
	}, []);

	return null;
}
