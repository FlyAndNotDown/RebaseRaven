//! Bind approval to the native workspace mapping, scan options, and each selected file.
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::client::stable_spec;
use super::parse::path_is_within;
use super::review::{hash_file, run, STALE};
use super::workspace::P4Connection;
use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
pub struct FileApproval {
    pub path: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reviewed<T> {
    #[serde(flatten)]
    pub file: T,
    pub fingerprint: String,
}

pub fn workspace_fingerprint(connection: &P4Connection, options: impl Hash) -> AppResult<String> {
    let client = run(connection, &["client", "-o", &connection.client])?;
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.root,
        &connection.user,
        &connection.client,
        &connection.stream,
        &connection.charset,
        stable_spec(&client),
        options,
    )
        .hash(&mut hash);
    Ok(format!("{:016x}", hash.finish()))
}

pub fn review_file<T>(
    connection: &P4Connection,
    path: &str,
    file: T,
    facts: impl Hash,
) -> AppResult<Reviewed<T>> {
    let mut hash = DefaultHasher::new();
    facts.hash(&mut hash);
    hash_file(&connection.root, Path::new(path), &mut hash)?;
    Ok(Reviewed {
        file,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn selected_paths(files: &[FileApproval], folders: &[PathBuf]) -> AppResult<Vec<String>> {
    if files.is_empty() {
        return Err(AppError::msg("Choose a file."));
    }
    let mut seen = HashSet::new();
    files
        .iter()
        .map(|item| {
            let path = Path::new(&item.path);
            if !path.is_absolute()
                || item.path.contains("...")
                || item.path.chars().any(char::is_control)
                || path.components().any(|part| part == Component::ParentDir)
                || !seen.insert(path)
            {
                return Err(AppError::StaleReview(STALE));
            }
            let scope = folders
                .iter()
                .find(|dir| dir.as_path() != path && path_is_within(dir, path))
                .ok_or(AppError::StaleReview(STALE))?;
            let parent = path
                .parent()
                .and_then(|p| p.ancestors().find(|p| p.exists()))
                .ok_or(AppError::StaleReview(STALE))?;
            if !path_is_within(&scope.canonicalize()?, &parent.canonicalize()?) {
                return Err(AppError::StaleReview(STALE));
            }
            // A missing tracked file can also have missing parents. Never pass a
            // directory or a symlink to an exact-file dry run (it could recurse).
            match path.symlink_metadata() {
                Ok(meta) if !meta.is_file() => return Err(AppError::StaleReview(STALE)),
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
            Ok(item.path.clone())
        })
        .collect()
}

pub fn verify_selection<'a>(
    selected: &[FileApproval],
    actual: impl IntoIterator<Item = (&'a String, &'a String)>,
) -> AppResult<()> {
    let current: std::collections::HashMap<_, _> = actual.into_iter().collect();
    if selected.len() != current.len()
        || selected
            .iter()
            .any(|item| current.get(&item.path).copied() != Some(&item.fingerprint))
    {
        return Err(AppError::StaleReview(STALE));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selected_file_must_match_its_review_even_when_other_files_change() {
        let root = tempfile::tempdir().unwrap();
        let connection = P4Connection {
            root: root.path().display().to_string(),
            port: "example".into(),
            user: "tester".into(),
            client: "workspace".into(),
            stream: None,
            charset: String::new(),
            server: String::new(),
        };
        let selected = root.path().join("selected.txt");
        let path = selected.to_str().unwrap().to_owned();
        std::fs::write(&selected, "one").unwrap();
        let preview = |rev| {
            review_file(&connection, &path, (), ("edit", rev))
                .unwrap()
                .fingerprint
        };
        let original = preview(1);
        let approval = [FileApproval {
            path: path.clone(),
            fingerprint: original,
        }];
        std::fs::write(root.path().join("unselected.txt"), "new").unwrap();
        assert!(verify_selection(&approval, [(&path, &preview(1))]).is_ok());
        assert!(verify_selection(&approval, [(&path, &preview(2))]).is_err());
        std::fs::write(&selected, "two").unwrap();
        assert!(verify_selection(&approval, [(&path, &preview(1))]).is_err());
        assert!(verify_selection(&approval, []).is_err());
    }

    #[test]
    fn only_unique_individual_paths_in_the_reviewed_folders_are_eligible() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let scopes = [sub.clone()];
        let file = |path: PathBuf| FileApproval {
            path: path.display().to_string(),
            fingerprint: "approved".into(),
        };
        assert!(selected_paths(&[file(sub.join("missing.txt"))], &scopes).is_ok());
        for path in [
            sub.clone(),
            sub.join("..."),
            sub.join("../sibling"),
            root.path().join("outside"),
        ] {
            assert!(selected_paths(&[file(path)], &scopes).is_err());
        }
        assert!(selected_paths(&[file(sub.join("a")), file(sub.join("a"))], &scopes).is_err());
    }
}
