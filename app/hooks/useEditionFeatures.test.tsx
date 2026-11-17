import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicEditionInfo } from "../../shared/wemail/edition";
import { useEditionFeatures } from "./useEditionFeatures";

vi.mock("~/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("~/services/api")>();
	return {
		...actual,
		default: {
			...actual.default,
			getEditionInfo: vi.fn(),
		},
	};
});

import api from "~/services/api";

const ALL_OFF = {
	wecli: false,
	allowanceInvoice: false,
	enterpriseDirectory: false,
	officeSceneDetection: false,
};

function wrapperFor(client: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}

function freshClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

describe("useEditionFeatures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns every feature off while the edition info is still loading", () => {
		vi.mocked(api.getEditionInfo).mockReturnValue(new Promise(() => {}));
		const { result } = renderHook(() => useEditionFeatures(), {
			wrapper: wrapperFor(freshClient()),
		});
		expect(result.current).toEqual(ALL_OFF);
	});

	it("defaults to all-off when the edition info carries no features block", async () => {
		// The endpoint contract always includes `features`, but the hook must
		// stay branch-free even against an edition shape that predates it.
		vi.mocked(api.getEditionInfo).mockResolvedValue({
			providerPresets: [],
			bootToCredentials: false,
			signatureBrandUrl: "",
		} as PublicEditionInfo);
		const { result } = renderHook(() => useEditionFeatures(), {
			wrapper: wrapperFor(freshClient()),
		});
		await waitFor(() => expect(api.getEditionInfo).toHaveBeenCalled());
		expect(result.current).toEqual(ALL_OFF);
	});

	it("surfaces enabled internal features from the edition info", async () => {
		vi.mocked(api.getEditionInfo).mockResolvedValue({
			providerPresets: [],
			bootToCredentials: true,
			signatureBrandUrl: "",
			features: {
				wecli: true,
				allowanceInvoice: true,
				enterpriseDirectory: true,
				officeSceneDetection: true,
			},
		});
		const { result } = renderHook(() => useEditionFeatures(), {
			wrapper: wrapperFor(freshClient()),
		});
		await waitFor(() => expect(result.current.wecli).toBe(true));
		expect(result.current).toEqual({
			wecli: true,
			allowanceInvoice: true,
			enterpriseDirectory: true,
			officeSceneDetection: true,
		});
	});

	it("keeps unset feature keys off when only some are enabled", async () => {
		vi.mocked(api.getEditionInfo).mockResolvedValue({
			providerPresets: [],
			bootToCredentials: false,
			signatureBrandUrl: "",
			features: {
				wecli: true,
				officeSceneDetection: true,
			},
		});
		const { result } = renderHook(() => useEditionFeatures(), {
			wrapper: wrapperFor(freshClient()),
		});
		await waitFor(() => expect(result.current.wecli).toBe(true));
		expect(result.current).toEqual({
			wecli: true,
			allowanceInvoice: false,
			enterpriseDirectory: false,
			officeSceneDetection: true,
		});
	});

	it("reuses the shared edition query cache across hooks", async () => {
		vi.mocked(api.getEditionInfo).mockResolvedValue({
			providerPresets: [],
			bootToCredentials: false,
			signatureBrandUrl: "",
			features: { wecli: true },
		});
		const client = freshClient();
		const wrapper = wrapperFor(client);
		const first = renderHook(() => useEditionFeatures(), { wrapper });
		const second = renderHook(() => useEditionFeatures(), { wrapper });
		await waitFor(() => expect(second.result.current.wecli).toBe(true));
		expect(first.result.current.wecli).toBe(true);
		// Same ["system", "edition"] query key as onboarding/useComposeForm:
		// both subscriptions share one fetch.
		expect(api.getEditionInfo).toHaveBeenCalledTimes(1);
	});
});
