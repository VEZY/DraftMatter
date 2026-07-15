use crate::{canonical_root, safe_relative, slash_path, HostError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_EXPORT_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXPORT_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOOL_MESSAGE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalExportAdapter {
    Pandoc,
    Quarto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalExportFormat {
    Html,
    Docx,
    Pdf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolProbe {
    pub adapter: ExternalExportAdapter,
    pub available: bool,
    pub version: Option<String>,
    pub executable: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalExportTools {
    pub pandoc: ExternalToolProbe,
    pub quarto: ExternalToolProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalExportRequest {
    pub root: String,
    pub adapter: ExternalExportAdapter,
    pub format: ExternalExportFormat,
    pub source: String,
    pub output_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalExportResult {
    pub adapter: ExternalExportAdapter,
    pub format: ExternalExportFormat,
    pub path: String,
    pub bytes: u64,
    pub message: String,
}

fn executable_name(adapter: ExternalExportAdapter) -> &'static str {
    match adapter {
        ExternalExportAdapter::Pandoc => "pandoc",
        ExternalExportAdapter::Quarto => "quarto",
    }
}

fn bounded_message(output: &Output) -> String {
    let bytes = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let bounded = &bytes[..bytes.len().min(MAX_TOOL_MESSAGE_BYTES)];
    let mut message = String::from_utf8_lossy(bounded).trim().to_string();
    if bytes.len() > MAX_TOOL_MESSAGE_BYTES {
        message.push_str(" …");
    }
    if message.is_empty() {
        "The external renderer did not provide details.".to_string()
    } else {
        message
    }
}

fn probe(adapter: ExternalExportAdapter) -> ExternalToolProbe {
    let executable = executable_name(adapter);
    match Command::new(executable).arg("--version").output() {
        Ok(output) if output.status.success() => ExternalToolProbe {
            adapter,
            available: true,
            version: String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string),
            executable: Some(executable.to_string()),
            message: "Detected separately installed system tool.".to_string(),
        },
        Ok(output) => ExternalToolProbe {
            adapter,
            available: false,
            version: None,
            executable: None,
            message: bounded_message(&output),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ExternalToolProbe {
            adapter,
            available: false,
            version: None,
            executable: None,
            message: format!("{executable} is not installed or is not available on PATH."),
        },
        Err(error) => ExternalToolProbe {
            adapter,
            available: false,
            version: None,
            executable: None,
            message: format!("Could not inspect {executable}: {error}"),
        },
    }
}

pub fn probe_external_export_tools_impl() -> ExternalExportTools {
    ExternalExportTools {
        pandoc: probe(ExternalExportAdapter::Pandoc),
        quarto: probe(ExternalExportAdapter::Quarto),
    }
}

fn prepare_external_source(source: &str) -> Result<String, HostError> {
    if source.len() > MAX_EXPORT_SOURCE_BYTES {
        return Err(HostError::UnsupportedFile(
            "External export source exceeds the 16 MB safety limit.".to_string(),
        ));
    }
    if source.contains(".dm-anchor")
        || source.contains(".draftmatter-reviews")
        || source.contains(".dm-change")
        || source.contains(".dm-thread")
        || source.contains(".dm-decision")
    {
        return Err(HostError::InvalidProject(
            "External renderers accept only a clean projection without DraftMatter review data."
                .to_string(),
        ));
    }
    // The adapters call Pandoc directly (or Quarto's Pandoc pass-through), never
    // `quarto render`. Removing DraftMatter's execution class makes the inert
    // boundary visible even if the generated source is inspected independently.
    Ok(source
        .replace(" .execute", "")
        .replace("{.execute ", "{")
        .replace("{.execute}", ""))
}

fn format_name(format: ExternalExportFormat) -> (&'static str, &'static str) {
    match format {
        ExternalExportFormat::Html => ("html5", "html"),
        ExternalExportFormat::Docx => ("docx", "docx"),
        ExternalExportFormat::Pdf => ("latex", "pdf"),
    }
}

fn safe_output_name(raw: &str, extension: &str) -> Result<String, HostError> {
    let relative = safe_relative(raw)?;
    if relative.components().count() != 1 {
        return Err(HostError::InvalidPath(
            "External export names cannot contain folders.".to_string(),
        ));
    }
    let name = relative.to_string_lossy();
    if name.len() > 180
        || !name
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'))
        || Path::new(name.as_ref())
            .extension()
            .and_then(|value| value.to_str())
            != Some(extension)
    {
        return Err(HostError::InvalidPath(format!(
            "External export must use a simple .{extension} filename."
        )));
    }
    Ok(name.to_string())
}

fn unique_work_directory(root: &Path) -> Result<PathBuf, HostError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = root
        .join(".draftmatter/export-work")
        .join(format!("{}-{nonce}", std::process::id()));
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn render_arguments(
    adapter: ExternalExportAdapter,
    target: &str,
    output: &str,
    input: &str,
) -> Vec<String> {
    let mut arguments = Vec::new();
    if adapter == ExternalExportAdapter::Quarto {
        arguments.push("pandoc".to_string());
    }
    arguments.extend([
        "--from=markdown".to_string(),
        format!("--to={target}"),
        "--standalone".to_string(),
        "--output".to_string(),
        output.to_string(),
        input.to_string(),
    ]);
    arguments
}

pub fn render_external_export_impl(
    request: ExternalExportRequest,
) -> Result<ExternalExportResult, HostError> {
    let root = canonical_root(&request.root)?;
    let source = prepare_external_source(&request.source)?;
    let (target, extension) = format_name(request.format);
    let output_name = safe_output_name(&request.output_name, extension)?;
    let export_directory = root.join(".draftmatter/exports");
    fs::create_dir_all(&export_directory)?;
    let output_path = export_directory.join(&output_name);
    if output_path.exists() {
        return Err(HostError::Conflict(format!(
            "An external export already exists at .draftmatter/exports/{output_name}. Rename or remove it explicitly before exporting again."
        )));
    }
    let work_directory = unique_work_directory(&root)?;
    let input_path = work_directory.join("clean-projection.md");
    fs::write(&input_path, source)?;
    let output_string = output_path.to_string_lossy().to_string();
    let input_string = input_path.to_string_lossy().to_string();
    let arguments = render_arguments(request.adapter, target, &output_string, &input_string);
    let output = Command::new(executable_name(request.adapter))
        .current_dir(&root)
        .args(arguments)
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                HostError::Integration(format!(
                    "{} is not installed or is not available on PATH.",
                    executable_name(request.adapter)
                ))
            } else {
                HostError::Io(format!("Could not start the external renderer: {error}"))
            }
        })?;
    let _ = fs::remove_dir_all(&work_directory);
    if !output.status.success() {
        let _ = fs::remove_file(&output_path);
        return Err(HostError::Integration(format!(
            "External export failed: {}",
            bounded_message(&output)
        )));
    }
    let metadata = fs::metadata(&output_path).map_err(|_| {
        HostError::Integration(
            "The external renderer succeeded but did not create the requested output.".to_string(),
        )
    })?;
    if metadata.len() > MAX_EXPORT_OUTPUT_BYTES {
        let _ = fs::remove_file(&output_path);
        return Err(HostError::UnsupportedFile(
            "External export exceeded the 128 MB safety limit and was removed.".to_string(),
        ));
    }
    Ok(ExternalExportResult {
        adapter: request.adapter,
        format: request.format,
        path: slash_path(
            output_path
                .strip_prefix(&root)
                .unwrap_or(output_path.as_path()),
        ),
        bytes: metadata.len(),
        message: "Rendered from DraftMatter's clean projection. No manuscript cells were executed."
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn review_storage_is_rejected_before_any_external_command() {
        let source = "Text []{#a .dm-anchor data-anchor=\"a\"}.\n\n::::: {.draftmatter-reviews .hidden}\n:::::\n";
        assert!(matches!(
            prepare_external_source(source),
            Err(HostError::InvalidProject(_))
        ));
    }

    #[test]
    fn executable_cells_remain_inert_source_and_quarto_uses_only_pandoc_passthrough() {
        let source = "```python {.execute #side-effect}\nopen('sentinel', 'w').write('bad')\n```\n";
        let prepared = prepare_external_source(source).unwrap();
        assert!(prepared.contains("open('sentinel'"));
        assert!(!prepared.contains(".execute"));
        let arguments = render_arguments(
            ExternalExportAdapter::Quarto,
            "html5",
            "/project/out.html",
            "/project/clean.md",
        );
        assert_eq!(arguments.first().map(String::as_str), Some("pandoc"));
        assert!(!arguments.iter().any(|argument| argument == "render"));
        assert!(!arguments
            .iter()
            .any(|argument| argument.contains("execute")));
    }

    #[test]
    fn output_names_are_format_scoped_and_cannot_traverse() {
        assert_eq!(
            safe_output_name("paper.docx", "docx").unwrap(),
            "paper.docx"
        );
        assert!(safe_output_name("../paper.docx", "docx").is_err());
        assert!(safe_output_name("paper.pdf", "docx").is_err());
        assert!(safe_output_name("nested/paper.docx", "docx").is_err());
    }

    #[test]
    fn installed_pandoc_receives_only_inert_clean_source() {
        if !probe(ExternalExportAdapter::Pandoc).available {
            return;
        }
        let project = tempdir().unwrap();
        let source = "# Results\n\n```python {.execute #side-effect}\nopen('sentinel', 'w').write('bad')\n```\n";
        let result = render_external_export_impl(ExternalExportRequest {
            root: project.path().to_string_lossy().to_string(),
            adapter: ExternalExportAdapter::Pandoc,
            format: ExternalExportFormat::Html,
            source: source.to_string(),
            output_name: "paper.html".to_string(),
        })
        .unwrap();

        assert_eq!(result.path, ".draftmatter/exports/paper.html");
        assert!(!project.path().join("sentinel").exists());
        let html = fs::read_to_string(project.path().join(&result.path)).unwrap();
        assert!(html.contains("sentinel"));
        assert!(html.contains("sourceCode"));
        assert!(!html.contains(".execute"));
        assert!(!html.contains(".draftmatter-reviews"));
    }
}
