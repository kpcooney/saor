<script lang="ts">
  // Root layout. Imports the app-wide stylesheet and renders the active route.
  // SSR is disabled (see +layout.ts) — this is a Tauri SPA.
  import "../app.css";

  let { children } = $props();
</script>

{@render children()}
