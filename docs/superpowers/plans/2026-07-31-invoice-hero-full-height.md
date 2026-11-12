# Invoice Hero Full-Height Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four-column homepage invoice App workspace fill the entire area below the titlebar inside the existing 16:9 canvas.

**Architecture:** Keep the viewport as the sizing boundary and make it a two-row CSS Grid. The titlebar occupies its natural height; the workspace stretches into the remaining row without changing column proportions, typography, animation, or narrow-screen behavior.

**Tech Stack:** Astro, CSS Grid, Node.js `node:test`, Astro/Starlight build tooling.

## Global Constraints

- Keep the homepage canvas width and `aspect-ratio: 16 / 9` unchanged above `62rem`.
- Keep `aspect-ratio: auto` below `62rem`.
- Do not scale the simulated App or add filler content.
- Do not change animation timing, controller state, column proportions, or documentation-page demos.
- Use `--script-shell="C:\Windows\System32\cmd.exe"` for npm scripts.

---

### Task 1: Stretch the invoice workspace to the canvas bottom

**Files:**
- Modify: `website/tests/invoice-hero-markup.test.mjs`
- Modify: `website/src/styles/invoice-hero.css`

**Interfaces:**
- Consumes: `.invoice-hero__viewport`, `.invoice-hero__titlebar`, and `.invoice-hero__workspace` from `InvoiceHeroDemo.astro`.
- Produces: a viewport with an `auto` titlebar row and a flexible workspace row; the existing four workspace columns fill that row.

- [ ] **Step 1: Write the failing full-height layout contract**

Add this test to `website/tests/invoice-hero-markup.test.mjs`:

```javascript
test("invoice hero workspace fills the 16:9 viewport below the titlebar", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "invoice-hero.css"),
    "utf8",
  );
  const viewportRules = extractCssBlock(css, ".invoice-hero__viewport");
  const workspaceRules = extractCssBlock(css, ".invoice-hero__workspace");

  assert.match(viewportRules, /display:\s*grid/);
  assert.match(
    viewportRules,
    /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/,
  );
  assert.match(workspaceRules, /min-height:\s*0/);
  assert.doesNotMatch(workspaceRules, /min-height:\s*31\.4rem/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test website/tests/invoice-hero-markup.test.mjs
```

Expected: the new test fails because `.invoice-hero__viewport` is not a Grid container and `.invoice-hero__workspace` still has `min-height: 31.4rem`.

- [ ] **Step 3: Implement the minimal CSS layout fix**

Update the two rules in `website/src/styles/invoice-hero.css`:

```css
.invoice-hero__viewport {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  aspect-ratio: 16 / 9;
  min-height: 34rem;
  overflow: hidden;
  border: 1px solid #ded4ce;
  border-radius: 1.3rem 1.3rem 0 0;
  background: #fff;
  box-shadow: 0 2rem 6rem rgba(75, 47, 34, 0.16);
}

.invoice-hero__workspace {
  display: grid;
  grid-template-columns: 12fr 21fr 38fr 29fr;
  min-height: 0;
}
```

- [ ] **Step 4: Run focused GREEN and website verification**

Run:

```powershell
node --test website/tests/invoice-hero-markup.test.mjs
npm --prefix website run test:all --script-shell="C:\Windows\System32\cmd.exe"
git diff --check
```

Expected: all commands exit `0`; the focused test includes the new full-height contract, Astro reports zero diagnostics, and the production build succeeds.

- [ ] **Step 5: Verify the live page and preview in the browser**

Request `http://127.0.0.1:4322/` and confirm status `200`. Refresh/open that address in the browser and visually confirm:

- the titlebar remains at the top;
- navigation, list, reader, and AI panel extend to the canvas bottom;
- no unowned blank strip remains below the four-column workspace;
- the canvas remains 16:9.

- [ ] **Step 6: Commit and push**

```powershell
git add website/tests/invoice-hero-markup.test.mjs website/src/styles/invoice-hero.css
git commit -m "fix(docs): fill invoice hero canvas"
git push origin feature/official-docs-homepage-polish
```

