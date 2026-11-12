import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import type { DirectoryContactSummary } from "../../../shared/wemail/directory";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";

interface DirectoryContactTableProps {
	title: string;
	contacts: DirectoryContactSummary[];
	total: number;
	page: number;
	pageSize: number;
	loading: boolean;
	error: boolean;
	emptyHint: string;
	selectedIds: Set<string>;
	selectedContacts: DirectoryContactSummary[];
	onToggle: (contact: DirectoryContactSummary) => void;
	onTogglePage: (contacts: DirectoryContactSummary[], selected: boolean) => void;
	onClearSelection: () => void;
	onCompose: (contacts: DirectoryContactSummary[]) => void;
	onPageChange: (page: number) => void;
	onRetry: () => void;
}

export function DirectoryContactTable({
	title,
	contacts,
	total,
	page,
	pageSize,
	loading,
	error,
	emptyHint,
	selectedIds,
	selectedContacts,
	onToggle,
	onTogglePage,
	onClearSelection,
	onCompose,
	onPageChange,
	onRetry,
}: DirectoryContactTableProps) {
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const pageSelected = contacts.length > 0 && contacts.every((contact) => selectedIds.has(contact.id));
	return (
		<section className="flex min-w-0 flex-1 flex-col bg-transparent">
			<div className="flex min-h-14 items-center justify-between gap-4 border-b border-edge px-4">
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold text-ink">{title}</div>
					<div className="mt-0.5 text-xs text-ink-3">共 {total} 位联系人</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<span className="mr-1 text-xs tabular-nums text-ink-3">
						{page + 1}/{pageCount}
					</span>
					<Button
						variant="outline"
						size="sm"
						className="h-9 w-9 px-0"
						onClick={() => onPageChange(page - 1)}
						disabled={page <= 0 || loading}
						aria-label="上一页"
					>
						<CaretLeftIcon size={13} />
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-9 w-9 px-0"
						onClick={() => onPageChange(page + 1)}
						disabled={page + 1 >= pageCount || loading}
						aria-label="下一页"
					>
						<CaretRightIcon size={13} />
					</Button>
				</div>
			</div>

			{selectedIds.size > 0 ? (
				<div className="flex min-h-11 items-center justify-between gap-3 border-b border-coral/20 bg-coral/[0.045] px-4">
					<div className="text-xs font-medium text-ink-2">已选择 {selectedIds.size} 人</div>
					<div className="flex items-center gap-2">
						<Button variant="ghost" size="sm" className="h-9 text-xs" onClick={onClearSelection}>
							清除
						</Button>
						<Button
							size="sm"
							className="h-9 text-xs"
							onClick={() => onCompose(selectedContacts)}
						>
							<EnvelopeSimpleIcon size={14} />
							写邮件
						</Button>
					</div>
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-auto">
				<table className="w-full min-w-[640px] table-fixed border-collapse text-left">
					<thead className="sticky top-0 z-10 bg-paper-2/95 text-xs font-medium text-ink-3 backdrop-blur-sm">
						<tr className="h-9 border-b border-edge">
							<th className="w-11 px-4">
								<Checkbox
									checked={pageSelected}
									onChange={(next) => onTogglePage(contacts, next)}
									disabled={contacts.length === 0}
									label="选择当前页联系人"
									size={14}
									boxClassName="rounded-[4px]"
								/>
							</th>
							<th className="w-[24%] px-3">姓名</th>
							<th className="w-[36%] px-3">邮件地址</th>
							<th className="hidden w-[20%] px-3 xl:table-cell">手机号码</th>
							<th className="hidden w-[20%] px-3 lg:table-cell">职位</th>
							<th className="w-20 px-3">操作</th>
						</tr>
					</thead>
					<tbody className="text-xs text-ink-2">
						{contacts.map((contact) => (
							<tr
								key={contact.id}
								onDoubleClick={() => onCompose([contact])}
								className="h-10 border-b border-edge-3 transition-colors hover:bg-paper-2/65"
							>
								<td className="px-4">
									<Checkbox
										checked={selectedIds.has(contact.id)}
										onChange={() => onToggle(contact)}
										label={`选择${contact.name}`}
										size={14}
										boxClassName="rounded-[4px]"
									/>
								</td>
								<td className="truncate px-3 font-medium text-ink" title={contact.name}>
									{contact.name}
								</td>
								<td className="truncate px-3" title={contact.email}>{contact.email}</td>
								<td className="hidden truncate px-3 text-ink-3 xl:table-cell">{contact.mobile || "—"}</td>
								<td className="hidden truncate px-3 text-ink-3 lg:table-cell">{contact.title || "—"}</td>
								<td className="px-3">
									<button
										type="button"
										onClick={() => onCompose([contact])}
										className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-coral/10 hover:text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										aria-label={`给${contact.name}写邮件`}
										title={`给${contact.name}写邮件`}
									>
										<EnvelopeSimpleIcon size={15} />
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>

				{loading ? (
					<div className="flex h-40 items-center justify-center gap-2 text-xs text-ink-3" role="status" aria-live="polite">
						<SpinnerGapIcon size={16} className="animate-spin motion-reduce:animate-none" />
						正在读取通讯录…
					</div>
				) : error ? (
					<div className="flex h-48 flex-col items-center justify-center text-center">
						<div className="text-sm font-medium text-ink">联系人读取失败</div>
						<button type="button" onClick={onRetry} className="mt-2 text-xs text-coral hover:underline">
							点击重试
						</button>
					</div>
				) : contacts.length === 0 ? (
					<div className="flex h-52 flex-col items-center justify-center px-6 text-center">
						<div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-paper-2 text-ink-3">
							<UsersThreeIcon size={20} />
						</div>
						<div className="text-sm font-medium text-ink">暂无联系人</div>
						<div className="mt-1 max-w-sm text-xs leading-5 text-ink-3">{emptyHint}</div>
					</div>
				) : null}
			</div>
		</section>
	);
}
