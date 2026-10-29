# Generative UI plan

Status: A0, A1 and A2 built, and the Tasks tab pilot built behind a toggle (2026-10-29). Written 2026-10-28.

Built:

- **A0.** `dpi-sdk/src/ui-spec.ts` is the one catalog. `ui_render` and `ui_template_save` read its
  generated text (`uiCatalogText`).
- **A1.** Data paths are under `/state`, `/agent`, `/device` and `/local`. Fields take `{"@path"}`
  and `{"@template"}` bindings, and any component can carry a `when` condition. Data model:
  playground `client/ui-data.ts`.
- **A2.** `each` uses item-relative paths and `@index`. `button` runs one of the named actions in
  `UI_ACTIONS`: setState, sendToAgent, runJob, decideJob, stopAll, showRun or openAgent.
- **Tasks pilot.** `client/tab-templates.ts` holds `TASKS_TAB`. The "Template view" toggle on the
  Tasks tab switches to it and is remembered in localStorage.

## Question

Should the whole playground explorer UI be rebuilt as generative views (agent-published ui-spec
JSON, shaped by saved templates and user preferences), either by converting the current UI or
starting over?

## Decision

Heavy templates, generative in between. Saved templates are the base of the UI, and the agent
generates views in the gaps between them. Build on the current UI. Do not rebuild from scratch.

- **Fixed core, for now (hand-written Vue):** network tree, chat transcript, composer, todo widget.
  We run both approaches side by side until the templates are locked in. After that, the core
  can move to templates too.
- **Templates and generated views:** inspector tabs (State, Tasks, Tools, Extend, Session) and the
  Canvas, rendered from ui-spec views and templates that the user or the agent can edit at runtime.

- **Direction (2026-10-29): the Canvas absorbs the inspector tabs.** Over time every tab (Session
  and context, State, Tasks, Tools, Extend) becomes a card on the Canvas, built from a template.
  The tab strip goes away once the last tab has moved. The Tasks tab template (`TASKS_TAB`) is the
  first of these cards.

A greenfield rewrite only pays off if Vue or the hub is also being replaced. Otherwise it rewrites
the cheap parts and keeps the hard ones (hub, SSE streams, store, App State sync), which already
work.

## Why the core stays fixed until templates are locked in

- **R1. The core can't depend on an agent.** The network tree, chat and composer are how you
  reach an agent. A broken view would stop you from asking the agent to fix it.
- **R2. Chat performance.** The transcript streams tokens and tool cards. Re-rendering a JSON spec
  on every frame is slower and loses detail like tool expansion and the todo widget.
- **R3. Catalog gap.** ui-spec has 10 components (card, row, column, text, markdown, metric,
  badge, progress, list, table, input), and only `input` is interactive. The playground FE is 22
  components (about 4,500 lines) with buttons, trees, forms and job cards.

## Work plan

| Step | Work | Estimate |
| ---- | ---- | -------- |
| A1 | Data bindings. text, metric, table and list read a live path (`/state/...` App State, or an agent doc such as `toolkit.todo`) instead of fixed values. `input` already binds to App State. | about 1 day |
| A2 | Actions and repeats. A `button` component that calls a tool, an endpoint or a state write. An `each` component that repeats a child for every item in an array. | 1 to 2 days |
| A3 | Move each inspector tab (about 1,200 lines of Vue) onto the Canvas as a template card, one tab at a time: Tasks, State, Tools, Extend, then Session and context. The hand-written tab stays as a fallback until its card matches it. Remove the tab strip after the last one. | 2 to 3 days |
| A4 | User preferences. Card order, pinned cards and template overrides are stored in App State, so a card can be reshaped by editing a template, with no rebuild. | 1 to 2 days |

Total: about 5 to 8 days. A1 and A2 are useful on their own, because they make canvas forms and
dashboards useful even if the rest is never done.

Suggested first step: A1 and A2, then convert the Tasks tab (mostly lists and buttons) to test the
approach before converting the other tabs.

## Research (2026-10-28)

Sources:

- A2UI v1.0 spec (Google): github.com/a2ui-project/a2ui, `specification/v1_0/docs/a2ui_protocol.md`.
- json-render (Vercel Labs): github.com/vercel-labs/json-render.
- CopilotKit, "The Three Types of Generative UI" (2025-09).
- AG-UI docs, State Management: docs.ag-ui.com/concepts/state.
- MCP Apps proposal SEP-1865 (2025-11-21): blog.modelcontextprotocol.io.
- Adaptive Cards template language (Microsoft).
- NN/g, "Generative UI and Outcome-Oriented Design" (2024-03).
- Google Research, "Generative UI" (2025-11-18).
- OpenUI comparison page (Thesys). It is a vendor page, so treat its token figures as claims.

What these sources agree on, and how our system compares:

| # | Practice | Source | Us today |
| --- | --- | --- | --- |
| F1 | Use the declarative pattern at runtime: the agent assembles views from a fixed catalog. Free-form HTML is for prototypes or sandboxed iframes only. | CopilotKit, json-render, A2UI | Declarative. Matches. |
| F2 | Keep structure and data separate. Change data without resending the layout. | A2UI `updateDataModel`, Adaptive Cards, MCP Apps | Only `input` binds to data. Every other value is fixed in the view. A1 fixes this. |
| F3 | Bind data with an object holding a JSON Pointer, such as A2UI `{"@path": "/x"}` or json-render `{"$state": "/x"}`. | A2UI, json-render | Not built. My A1 draft used `{"bind": ...}`. |
| F4 | Repeat a child from a data array. Paths inside the child are relative to the current item, with `@index`/`$index` available. | A2UI `ChildList` template, Adaptive Cards `$data` | Not built. My A2 draft `each`/`$item` matches. |
| F5 | Actions are named and declared in the catalog. A button sends `{name, context}` to the agent or runs a built-in such as `setState`. It cannot call any tool it likes. Sensitive actions need a user click or the user's consent. | json-render `actions`, A2UI `action`/`requiresUserActivation`, MCP Apps consent | Not built. My A2 draft allowed a button to call any tool. That is too open. |
| F6 | Use one catalog to drive validation, the agent's prompt and the renderers. | json-render `catalog.prompt()`, A2UI catalog `instructions` | Two sources: `ui-spec.ts` (validation) and hand-written text in `ui-tools.ts`. They drift. Adding `input` meant editing both. |
| F7 | Show and hide parts based on state, and check input values (required, regex). | json-render `visible`, Adaptive Cards `$when`, A2UI `checks` | Not built. Useful later. |
| F8 | Layouts that keep changing hurt usability, because users relearn the screen each time. Keep a stable layout and a consistent style. | NN/g, Google Research | Matches the "heavy templates" decision. |
| F9 | Every UI result should also have a text answer, for clients that cannot render it. | MCP Apps | The TUI and the Omarchy plugin render only some components. |
| F10 | Shared state needs a rule for conflicts between agent and user edits, and a way to resync. | AG-UI | Last write wins. A text box is not overwritten while the user is typing in it. |
| F11 | Interactive components require an accessible label. | A2UI | `input` requires `label`. Matches. |

Not relevant yet: flat adjacency-list specs and token streaming (A2UI, json-render). We publish whole
views through tool calls, so there is no partial stream to render.

### Options for the spec format

- O1. Keep our `ui-spec` and adopt the conventions above, using A2UI's syntax (`@path`, a
  children template, named actions). Lowest cost, and it keeps O3 open.
- O2. Switch to json-render. It has a Vue renderer, bindings, actions, repeats, visibility and
  prompt generation already built. Its TUI renderer is Ink (React), which does not fit pi-tui. It
  replaces our renderer and spec.
- O3. Adopt A2UI v1.0 in full. It is the standard UI format carried over AG-UI, which our hub
  already speaks. The protocol is heavy (surfaces, function-call messages, catalog negotiation).
  I have not checked whether a Vue renderer exists.

Leaning: O1.

### Changes to A1 and A2 from this research

- A1 uses `{"@path": "/..."}` instead of `{"bind": ...}`.
- A2 `each` uses item-relative paths and `@index`.
- A2 `button` uses named actions only:
  - built-in `setState`;
  - `sendToAgent`, which posts `{name, context}` to the agent as a message;
  - a short list of catalog-declared tools.

  It cannot call arbitrary tools.
- New A0: generate the `ui_render` catalog text from `ui-spec.ts`, so there is one source (F6).

## Current state (what exists today)

- `apps/dpi-sdk/src/ui-spec.ts`: the catalog and its validation (`checkUiSpec`), including `input`
  (`{label, path, placeholder?, multiline?}` bound to an App State path).
- `apps/dpi-backend/src/ui-tools.ts`: the agent tools `ui_render`, `ui_clear`, `ui_template_save`,
  `ui_template_list` and `ui_template_use`.
- The hub projects views to the playground over AG-UI (`/api/agui`, see `dpi-sdk/src/agui.ts`
  `projectViews`).
- Playground: `CanvasView.vue` (blank until a view is published, views centered, max 1200px),
  `UiView.vue`, `UiRender.vue` and `UiInput.vue`.
- Live updates already work in an open tab. App State changes and re-published views appear
  within about 1 to 2 seconds. Code changes reach open tabs through the `reload` tool
  (`reload(target="clients")`).

## Open questions

- Q6. Should the hub watch `dist` and reload open tabs on every frontend build, instead of relying
  on the `reload` tool?
- The Omarchy plugin (`omarchy-plugin/UiNode.qml`) does not render `input` or any new
  components. Decide whether it should keep up with the catalog.
