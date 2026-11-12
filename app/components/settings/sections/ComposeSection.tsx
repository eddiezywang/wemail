// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { IdentificationCardIcon } from "@phosphor-icons/react/IdentificationCard";
import { SignatureIcon } from "@phosphor-icons/react/Signature";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useAccountSignaturePreference } from "~/hooks/useAccountSignaturePreferences";
import { useAccountDirectoryName } from "~/hooks/useAccountDirectoryName";
import { resolveSignatureText } from "~/lib/utils";
import { useCurrentAccount } from "~/queries/currentAccount";

interface ComposeSectionProps {
	account?: {
		id: string;
		emailAddress: string;
		displayName?: string;
	} | null;
}

export function ComposeSection({ account: accountOverride }: ComposeSectionProps = {}) {
	const { data: currentAccount } = useCurrentAccount();
	const account = accountOverride === undefined
		? currentAccount?.account
		: accountOverride;
	const { preference, update } = useAccountSignaturePreference(account?.id);
	const directoryName = useAccountDirectoryName(account);
	const defaultIdentity = resolveSignatureText({
		directoryName,
		displayName: account?.displayName,
		emailAddress: account?.emailAddress,
	});
	return (
		<div className="space-y-5">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">签名</h2>
				<p className="text-xs text-ink-3">设置当前邮箱的默认签名，写信时仍可逐封修改。</p>
			</div>

			<section className="overflow-hidden rounded-xl border border-edge bg-paper-2 shadow-[var(--shadow-1)]">
				<div className="flex items-start justify-between gap-4 border-b border-edge-3 px-5 py-4">
					<div className="flex min-w-0 gap-3">
						<span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
							<SignatureIcon size={17} weight="duotone" />
						</span>
						<div className="min-w-0">
							<label htmlFor="account-signature-toggle" className="text-sm font-semibold text-ink">
								使用签名
							</label>
							<p className="mt-0.5 text-xs leading-5 text-ink-3">
								当前邮箱：<span className="font-medium text-ink-2">{account?.emailAddress || "尚未连接邮箱"}</span>
							</p>
						</div>
					</div>
					<Switch
						id="account-signature-toggle"
						aria-label="使用签名"
						checked={preference.enabled}
						onCheckedChange={(enabled) => update({ enabled })}
						disabled={!account}
					/>
				</div>

				{preference.enabled ? (
					<div className="space-y-4 px-5 py-4">
						<div className="flex items-center gap-2 rounded-lg bg-paper-3 px-3 py-2 text-xs text-ink-3">
							<IdentificationCardIcon size={15} className="text-coral" />
							<span>默认身份</span>
							<span className="font-semibold text-ink">{defaultIdentity || "邮箱名称"}</span>
						</div>

						<div>
							<div className="mb-1.5 flex items-center justify-between gap-3">
								<label htmlFor="account-signature-text" className="text-xs font-medium text-ink-2">
									自定义签名
								</label>
								<button
									type="button"
									onClick={() => update({ customText: "" })}
									disabled={!preference.customText}
									className="text-xs font-medium text-coral transition-opacity hover:text-coral-2 disabled:cursor-default disabled:opacity-40"
								>
									恢复默认
								</button>
							</div>
							<Textarea
								id="account-signature-text"
								aria-label="自定义签名"
								rows={3}
								value={preference.customText}
								onChange={(event) => update({ customText: event.target.value })}
								placeholder={`留空则使用“${defaultIdentity || "邮箱名称"}”`}
								className="min-h-20 resize-y bg-paper text-sm"
							/>
						</div>
					</div>
				) : (
					<div className="px-5 py-5 text-sm text-ink-3">
						发送邮件时不会添加签名或 Sent with Wemail。
					</div>
				)}
			</section>
		</div>
	);
}
