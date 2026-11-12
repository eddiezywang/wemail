# Sidebar Secondary Active State Fix Plan

1. Derive parent and child active states from the current pathname and query parameters.
2. Pass explicit active state into the reusable secondary-link component instead of using `NavLink`'s pathname-only result.
3. Replace the secondary active style with a light coral tint and short coral hierarchy rail.
4. Add focused sidebar tests for category exclusivity, parent behavior, smart tags, folders, and active classes.
5. Run typecheck, focused and full renderer tests, desktop rebuild/startup acceptance, then commit, merge to `main`, and push.
