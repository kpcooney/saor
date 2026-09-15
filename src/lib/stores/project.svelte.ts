/**
 * src/lib/stores/project.svelte.ts
 *
 * Reactive state for the currently active project and the agent sessions
 * started against it during this UI session. Built on Svelte 5 runes ($state),
 * exported as a single shared instance so components read and mutate the same
 * source of truth without prop drilling.
 *
 * Why sessions live here (and only for the current UI session): the Phase 1
 * backend exposes `agent_start`/`agent_status`/`agent_stop` but no command to
 * enumerate a project's sessions. So the dashboard remembers the sessions it
 * started and polls each one's status. On reload the list resets — acceptable
 * for the minimal Phase 1 UI; a persistent session list is future work.
 */

import type { AgentSession, AgentStatus, Project } from "$lib/types";

class ProjectStore {
  /** The project currently open in the UI, or null when none is selected. */
  active = $state<Project | null>(null);

  /** Sessions started against the active project during this UI session. */
  sessions = $state<AgentSession[]>([]);

  /** Opens a project, resetting the tracked session list. */
  open(project: Project) {
    this.active = project;
    this.sessions = [];
  }

  /** Clears the active project and its tracked sessions. */
  close() {
    this.active = null;
    this.sessions = [];
  }

  /** Records a newly started session at the top of the list. */
  addSession(session: AgentSession) {
    this.sessions = [session, ...this.sessions];
  }

  /** Updates the status of a tracked session in place. */
  setSessionStatus(sessionId: string, status: AgentStatus) {
    this.sessions = this.sessions.map((s) =>
      s.sessionId === sessionId ? { ...s, status } : s,
    );
  }
}

/** Shared singleton — import and use directly in components. */
export const projectStore = new ProjectStore();
