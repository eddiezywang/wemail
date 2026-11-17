// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type {
	AutomationAction,
	AutomationConditionMode,
	AutomationConditionRule,
	AutomationConditions,
	AutomationRule,
	AutomationRulePreviewResult,
	AutomationTrigger,
	AutomationProcessing,
} from "../../shared/wemail/automation";
import type {
	AutomationDetail,
	AutomationListItem,
	AutomationRunDetail,
	AutomationTemplateSummary,
} from "../../shared/wemail/automationCenter";

const KEY = (accountId?: string) =>
	accountId ? ["automation-rules", accountId] : ["automation-rules", "_all"];
const RUN_KEY = (accountId?: string) =>
	accountId ? ["automation-runs", accountId] : ["automation-runs", "_all"];
const CENTER_KEY = (accountId?: string) =>
	["automation-center", accountId ?? "_none"] as const;
const DETAIL_KEY = (accountId?: string, id?: string) =>
	["automation-center-detail", accountId ?? "_none", id ?? "_none"] as const;
const RUN_DETAIL_KEY = (accountId?: string, id?: string, runId?: string) =>
	["automation-center-run", accountId ?? "_none", id ?? "_none", runId ?? "_none"] as const;

export function useUnifiedAutomations(accountId: string | undefined) {
	return useQuery<{
		automations: AutomationListItem[];
		recommendedTemplates: AutomationTemplateSummary[];
	}>({
		queryKey: CENTER_KEY(accountId),
		queryFn: async () => {
			const response = await api.listUnifiedAutomations(accountId!);
			return {
				automations: response.automations,
				recommendedTemplates: response.recommendedTemplates,
			};
		},
		enabled: !!accountId,
	});
}

export function useUnifiedAutomationDetail(
	accountId: string | undefined,
	id: string | undefined,
) {
	return useQuery<AutomationDetail>({
		queryKey: DETAIL_KEY(accountId, id),
		queryFn: async () => (await api.getUnifiedAutomation(id!, accountId!)).automation,
		enabled: !!accountId && !!id,
	});
}

export function useUnifiedAutomationRunDetail(
	accountId: string | undefined,
	id: string | undefined,
	runId: string | undefined,
) {
	return useQuery<AutomationRunDetail>({
		queryKey: RUN_DETAIL_KEY(accountId, id, runId),
		queryFn: async () =>
			(await api.getUnifiedAutomationRun(id!, runId!, accountId!)).run,
		enabled: !!accountId && !!id && !!runId,
		refetchInterval: (query) =>
			query.state.data?.outcome === "running" ? 1_500 : false,
	});
}

function useRefreshUnifiedAutomation(accountId: string | undefined) {
	const queryClient = useQueryClient();
	return (id?: string) => {
		queryClient.invalidateQueries({ queryKey: CENTER_KEY(accountId) });
		if (id) {
			queryClient.invalidateQueries({ queryKey: DETAIL_KEY(accountId, id) });
			queryClient.invalidateQueries({ queryKey: ["automation-center-run", accountId ?? "_none", id] });
		}
	};
}

export function useSetUnifiedAutomationEnabled(accountId: string | undefined) {
	const refresh = useRefreshUnifiedAutomation(accountId);
	return useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			api.setUnifiedAutomationEnabled(id, accountId!, enabled),
		onSuccess: (_result, variables) => refresh(variables.id),
	});
}

export function useResumeUnifiedAutomationSchedule(accountId: string | undefined) {
	const refresh = useRefreshUnifiedAutomation(accountId);
	return useMutation({
		mutationFn: ({ id, ruleVersion, pauseToken }: { id: string; ruleVersion: number; pauseToken: string }) => api.resumeUnifiedAutomationSchedule(id, accountId!, ruleVersion, pauseToken),
		onSuccess: (_result, input) => refresh(input.id),
	});
}

export function useRunUnifiedAutomation(accountId: string | undefined) {
	const refresh = useRefreshUnifiedAutomation(accountId);
	return useMutation({
		mutationFn: ({ id, confirmDangerous }: { id: string; confirmDangerous?: boolean }) =>
			api.runUnifiedAutomation(id, accountId!, confirmDangerous),
		onSettled: (_result, _error, variables) => refresh(variables.id),
	});
}

export function useTestUnifiedAutomation(accountId: string | undefined) {
	return useMutation({
		mutationFn: (id: string) => api.testUnifiedAutomation(id, accountId!),
	});
}

export function useArchiveUnifiedAutomation(accountId: string | undefined) {
	const refresh = useRefreshUnifiedAutomation(accountId);
	return useMutation({
		mutationFn: (id: string) => api.archiveUnifiedAutomation(id, accountId!),
		onSuccess: (_result, id) => refresh(id),
	});
}

export function useDeleteUnifiedAutomation(accountId: string | undefined) {
	const refresh = useRefreshUnifiedAutomation(accountId);
	return useMutation({
		mutationFn: (id: string) => api.deleteUnifiedAutomation(id, accountId!),
		onSuccess: () => refresh(),
	});
}

export function useRetryUnifiedAutomationStep(accountId: string | undefined) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			id: string;
			runId: string;
			stepId: string;
			confirmDelivery?: boolean;
		}) =>
			api.retryUnifiedAutomationStep(
				input.id,
				input.runId,
				input.stepId,
				accountId!,
				input.confirmDelivery,
			),
		onSettled: (_result, _error, input) => {
			queryClient.invalidateQueries({
				queryKey: RUN_DETAIL_KEY(accountId, input.id, input.runId),
			});
			queryClient.invalidateQueries({ queryKey: DETAIL_KEY(accountId, input.id) });
		},
	});
}

export function useResumeUnifiedAutomationDraft(accountId: string | undefined) {
	return useMutation({
		mutationFn: (id: string) => api.resumeUnifiedAutomationDraft(id, accountId!),
	});
}

export interface AutomationRuleRunSummary {
	id: string;
	ruleId: string;
	accountId: string;
	dryRun: boolean;
	matchedCount: number;
	appliedCount: number;
	triggerKind?: string;
	status?: "matched" | "applied" | "skipped" | "evaluation_failed" | "failed";
	actionResults: Array<Record<string, unknown>>;
	createdAt: string;
}

export function useAutomationRules(accountId: string | undefined) {
	return useQuery<AutomationRule[]>({
		queryKey: KEY(accountId),
		queryFn: async () => {
			const res = await api.listAutomationRules(accountId);
			return res.rules;
		},
		enabled: !!accountId,
	});
}

export function useAutomationRuns(accountId: string | undefined) {
	return useQuery<AutomationRuleRunSummary[]>({
		queryKey: RUN_KEY(accountId),
		queryFn: async () => {
			const res = await api.listAutomationRuns(accountId!);
			return res.runs;
		},
		enabled: !!accountId,
	});
}

export function useCreateAutomationRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			accountId: string;
			name: string;
			enabled?: boolean;
			trigger?: AutomationTrigger;
			naturalLanguageCondition?: string;
			conditions: AutomationConditions;
			conditionMode?: AutomationConditionMode;
			conditionRules?: AutomationConditionRule[];
			processing?: AutomationProcessing;
			actions: AutomationAction[];
		}) => api.createAutomationRule(input),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: KEY(vars.accountId) });
		},
	});
}

export function useUpdateAutomationRule(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			update,
		}: {
			id: string;
			update: Partial<{
				name: string;
				enabled: boolean;
				trigger: AutomationTrigger;
				naturalLanguageCondition: string;
				conditions: AutomationConditions;
				conditionMode: AutomationConditionMode;
				conditionRules: AutomationConditionRule[];
				processing: AutomationProcessing;
				actions: AutomationAction[];
			}>;
		}) => api.updateAutomationRule(id, update),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: KEY(accountId) });
		},
	});
}

export function useDeleteAutomationRule(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteAutomationRule(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: KEY(accountId) });
		},
	});
}

export function useDryRunAutomationRule() {
	return useMutation({
		mutationFn: (id: string) => api.dryRunAutomationRule(id),
	});
}

export function useRunAutomationRule(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			confirmDangerous,
		}: {
			id: string;
			confirmDangerous?: boolean;
		}) => api.runAutomationRule(id, { confirmDangerous }),
		onSuccess: () => {
			// Rule application changes mail flags/folders; refetch lists.
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: RUN_KEY(accountId) });
		},
	});
}

export function usePreviewAutomationRule() {
	return useMutation({
		mutationFn: (input: Omit<AutomationRule, "id" | "createdAt" | "updatedAt"> & { sourceRuleId?: string }) => api.previewAutomationRule(input),
	});
}

export function useCommitAutomationRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { accountId: string; previewId: string; ruleHash: string }) => api.commitAutomationRule(input),
		onSettled: (_data, _error, vars) => {
			qc.invalidateQueries({ queryKey: KEY(vars.accountId) });
			qc.invalidateQueries({ queryKey: CENTER_KEY(vars.accountId) });
		},
	});
}
