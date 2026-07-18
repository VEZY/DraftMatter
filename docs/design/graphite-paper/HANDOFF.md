# DraftMatter Graphite Paper design handoff

Status: visual design complete; implementation has not started.

This pack defines a pencil-inspired interface that remains practical to build and maintain. The pencil character belongs in icons, status marks, selection brackets, proofing marks, and occasional keylines. Text, layout, fields, dialogs, and most borders remain crisp digital UI.

## Visual reference index

| File | Purpose |
| --- | --- |
| `00-design-system.png` | Tokens, typography, surfaces, controls, statuses, and component fragments |
| `01-workspace-desktop.png` | Everyday desktop manuscript workspace |
| `02-focus-writing.png` | Distraction-free writing and active editor states |
| `03-review-workflow.png` | Review rail, comments, tracked changes, conflicts, and decisions |
| `04-code-computation.png` | Reproducibility drawer, execution freshness, code, and retained output |
| `05-citation-picker.png` | Citation import, search, selection, metadata, and insertion |
| `06-responsive.png` | Tablet and mobile responsive behavior |
| `07-structured-blocks.png` | Equation, figure, table, footnote, and code-cell treatments |

## Design principles

1. Calm comes from spacing, a warm paper ground, restrained contrast, and a readable manuscript measure.
2. Pencil texture is an accent, not a filter. Never roughen body text or every container edge.
3. Product geometry stays systematic: an 8 px spacing rhythm, three radii, uniform borders, and one shadow family.
4. State is communicated by shape and text before color. Rust is supplemental, never the only signal.
5. The manuscript remains editorial; utilities remain compact and operational.

## Foundation tokens

```css
:root {
  --gp-paper: #f3f1eb;
  --gp-sheet: #fbfaf6;
  --gp-graphite: #292a28;
  --gp-lead: #62635f;
  --gp-line: #aaa9a2;
  --gp-eraser: #e2ded4;
  --gp-rust: #a55c45;

  --gp-radius-sm: 8px;
  --gp-radius-md: 12px;
  --gp-radius-lg: 16px;

  --gp-shadow-soft:
    0 1px 2px rgb(41 42 40 / 8%),
    0 2px 9px rgb(41 42 40 / 8%);

  --gp-font-manuscript: Georgia, "Times New Roman", serif;
  --gp-font-utility: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --gp-font-ui: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64` px.

Use at most one low-opacity paper-noise layer across the application canvas. It must not be repeated independently on cards and must become almost imperceptible behind text.

## Type roles

- Manuscript serif: title, abstract/body copy, section headings, captions, equations, bibliography.
- Utility mono: micro-labels, statuses, citekeys, code metadata, keyboard hints, outline counts.
- System sans: buttons, forms, author names, dense panel copy, dialogs, accessibility-critical controls.

Body text must remain crisply rendered. Do not simulate uneven ink in ordinary manuscript paragraphs.

## Geometry and interaction

- Standard components use 1 px `--gp-line` borders.
- Cards and popovers use 12 px radii; large dialogs use 16 px; small controls use 8 px.
- Focus uses a doubled graphite outline with a pale eraser halo.
- Active manuscript blocks use four reusable corner brackets, not a full heavy border.
- Pencil hatching is optional on the lower edge of a primary action or one card keyline. It must never appear on every control.
- Minimum touch target is 40 px on compact layouts.

## Semantic marks

| State | Mark | Supplemental treatment |
| --- | --- | --- |
| Current | Filled graphite circle | `Current` text |
| Stale | Half-filled circle | One rust side tick plus `Stale` |
| Not run | Empty circle | `Not run` text |
| Running | Concentric circles | Motion-reduced-safe pulse plus `Running` |
| Failed | Graphite X | Rust may appear in supporting error copy |
| Active review | Four corner brackets | Pale eraser fill |
| Insertion | Graphite underline | `Insertion` or author metadata where needed |
| Deletion | Rust strikeout | Deletion icon/text; never color alone |
| Comment | Pencil margin tick | Comment icon and author metadata |

## Existing implementation map

- `src/styles.css`: tokens, page material, shell, panels, controls, dialogs, responsive rules.
- `src/App.tsx`: top bar, project switcher, navigation rail, outline, focus mode, review shell, citation picker, command/export/project overlays, code drawer.
- `src/StructuredManuscriptEditor.tsx`: manuscript typography, active-block brackets, drag handles, citations, tracked markup, headings, equations, figures, tables, footnotes, and raw blocks.
- `src/ManagedCodeCellEditor.tsx` and `src/ExecutionOutputView.tsx`: code surfaces and retained-output presentation.
- `src/PortableReviewItems.tsx`, `src/AlignedReviewRail.tsx`, and `src/CollaborationReviewPanel.tsx`: comments, suggestions, conflicts, and review decisions.
- `src/Icon.tsx`: reusable graphite icon treatment and the small set of pencil-specific marks.

Preserve the existing accessibility behavior, semantic labels, keyboard navigation, and focus management. This is a visual-system migration, not permission to change functionality implicitly.

## Responsive rules

Use the existing breakpoint structure as the starting point:

- Wide desktop: icon rail + outline + manuscript + optional review rail.
- Under roughly 1180 px: outline becomes optional; review remains available as a drawer.
- Under roughly 980 px: persistent side panels close; top-bar toggles open slide-over panels.
- Under roughly 720 px: icon rail disappears; project/status copy compresses; formatting becomes `Aa Format`, citation, and insert controls; reproducibility becomes a two-row card.

Never allow horizontal document scrolling. Reduce manuscript margins and type scale modestly before reducing touch targets.

## Suggested implementation sequence

1. Add tokens, font roles, background material, focus rule, status primitives, and pencil SVG marks.
2. Migrate the app shell, outline, manuscript sheet, format toolbar, and focus mode.
3. Migrate structured manuscript nodes and active editing states.
4. Migrate review, citation, and code/computation workflows.
5. Apply responsive rules and run accessibility, visual-regression, and interaction tests.

## Acceptance criteria

- No sage/green/blue product accents remain in the Graphite Paper theme.
- Rust appears only for warnings, stale states, deletions, conflicts, and proofreader carets.
- Essential meaning never depends on texture or color alone.
- Body copy and dense UI text remain digitally crisp.
- Pencil treatment is reusable and sparse; there are no one-off hand-drawn borders per component.
- All existing editor, review, citation, execution, export, collaboration, and keyboard workflows remain functional.
- Reduced-motion, focus-visible, contrast, and mobile touch-target behavior continue to pass the existing test suite.

## Generation provenance

The PNG references were generated with the built-in image generator. The prompt set used the current DraftMatter screenshots and code structure as layout references, then applied the Graphite Paper system consistently to the everyday workspace, focus editing, review, reproducibility, citations, responsive layouts, and structured manuscript blocks. The PNGs are visual references only; do not ship them as application UI assets.
