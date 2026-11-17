# Compose Empty Guidance Pointer Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let clicks on the gray empty-compose guidance reach the editor while keeping only `使用 AI 写作` clickable.

**Architecture:** Keep the existing `emptyGuidance` overlay and `hasEditableComposeContent` visibility condition. Make the overlay pointer-transparent in `RichTextEditor`, split the guidance in `ComposeBody` into presentational gray text plus one pointer-enabled AI button, and preserve the existing AI prompt focus handle.

**Tech Stack:** React 19, TypeScript, TipTap 3, Tailwind CSS, Vitest, Testing Library

## Global Constraints

- Preserve the existing guidance copy and visual styling.
- The gray guidance text has no click handler or interactive semantic role.
- Only `使用 AI 写作` is a button and focuses the AI prompt.
- The guidance remains controlled by `hasEditableComposeContent`.
- Do not add a TipTap placeholder extension or programmatic focus behavior for gray-text clicks.

---

## File Structure

- `app/components/compose/ComposeBody.tsx`: owns compose-specific guidance copy, visibility, and the AI prompt action.
- `app/components/RichTextEditor.tsx`: owns the pointer-transparent overlay boundary above TipTap.
- `app/components/compose/ComposeBody.test.tsx`: verifies guidance semantics, AI focus behavior, and content-driven visibility.
- `app/components/editor/RichTextEditor.test.tsx`: verifies the reusable overlay is pointer-transparent.

### Task 1: Correct the empty-guidance interaction boundary

**Files:**

- Modify: `app/components/compose/ComposeBody.test.tsx`
- Modify: `app/components/editor/RichTextEditor.test.tsx`
- Modify: `app/components/compose/ComposeBody.tsx`
- Modify: `app/components/RichTextEditor.tsx`

**Interfaces:**

- Consumes: `RichTextEditor.emptyGuidance?: ReactNode`, `AiPromptBarHandle.focus(): void`, and `hasEditableComposeContent(html: string): boolean`.
- Produces: an empty guidance overlay whose container has `pointer-events-none`, with one descendant button named `使用 AI 写作` using `pointer-events-auto`.

- [ ] **Step 1: Write failing compose behavior tests**

Update the hoisted test state and compose-form mock in
`app/components/compose/ComposeBody.test.tsx`:

```tsx
const { focusSpy, composeState } = vi.hoisted(() => ({
	focusSpy: vi.fn(),
	composeState: {
		body: '<p><br></p><div data-wemail-signature="true">V Bank</div>',
	},
}));

// Inside the useComposeForm mock:
body: composeState.body,
```

Replace the current single test with:

```tsx
describe("ComposeBody AI writing guidance", () => {
	it("makes only the AI writing text interactive", async () => {
		focusSpy.mockReset();
		composeState.body =
			'<p><br></p><div data-wemail-signature="true">V Bank</div>';
		render(<ComposeBody renderHeader={() => null} />);

		expect(
			screen.queryByRole("button", { name: "开始输入或 使用 AI 写作" }),
		).not.toBeInTheDocument();

		const aiButton = screen.getByRole("button", { name: "使用 AI 写作" });
		expect(aiButton).toHaveClass("pointer-events-auto");

		await userEvent.click(screen.getByText("开始输入或"));
		expect(focusSpy).not.toHaveBeenCalled();

		await userEvent.click(aiButton);
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it("hides the guidance when the draft has editable body content", () => {
		composeState.body = "<p>Already writing</p>";
		render(<ComposeBody renderHeader={() => null} />);

		expect(screen.queryByText("开始输入或")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "使用 AI 写作" }),
		).not.toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Write the failing editor overlay test**

Replace the first test in `app/components/editor/RichTextEditor.test.tsx`
with:

```tsx
it("keeps the empty-compose guidance overlay pointer-transparent", async () => {
	render(
		<RichTextEditor
			value="<p><br></p>"
			onChange={() => {}}
			composeSurface
			emptyGuidance={
				<span>
					<span>开始输入或</span>{" "}
					<button type="button" className="pointer-events-auto">
						使用 AI 写作
					</button>
				</span>
			}
		/>,
	);

	expect(await screen.findByTestId("empty-guidance-overlay")).toHaveClass(
		"pointer-events-none",
	);
	expect(
		screen.getByRole("button", { name: "使用 AI 写作" }),
	).toHaveClass("pointer-events-auto");
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run app/components/compose/ComposeBody.test.tsx app/components/editor/RichTextEditor.test.tsx
```

Expected: FAIL because the current full sentence is one button and the editor overlay does not expose `data-testid="empty-guidance-overlay"`.

- [ ] **Step 4: Implement the minimal semantic and pointer-event fix**

Replace `ComposeBody.tsx` guidance markup with:

```tsx
emptyGuidance={
	!hasEditableComposeContent(body) ? (
		<span className="rounded-md px-1.5 py-1 text-sm text-ink-3">
			<span>开始输入或</span>{" "}
			<button
				type="button"
				onClick={() => aiPromptRef.current?.focus()}
				className="pointer-events-auto font-medium text-coral underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30"
			>
				使用 AI 写作
			</button>
		</span>
	) : undefined
}
```

Replace the overlay markup in `RichTextEditor.tsx` with:

```tsx
{emptyGuidance ? (
	<div
		data-testid="empty-guidance-overlay"
		className="pointer-events-none absolute left-3 top-3 z-10"
	>
		{emptyGuidance}
	</div>
) : null}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
npx vitest run app/components/compose/ComposeBody.test.tsx app/components/editor/RichTextEditor.test.tsx
```

Expected: both files pass with no failed tests.

- [ ] **Step 6: Run full verification**

Run:

```powershell
npm run test:renderer
npm run typecheck
npm run build:renderer
git diff --check
```

Expected: every command exits with code `0`; Vitest reports no failed tests,
TypeScript reports no errors, and the renderer production build completes.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- app/components/compose/ComposeBody.tsx app/components/RichTextEditor.tsx app/components/compose/ComposeBody.test.tsx app/components/editor/RichTextEditor.test.tsx docs/superpowers/plans/2026-07-20-compose-empty-guidance-pointer-behavior.md
git commit -m "fix: preserve compose editor first-line clicks"
```
