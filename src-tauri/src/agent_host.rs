use crate::execution_artifacts::{fingerprint_execution_inputs_impl, ExecutionInput};
use crate::execution_trust::{
    execution_trust_status_impl, revoke_project_trust_impl, trust_project_for_session_impl,
    ExecutionTrustStore,
};
use crate::jupyter_execution::{
    execute_kernel_impl, interrupt_kernel_impl, restart_kernel_impl, terminate_kernel_impl,
    KernelExecutionRequest, KernelProcessRegistry,
};
use crate::runtime::{discover_jupyter_kernels_impl, RuntimeHealth, RuntimeLanguage};
use crate::{
    canonical_root, crossref_search_impl, zotero_search_impl, zotero_status_impl,
    CrossrefSearchRequest, HostError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::{Arc, Mutex};
use std::thread;

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostRequest {
    id: String,
    #[serde(flatten)]
    command: HostCommand,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum HostCommand {
    Hello,
    Kernels,
    TrustStatus,
    Trust {
        acknowledgement: String,
    },
    Untrust,
    FingerprintInputs {
        paths: Vec<String>,
    },
    ZoteroStatus {
        approved: bool,
    },
    ZoteroSearch {
        approved: bool,
        query: String,
        #[serde(default = "default_reference_limit")]
        limit: u8,
    },
    CrossrefSearch {
        approved: bool,
        query: String,
    },
    Execute {
        cell_id: String,
        language: RuntimeLanguage,
        #[serde(default)]
        kernel_name: Option<String>,
        code: String,
        #[serde(default)]
        attributes: HashMap<String, Value>,
        #[serde(default)]
        inputs: Vec<ExecutionInput>,
    },
    Interrupt {
        language: RuntimeLanguage,
    },
    Restart {
        language: RuntimeLanguage,
    },
    Terminate {
        language: RuntimeLanguage,
    },
}

fn default_reference_limit() -> u8 {
    25
}

fn require_network_approval(approved: bool) -> Result<(), HostError> {
    if approved {
        Ok(())
    } else {
        Err(HostError::Integration(
            "Reference-provider access requires explicit approval.".to_string(),
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

fn response(id: String, result: Result<Value, HostError>) -> HostResponse {
    match result {
        Ok(result) => HostResponse {
            id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => HostResponse {
            id,
            ok: false,
            result: None,
            error: Some(serde_json::to_value(error).unwrap_or_else(|_| {
                json!({ "kind": "integration", "message": "The execution host returned an unserializable error." })
            })),
        },
    }
}

fn selected_kernel(
    language: RuntimeLanguage,
    requested: Option<String>,
) -> Result<String, HostError> {
    let inventory = discover_jupyter_kernels_impl();
    if let Some(requested) = requested {
        if inventory.kernels.iter().any(|kernel| {
            kernel.name == requested
                && kernel.language == Some(language)
                && kernel.health == RuntimeHealth::Available
        }) {
            return Ok(requested);
        }
        return Err(HostError::Integration(format!(
            "Jupyter kernel {requested} is not available for {language:?}."
        )));
    }
    inventory
        .kernels
        .into_iter()
        .find(|kernel| {
            kernel.language == Some(language) && kernel.health == RuntimeHealth::Available
        })
        .map(|kernel| kernel.name)
        .ok_or_else(|| {
            HostError::Integration(format!(
                "No healthy Jupyter kernel is available for {language:?}."
            ))
        })
}

fn dispatch(
    command: HostCommand,
    root: &str,
    trust: &ExecutionTrustStore,
    kernels: &KernelProcessRegistry,
) -> Result<Value, HostError> {
    match command {
        HostCommand::Hello => Ok(json!({
            "protocolVersion": 1,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "projectRoot": root,
            "transport": "json-lines-stdio",
            "persistentKernels": true,
        })),
        HostCommand::Kernels => serde_json::to_value(discover_jupyter_kernels_impl())
            .map_err(|error| HostError::Integration(error.to_string())),
        HostCommand::TrustStatus => serde_json::to_value(execution_trust_status_impl(root, trust)?)
            .map_err(|error| HostError::Integration(error.to_string())),
        HostCommand::Trust { acknowledgement } => serde_json::to_value(
            trust_project_for_session_impl(root, &acknowledgement, trust)?,
        )
        .map_err(|error| HostError::Integration(error.to_string())),
        HostCommand::Untrust => serde_json::to_value(revoke_project_trust_impl(root, trust)?)
            .map_err(|error| HostError::Integration(error.to_string())),
        HostCommand::FingerprintInputs { paths } => {
            serde_json::to_value(fingerprint_execution_inputs_impl(root, paths)?)
                .map_err(|error| HostError::Integration(error.to_string()))
        }
        HostCommand::ZoteroStatus { approved } => {
            require_network_approval(approved)?;
            serde_json::to_value(zotero_status_impl())
                .map_err(|error| HostError::Integration(error.to_string()))
        }
        HostCommand::ZoteroSearch {
            approved,
            query,
            limit,
        } => {
            require_network_approval(approved)?;
            serde_json::to_value(zotero_search_impl(&query, limit)?)
                .map_err(|error| HostError::Integration(error.to_string()))
        }
        HostCommand::CrossrefSearch { approved, query } => {
            require_network_approval(approved)?;
            let compact = query.trim();
            let request = if compact.starts_with("10.") && compact.contains('/') {
                CrossrefSearchRequest {
                    doi: Some(compact.to_string()),
                    ..CrossrefSearchRequest::default()
                }
            } else {
                CrossrefSearchRequest {
                    bibliographic: Some(compact.to_string()),
                    ..CrossrefSearchRequest::default()
                }
            };
            serde_json::to_value(crossref_search_impl(request).map_err(|error| {
                HostError::Integration(format!("Crossref {}: {}", error.kind, error.message))
            })?)
            .map_err(|error| HostError::Integration(error.to_string()))
        }
        HostCommand::Execute {
            cell_id,
            language,
            kernel_name,
            code,
            attributes,
            inputs,
        } => {
            let kernel_name = selected_kernel(language, kernel_name)?;
            serde_json::to_value(execute_kernel_impl(
                KernelExecutionRequest {
                    root: root.to_string(),
                    cell_id,
                    language,
                    kernel_name,
                    code,
                    attributes,
                    inputs,
                },
                trust,
                kernels,
            )?)
            .map_err(|error| HostError::Integration(error.to_string()))
        }
        HostCommand::Interrupt { language } => {
            Ok(json!({ "interrupted": interrupt_kernel_impl(language, kernels)? }))
        }
        HostCommand::Restart { language } => {
            Ok(json!({ "restarted": restart_kernel_impl(language, kernels)? }))
        }
        HostCommand::Terminate { language } => {
            Ok(json!({ "terminated": terminate_kernel_impl(language, kernels)? }))
        }
    }
}

fn write_response(writer: &Arc<Mutex<BufWriter<io::Stdout>>>, response: HostResponse) {
    let Ok(mut writer) = writer.lock() else {
        return;
    };
    if serde_json::to_writer(&mut *writer, &response).is_ok() {
        let _ = writer.write_all(b"\n");
        let _ = writer.flush();
    }
}

pub fn run_agent_host(raw_root: &str) -> Result<(), HostError> {
    let canonical = canonical_root(raw_root)?;
    let root = canonical.to_string_lossy().into_owned();
    let trust = ExecutionTrustStore::default();
    let kernels = KernelProcessRegistry::default();
    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.len() > MAX_REQUEST_BYTES {
            write_response(
                &writer,
                response(
                    "oversized".to_string(),
                    Err(HostError::UnsupportedFile(
                        "Execution-host request exceeds the 2 MB safety limit.".to_string(),
                    )),
                ),
            );
            continue;
        }
        let request = match serde_json::from_str::<HostRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let id = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|value| value.get("id")?.as_str().map(str::to_string))
                    .unwrap_or_else(|| "invalid".to_string());
                write_response(
                    &writer,
                    response(
                        id,
                        Err(HostError::InvalidProject(format!(
                            "Invalid execution-host request: {error}"
                        ))),
                    ),
                );
                continue;
            }
        };
        let request_root = root.clone();
        let request_trust = trust.clone();
        let request_kernels = kernels.clone();
        let request_writer = writer.clone();
        thread::spawn(move || {
            let result = dispatch(
                request.command,
                &request_root,
                &request_trust,
                &request_kernels,
            );
            write_response(&request_writer, response(request.id, result));
        });
    }
    Ok(())
}
