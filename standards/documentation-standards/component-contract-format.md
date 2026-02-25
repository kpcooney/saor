# Component Contract Format

Component contracts define what a UI component must do, what data it requires, and what states it must handle. They are produced by the UX Agent and live in `docs/ux/components/`, one file per component or significantly modified component. The Code Agent uses them as primary reference during implementation; the Test Agent derives interaction tests from them.

## When a Contract Is Required

- Any new UI component introduced by a feature
- Any existing component that is significantly modified (new states, new data requirements, changed interactions)
- Do not write a contract for trivial wrapper components or one-off layout elements

## File Naming

`{component-name}.md` or `{component-name}.yaml` — use the same name as the Svelte component file. Either format is acceptable; YAML is preferred for data-heavy contracts (many props, many states), Markdown for simpler ones.

## Markdown Format

```markdown
# {ComponentName}

**Purpose**: One sentence describing what this component does and where it appears.
**File**: `src/lib/components/{ComponentName}.svelte`
**Epic**: {tracker reference}

## Data Requirements

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `projectId` | `string` | Yes | ID of the project whose memory entries to display |
| `limit` | `number` | No (default: 20) | Maximum number of entries to show |
| `onSelect` | `(entry: MemoryEntry) => void` | No | Callback when an entry is clicked |

## Interaction States

Document every state the component must handle. Not all states apply to every component — omit states that do not apply, but do not omit states that apply and are awkward to implement.

### Loading
Displayed while memory entries are being fetched from the Rust backend.
- Show a loading skeleton (three placeholder rows, matching the shape of a real row)
- The search input is disabled during loading

### Empty
Displayed when the query returns zero results.
- Message: "No memory entries found." If a search query is active, add: "Try a different search term."
- Do not show the entry list; show the empty state message in its place

### Populated
The normal state with one or more entries displayed.
- Entries are listed in reverse chronological order (newest first)
- Each row shows: category badge, content preview (first 120 characters), created-by agent, relative timestamp
- Clicking a row triggers `onSelect` if provided

### Error
Displayed when the backend call fails.
- Message: "Failed to load memory entries." with a "Retry" button
- Log the underlying error to the console for debugging

## Events / Outputs

| Event | Payload | When |
|-------|---------|------|
| `select` | `MemoryEntry` | User clicks an entry row |

## Keyboard Behavior

- Tab navigates between the search input and entry rows
- Enter or Space on a focused row triggers selection (same as click)
- Escape clears the search input if focused and non-empty; otherwise does nothing

## ARIA

- Component root: `role="region"` with `aria-label="Memory inspector"`
- Entry list: `role="list"`; each row: `role="listitem"` with `aria-label="{category}: {content preview}"`
- Loading state: `aria-busy="true"` on the region, `aria-live="polite"` for the status message
- Error message: `role="alert"`

## Design System References

- Uses `Badge` component for category labels (existing pattern)
- Uses `SkeletonRow` component for loading state (existing pattern)
- Entry row hover and focus styles follow the `interactive-row` design token

## References

- Epic: {tracker reference}
- UX flow: {link to flow document}
- Issue: {tracker reference}
```

## YAML Format (alternative for data-heavy contracts)

```yaml
component: MemoryInspector
purpose: Displays and searches memory entries for the active project.
file: src/lib/components/MemoryInspector.svelte
epic: PROJ-142

props:
  - name: projectId
    type: string
    required: true
    description: ID of the project whose memory entries to display
  - name: limit
    type: number
    required: false
    default: 20

states:
  loading:
    description: Fetching entries from backend
    ui: Three skeleton rows; search input disabled
  empty:
    description: Query returned zero results
    ui: "No memory entries found." message; no list
  populated:
    description: One or more entries returned
    ui: Reverse-chronological list; category badge, content preview, agent, timestamp
  error:
    description: Backend call failed
    ui: Error message with Retry button

events:
  - name: select
    payload: MemoryEntry
    trigger: User clicks an entry row

accessibility:
  keyboard:
    - Tab between search input and rows
    - Enter/Space on row triggers selection
    - Escape clears search input if non-empty
  aria:
    root: role="region" aria-label="Memory inspector"
    list: role="list"
    rows: role="listitem"

references:
  epic: PROJ-142
  flow: docs/ux/flows/epic-142-memory-inspector-flow.md
  issue: PROJ-158
```

## Rules

- Every state that can occur must be documented. If the component can be in an error state, write the error state — do not leave it to the developer's imagination.
- Write exact UI copy for empty states, error messages, and placeholder text. No `{message}` placeholders in the contract.
- The References section is required.
- Accessibility requirements must be at the component level, not "we'll handle accessibility later".
