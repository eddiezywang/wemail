export const SYSTEM_MAIL_CATEGORY_LABELS: Record<string, string> = {
	important: "重要",
	action_required: "待处理",
	invoice: "发票",
};

export function mailCategoryLabel(id: string, fallback?: string): string {
	return SYSTEM_MAIL_CATEGORY_LABELS[id] ?? fallback ?? id;
}
