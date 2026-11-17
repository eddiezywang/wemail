import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DirectoryContactTable } from "~/components/directory/DirectoryContactTable";
import { DirectoryTree } from "~/components/directory/DirectoryTree";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useUIStore } from "~/hooks/useUIStore";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import api from "~/services/api";
import type {
	DirectoryContactQueryOptions,
	DirectoryContactSummary,
	DirectoryDepartment,
} from "../../shared/wemail/directory";

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;

export function meta() {
	return [{ title: "企业通讯录 / WeMail" }];
}

export default function DirectoryRoute() {
	return <DirectoryWorkspace />;
}

export function DirectoryWorkspace() {
	const queryClient = useQueryClient();
	const features = useEditionFeatures();
	const startCompose = useUIStore((state) => state.startCompose);
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [selectedDepartment, setSelectedDepartment] = useState<DirectoryDepartment>();
	const [page, setPage] = useState(0);
	const [selectedContacts, setSelectedContacts] = useState<Map<string, DirectoryContactSummary>>(
		() => new Map(),
	);
	const previousSyncState = useRef<string | undefined>(undefined);

	useEffect(() => {
		const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [query]);

	const status = useQuery({
		queryKey: ["directory", "status"],
		queryFn: api.getDirectoryStatus,
		refetchInterval: (current) =>
			current.state.data?.status.state === "running" ? 1_000 : false,
	});
	const effectiveDepartmentId = debouncedQuery ? undefined : selectedDepartment?.id;
	const contactQueryOptions = buildDirectoryContactQueryOptions(
		debouncedQuery,
		effectiveDepartmentId,
		page,
	);
	const contacts = useQuery({
		queryKey: [
			"directory",
			"contacts",
			debouncedQuery,
			effectiveDepartmentId,
			page,
		],
		queryFn: () =>
			api.searchDirectoryContacts(debouncedQuery, contactQueryOptions),
	});

	useEffect(() => {
		const nextState = status.data?.status.state;
		if (!nextState || previousSyncState.current === nextState) return;
		const previous = previousSyncState.current;
		previousSyncState.current = nextState;
		if (previous === "running" && (nextState === "completed" || nextState === "failed")) {
			void queryClient.invalidateQueries({ queryKey: ["directory", "departments"] });
			void queryClient.invalidateQueries({ queryKey: ["directory", "contacts"] });
		}
	}, [queryClient, status.data?.status.state]);

	const refresh = useMutation({
		mutationFn: api.refreshDirectory,
		onSuccess: () => {
			setSelectedContacts(new Map());
			setPage(0);
			toast.success("已开始刷新通讯录");
			void queryClient.invalidateQueries({ queryKey: ["directory", "status"] });
		},
		onError: () => toast.error("通讯录刷新失败，请稍后重试"),
	});

	const selectedIds = useMemo(
		() => new Set(selectedContacts.keys()),
		[selectedContacts],
	);
	const currentContacts = contacts.data?.contacts ?? [];
	const total = contacts.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

	useEffect(() => {
		if (!contacts.isSuccess || page < pageCount) return;
		setPage(pageCount - 1);
	}, [contacts.isSuccess, page, pageCount]);

	const clearSelection = () => setSelectedContacts(new Map());
	const handleSelectDepartment = (department?: DirectoryDepartment) => {
		setSelectedDepartment(department);
		setPage(0);
		clearSelection();
	};
	const handleQueryChange = (value: string) => {
		setQuery(value);
		setPage(0);
		clearSelection();
	};
	const handleToggleContact = (contact: DirectoryContactSummary) => {
		setSelectedContacts((current) => {
			const next = new Map(current);
			if (next.has(contact.id)) next.delete(contact.id);
			else next.set(contact.id, contact);
			return next;
		});
	};
	const handleTogglePage = (pageContacts: DirectoryContactSummary[], selected: boolean) => {
		setSelectedContacts((current) => {
			const next = new Map(current);
			for (const contact of pageContacts) {
				if (selected) next.set(contact.id, contact);
				else next.delete(contact.id);
			}
			return next;
		});
	};
	const handleCompose = (recipients: DirectoryContactSummary[]) => {
		const unique = Array.from(
			new Map(recipients.map((contact) => [contact.email.toLocaleLowerCase(), contact])).values(),
		);
		if (unique.length === 0) return;
		startCompose({
			mode: "new",
			prefilledTo: unique
				.map((contact) => `${contact.name} <${contact.email}>`)
				.join(", "),
		});
	};

	const tableTitle = debouncedQuery
		? `搜索：${debouncedQuery}`
		: selectedDepartment?.name ?? "全部同事";
	const emptyHint = !features.enterpriseDirectory
		? "企业通讯录未配置"
		: debouncedQuery
			? contacts.data?.remoteAvailable === false
				? "企业通讯录暂时不可用，请稍后重试。"
				: "没有找到匹配的姓名、邮箱、部门或职务。"
			: selectedDepartment
				? "该部门及下级部门暂无成员。"
				: status.data?.status.lastSuccessfulAt
					? "当前通讯录快照中没有联系人。"
					: "通讯录尚未完成初始化，请点击刷新开始同步。";

	return (
		<div
			data-testid="directory-workspace"
			className="flex h-full min-w-0 flex-col overflow-hidden bg-transparent"
		>
			<div className="flex h-14 shrink-0 items-center gap-2 border-b border-edge px-4">
				<UsersThreeIcon size={19} className="text-coral" />
				<h1 className="shrink-0 text-sm font-semibold text-ink">企业通讯录</h1>
				<form
					className="ml-3 flex max-w-xl flex-1 items-center gap-2 rounded-full bg-paper-2 px-3"
					onSubmit={(event) => event.preventDefault()}
				>
					<MagnifyingGlassIcon size={14} className="shrink-0 text-ink-3" />
					<Input
						value={query}
						onChange={(event) => handleQueryChange(event.target.value)}
						placeholder="搜索姓名、邮箱、拼音、部门或职务"
						aria-label="搜索企业通讯录"
						className="h-9 border-0 bg-transparent px-0 text-xs focus-visible:ring-0"
					/>
				</form>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => refresh.mutate()}
					disabled={
						refresh.isPending ||
						status.data?.status.state === "running" ||
						!features.enterpriseDirectory
					}
				>
					<ArrowsClockwiseIcon
						size={15}
						className={
							refresh.isPending || status.data?.status.state === "running"
								? "animate-spin motion-reduce:animate-none"
								: ""
						}
					/>
					刷新
				</Button>
			</div>

			<DirectoryStatusBar
				loading={status.isLoading}
				queryError={status.isError}
				notConfigured={!features.enterpriseDirectory}
				state={status.data?.status.state}
				processedDepartments={status.data?.status.processedDepartments ?? 0}
				processedContacts={status.data?.status.processedContacts ?? 0}
				lastSuccessfulAt={status.data?.status.lastSuccessfulAt}
				onRefresh={() => refresh.mutate()}
				onRetry={() => void status.refetch()}
			/>

			<div className="flex min-h-0 flex-1">
				<DirectoryTree
					selectedDepartmentId={selectedDepartment?.id}
					onSelect={handleSelectDepartment}
				/>
				<DirectoryContactTable
					title={tableTitle}
					contacts={currentContacts}
					total={total}
					page={page}
					pageSize={PAGE_SIZE}
					loading={contacts.isLoading || contacts.isFetching}
					error={contacts.isError}
					emptyHint={emptyHint}
					selectedIds={selectedIds}
					selectedContacts={Array.from(selectedContacts.values())}
					onToggle={handleToggleContact}
					onTogglePage={handleTogglePage}
					onClearSelection={clearSelection}
					onCompose={handleCompose}
					onPageChange={setPage}
					onRetry={() => void contacts.refetch()}
				/>
			</div>
		</div>
	);
}

export function buildDirectoryContactQueryOptions(
	query: string,
	departmentId: string | undefined,
	page: number,
): DirectoryContactQueryOptions {
	const effectiveDepartmentId = query ? undefined : departmentId;
	return {
		departmentId: effectiveDepartmentId,
		includeDescendants: !!effectiveDepartmentId,
		limit: PAGE_SIZE,
		offset: page * PAGE_SIZE,
	};
}

function DirectoryStatusBar({
	loading,
	queryError,
	notConfigured,
	state,
	processedDepartments,
	processedContacts,
	lastSuccessfulAt,
	onRefresh,
	onRetry,
}: {
	loading: boolean;
	queryError: boolean;
	notConfigured: boolean;
	state?: "idle" | "running" | "completed" | "failed";
	processedDepartments: number;
	processedContacts: number;
	lastSuccessfulAt?: string;
	onRefresh: () => void;
	onRetry: () => void;
}) {
	if (loading) {
		return (
			<div className="flex min-h-9 shrink-0 items-center border-b border-edge px-4 text-xs text-ink-3" role="status" aria-live="polite">
				正在读取同步状态…
			</div>
		);
	}
	if (notConfigured) {
		return (
			<div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-edge bg-amber/10 px-4 text-xs text-ink-2" role="status" aria-live="polite">
				<WarningCircleIcon size={13} className="shrink-0" />
				<span>企业通讯录未配置</span>
			</div>
		);
	}
	if (queryError) {
		return (
			<div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-edge bg-amber/10 px-4 text-xs text-ink-2" role="alert">
				<WarningCircleIcon size={13} className="shrink-0" />
				<span>同步状态暂时不可用。</span>
				<button type="button" onClick={onRetry} className="ml-auto min-h-8 shrink-0 font-medium text-coral hover:underline">
					重试
				</button>
			</div>
		);
	}
	if (state === "running") {
		return (
			<div className="flex min-h-9 shrink-0 items-center border-b border-edge bg-coral/[0.035] px-4 text-xs text-ink-3" role="status" aria-live="polite">
				正在同步：{processedDepartments} 个部门，{processedContacts} 位同事
			</div>
		);
	}
	if (state === "failed") {
		return (
			<div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-edge bg-amber/10 px-4 text-xs text-ink-2" role="alert">
				<WarningCircleIcon size={13} className="shrink-0" />
				<span className="truncate">
					{lastSuccessfulAt
						? `同步失败，正在显示 ${new Date(lastSuccessfulAt).toLocaleString()} 的快照`
						: "通讯录初始化失败，请稍后重试。"}
				</span>
				<button type="button" onClick={onRefresh} className="ml-auto shrink-0 font-medium hover:underline">
					重试
				</button>
			</div>
		);
	}
	return (
		<div className="flex min-h-9 shrink-0 items-center border-b border-edge px-4 text-xs text-ink-3">
			{lastSuccessfulAt
				? `最近同步：${new Date(lastSuccessfulAt).toLocaleString()}`
				: "通讯录尚未完成初始化"}
		</div>
	);
}
