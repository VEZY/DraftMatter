use crate::HostError;
use serde_json::Value;
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub(crate) fn bundled_assistant_cli() -> Result<PathBuf, HostError> {
    if let Some(configured) = env::var_os("DRAFTMATTER_BUNDLED_MCP_COMMAND") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(current) = env::current_exe() {
        if let Some(parent) = current.parent() {
            let sidecar = parent.join(executable_name("draftmatter-mcp"));
            if sidecar.is_file() {
                return Ok(sidecar);
            }
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("dist-cli")
        .join("draftmatter.js");
    if development.is_file() {
        return Ok(development);
    }
    Err(HostError::Integration(
        "The DraftMatter MCP sidecar is missing from this application bundle.".to_string(),
    ))
}

fn run_assistant_cli(arguments: &[String]) -> Result<Value, HostError> {
    let mut command = bundled_cli_command()?;
    let output = command.args(arguments).output().map_err(|error| {
        HostError::Integration(format!(
            "Could not start the bundled DraftMatter assistant installer: {error}"
        ))
    })?;
    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        HostError::Integration(
            "The bundled DraftMatter assistant installer returned non-UTF-8 output.".to_string(),
        )
    })?;
    let value = serde_json::from_str::<Value>(stdout.trim()).map_err(|error| {
        HostError::Integration(format!(
            "The bundled DraftMatter assistant installer returned invalid status: {error}"
        ))
    })?;
    if !output.status.success() && output.status.code() != Some(2) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(HostError::Integration(if stderr.trim().is_empty() {
            format!(
                "The bundled DraftMatter assistant installer exited with status {}.",
                output.status
            )
        } else {
            stderr.trim().to_string()
        }));
    }
    Ok(value)
}

fn bundled_cli_command() -> Result<Command, HostError> {
    let executable = bundled_assistant_cli()?;
    let javascript_bundle = executable
        .extension()
        .is_some_and(|extension| extension == "js");
    let mut command = if javascript_bundle {
        let mut command = Command::new("node");
        command.arg(&executable);
        command
    } else {
        Command::new(&executable)
    };
    command
        .env(
            "DRAFTMATTER_BUNDLED_MCP_COMMAND",
            if javascript_bundle {
                std::ffi::OsStr::new("node")
            } else {
                executable.as_os_str()
            },
        )
        .env(
            "DRAFTMATTER_BUNDLED_MCP_ARGS",
            if javascript_bundle {
                serde_json::to_string(&vec![executable.to_string_lossy().into_owned()])
                    .map_err(|error| HostError::Integration(error.to_string()))?
            } else {
                "[]".to_string()
            },
        );
    Ok(command)
}

pub(crate) fn run_bundled_cli(arguments: &[String]) -> Result<i32, HostError> {
    let status = bundled_cli_command()?
        .args(arguments)
        .status()
        .map_err(|error| {
            HostError::Integration(format!(
                "Could not start the bundled DraftMatter command: {error}"
            ))
        })?;
    Ok(status.code().unwrap_or(1))
}

pub(crate) fn assistant_connections_status_impl() -> Result<Value, HostError> {
    run_assistant_cli(&[
        "assistants".to_string(),
        "status".to_string(),
        "all".to_string(),
        "--json".to_string(),
    ])
}

pub(crate) fn assistant_connection_action_impl(
    client: &str,
    operation: &str,
    apply: bool,
) -> Result<Value, HostError> {
    if !matches!(client, "codex" | "claude" | "copilot" | "vibe") {
        return Err(HostError::InvalidPath(format!(
            "Unsupported AI assistant client {client:?}."
        )));
    }
    if !matches!(operation, "install" | "update" | "repair" | "remove") {
        return Err(HostError::InvalidPath(format!(
            "Unsupported assistant connection operation {operation:?}."
        )));
    }
    let mut arguments = vec![
        "assistants".to_string(),
        operation.to_string(),
        client.to_string(),
    ];
    if apply {
        arguments.push("--apply".to_string());
    }
    run_assistant_cli(&arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_bundle_resolves_without_a_project() {
        let path = bundled_assistant_cli().unwrap();
        assert!(
            path.ends_with("draftmatter.js") || path.ends_with(executable_name("draftmatter-mcp"))
        );
    }

    #[test]
    fn validates_client_and_operation_before_launch() {
        assert!(assistant_connection_action_impl("unknown", "install", false).is_err());
        assert!(assistant_connection_action_impl("codex", "trust", false).is_err());
    }
}
