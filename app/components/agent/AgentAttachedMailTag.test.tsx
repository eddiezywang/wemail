import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAttachedMailTag } from "./AgentAttachedMailTag";

describe("AgentAttachedMailTag", () => {
	it("keeps the email title visible without an association label or internals", () => {
		render(
			<AgentAttachedMailTag
				mail={{
					subject: "补光灯067",
					sender: "SHDR Lost & Found",
					receivedAt: "2026-06-01T07:52:17.000Z",
				}}
			/>,
		);

		const tag = screen.getByTestId("agent-attached-mail-tag");
		expect(tag).toHaveTextContent("补光灯067");
		expect(tag).not.toHaveTextContent("已关联");
		expect(tag).not.toHaveTextContent(/emailId|tool|path/);
	});
});
