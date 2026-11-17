import { getUserFacingError, resolvePublicError } from "~/lib/user-facing-error";

/** Known local queue errors have recovery steps the generic error copy cannot express. */
export function getComposeError(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	switch (message) {
		case "reply-source-required":
		case "reply-source-message-id-unavailable":
			return "无法关联原邮件的回复标识，请重新打开原邮件后重试；如仍无法回复，请新建邮件联系收件人。";
		case "draft-not-editable":
			return "该草稿已进入发件队列或不再可编辑，请查看定时发送与待确认邮件。";
		case "draft-not-found":
			return "该草稿已被移除，请重新保存当前内容。";
		case "idempotency-key-conflict":
			return "该发送请求与已有记录不一致，请检查待确认邮件后重新操作。";
		case "send-state-changed":
			return "发送状态已变化，请刷新列表并核实发送结果。";
		case "send-already-completed":
			return "该请求已处理，请查看已发送邮件和发件队列，确认所有收件人的结果。";
		case "send-already-cancelled":
			return "该发送请求已取消；如需发送，请重新打开草稿或新建邮件。";
		case "send-outcome-unknown":
			return "该邮件的发送结果待确认，请先检查发件队列、已发送邮件并向收件人核实。";
		default:
			return getUserFacingError(error, fallback);
	}
}

export function getComposeSubmitError(error: unknown, fallback: string): string {
	const category = resolvePublicError(error).messageKey;
	if (category === "timeout" || category === "network" || category === "service_unavailable") {
		return "提交结果不确定。请先检查定时发送与待确认邮件、已发送邮件，并在必要时向收件人确认，再决定是否重试。";
	}
	return getComposeError(error, fallback);
}
