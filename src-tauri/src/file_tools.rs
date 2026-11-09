use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const FILE_LIMIT: usize = 64 * 1024 * 1024;

pub struct FilePair {
    pub path: String,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub working_path: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentSource {
    Perforce {
        connection: Box<crate::p4::P4Connection>,
        source: crate::p4::P4FileSource,
    },
    Text {
        path: String,
        before: String,
        after: String,
    },
}

#[derive(Serialize)]
pub struct TextPair {
    pub path: String,
    pub before: String,
    pub after: String,
}

impl DocumentSource {
    pub fn files(&self, limit: usize) -> AppResult<FilePair> {
        match self {
            Self::Perforce { connection, source } => {
                crate::p4::external_file_pair(connection, source, limit)
            }
            Self::Text {
                path,
                before,
                after,
            } => {
                if before.len().max(after.len()) > limit {
                    return Err(AppError::msg("The selected text is too large to preview."));
                }
                Ok(FilePair {
                    path: path.clone(),
                    before: Some(before.as_bytes().to_vec()),
                    after: Some(after.as_bytes().to_vec()),
                    working_path: None,
                })
            }
        }
    }

    pub fn text(&self) -> AppResult<TextPair> {
        let files = self.files(2 * 1024 * 1024)?;
        let text = |bytes: Option<Vec<u8>>| {
            String::from_utf8(bytes.unwrap_or_default())
                .map_err(|_| AppError::msg("Text comparison requires UTF-8 files."))
        };
        Ok(TextPair {
            path: files.path,
            before: text(files.before)?,
            after: text(files.after)?,
        })
    }
}

/// Revision copies stay alive while an editor is using them, independently of the workspace.
#[derive(Clone, Default)]
pub struct ExternalFiles(Arc<Mutex<Vec<RevisionCopy>>>);

struct RevisionCopy {
    file: PathBuf,
    permissions: fs::Permissions,
    _directory: tempfile::TempDir,
}

impl Drop for RevisionCopy {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.file, self.permissions.clone());
    }
}

impl ExternalFiles {
    pub fn clear(&self) {
        if let Ok(mut files) = self.0.lock() {
            files.clear();
        }
    }
    pub fn editor(&self, pair: &FilePair) -> AppResult<PathBuf> {
        if let Some(path) = &pair.working_path {
            if path.is_file() {
                return Ok(path.clone());
            }
        }
        self.revision(
            &pair.path,
            pair.after
                .as_deref()
                .or(pair.before.as_deref())
                .ok_or_else(|| AppError::msg("The selected file revision is unavailable."))?,
        )
    }
    pub fn revision(&self, name: &str, bytes: &[u8]) -> AppResult<PathBuf> {
        if bytes.len() > FILE_LIMIT {
            return Err(AppError::msg(
                "External file previews are limited to 64 MiB.",
            ));
        }
        let directory = tempfile::Builder::new()
            .prefix("rebaseraven-revision-")
            .tempdir()?;
        let file = directory.path().join(file_name(name));
        fs::write(&file, bytes)?;
        let permissions = fs::metadata(&file)?.permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&file, readonly)?;
        self.0
            .lock()
            .map_err(|_| AppError::msg("Could not prepare the revision copy."))?
            .push(RevisionCopy {
                file: file.clone(),
                permissions,
                _directory: directory,
            });
        Ok(file)
    }
}

pub fn external_diff(
    pair: FilePair,
    tool: Option<&str>,
    on_error: impl FnOnce(String) + Send + 'static,
) -> AppResult<()> {
    let directory = tempfile::Builder::new()
        .prefix("rebaseraven-diff-")
        .tempdir()?;
    let before = directory.path().join("before");
    let after = directory.path().join("after");
    fs::create_dir_all(&before)?;
    fs::create_dir_all(&after)?;
    let before = before.join(file_name(&pair.path));
    let after = after.join(file_name(&pair.path));
    fs::write(&before, pair.before.unwrap_or_default())?;
    fs::write(&after, pair.after.unwrap_or_default())?;
    if let Some(tool) = tool {
        let tool = tool.to_string();
        std::thread::spawn(move || {
            if let Err(error) =
                crate::git::diff_files_external(&tool, directory.path(), &before, &after)
            {
                on_error(error.to_string());
            }
        });
        Ok(())
    } else {
        crate::git::launch_file_difftool(directory, &before, &after, on_error)
    }
}

pub fn file_name(name: &str) -> &str {
    name.rsplit(|ch| ch == '/' || cfg!(windows) && ch == '\\')
        .find(|part| !part.is_empty() && *part != "." && *part != "..")
        .unwrap_or("revision.txt")
}

pub fn open_editor(path: &Path, line: Option<u32>, editor: &str) -> AppResult<()> {
    crate::editor::open_in_editor(&path.to_string_lossy(), line, editor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_copies_keep_the_extension_and_are_removed_with_the_owner() {
        let files = ExternalFiles::default();
        let path = files
            .revision("folder with spaces/example.rs", b"old revision\n")
            .unwrap();
        assert_eq!(path.file_name().unwrap(), "example.rs");
        assert_eq!(fs::read(&path).unwrap(), b"old revision\n");
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        drop(files);
        assert!(!path.exists());
        if cfg!(windows) {
            assert_eq!(file_name(r"C:\source\example.rs"), "example.rs");
        } else {
            assert_eq!(file_name(r"folder/with\backslash.rs"), r"with\backslash.rs");
        }
    }
}
