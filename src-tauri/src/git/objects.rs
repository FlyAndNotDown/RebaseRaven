//! Read the immutable blobs for one preview with a single native Git process.
use super::*;
use crate::diagnostics::{LoggedChild, LoggedReader};
use std::io::Write;
use std::process::ChildStdout;

pub(super) enum Blob {
    Bytes(Vec<u8>),
    Oversized(u64),
}

struct Batch {
    child: LoggedChild,
    output: BufReader<LoggedReader<ChildStdout>>,
}

pub(super) struct BlobReader<'a> {
    root: &'a Path,
    batch: Option<Batch>,
}

impl<'a> BlobReader<'a> {
    pub(super) fn new(root: &'a Path) -> Self {
        Self { root, batch: None }
    }

    pub(super) fn read(&mut self, spec: &str, limit: usize) -> Option<Blob> {
        // Batch input is line-delimited. Resolve uncommon multiline names with
        // a native argv before sending their immutable object ID over the pipe.
        let oid;
        let spec = if spec.contains(['\r', '\n']) {
            oid = run_git_stdout(
                self.root,
                &["rev-parse", "--verify", "--end-of-options", spec],
            )
            .ok()?;
            std::str::from_utf8(&oid).ok()?.trim_end()
        } else {
            spec
        };
        let mut batch = match self.batch.take() {
            Some(batch) => batch,
            None => {
                let mut child =
                    spawn_git_stream(self.root, &["cat-file", "--batch"], &[], Stdio::piped())
                        .ok()?;
                let output = BufReader::new(child.stdout.take()?);
                Batch { child, output }
            }
        };
        let input = batch.child.stdin.as_mut()?;
        let mut request = spec.as_bytes().to_vec();
        request.push(b'\n');
        input.write_all(&request).ok()?;
        let mut header = String::new();
        batch.output.read_line(&mut header).ok()?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.last() == Some(&"missing") {
            self.batch = Some(batch);
            return None;
        }
        let [_, "blob", size] = fields.as_slice() else {
            return None;
        };
        let size: u64 = size.parse().ok()?;
        if size > limit as u64 {
            batch.child.finish_preview();
            return Some(Blob::Oversized(size));
        }
        let mut bytes = vec![0; size as usize];
        batch.output.read_exact(&mut bytes).ok()?;
        let mut delimiter = [0];
        batch.output.read_exact(&mut delimiter).ok()?;
        if delimiter[0] != b'\n' {
            return None;
        }
        self.batch = Some(batch);
        Some(Blob::Bytes(bytes))
    }
}

impl Drop for BlobReader<'_> {
    fn drop(&mut self) {
        if let Some(mut batch) = self.batch.take() {
            drop(batch.child.stdin.take());
            let _ = batch.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_oversized_side_preserves_the_following_binary_blob() {
        let (root, repo) = super::super::tests::temp_repo();
        let bytes = b"line\n\0tail";
        fs::write(root.join("binary asset"), bytes).unwrap();
        run_git_stdout(repo.workdir(), &["add", "--", "binary asset"]).unwrap();
        let mut blobs = BlobReader::new(repo.workdir());
        assert!(blobs.read(":missing", 100).is_none());
        assert!(matches!(
            blobs.read(":binary asset", 3),
            Some(Blob::Oversized(10))
        ));
        assert!(
            matches!(blobs.read(":binary asset", 10), Some(Blob::Bytes(found)) if found == bytes)
        );
        #[cfg(unix)]
        {
            let name = "line\nbreak";
            fs::write(root.join(name), bytes).unwrap();
            run_git_stdout(repo.workdir(), &["add", "--", name]).unwrap();
            assert!(
                matches!(blobs.read(&format!(":{name}"), 10), Some(Blob::Bytes(found)) if found == bytes)
            );
        }
        drop(blobs);
        fs::remove_dir_all(root).unwrap();
    }
}
