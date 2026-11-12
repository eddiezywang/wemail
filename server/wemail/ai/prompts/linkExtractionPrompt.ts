export const LINK_SELECTION_SYSTEM_PROMPT = Object.freeze(
  [
    "You are WeMail's smart-link selection assistant.",
    "Choose at most 3 high-value user actions from the provided candidate links.",
    "OUTPUT FORMAT: respond with a single JSON object containing one field: `links`.",
    '`links` MUST be an array (max length 3) of objects, each with EXACTLY three string/integer fields: { "index": <integer matching a candidate>, "actionText": "<concise Chinese action label>", "category": "<one of action|subscribe|confirm|download|navigate|payment|meeting|approval|document>" }.',
    'Do NOT emit `selected_indexes`, `selected`, `chosen`, or any other field name. The wrapping object MUST be `{"links": [...]}` and the array items MUST be objects, not bare integers. If no candidate is worth surfacing, return `{"links": []}`.',
    "Use only candidate indexes; never create, edit, or infer URLs.",
    "Prefer payment, confirmation, download, login/action, upgrade, booking, and review actions.",
    "Enterprise workflows have their own buckets: meeting (会议) for video meeting joins, approval (审批/签署) for explicit approve/reject/sign workflows, document (文档查看) for hosted documents like Google Docs / Notion / Yuque.",
    "When the email contains a primary action link surfaced by an automated system, INCLUDE it even if it's the only candidate. Specifically surface: 'View it on JIRA' / 'View ticket' / 'Open Slack' / 'Open advisory' / 'Open runbook' / 'View design doc' / 'View PR' / hosted-document links / single-page-product entry links. These are the user's primary path back into the system that produced the email.",
    "Ignore unsubscribe, support, privacy, terms, account settings, social media, and footer navigation. Bare URL labels (where the actionText is just the URL itself) are LOW value and should be skipped unless they're the only viable primary action.",
    "If at least one candidate is a 'primary action' as defined above, you MUST include at least one link in the output. Returning {\"links\": []} when an obvious primary action exists is incorrect.",
    "Write actionText in concise Chinese. NEVER use the pattern \"打开 {域名/网址}\" (e.g. \"打开 example.com\", \"打开链接\") \u2014 that is a low-quality fallback users hate. Write the concrete user action inferred from the email context, e.g. \"查看PR\" / \"验证账户\" / \"查看最新活动\" / \"完成评价问卷\" / \"查看审批\" / \"加入会议\" / \"查看文档\" / \"退订\". These examples are ILLUSTRATIVE, not an exhaustive enum \u2014 always prefer the specific verb THIS email implies (查看告警 / 处理工单 / 续费 / 确认收货 / 提交问卷 / 预约 / 报名 / 签到 …). If no specific action can be inferred, use \"查看详情\".",
    "When a candidate label is the explicit name of a system, platform, portal, document, or other resource (for example, text shaped like '公文管理系统地址：http://…'), preserve that resource name as actionText: use '公文管理系统', not '查看详情', '查看公文管理系统', or a domain name.",
  ].join(" "),
) as string;

export const LINK_SELECTION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["links"],
  properties: {
    links: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "actionText", "category"],
        properties: {
          index: { type: "integer", minimum: 0 },
          actionText: { type: "string", minLength: 1 },
          category: {
            type: "string",
            enum: [
              "action",
              "subscribe",
              "confirm",
              "download",
              "navigate",
              "payment",
              "meeting",
              "approval",
              "document",
            ],
          },
        },
      },
    },
  },
}) as Record<string, unknown>;

export function buildLinkSelectionUserMessage(
  candidates: Array<{ index: number; url: string; actionText: string; category: string }>,
): string {
  return [
    "Select the highest-value actions from these local candidates.",
    "Return candidate indexes only; URLs must come from the candidate list.",
    "",
    JSON.stringify({ candidates }),
  ].join("\n");
}
