// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { UsageBucketStats } from "../../shared/wemail/intelligence";
import type {
	EmailUsageRow,
	UsagePeriod,
	UsageTimeseriesGranularity,
	UsageTimeseriesResult,
} from "../../shared/wemail/usage";

const KEY = (accountId: string, period: string) => [
	"usage-stats",
	accountId,
	period,
];

export function useUsageStats(
	accountId: string | undefined,
	period: UsagePeriod = "30d",
) {
	return useQuery<UsageBucketStats[]>({
		queryKey: KEY(accountId ?? "", period),
		enabled: !!accountId,
		queryFn: async () => {
			const res = await api.getUsageStats(accountId as string, period);
			return res.stats;
		},
	});
}

const EMAIL_KEY = (emailId: string) => ["email-usage", emailId] as const;

/**
 * Per-email AI token history. Returns one row per recorded AI request for the
 * open email (newest first), so retries and regenerations each appear as their
 * own entry.
 */
export function useEmailUsage(emailId: string | undefined) {
	return useQuery<EmailUsageRow[]>({
		queryKey: EMAIL_KEY(emailId ?? ""),
		enabled: !!emailId,
		queryFn: async () => {
			const res = await api.getEmailUsage(emailId as string);
			return res.rows;
		},
	});
}

/** Throughput monitoring: per-category token + call timeseries. Polls faster at minute granularity. */
export function useUsageTimeseries(
	accountId: string | undefined,
	granularity: UsageTimeseriesGranularity = "minute",
	window?: number,
) {
	return useQuery<UsageTimeseriesResult>({
		queryKey: ["usage-timeseries", accountId ?? "", granularity, window ?? "default"],
		enabled: !!accountId,
		refetchInterval: granularity === "minute" ? 15_000 : 60_000,
		queryFn: async () => {
			const res = await api.getUsageTimeseries(accountId as string, granularity, window);
			return res.result;
		},
	});
}
