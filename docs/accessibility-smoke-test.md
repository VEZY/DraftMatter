# Keyboard-only accessibility smoke test

Use this short manual check before a desktop release on macOS, Windows, and Linux. Do not use a mouse or trackpad during the test. The expected result is the same in the browser development build and the packaged desktop application.

1. Launch DraftMatter with the operating system's reduced-motion preference enabled. Confirm that saving, loading, collaboration, and execution status changes do not pulse or spin, and that outline or footnote navigation moves immediately instead of scrolling smoothly.
2. Press `Command+K` on macOS or `Control+K` on Windows/Linux. Confirm that the **Command menu** opens with focus in **Search commands**.
3. Type `portable source`, use the arrow keys to move through any matching commands, and press `Enter`. Confirm that the **Portable source inspector** opens and that its name is announced by the screen reader, if one is enabled.
4. Close the inspector with its keyboard-reachable close control. Open the command menu again and press `Escape`; confirm that the menu closes without inserting text into the manuscript.
5. Use `Tab` and `Shift+Tab` through the project controls, document title, formatting controls, manuscript, review panel, and footer controls. Every focused control must have a visible green outline, and the focus order must follow the visual reading order.
6. In the manuscript title and a paragraph, type a short change and undo it with `Command+Z` or `Control+Z`. Confirm that the editor remains focused and that the portable manuscript content is restored.
7. Tab to **Next review item** and **Previous review item**, activate each with `Space` or `Enter`, and confirm that the selected review and its `n of total` position both update.
8. Open each dialog reached during the workflow, traverse its fields and actions with `Tab` and `Shift+Tab`, then close it with a visible close control or `Escape`. Confirm that no actionable control is skipped and no focus indicator is clipped.

The smoke test passes only when all actions are keyboard-complete, focus is always perceptible, status changes remain understandable without animation, and no text or action depends on color alone.

The automated companion checks run with:

```sh
npx vitest run src/accessibility.test.ts src/accessibility.test.tsx
npm run test:e2e -- tests/e2e/accessibility.spec.ts
```

The unit scan catches semantic WCAG A/AA regressions quickly. The Chromium scan repeats those rules in a rendered page, including usable color contrast, and verifies reduced-motion CSS plus the visible keyboard focus ring.
