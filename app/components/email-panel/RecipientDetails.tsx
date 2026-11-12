import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/CaretUp";
import { useEffect, useState } from "react";
import type {
	WemailAddress,
	WemailDeliveryResult,
} from "../../../shared/wemail/mail";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { parseAddressList } from "~/lib/utils";

interface RecipientDetailsProps {
	messageId: string;
	selfAddress?: string;
	sender?: string;
	date?: string;
	to?: WemailAddress[];
	cc?: WemailAddress[];
	bcc?: WemailAddress[];
	fallbackTo?: string;
	fallbackCc?: string;
	fallbackBcc?: string;
	delivery?: WemailDeliveryResult;
}

function addressLabel(address: WemailAddress): string {
	const displayName = address.directoryName || address.name;
	return displayName ? `${displayName} <${address.email}>` : address.email;
}

function addressListLabel(addresses: WemailAddress[]): string {
	return addresses.map(addressLabel).join(", ");
}

function AddressTag({
	address,
	rejected = false,
}: {
	address: WemailAddress;
	rejected?: boolean;
}) {
	const label = addressLabel(address);
	const tag = (
		<span
			tabIndex={rejected ? 0 : undefined}
			className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs leading-4 ${
				rejected
					? "cursor-help border-red-300 bg-red-50 font-medium text-red-600 underline decoration-dotted decoration-1 underline-offset-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/60"
					: "border-edge-3 bg-paper-2 text-ink-2"
			}`}
			title={address.email}
		>
			{label}
		</span>
	);

	if (!rejected) return tag;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{tag}</TooltipTrigger>
			<TooltipContent>SMTP 未接受此收件人，邮件可能未送达</TooltipContent>
		</Tooltip>
	);
}

function AddressTagList({
	addresses,
	rejected,
	compact = false,
}: {
	addresses: WemailAddress[];
	rejected: Set<string>;
	compact?: boolean;
}) {
	return (
		<span
			className={compact
				? "inline-flex max-h-5 min-w-0 flex-wrap items-start gap-1 overflow-hidden"
				: "inline-flex min-w-0 flex-wrap items-center gap-1"}
			data-recipient-tag-list={compact ? "compact" : "expanded"}
		>
			{addresses.map((address, index) => (
				<AddressTag
					key={`${address.email}-${index}`}
					address={address}
					rejected={rejected.has(address.email.trim().toLowerCase())}
				/>
			))}
		</span>
	);
}

function resolvedAddresses(
	addresses: WemailAddress[] | undefined,
	fallback: string | undefined,
): WemailAddress[] {
	return addresses ?? parseAddressList(fallback);
}

function formatFullDate(dateStr: string): string {
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return dateStr;

	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
}

function compactAddressLabel(address: WemailAddress, selfAddress?: string): string {
	if (
		selfAddress &&
		address.email.trim().toLowerCase() === selfAddress.trim().toLowerCase()
	) {
		return "我";
	}
	return address.directoryName || address.name || address.email;
}

export default function RecipientDetails({
	messageId,
	selfAddress,
	sender,
	date,
	to,
	cc,
	bcc,
	fallbackTo,
	fallbackCc,
	fallbackBcc,
	delivery,
}: RecipientDetailsProps) {
	const [expanded, setExpanded] = useState(false);
	useEffect(() => setExpanded(false), [messageId]);

	const toAddresses = resolvedAddresses(to, fallbackTo);
	const ccAddresses = resolvedAddresses(cc, fallbackCc);
	const bccAddresses = resolvedAddresses(bcc, fallbackBcc);
	const senderAddresses = parseAddressList(sender);
	const rejected = new Set(
		(delivery?.rejected ?? []).map((email) => email.trim().toLowerCase()),
	);
	const recipientSummary = toAddresses.length > 0
		? toAddresses
				.map((address) => compactAddressLabel(address, selfAddress))
				.slice(0, 2)
				.join("、") + (toAddresses.length > 2 ? ` 等 ${toAddresses.length} 人` : "")
		: fallbackTo || "(无收件人)";
	const rows = [
		sender
			? {
					label: "发件人",
					value: addressListLabel(senderAddresses) || sender,
					addresses: undefined,
				}
			: null,
		toAddresses.length > 0
			? { label: "收件人", value: "", addresses: toAddresses }
			: null,
		ccAddresses.length > 0
			? { label: "抄送", value: "", addresses: ccAddresses }
			: null,
		bccAddresses.length > 0
			? { label: "密送", value: "", addresses: bccAddresses }
			: null,
		date
			? { label: "日期", value: formatFullDate(date), addresses: undefined }
			: null,
	].filter((row): row is {
		label: string;
		value: string;
		addresses: WemailAddress[] | undefined;
	} => row !== null);

	return (
		<div className="mt-0.5 w-full min-w-0 text-xs text-ink-3">
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					setExpanded((value) => !value);
				}}
				className="inline-flex min-h-7 max-w-full min-w-0 items-center gap-1 rounded-md py-0.5 text-left leading-5 transition-colors hover:bg-paper-3/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={expanded ? "收起邮件详情" : "展开邮件详情"}
				aria-expanded={expanded}
			>
				<span className="shrink-0">发送给：</span>
				<span className="min-w-0 max-w-full truncate text-ink-2" title={recipientSummary}>
					{recipientSummary}
				</span>
				<span
					aria-hidden="true"
					className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-3"
				>
					{expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
				</span>
			</button>

			{expanded ? (
				<div className="space-y-1 py-1" aria-label="邮件详细信息">
					{rows.map((row) => (
						<div
							key={row.label}
							className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-2 leading-5"
						>
							<span className="text-ink-4">{row.label}：</span>
							<span className="min-w-0 break-words text-ink-2">
								{row.addresses
									? <AddressTagList addresses={row.addresses} rejected={rejected} />
									: row.value}
							</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
