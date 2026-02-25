# UX Flow Document Format

User flow documents map user journeys through a feature with enough specificity that a developer can implement without guessing intent. These are produced by the UX Agent and live in `docs/ux/flows/`, one document per epic.

## File Naming

`epic-{id}-{short-description}.md` — e.g., `epic-142-project-creation-flow.md`

## Template

```markdown
# {Feature Name} — User Flow

**Epic**: {tracker reference}
**Last updated**: YYYY-MM-DD
**Status**: draft | reviewed | approved

## Entry Conditions

What must be true before this flow begins. Be specific.

- The application is open and on the home screen
- No project is currently active

## Flow

Steps are numbered sequentially. Each step has three parts:
- **Action**: what the user does
- **System response**: what the application does in response
- **Notes**: implementation hints, edge cases, or constraints (optional)

Decision branches are indented under the step that creates them.
Error paths are explicitly called out, not left implied.

### 1. {Step name}

**Action**: The user {does something}.
**System response**: The application {responds}.
**Notes**: {Any constraints or hints for implementation.}

  #### 1a. {Branch condition}

  **Action**: If the user {alternative action or condition}.
  **System response**: {Alternative response}.

  #### 1b. {Error path}

  **Action**: If {error condition occurs}.
  **System response**: Display error message: "{exact message text}". Return focus to
    {specific element}.

### 2. {Next step}
...

## Exit Conditions

What is true when this flow has completed successfully.

- A new project directory exists at the chosen path
- `.sdlc/memory.db` has been created and initialized
- The UI has navigated to the project dashboard

## Error Paths (Summary)

List error conditions not already covered inline, and how they are handled.

| Error | User-facing message | Recovery |
|-------|---------------------|----------|
| Path already exists | "A project already exists at this path." | User chooses a different path |
| No write permission | "Cannot create project: permission denied." | User chooses a writable path |

## References

- Epic: {tracker reference}
- Requirements: {link to requirements doc or issue}
- Component contracts: {links to relevant component contracts in docs/ux/components/}
- Related ADRs: {if any}
```

## Example (excerpt)

```markdown
# Project Creation — User Flow

**Epic**: PROJ-142
**Last updated**: 2026-02-24
**Status**: approved

## Entry Conditions

- Application is open on the home screen
- No project is currently active

## Flow

### 1. User initiates project creation

**Action**: User clicks "New Project".
**System response**: Open the project creation dialog with three fields: Project Name
  (text), Project Path (directory picker), Description (optional textarea). Focus is
  placed on the Project Name field.

### 2. User fills in project details

**Action**: User types a project name and selects or types a project path.
**System response**: Validate path in real time (debounced, 300ms). Show a green
  checkmark if the path is writable and does not already contain a `.sdlc/` directory.

  #### 2a. Path already has a project

  **Action**: User enters a path that contains an existing `.sdlc/` directory.
  **System response**: Show inline warning: "A Saor project already exists here. Opening
    it instead will preserve all existing data." Show "Open Existing" and "Choose
    Different Path" buttons. "Create" button is disabled.

  #### 2b. Path is not writable

  **Action**: User enters a path they do not have write access to.
  **System response**: Show inline error: "Cannot create project here: permission
    denied." "Create" button is disabled.
```

## Rules

- Every step must have a System Response. "Nothing happens" is a valid response if accurate — write it explicitly.
- Error paths are required. If a step can fail, the failure path must be documented.
- Write the exact text for error messages and button labels — do not use placeholders like "{message}".
- The References section is required. Every flow document must link to its epic.
