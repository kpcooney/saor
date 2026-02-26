// src-tauri/src/lib.rs
//
// Tauri application entry point and IPC command handler registry. This file
// wires together the backend modules and exposes Tauri commands that the
// Svelte frontend can call via invoke(). Business logic lives in the modules
// below — this file is intentionally thin, acting as the bridge layer.
//
// Module layout:
//   memory/     — SQLite memory store with FTS5 full-text search
//   audit/      — JSONL append-only audit trail
//   identity/   — AgentIdentity types and scope validation
//   references/ — URI scheme resolver for agent reference manifests
//   process/    — Agent sidecar process lifecycle management
//
// See src-tauri/README.md for the full responsibility breakdown.
// See docs/architecture/sdlc-agent-architecture-research-v4.md Section 2.3
// for the IPC communication flow between frontend, Rust, and agent layer.

pub mod audit;
pub mod identity;
pub mod memory;
pub mod process;
pub mod references;

// Scaffold command from Tauri template — will be replaced with real commands
// as Phase 1 modules are implemented.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Verification command: spawns a Node.js subprocess, captures its output,
/// and waits for it to exit. Confirms the Tauri shell plugin can spawn and
/// communicate with child processes via stdio — the pattern the agent layer
/// will use.
///
/// This command is temporary — it exists to verify the sidecar pattern
/// (Issue #3) and will be replaced by the real AgentProcessManager.
///
/// See docs/verification/003-tauri-sidecar-verification.md for findings.
#[tauri::command]
async fn verify_sidecar(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    use tauri_plugin_shell::process::CommandEvent;

    // Spawn node to evaluate a simple script that prints to stdout and exits
    let command = app
        .shell()
        .command("node")
        .args([
            "-e",
            r#"
                console.log(JSON.stringify({ status: "started", pid: process.pid }));
                setTimeout(() => {
                    console.log(JSON.stringify({ status: "heartbeat", uptime_ms: 100 }));
                }, 100);
                setTimeout(() => {
                    console.log(JSON.stringify({ status: "completed" }));
                }, 200);
            "#,
        ]);

    let (mut rx, child) = command.spawn().map_err(|e| format!("Failed to spawn: {e}"))?;

    let mut lines: Vec<String> = Vec::new();
    let child_pid = child.pid();

    // Collect stdout lines from the spawned process
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                lines.push(line);
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                lines.push(format!("[stderr] {line}"));
            }
            CommandEvent::Terminated(payload) => {
                lines.push(format!(
                    "Process exited: code={:?}, signal={:?}",
                    payload.code, payload.signal
                ));
                break;
            }
            CommandEvent::Error(err) => {
                lines.push(format!("[error] {err}"));
                break;
            }
            _ => {}
        }
    }

    let result = format!(
        "Sidecar verification complete.\nChild PID: {}\nCaptured {} lines:\n{}",
        child_pid,
        lines.len(),
        lines.join("\n")
    );

    Ok(result)
}

/// Verification command: spawns a long-running Node.js process and kills it
/// after collecting a few heartbeat messages. Confirms clean process
/// termination without zombie processes.
///
/// Temporary — part of Issue #3 sidecar verification.
#[tauri::command]
async fn verify_sidecar_kill(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    use tauri_plugin_shell::process::CommandEvent;

    // Spawn a process that runs indefinitely (prints heartbeats every 100ms)
    let command = app
        .shell()
        .command("node")
        .args([
            "-e",
            r#"
                console.log(JSON.stringify({ status: "started", pid: process.pid }));
                const interval = setInterval(() => {
                    console.log(JSON.stringify({ status: "heartbeat" }));
                }, 100);
                process.on("SIGTERM", () => {
                    clearInterval(interval);
                    console.log(JSON.stringify({ status: "received_sigterm" }));
                    process.exit(0);
                });
            "#,
        ]);

    let (mut rx, child) = command.spawn().map_err(|e| format!("Failed to spawn: {e}"))?;

    let child_pid = child.pid();
    let mut lines: Vec<String> = Vec::new();

    // Collect a few messages before killing
    let mut message_count = 0;
    let mut should_kill = false;
    loop {
        match rx.recv().await {
            Some(CommandEvent::Stdout(bytes)) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                lines.push(line);
                message_count += 1;
                if message_count >= 3 {
                    should_kill = true;
                    break;
                }
            }
            Some(CommandEvent::Error(err)) => {
                lines.push(format!("[error] {err}"));
                break;
            }
            None => break,
            _ => {}
        }
    }

    // Kill the process after collecting enough messages. kill() takes
    // ownership of child, so it must happen outside the recv loop.
    if should_kill {
        child.kill().map_err(|e| format!("Failed to kill: {e}"))?;
        lines.push("Sent kill signal".to_string());

        // Drain remaining events until process terminates
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(payload) => {
                    lines.push(format!(
                        "Process terminated: code={:?}, signal={:?}",
                        payload.code, payload.signal
                    ));
                    break;
                }
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    lines.push(line);
                }
                _ => {}
            }
        }
    }

    let result = format!(
        "Kill verification complete.\nChild PID: {}\nCaptured {} events:\n{}",
        child_pid,
        lines.len(),
        lines.join("\n")
    );

    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            verify_sidecar,
            verify_sidecar_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
