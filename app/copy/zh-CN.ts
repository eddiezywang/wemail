import type { PublicErrorMessageKey } from "../../shared/wemail/presentation";

export const zhCN = {
	appName: "WeMail",
	loadingApp: "正在加载 WeMail",
	window: {
		minimize: "最小化窗口",
		maximize: "最大化窗口",
		restore: "还原窗口",
		minimizeToTray: "最小化到系统托盘",
		exit: "退出 WeMail",
	},
	notFound: {
		title: "404：页面不存在",
		description: "这个页面可能已被移动或删除。",
		backHome: "返回首页",
	},
	waits: {
		loadingApp: "正在加载…",
		loadingMailList: "正在加载邮件列表",
		loadingDetail: "正在加载邮件",
		loadingBody: "正在加载正文",
		loadingMore: "正在加载更多邮件…",
		retry: "重试",
		jobEstimating: "剩余时间估算中…",
		jobDone: "已完成",
		jobCancel: "取消",
		jobDismiss: "关闭",
	},
	pageError: {
		title: "WeMail 暂时无法打开此页面",
		description: "发生了意外问题。你可以返回首页后重试。",
		loadFailed: "页面加载失败",
	},
} as const;

export const publicErrorCopy: Record<PublicErrorMessageKey, string> = {
	cancelled: "操作已取消。",
	timeout: "等待响应超时，请检查网络后重试。",
	authentication: "身份验证失败，请检查账号、密码或授权码后重试。",
	network: "暂时无法连接服务，请检查网络后重试。",
	rate_limit: "请求过于频繁，请稍后再试。",
	permission: "当前账号没有完成此操作的权限。",
	not_found: "相关内容已不存在或暂时不可用。",
	conflict: "内容状态已经变化，请刷新后重试。",
	outcome_unknown: "执行结果尚未确认。请查看运行记录并核实是否已产生副作用，再决定下一步。",
	service_unavailable: "服务暂时不可用，请稍后重试。",
	unknown: "操作没有完成，请稍后重试。",
};
