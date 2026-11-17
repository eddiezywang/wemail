import { expect, test as base } from "@playwright/test";
import { PlaywrightAiFixture } from "@midscene/web/playwright";
import { injectDesktopApi } from "../browser/helpers/mockDesktop";
import {
  loginWithFixture,
  startTestServer,
  type TestServer,
} from "../browser/helpers/testServer";
import { installAgentStreamScenario } from "../browser/helpers/agentStream";

const test = base.extend(PlaywrightAiFixture());
let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer({ inboxFixtures: ["mail-001-question.json"] });
});

test.afterAll(async () => server.close());

test("reasoning settles into readable Markdown with a subordinate tool card", async ({
  page,
  aiAssert,
}) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await installAgentStreamScenario(page, "reasoning-markdown-tool");
  await loginWithFixture(server.apiBaseUrl);
  await page.goto("/");

  const input = page.getByLabel("Chat message input");
  await input.fill("总结今天最需要处理的邮件");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("正在分析")).toBeVisible();
  await aiAssert("WeMail AI 对话中正在分析的过程清晰可见，但不会伪装成最终答案");

  await expect(page.getByRole("heading", { name: "今日重点" })).toBeVisible();
  await expect(page.getByText("已完成分析")).toBeVisible();
  await aiAssert(
    "最终回复已经渲染成整洁的 Markdown：有标题、项目列表、强调文字和对齐正常的表格，看不到原始井号或表格分隔符",
  );
  await aiAssert(
    "分析过程和工具执行已经统一收成一行可查看的已完成分析入口，最终结论位于它下方且是本轮最后的主要内容，整个聊天面板没有文字重叠或横向溢出",
  );
  await page.screenshot({ path: "workspace/reports/midscene-agent-reasoning-markdown-tool.png" });
});

test("stopped follow-up queue is visibly paused and requires confirmation", async ({
  page,
  aiAssert,
}) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await installAgentStreamScenario(page, "stoppable-queue");
  await loginWithFixture(server.apiBaseUrl);
  await page.goto("/");

  const input = page.getByLabel("Chat message input");
  await input.fill("分析最近的邮件");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("正在分析")).toBeVisible();
  await input.fill("完成后再给出一句话建议");
  await page.getByRole("button", { name: "Queue message" }).click();
  await expect(page.getByTestId("agent-followup-queue")).toContainText("完成后再给出一句话建议");
  await aiAssert("后续消息以独立队列显示，和已经发送的用户消息有明确区别，用户能看出它尚未执行");

  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByText("后续消息已暂停")).toBeVisible();
  await aiAssert("停止生成后，队列明确显示为暂停状态，并提供醒目的确认继续入口，不会让人误以为消息已自动发送");
  await page.screenshot({ path: "workspace/reports/midscene-agent-paused-queue.png" });

  await page.getByRole("button", { name: "确认继续" }).click();
  await expect(page.getByText("已按你的确认恢复后续分析。")).toBeVisible();
  await aiAssert("用户确认后，暂停的后续消息作为新的对话轮次执行，队列消失且结果出现在正确位置");
});
