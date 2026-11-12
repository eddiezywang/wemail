// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { MemoryRouter } from "react-router";
import EmailPanel from "./EmailPanel";
import type { Email } from "~/types";
import type { EmailIntelligenceState } from "shared/wemail/intelligence";

const state = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	return {
		...(() => {
			vi.resetModules();
			return {};
		})(),
		email: undefined as Email | undefined,
		emailIsFetching: false,
		intelligenceData: undefined as EmailIntelligenceState | undefined,
		threadReplies: [] as Email[],
		mutation: () => ({
			mutate: vi.fn(),
			mutateAsync: vi.fn(),
			isPending: false,
		}),
		// Subscription plumbing so the mocked query hooks re-render their host
		// on data change, exactly like real TanStack Query (internal subscription,
		// independent of parent). EmailPanel is memoized, so parent re-renders no
		// longer propagate; tests mutate `state` then call `state.emit()`.
		subscribe: (cb: () => void) => {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		emit: () => {
			for (const cb of listeners) cb();
		},
	};
});

vi.mock("~/components/email-panel/EmailPanelDialogs", () => ({
	default: () => null,
}));

vi.mock("~/components/email-panel/EmailPanelHeader", () => ({
	default: ({ subject }: { subject: string }) => (
		<div data-testid="email-panel-header">{subject}</div>
	),
}));

vi.mock("~/components/email-panel/EmailPanelToolbar", () => ({
	default: () => <div data-testid="email-panel-toolbar" />,
}));

vi.mock("~/components/email-panel/MessageSenderBar", () => ({
	default: ({ email }: { email: Email }) => (
		<div data-testid="message-sender-bar">{email.sender}</div>
	),
}));

vi.mock("~/components/email-panel/SingleMessageView", () => ({
	default: ({ email, isBodyLoading }: { email: Email; isBodyLoading?: boolean }) => (
		<div data-testid="single-message-view" data-body-loading={String(!!isBodyLoading)}>{email.id}</div>
	),
	SingleMessageActions: () => <div data-testid="single-message-actions" />,
}));

vi.mock("~/components/email-panel/ThreadMessage", () => ({
	default: ({ email, isExpanded }: { email: Email; isExpanded: boolean }) => (
		<div
			data-email-id={email.id}
			data-expanded={String(isExpanded)}
			data-testid="thread-message"
		>
			{email.id}
		</div>
	),
}));

vi.mock("~/components/email-panel/CreateTodoDialog", () => ({
	CreateTodoDialog: () => null,
}));

vi.mock("~/components/automation/AutomationRuleForm", () => ({
	AutomationRuleForm: () => null,
}));

// P2.6: EmailPanel reads the edition feature flags directly (the invoice
// refresh trigger stays unwired without `allowanceInvoice`), so the suite
// pins the open-edition defaults instead of mounting a QueryClient.
const editionFeatures = vi.hoisted(() => ({ allowanceInvoice: false }));

vi.mock("~/hooks/useEditionFeatures", () => ({
	useEditionFeatures: () => ({
		wecli: false,
		allowanceInvoice: editionFeatures.allowanceInvoice,
		enterpriseDirectory: false,
		officeSceneDetection: false,
	}),
}));

vi.mock("~/components/wemail/EmailIntelligenceCard", () => ({
	default: () => <div data-testid="email-intelligence-card" />,
}));

vi.mock("~/components/compose/InlineFloatingCompose", () => ({
	default: () => <div data-testid="inline-floating-compose" />,
}));

vi.mock("~/components/wemail/SmartDraftPanel", () => ({
	default: () => <div data-testid="smart-draft-panel" />,
}));

vi.mock("~/components/email-panel/QuickReplyChips", () => ({
	default: () => <div data-testid="quick-reply-chips" />,
}));

vi.mock("~/queries/intelligence", () => ({
	intelligenceKeys: {
		detail: (emailId: string) => ["wemail-intelligence", "messages", emailId],
	},
	useIntelligence: () => ({
		data: state.intelligenceData,
		error: undefined,
		isError: false,
		isLoading: false,
	}),
	useLlmStatus: () => ({ data: { configured: true } }),
	useRetrySummary: state.mutation,
	useTriggerReplyDecision: state.mutation,
}));

vi.mock("~/queries/insightReports", () => ({
	useInsightReport: () => ({ data: null }),
}));

vi.mock("~/queries/emails", () => ({
	useDeleteEmail: state.mutation,
	useEmail: () => ({
		data: useSyncExternalStore(
			state.subscribe,
			() => state.email,
			() => state.email,
		),
		isFetching: useSyncExternalStore(
			state.subscribe,
			() => state.emailIsFetching,
			() => state.emailIsFetching,
		),
	}),
	useMoveEmail: state.mutation,
	useSendDraft: state.mutation,
	useThreadReplies: () => ({
		data: useSyncExternalStore(
			state.subscribe,
			() => state.threadReplies,
			() => state.threadReplies,
		),
	}),
	useUpdateEmail: state.mutation,
	requestAutoRead: () => true,
	releaseAutoRead: () => undefined,
	scheduleIdleTask: (task: () => void) => {
		task();
		return () => {};
	},
}));

vi.mock("~/queries/folders", () => ({
	useFolders: () => ({ data: [] }),
}));

vi.mock("~/queries/mailboxes", () => ({
	useMailbox: () => ({ data: { email: "me@example.com" } }),
}));

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: () => ({ data: { account: { id: "acct-1" } } }),
}));

vi.mock("~/hooks/useUIStore", () => ({
	useUIStore: () => ({
		closePanel: vi.fn(),
		composeOptions: { mode: "new" },
		draftPanelMode: "docked",
		draftPanelPosition: { x: 0, y: 0 },
		isComposing: false,
		moveDraftPanel: vi.fn(),
		setDraftPanelDocked: vi.fn(),
		setDraftPanelFloating: vi.fn(),
		startCompose: vi.fn(),
	}),
}));

function makeEmail(overrides: Partial<Email> = {}): Email {
	return {
		body: "Hello",
		date: "2026-04-27T12:00:00.000Z",
		folder_id: "Inbox",
		id: "msg-1",
		read: false,
		recipient: "me@example.com",
		sender: "Alice <alice@example.com>",
		snippet: "Hello",
		starred: false,
		subject: "Project update",
		thread_id: "thread-1",
		...overrides,
	} as Email;
}

function renderPanel(folderId?: string) {
	return (
		<MemoryRouter>
			<EmailPanel emailId="msg-1" folderId={folderId} />
		</MemoryRouter>
	);
}

function waitForSecondaryContent() {
	return new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});
}

describe("EmailPanel", () => {
	beforeEach(() => {
		state.email = undefined;
		state.emailIsFetching = false;
		state.intelligenceData = undefined;
		state.threadReplies = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps hook order stable when the selected email loads after the skeleton", () => {
		render(renderPanel());

		// Email arrives via the query subscription (internal re-render), the way
		// real TanStack Query delivers data — not via a parent re-render.
		state.email = makeEmail();
		act(() => state.emit());

		expect(screen.getByTestId("email-panel-header")).toHaveTextContent(
			"Project update",
		);
	});

	it("keeps the selected thread message expanded after replies load asynchronously", () => {
		state.email = makeEmail({
			id: "msg-1",
			date: "2026-04-27T12:00:00.000Z",
		});
		render(renderPanel());

		expect(screen.getByTestId("single-message-view")).toHaveTextContent(
			"msg-1",
		);

		state.threadReplies = [
			makeEmail({
				body: "Newest reply body",
				date: "2026-04-27T12:05:00.000Z",
				id: "msg-2",
				snippet: "Newest reply body",
			}),
		];
		act(() => state.emit());

		const messages = screen.getAllByTestId("thread-message");
		expect(messages[0]).toHaveAttribute("data-email-id", "msg-2");
		expect(messages[0]).toHaveAttribute("data-expanded", "false");
		expect(messages[1]).toHaveAttribute("data-email-id", "msg-1");
		expect(messages[1]).toHaveAttribute("data-expanded", "true");
	});

	it("shows the intelligence card after the metadata-first paint and before the email body", async () => {
		state.email = makeEmail();

		render(renderPanel());

		const header = screen.getByTestId("email-panel-header");
		const senderBar = screen.getByTestId("message-sender-bar");
		const body = screen.getByTestId("single-message-view");
		const intelligence = await screen.findByTestId("email-intelligence-card");
		expect(
			header.compareDocumentPosition(senderBar) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			senderBar.compareDocumentPosition(intelligence) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			intelligence.compareDocumentPosition(body) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("uses per-message headers instead of a fixed sender bar for threads", () => {
		state.email = makeEmail();
		state.threadReplies = [
			makeEmail({
				id: "msg-2",
				date: "2026-04-27T12:05:00.000Z",
			}),
		];

		render(renderPanel());

		expect(screen.queryByTestId("message-sender-bar")).toBeNull();
		expect(screen.getAllByTestId("thread-message")).toHaveLength(2);
	});

	it("keeps metadata visible and limits loading to the body while fetching full content", async () => {
		state.email = makeEmail({ body: null });
		state.emailIsFetching = true;

		render(renderPanel());

		expect(screen.getByTestId("email-panel-shell")).toBeInTheDocument();
		expect(screen.getByTestId("single-message-view")).toHaveAttribute(
			"data-body-loading",
			"true",
		);
		await waitFor(() => {
			expect(screen.getByTestId("email-intelligence-card")).toBeInTheDocument();
		});
	});

	it("hides translation and no-reply UI while preserving the decision state", () => {
		state.email = makeEmail();
		state.intelligenceData = {
			emailId: "msg-1",
			summary: { status: "pending" },
			tags: { status: "pending" },
			replyDecision: {
				status: "succeeded",
				result: {
					type: "replyDecision",
					shouldReply: false,
					reason: "Automated notification",
					confidence: 0.98,
				},
			},
			replyDraft: { status: "not-needed" },
		};

		render(renderPanel());

		expect(screen.queryByText("翻译")).toBeNull();
		expect(screen.queryByText("无需回复")).toBeNull();
		expect(screen.queryByTestId("smart-draft-panel")).toBeNull();
	});

	it("hides reply-waiting intelligence for sent mail", async () => {
		state.email = makeEmail({ folder_id: "Sent" });
		state.intelligenceData = {
			emailId: "msg-1",
			summary: {
				status: "succeeded",
				result: {
					type: "summary",
					bullets: ["Existing summary"],
					actionItems: [],
					urgency: "low",
				},
			},
			tags: { status: "succeeded" },
			replyDecision: {
				status: "succeeded",
				result: {
					type: "replyDecision",
					shouldReply: true,
					reason: "asks for confirmation",
					confidence: 0.98,
					priorityScore: 0.9,
					level: "high",
					replyRequired: true,
					signals: [],
				},
			},
			replyDraft: {
				status: "succeeded",
				result: {
					type: "replyDraft",
					draftMarkdown: "Reply",
					variants: [{ tone: "medium", draftMarkdown: "Reply" }],
				} as any,
			},
		};

		render(renderPanel());
		await waitForSecondaryContent();

		expect(screen.queryByText("建议回复")).toBeNull();
		expect(screen.queryByTestId("email-intelligence-card")).toBeNull();
		expect(screen.queryByTestId("quick-reply-chips")).toBeNull();
		expect(screen.queryByTestId("smart-draft-panel")).toBeNull();
	});

	it("uses the explicit list folder when provider mail metadata is ambiguous", async () => {
		state.email = makeEmail({ folder_id: "All Mail" });
		state.intelligenceData = {
			emailId: "msg-1",
			summary: {
				status: "succeeded",
				result: {
					type: "summary",
					bullets: ["Stale sent summary"],
					actionItems: [],
					urgency: "low",
				},
			},
			tags: { status: "succeeded" },
			replyDecision: { status: "pending" },
			replyDraft: { status: "pending" },
		};

		render(renderPanel("sent"));
		await waitForSecondaryContent();

		expect(screen.queryByTestId("email-intelligence-card")).toBeNull();
		expect(screen.queryByTestId("smart-draft-panel")).toBeNull();
	});
});
