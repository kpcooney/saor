/**
 * src/lib/stores/project.ts
 *
 * Svelte store for the currently active project. Holds the project metadata
 * (id, name, path) loaded from the Rust backend via Tauri IPC. Components
 * subscribe to this store to react to project changes without prop drilling.
 *
 * The store is populated on app startup if a last-used project is recorded,
 * or after the user creates or opens a project. It is the single source of
 * truth for which project is active in the UI.
 */

// Implementation coming in Phase 1 UI work.
