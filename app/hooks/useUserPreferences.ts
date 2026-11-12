// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * User preference store with localStorage offline fallback.
 *
 * Non-sensitive Inbox / Compose / Notifications / Language fields sync
 * through the local API so PI and the settings UI share one value. The
 * security-only fields remain renderer-local and are intentionally not
 * exposed to PI.
 */

import { useSyncExternalStore } from "react";
import type { NotificationContentMode } from "shared/wemail/notifications";
import api from "~/services/api";

export interface UserPreferences {
	// Inbox
	inboxDensity: "comfortable" | "compact";
	threading: boolean;
	readingPane: "side" | "off";

	// Compose
	sendShortcut: "cmd-enter" | "ctrl-enter" | "off";

	// Security
	blockTrackerPixels: boolean;
	linkSafetyPreview: boolean;

	// Notifications
	actionRequiredNotifications: boolean;
	newMailNotifications: boolean;
	notificationSound: boolean;
	notificationContentMode: NotificationContentMode;
	dailyDigest: boolean;

	// Language
	interfaceLanguage: "auto" | "zh-CN" | "en";
}

const DEFAULTS: UserPreferences = {
	inboxDensity: "comfortable",
	threading: true,
	readingPane: "side",
	sendShortcut: "cmd-enter",
	blockTrackerPixels: true,
	linkSafetyPreview: true,
	actionRequiredNotifications: true,
	newMailNotifications: true,
	notificationSound: false,
	notificationContentMode: "full",
	dailyDigest: false,
	interfaceLanguage: "auto",
};

const STORAGE_KEY = "wemail.userPreferences";
const BUSINESS_KEYS = new Set<keyof UserPreferences>([
	"inboxDensity",
	"threading",
	"readingPane",
	"sendShortcut",
	"actionRequiredNotifications",
	"newMailNotifications",
	"notificationSound",
	"notificationContentMode",
	"dailyDigest",
	"interfaceLanguage",
]);

function readFromStorage(): UserPreferences {
	if (typeof window === "undefined") return DEFAULTS;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULTS;
		const parsed = JSON.parse(raw) as Partial<UserPreferences> & {
			desktopNotifications?: boolean;
		};
		const { desktopNotifications: _legacyDesktopNotifications, ...current } = parsed;
		return {
			...DEFAULTS,
			...current,
			newMailNotifications:
				typeof current.newMailNotifications === "boolean"
					? current.newMailNotifications
					: DEFAULTS.newMailNotifications,
		};
	} catch {
		return DEFAULTS;
	}
}

let state: UserPreferences = readFromStorage();
const listeners = new Set<() => void>();
let hydration: Promise<void> | undefined;
let hydrated = false;

async function hydrateBusinessPreferences(): Promise<boolean> {
	if (typeof window === "undefined") return false;
	try {
		const data = (await api.getBusinessPreferences()) as {
			stored?: boolean;
			preferences?: Partial<UserPreferences>;
		};
		if (!data.preferences) return true;
		if (data.stored === false) {
			const initial = Object.fromEntries(
				[...BUSINESS_KEYS].map((key) => [key, state[key]]),
			);
			await api.saveBusinessPreferences(initial);
			return true;
		}
		const next = { ...state };
		const nextRecord = next as unknown as Record<string, unknown>;
		for (const key of BUSINESS_KEYS) {
			if (data.preferences[key] !== undefined) {
				nextRecord[key] = data.preferences[key];
			}
		}
		if (JSON.stringify(next) !== JSON.stringify(state)) persist(next);
		return true;
	} catch {
		// Local API may be unavailable during renderer startup.
		return false;
	}
}

function requestBusinessPreferenceHydration(): void {
	if (hydrated) return;
	hydration ??= hydrateBusinessPreferences()
		.then((success) => { hydrated = success; })
		.finally(() => { hydration = undefined; });
}

async function persistBusinessPreference<K extends keyof UserPreferences>(
	key: K,
	value: UserPreferences[K],
) {
	if (typeof window === "undefined" || !BUSINESS_KEYS.has(key)) return;
	try {
		await api.saveBusinessPreferences({ [key]: value });
	} catch {
		// localStorage remains the offline fallback
	}
}

function notify() {
	for (const listener of listeners) listener();
}

function persist(next: UserPreferences) {
	state = next;
	if (typeof window !== "undefined") {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// Best-effort; ignore quota / privacy mode errors.
		}
	}
	notify();
}

export function setUserPreference<K extends keyof UserPreferences>(
	key: K,
	value: UserPreferences[K],
) {
	persist({ ...state, [key]: value });
	void persistBusinessPreference(key, value);
}

export function resetUserPreferences() {
	persist({ ...DEFAULTS });
	void api.saveBusinessPreferences(
		Object.fromEntries([...BUSINESS_KEYS].map((key) => [key, DEFAULTS[key]])),
	).catch(() => {
		// localStorage remains the offline fallback
	});
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	requestBusinessPreferenceHydration();
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot() {
	return state;
}

function getServerSnapshot() {
	return DEFAULTS;
}

export function useUserPreferences(): UserPreferences {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
