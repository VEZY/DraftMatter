use crate::{canonical_root, HostError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const TRUST_ACKNOWLEDGEMENT: &str = "run-project-code-with-user-permissions";
const TRUST_WARNING: &str = "Project code can read and change files and use the network with your user permissions. Local execution is not a sandbox.";

#[derive(Debug, Default)]
pub struct ExecutionTrustStore {
    roots: Mutex<HashSet<PathBuf>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTrustStatus {
    pub trusted: bool,
    pub scope: String,
    pub warning: String,
}

fn status(trusted: bool) -> ExecutionTrustStatus {
    ExecutionTrustStatus {
        trusted,
        scope: "session".to_string(),
        warning: TRUST_WARNING.to_string(),
    }
}

fn store_error() -> HostError {
    HostError::Integration("The session execution-trust store is unavailable.".to_string())
}

pub fn execution_trust_status_impl(
    raw_root: &str,
    store: &ExecutionTrustStore,
) -> Result<ExecutionTrustStatus, HostError> {
    let root = canonical_root(raw_root)?;
    let trusted = store
        .roots
        .lock()
        .map_err(|_| store_error())?
        .contains(&root);
    Ok(status(trusted))
}

pub fn trust_project_for_session_impl(
    raw_root: &str,
    acknowledgement: &str,
    store: &ExecutionTrustStore,
) -> Result<ExecutionTrustStatus, HostError> {
    if acknowledgement != TRUST_ACKNOWLEDGEMENT {
        return Err(HostError::InvalidProject(
            "Execution trust requires the exact safety acknowledgement shown by DraftMatter."
                .to_string(),
        ));
    }
    let root = canonical_root(raw_root)?;
    store.roots.lock().map_err(|_| store_error())?.insert(root);
    Ok(status(true))
}

pub fn revoke_project_trust_impl(
    raw_root: &str,
    store: &ExecutionTrustStore,
) -> Result<ExecutionTrustStatus, HostError> {
    let root = canonical_root(raw_root)?;
    store.roots.lock().map_err(|_| store_error())?.remove(&root);
    Ok(status(false))
}

// The native runners call this guard before creating any child process.
#[allow(dead_code)]
pub fn require_execution_trust(root: &Path, store: &ExecutionTrustStore) -> Result<(), HostError> {
    if store
        .roots
        .lock()
        .map_err(|_| store_error())?
        .contains(root)
    {
        Ok(())
    } else {
        Err(HostError::Integration(
            "Execution is blocked until this project is trusted for the current DraftMatter session."
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn trust_is_canonical_session_state_and_requires_exact_acknowledgement() {
        let project = tempdir().unwrap();
        let root = project.path().to_string_lossy();
        let store = ExecutionTrustStore::default();

        assert!(!execution_trust_status_impl(&root, &store).unwrap().trusted);
        assert!(trust_project_for_session_impl(&root, "yes", &store).is_err());
        assert!(!execution_trust_status_impl(&root, &store).unwrap().trusted);
        assert!(
            trust_project_for_session_impl(&root, TRUST_ACKNOWLEDGEMENT, &store)
                .unwrap()
                .trusted
        );
        assert!(
            require_execution_trust(&fs::canonicalize(project.path()).unwrap(), &store).is_ok()
        );
        assert!(!revoke_project_trust_impl(&root, &store).unwrap().trusted);
        assert!(
            require_execution_trust(&fs::canonicalize(project.path()).unwrap(), &store).is_err()
        );
    }

    #[test]
    fn a_new_store_never_inherits_project_trust() {
        let project = tempdir().unwrap();
        let root = project.path().to_string_lossy();
        let first = ExecutionTrustStore::default();
        trust_project_for_session_impl(&root, TRUST_ACKNOWLEDGEMENT, &first).unwrap();

        assert!(
            !execution_trust_status_impl(&root, &ExecutionTrustStore::default())
                .unwrap()
                .trusted
        );
    }
}
