// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useSyncExternalStore } from "react";
import api from "~/services/api";

export interface AccountSignaturePreference {
	enabled: boolean;
	customText: string;
}

type SignaturePreferenceStore = Record<string, AccountSignaturePreference>;

const STORAGE_KEY = "wemail.signaturePreferences.v1";
const DIRTY_KEY = "wemail.signaturePreferences.pending";
const DEFAULT_PREFERENCE: AccountSignaturePreference = {
	enabled: true,
	customText: "",
};

function isPreference(value: unknown): value is AccountSignaturePreference {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AccountSignaturePreference>;
	return (
		typeof candidate.enabled === "boolean" &&
		typeof candidate.customText === "string"
	);
}

function readFromStorage(): SignaturePreferenceStore {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, AccountSignaturePreference] =>
				isPreference(entry[1]),
			),
		);
	} catch {
		return {};
	}
}

let state: SignaturePreferenceStore = readFromStorage();
const listeners = new Set<() => void>();
let hydration: Promise<void> | undefined;
let hydrated = false;
let revision = 0;
let writes = Promise.resolve();

function syncToServer() {
	const snapshot = state;
	const savedRevision = revision;
	writes = writes.then(async () => {
		await api.saveBusinessPreferences({ accountSignatures: snapshot });
		if (revision === savedRevision) window.localStorage.removeItem(DIRTY_KEY);
	}).catch(() => { hydrated = false; });
}

function hydrate() {
	if (hydrated || hydration || typeof window === "undefined") return;
	const startRevision = revision;
	hydration = (async () => {
		try {
			const result = await api.getBusinessPreferences() as {
				preferences?: { accountSignatures?: SignaturePreferenceStore | null };
			};
			const remote = result.preferences?.accountSignatures;
			const dirty = window.localStorage.getItem(DIRTY_KEY) === "true";
			if (remote && !dirty && revision === startRevision) persist(remote);
			if (!remote || dirty || revision !== startRevision) syncToServer();
			hydrated = true;
		} catch {
			// Keep the local copy until the service is available.
		} finally {
			hydration = undefined;
		}
	})();
}

function notify() {
	for (const listener of listeners) listener();
}

function persist(next: SignaturePreferenceStore) {
	state = next;
	if (typeof window !== "undefined") {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// Storage is best-effort; the in-memory preference remains usable.
		}
	}
	notify();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	hydrate();
	return () => listeners.delete(listener);
}

function getSnapshot() {
	return state;
}

const EMPTY_SERVER_SNAPSHOT: SignaturePreferenceStore = {};

function getServerSnapshot() {
	return EMPTY_SERVER_SNAPSHOT;
}

export function getAccountSignaturePreference(
	accountId: string | undefined,
): AccountSignaturePreference {
	if (!accountId) return DEFAULT_PREFERENCE;
	return state[accountId] ?? DEFAULT_PREFERENCE;
}

export function setAccountSignaturePreference(
	accountId: string,
	patch: Partial<AccountSignaturePreference>,
) {
	if (!accountId) return;
	revision++;
	try { window.localStorage.setItem(DIRTY_KEY, "true"); } catch { /* Local storage may be unavailable. */ }
	const current = getAccountSignaturePreference(accountId);
	persist({
		...state,
		[accountId]: { ...current, ...patch },
	});
	if (hydrated) syncToServer();
	else hydrate();
}

export function useAccountSignaturePreference(accountId: string | undefined) {
	const store = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const preference = accountId
		? store[accountId] ?? DEFAULT_PREFERENCE
		: DEFAULT_PREFERENCE;
	const update = useCallback(
		(patch: Partial<AccountSignaturePreference>) => {
			if (accountId) setAccountSignaturePreference(accountId, patch);
		},
		[accountId],
	);

	return { preference, update };
}

export function resetAccountSignaturePreferencesForTests() {
	state = readFromStorage();
	hydrated = false;
	hydration = undefined;
	revision = 0;
	notify();
}
