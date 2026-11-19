//! Check Windows sharing before p4 starts its (potentially nested) rename retries.
use super::*;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, BufWriter, Seek, Write};
use tempfile::SpooledTempFile;

pub(super) struct Plan {
    pub total: Option<u64>,
    pub targets: Option<FilteredTargets>,
}

pub(super) struct FilteredTargets {
    specs: SpooledTempFile,
    excluded: HashSet<String>,
}

#[cfg(windows)]
pub(super) fn plan(
    env: &P4Env,
    paths: &[String],
    flags: SyncFlags,
    revision: &str,
    output: &mut SyncOutput,
) -> AppResult<Plan> {
    let mut args = vec!["-Mj", "-ztag", "sync", "-n"];
    if flags.force {
        args.push("-f");
    }
    if flags.safe {
        args.push("-s");
    }
    args.extend(paths.iter().map(String::as_str));
    prepare(
        revision,
        output,
        |visit| cli::run_p4_stream(env, &args, visit),
        is_busy,
        || {
            crate::activity::check_cancelled()?;
            std::thread::sleep(std::time::Duration::from_millis(200));
            crate::activity::check_cancelled()
        },
    )
}

#[cfg(windows)]
fn is_busy(path: &str) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    // Ask for delete access (needed to replace a file), allowing every other
    // handle to coexist. Opening an existing file this way never removes it.
    std::fs::OpenOptions::new()
        .access_mode(DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .share_mode(FILE_SHARE_DELETE | FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .is_err_and(|e| matches!(e.raw_os_error(), Some(32 | 33 | 1224)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRow {
    depot_file: Option<String>,
    client_file: Option<String>,
    data: Option<String>,
    code0: Option<u32>,
}

fn exact_depot(path: &str) -> bool {
    path.starts_with("//")
        && !path.contains(['\r', '\n', '*', '#', '@', '\u{fffd}'])
        && !path.contains("...")
}

enum PreviewEntry {
    File {
        depot: String,
        local: Option<String>,
    },
    UpToDate,
}

fn preview_entry(line: &str) -> Option<PreviewEntry> {
    let row: PreviewRow = serde_json::from_str(line).ok()?;
    if let (Some(depot), Some(local)) = (row.depot_file, row.client_file) {
        return (exact_depot(&depot) && !local.contains('\u{fffd}')).then_some(
            PreviewEntry::File {
                depot,
                local: Some(local),
            },
        );
    }
    // MsgDm::ExUPTODATE carries a translated message and a stable code.
    if row.code0 == Some(554768772) {
        return Some(PreviewEntry::UpToDate);
    }
    // Opened files and resolve notices can be info records without a client
    // path. Let the real sync process that exact file.
    let data = row.data?;
    let (depot, tail) = data.split_once('#')?;
    let (rev, _) = tail.split_once(" - ")?;
    (exact_depot(depot) && !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit())).then(|| {
        PreviewEntry::File {
            depot: depot.to_owned(),
            local: None,
        }
    })
}

fn prepare(
    revision: &str,
    output: &mut SyncOutput,
    preview: impl FnOnce(&mut dyn FnMut(&str) -> bool) -> AppResult<bool>,
    mut busy: impl FnMut(&str) -> bool,
    mut wait: impl FnMut() -> AppResult<()>,
) -> AppResult<Plan> {
    // Most syncs can use the original scope and a single parallel transfer.
    // Keep the alternative target list bounded in memory even on a full sync.
    let mut targets = BufWriter::new(tempfile::spooled_tempfile(256 * 1024));
    let mut blocked = Vec::new();
    let mut complete = true;
    let mut count = 0;
    let mut write_error = None;
    let success = preview(&mut |line| {
        if !complete || write_error.is_some() {
            return false;
        }
        match preview_entry(line) {
            Some(PreviewEntry::UpToDate) => true,
            Some(PreviewEntry::File { depot, local }) => {
                if let Some(local) = local {
                    count += 1;
                    if busy(&local) {
                        blocked.push((local, depot));
                        return true;
                    }
                }
                write_error = writeln!(targets, "{depot}{revision}").err();
                true
            }
            None => {
                // Preserve unknown work by passing the original scope to p4.
                complete = false;
                false
            }
        }
    })?;
    if !success || !complete {
        return Ok(Plan {
            total: None,
            targets: None,
        });
    }
    if let Some(error) = write_error {
        return Err(error.into());
    }
    for _ in 0..3 {
        if blocked.is_empty() {
            break;
        }
        wait()?;
        let mut still_busy = Vec::new();
        for (local, depot) in blocked {
            crate::activity::check_cancelled()?;
            if busy(&local) {
                still_busy.push((local, depot));
            } else {
                writeln!(targets, "{depot}{revision}")?;
            }
        }
        blocked = still_busy;
    }
    if blocked.is_empty() {
        return Ok(Plan {
            total: Some(count),
            targets: None,
        });
    }
    let total = count - blocked.len() as u64;
    let mut excluded = HashSet::new();
    for (local, depot) in blocked {
        output.skip("inUse", &local);
        // An overlapping request or a separate info record can mention the
        // same file again. Exclude every occurrence from the filtered sync.
        excluded.insert(format!("{depot}{revision}"));
    }
    let mut targets = targets.into_inner().map_err(|e| e.into_error())?;
    targets.rewind()?;
    Ok(Plan {
        total: Some(total),
        targets: Some(FilteredTargets {
            specs: targets,
            excluded,
        }),
    })
}

pub(super) fn run_batches(
    targets: FilteredTargets,
    mut run: impl FnMut(&[String]) -> AppResult<bool>,
) -> AppResult<bool> {
    let mut batch = Vec::new();
    let mut bytes = 0;
    for spec in BufReader::new(targets.specs).lines() {
        let spec = spec?;
        if targets.excluded.contains(&spec) {
            continue;
        }
        if !batch.is_empty() && bytes + spec.len() + 3 > SYNC_ARG_BYTES {
            if !run(&batch)? {
                return Ok(false);
            }
            batch.clear();
            bytes = 0;
        }
        bytes += spec.len() + 3;
        batch.push(spec);
    }
    Ok(batch.is_empty() || run(&batch)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::HashMap;

    fn row(name: &str) -> String {
        serde_json::json!({ "action": "updated", "depotFile": format!("//depot/{name}"),
            "clientFile": format!(r"C:\work\{name}") })
        .to_string()
    }

    #[test]
    fn transient_locks_rejoin_the_sync_and_persistent_locks_are_skipped_after_three_retries() {
        let mut output = SyncOutput::default();
        let mut probes = HashMap::new();
        let mut waits = 0;
        let plan = prepare(
            "@42",
            &mut output,
            |record| {
                for name in ["ready", "released", "busy", "other%23file"] {
                    assert!(record(&row(name)));
                }
                assert!(record(r#"{"level":0,"data":"//depot/busy#2 - must resolve #3"}"#));
                assert!(record(r#"{"level":0,"data":"//depot/opened#1 - is opened for edit and can't be deleted"}"#));
                assert!(record(r#"{"code0":554768772,"data":"file(s) up-to-date."}"#));
                Ok(true)
            },
            |path| {
                let calls = probes.entry(path.to_string()).or_insert(0);
                *calls += 1;
                path.ends_with("busy") || (path.ends_with("released") && *calls <= 2)
            },
            || {
                waits += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(probes[r"C:\work\busy"], 4);
        assert_eq!(probes[r"C:\work\released"], 3);
        assert_eq!(probes[r"C:\work\ready"], 1);
        assert_eq!(waits, 3);
        assert_eq!(plan.total, Some(3));
        let mut sent = Vec::new();
        assert!(run_batches(plan.targets.unwrap(), |batch| {
            sent.extend_from_slice(batch);
            Ok(true)
        })
        .unwrap());
        assert_eq!(
            sent,
            [
                "//depot/ready@42",
                "//depot/other%23file@42",
                "//depot/opened@42",
                "//depot/released@42"
            ]
        );
        assert!(output.only_skips());
        assert_eq!(
            serde_json::to_value(output.finish(true)).unwrap()["warnings"]["inUse"],
            1
        );
    }

    #[test]
    fn all_locked_never_invokes_a_scope_less_sync_and_cancellation_stops_the_retries() {
        let mut output = SyncOutput::default();
        let preview = |record: &mut dyn FnMut(&str) -> bool| {
            record(&row("busy"));
            Ok(true)
        };
        let plan = prepare("", &mut output, preview, |_| true, || Ok(())).unwrap();
        assert_eq!(plan.total, Some(0));
        assert!(run_batches(plan.targets.unwrap(), |_| panic!(
            "empty sync expands to the whole client"
        ))
        .unwrap());
        let cancelled = prepare(
            "",
            &mut output,
            preview,
            |_| true,
            || Err(AppError::cancelled()),
        );
        assert!(matches!(cancelled, Err(e) if e.is_cancelled()));
    }

    #[test]
    fn original_scope_is_preserved_when_locks_clear_or_the_preview_is_incomplete() {
        let mut output = SyncOutput::default();
        let busy = Cell::new(true);
        let plan = prepare(
            "",
            &mut output,
            |record| {
                record(&row("busy"));
                Ok(true)
            },
            |_| busy.get(),
            || {
                busy.set(false);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(plan.total, Some(1));
        assert!(plan.targets.is_none());
        for (valid, success) in [(true, false), (false, true)] {
            let plan = prepare(
                "",
                &mut output,
                |record| {
                    record(&row("busy"));
                    if !valid {
                        record(r#"{"data":"Unexpected server diagnostic"}"#);
                    }
                    Ok(success)
                },
                |_| true,
                || panic!("incomplete preview"),
            )
            .unwrap();
            assert!(plan.total.is_none());
            assert!(plan.targets.is_none());
        }
        assert!(!output.only_skips());
    }

    #[test]
    fn large_filtered_sync_stops_at_a_fatal_batch() {
        let plan = prepare(
            "",
            &mut SyncOutput::default(),
            |record| {
                for i in 0..20_000 {
                    record(&row(&format!("file-{i}")));
                }
                Ok(true)
            },
            |p| p.ends_with("file-0"),
            || Ok(()),
        )
        .unwrap();
        let targets = plan.targets.unwrap();
        assert!(targets.specs.is_rolled());
        let mut calls = 0;
        let success = run_batches(targets, |batch| {
            calls += 1;
            assert!(batch.iter().map(|p| p.len() + 3).sum::<usize>() <= SYNC_ARG_BYTES);
            Ok(calls != 2)
        })
        .unwrap();
        assert!(!success);
        assert_eq!(calls, 2);
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_handle_denying_delete_sharing_is_detected_until_released() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("asset.bin");
        std::fs::write(&path, b"original").unwrap();
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();
        let name = path.to_str().unwrap();
        assert!(is_busy(name));
        drop(handle);
        assert!(!is_busy(name));
        assert_eq!(std::fs::read(path).unwrap(), b"original");
    }
}
