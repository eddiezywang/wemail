// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getAccountSignaturePreference,
	resetAccountSignaturePreferencesForTests,
	setAccountSignaturePreference,
	useAccountSignaturePreference,
} from "./useAccountSignaturePreferences";

describe("account signature preferences", () => {
	beforeEach(() => {
		window.localStorage.clear();
		resetAccountSignaturePreferencesForTests();
	});

	it("defaults every account to an enabled signature", () => {
		expect(getAccountSignaturePreference("account-a")).toEqual({
			enabled: true,
			customText: "",
		});
		expect(getAccountSignaturePreference(undefined)).toEqual({
			enabled: true,
			customText: "",
		});
	});

	it("keeps custom settings isolated by account id", () => {
		setAccountSignaturePreference("account-a", {
			enabled: false,
			customText: "Alice",
		});

		expect(getAccountSignaturePreference("account-a")).toEqual({
			enabled: false,
			customText: "Alice",
		});
		expect(getAccountSignaturePreference("account-b")).toEqual({
			enabled: true,
			customText: "",
		});
	});

	it("ignores legacy global signature data", () => {
		window.localStorage.setItem(
			"wemail.userPreferences",
			JSON.stringify({
				signatureEnabled: true,
				signatureText: "—\nEddie Wang",
			}),
		);
		resetAccountSignaturePreferencesForTests();

		expect(getAccountSignaturePreference("account-a")).toEqual({
			enabled: true,
			customText: "",
		});
	});

	it("falls back safely when persisted data is malformed", () => {
		window.localStorage.setItem("wemail.signaturePreferences.v1", "not-json");
		resetAccountSignaturePreferencesForTests();

		expect(getAccountSignaturePreference("account-a")).toEqual({
			enabled: true,
			customText: "",
		});
	});

	it("updates subscribed components", () => {
		const { result } = renderHook(() =>
			useAccountSignaturePreference("account-a"),
		);

		act(() => {
			result.current.update({ customText: "Alice" });
		});

		expect(result.current.preference).toEqual({
			enabled: true,
			customText: "Alice",
		});
	});
});
