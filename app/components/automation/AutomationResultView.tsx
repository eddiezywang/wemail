import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { ShieldWarningIcon } from "@phosphor-icons/react/ShieldWarning";
import type {
	AutomationRunResultEnvelope,
	SubscriptionInsightResult,
} from "../../../shared/wemail/automationCenter";

type Renderer = (envelope: AutomationRunResultEnvelope) => React.ReactNode;

const renderers = new Map<string, Renderer>([
	["wemail.subscriptionDailyInsight@1.0.0", renderSubscriptionInsight],
]);

export function AutomationResultView({
	envelope,
}: {
	envelope: AutomationRunResultEnvelope;
}) {
	const renderer = renderers.get(`${envelope.rendererId}@${envelope.rendererVersion}`);
	if (!renderer) {
		return <GenericResult envelope={envelope} reason="当前版本没有匹配的安全渲染器。" />;
	}
	try {
		return <>{renderer(envelope)}</>;
	} catch {
		return <GenericResult envelope={envelope} reason="结果格式校验失败，已使用安全摘要。" />;
	}
}

function renderSubscriptionInsight(envelope: AutomationRunResultEnvelope) {
	if (!isSubscriptionInsight(envelope.data)) throw new Error("invalid-subscription-insight");
	const result = envelope.data;
	const windowLabel = insightWindowLabel(result.window);
	if (result.emptyReason) {
		return (
			<div className="rounded-lg border border-dashed border-edge px-4 py-5 text-center">
				<p className="text-sm font-medium text-ink">{windowLabel}未发现值得整理的营销、简报或订阅更新。</p>
			</div>
		);
	}
	return (
		<div className="space-y-5" data-testid="subscription-insight-result">
			<header>
				<h3 className="text-sm font-semibold text-ink">📬 邮箱订阅每日洞察</h3>
				<p className="mt-1 text-xs text-ink-3">{windowLabel} · 当前邮箱</p>
			</header>
			{result.stats.truncated ? (
				<div className="rounded-lg border border-amber/30 bg-amber-bg px-3 py-2 text-xs text-amber">
					本次数据量超过上限，速览展示的是有界结果。已扫描 {result.stats.scanned} 封，选中 {result.stats.selected} 封。
				</div>
			) : null}
			<section aria-labelledby="insight-highlights">
				<h4 id="insight-highlights" className="text-xs font-semibold text-ink">✨ 今日重点</h4>
				<ul className="mt-2 space-y-2">
					{result.topHighlights.slice(0, 4).map((highlight) => (
						<li key={highlight.id} className="rounded-lg border border-edge bg-paper px-3 py-2.5">
							<p className="text-xs leading-5 text-ink-2">{highlight.text}</p>
							<div className="mt-2 flex flex-wrap gap-2">
								{highlight.sourceEmails.slice(0, 1).map((source) => (
									source.availability &&
									source.availability !== "available" ? (
										<span
											key={`${source.accountId}-${source.emailId}`}
											className="inline-flex items-center gap-1 text-xs text-ink-4"
											title={
												source.availability === "account_disconnected"
													? "来源邮箱已断开，重新连接后可打开"
													: "原始邮件已不可用"
											}
										>
											{source.label || source.subject || "来源不可用"}
											（{source.availability === "account_disconnected" ? "邮箱已断开" : "邮件不存在"}）
										</span>
									) : (
										<a
											key={`${source.accountId}-${source.emailId}`}
											href={`/message/${encodeURIComponent(source.emailId)}?accountId=${encodeURIComponent(source.accountId)}`}
											className="inline-flex items-center gap-1 text-xs text-coral hover:underline"
										>
											{source.label || source.subject || "查看来源"}
											<ArrowSquareOutIcon size={11} />
										</a>
									)
								))}
							</div>
						</li>
					))}
				</ul>
			</section>
			<section aria-labelledby="insight-categories">
				<h4 id="insight-categories" className="text-xs font-semibold text-ink">🗂️ 精选信息</h4>
				<div className="mt-2 grid gap-2 sm:grid-cols-2">
					{result.curatedCategories.map((category, index) => (
						<div key={category.id} className="rounded-lg border border-edge bg-paper px-3 py-3">
							<p className="text-xs font-semibold text-ink">{index + 1}. {category.label || categoryLabel(category.kind)}</p>
							<ul className="mt-2 space-y-1.5 text-xs leading-5 text-ink-2">
								{category.items.map((item) => <li key={item.id}>• {item.takeaway}{item.whyItMatters ? <span className="text-ink-3"> {item.whyItMatters}</span> : null}</li>)}
							</ul>
						</div>
					))}
				</div>
			</section>
			{result.recommendedActions.length ? (
				<section aria-labelledby="insight-actions">
					<h4 id="insight-actions" className="text-xs font-semibold text-ink">⚡ 建议操作</h4>
					<div className="mt-2 space-y-2">
						{result.recommendedActions.map((action) => (
							<div key={action.id} className="flex items-start gap-2 rounded-lg border border-edge px-3 py-2.5">
								<ShieldWarningIcon className="mt-0.5 shrink-0 text-amber" size={15} />
								<div className="min-w-0 flex-1">
									<p className="text-xs text-ink-2">{action.reason}</p>
									<p className="mt-1 text-xs text-ink-4">
										{action.status === "requires_confirmation" ? "需要预览并确认后才能执行" : "打开来源后核验"}
									</p>
								</div>
							</div>
						))}
					</div>
				</section>
			) : null}
			{result.keepSubscriptions.length ? (
				<section aria-labelledby="insight-keep">
					<h4 id="insight-keep" className="text-xs font-semibold text-ink">🌟 值得保留的高质量订阅</h4>
					<ul className="mt-2 space-y-1.5 text-xs leading-5 text-ink-2">
						{result.keepSubscriptions.slice(0, 3).map((item) => (
							<li key={item.id}><strong>{item.sourceName}</strong> · {item.reason}</li>
						))}
					</ul>
				</section>
			) : null}
			<p className="text-xs text-ink-4">
				当前邮箱 · {result.stats.groups} 个内容组 · 排除 {result.stats.excluded} 封
			</p>
		</div>
	);
}

function GenericResult({
	envelope,
	reason,
}: {
	envelope: AutomationRunResultEnvelope;
	reason: string;
}) {
	return (
		<div className="rounded-lg border border-edge bg-paper px-4 py-3">
			<p className="text-xs font-medium text-ink">{reason}</p>
			<p className="mt-1 text-xs text-ink-3">
				结果类型 {envelope.resultType} · schema v{envelope.schemaVersion} · renderer {envelope.rendererVersion}
			</p>
		</div>
	);
}

function isSubscriptionInsight(value: unknown): value is SubscriptionInsightResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<SubscriptionInsightResult>;
	return (
		result.type === "subscriptionDailyInsight" &&
		result.schemaVersion === 1 &&
		Array.isArray(result.topHighlights) &&
		result.topHighlights.length <= 4 &&
		Array.isArray(result.curatedCategories) &&
		result.curatedCategories.length <= 8 &&
		Array.isArray(result.recommendedActions) &&
		!!result.stats &&
		typeof result.stats.scanned === "number" &&
		typeof result.stats.selected === "number"
	);
}

function categoryLabel(kind: SubscriptionInsightResult["curatedCategories"][number]["kind"]) {
	return {
		industry: "行业动态",
		product: "产品更新",
		security: "安全与风险",
		account: "账号通知",
		promotion: "营销订阅",
		social: "社区动态",
		custom: "其他",
	}[kind];
}

function insightWindowLabel(window: SubscriptionInsightResult["window"]) {
	const hours = Math.max(1, Math.round((Date.parse(window.end) - Date.parse(window.start)) / 3_600_000));
	return hours === 24 ? "过去 24 小时" : `过去 ${hours} 小时`;
}
