use super::*;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct ServerState {
    locks: BTreeMap<String, LfsLock>,
    next: u32,
    unavailable: bool,
    unlocks: usize,
    hanging: bool,
}

struct Server {
    state: Arc<Mutex<ServerState>>,
    stopped: Arc<AtomicBool>,
    requested: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    url: String,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture.git", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(Mutex::new(ServerState::default()));
        let stopped = Arc::new(AtomicBool::new(false));
        let requested = Arc::new(AtomicBool::new(false));
        let shared = state.clone();
        let end = stopped.clone();
        let received = requested.clone();
        let thread = thread::spawn(move || {
            while !end.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &shared, &end, &received),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("Lock fixture listener failed: {error}"),
                }
            }
        });
        Self {
            state,
            stopped,
            requested,
            thread: Some(thread),
            url,
        }
    }
    fn insert(&self, path: &str, owner: &str) -> String {
        let mut state = self.state.lock().unwrap();
        state.next += 1;
        let id = state.next.to_string();
        state.locks.insert(
            id.clone(),
            LfsLock {
                id: id.clone(),
                path: path.into(),
                owner: Some(Owner { name: owner.into() }),
                locked_at: "2026-01-01T00:00:00Z".into(),
                ours: false,
            },
        );
        id
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        let result = self.thread.take().unwrap().join();
        if !thread::panicking() {
            result.expect("Lock fixture server failed");
        }
    }
}

fn serve(
    mut stream: TcpStream,
    shared: &Mutex<ServerState>,
    stopped: &AtomicBool,
    requested: &AtomicBool,
) {
    // Accepted sockets can inherit the listener's nonblocking mode.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut request = Vec::new();
    let mut buf = [0; 4096];
    let header_end = loop {
        let Ok(count) = stream.read(&mut buf) else {
            return;
        };
        if count == 0 {
            return;
        }
        request.extend_from_slice(&buf[..count]);
        if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let line = headers.lines().next().unwrap();
    let parts: Vec<_> = line.split_whitespace().collect();
    let method = parts[0].to_string();
    let path = parts[1].to_string();
    let length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while request.len() < header_end + length {
        let Ok(count) = stream.read(&mut buf) else {
            return;
        };
        if count == 0 {
            return;
        }
        request.extend_from_slice(&buf[..count]);
    }
    let body: serde_json::Value =
        serde_json::from_slice(&request[header_end..header_end + length]).unwrap_or_default();
    requested.store(true, Ordering::Relaxed);
    if shared.lock().unwrap().hanging {
        while !stopped.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(5));
        }
        return;
    }
    let mut state = shared.lock().unwrap();
    let (status, response) = if state.unavailable {
        (404, serde_json::json!({"message":"Locking is unavailable"}))
    } else if method == "POST" && path.ends_with("/locks/verify") {
        let ours: Vec<_> = state
            .locks
            .values()
            .filter(|lock| {
                lock.owner
                    .as_ref()
                    .is_some_and(|owner| owner.name == "alice")
            })
            .cloned()
            .collect();
        let theirs: Vec<_> = state
            .locks
            .values()
            .filter(|lock| {
                lock.owner
                    .as_ref()
                    .is_none_or(|owner| owner.name != "alice")
            })
            .cloned()
            .collect();
        (
            200,
            serde_json::json!({"ours":ours,"theirs":theirs,"next_cursor":""}),
        )
    } else if method == "POST" && path.ends_with("/locks") {
        let name = body["path"].as_str().unwrap().to_string();
        if state.locks.values().any(|lock| lock.path == name) {
            (409, serde_json::json!({"message":"Already locked"}))
        } else {
            state.next += 1;
            let id = state.next.to_string();
            let lock = LfsLock {
                id: id.clone(),
                path: name,
                owner: Some(Owner {
                    name: "alice".into(),
                }),
                locked_at: "2026-01-01T00:00:00Z".into(),
                ours: false,
            };
            state.locks.insert(id, lock.clone());
            (201, serde_json::json!({"lock":lock}))
        }
    } else if method == "POST" && path.ends_with("/unlock") {
        let id = path.rsplit('/').nth(1).unwrap();
        match state.locks.get(id).cloned() {
            Some(lock)
                if lock
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owner.name == "alice")
                    || body["force"].as_bool() == Some(true) =>
            {
                state.unlocks += 1;
                state.locks.remove(id);
                (200, serde_json::json!({"lock":lock}))
            }
            _ => (403, serde_json::json!({"message":"Permission denied"})),
        }
    } else if method == "GET" && path.contains("/locks") {
        let locks: Vec<_> = state.locks.values().cloned().collect();
        (200, serde_json::json!({"locks":locks,"next_cursor":""}))
    } else {
        (404, serde_json::json!({"message":"Not found"}))
    };
    let bytes = serde_json::to_vec(&response).unwrap();
    let text=format!("HTTP/1.1 {status} Response\r\nContent-Type: application/vnd.git-lfs+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len());
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.write_all(&bytes);
}

fn fixture() -> Option<(tempfile::TempDir, Repository, Server)> {
    let dir = tempfile::tempdir().unwrap();
    if !run_git(dir.path(), &["lfs", "version"])
        .unwrap()
        .status
        .success()
    {
        eprintln!("Git LFS is not installed; skipping the lock integration fixture.");
        return None;
    }
    run_git_stdout(
        dir.path(),
        &["-c", "init.templateDir=", "init", "-b", "main"],
    )
    .unwrap();
    run_git_stdout(dir.path(), &["config", "core.hooksPath", ".git/hooks"]).unwrap();
    fs::write(
        dir.path().join("asset.bin"),
        "Original large-file content\n",
    )
    .unwrap();
    run_git_stdout(dir.path(), &["lfs", "install", "--local"]).unwrap();
    run_git_stdout(dir.path(), &["lfs", "track", "--lockable", "*.bin"]).unwrap();
    run_git_stdout(dir.path(), &["add", "."]).unwrap();
    run_git_stdout(
        dir.path(),
        &[
            "-c",
            "user.name=Alice",
            "-c",
            "user.email=alice@example.com",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "Add lockable asset",
        ],
    )
    .unwrap();
    let server = Server::start();
    run_git_stdout(dir.path(), &["remote", "add", "origin", &server.url]).unwrap();
    let repo = open_at(dir.path()).unwrap();
    Some((dir, repo, server))
}

#[test]
fn lock_fixture_accepts_fragmented_request_headers() {
    let server = Server::start();
    let address = server
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut client = TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    client
        .write_all(b"GET /fixture.git/info/lfs/locks HTTP/1.1\r\n")
        .unwrap();
    thread::sleep(Duration::from_millis(50));
    client
        .write_all(b"Host: fixture\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("\"locks\":[]"));
}

fn perform(repo: &Repository, operation: LfsAction) -> AppResult<LfsLocks> {
    action(repo, &lfs_state(repo)?, &operation, &mut |_| {})
}
fn unlock(lock: &LfsLock, fingerprint: &str, force: bool) -> LfsAction {
    LfsAction::Unlock {
        remote: "origin".into(),
        id: lock.id.clone(),
        path: lock.path.clone(),
        force,
        confirmation: if force {
            lock.path.clone()
        } else {
            String::new()
        },
        lock_fingerprint: fingerprint.into(),
    }
}

#[test]
fn native_lock_verify_and_unlock_preserve_files_refs_and_index() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    let head = head_oid(&repo);
    let empty = perform(
        &repo,
        LfsAction::Locks {
            remote: "origin".into(),
        },
    )
    .unwrap();
    assert!(empty.locks.is_empty());
    let locked = perform(
        &repo,
        LfsAction::Lock {
            remote: "origin".into(),
            path: "asset.bin".into(),
        },
    )
    .unwrap();
    assert_eq!(locked.locks.len(), 1);
    assert!(locked.locks[0].ours);
    assert!(!fs::metadata(repo.workdir().join("asset.bin"))
        .unwrap()
        .permissions()
        .readonly());
    let result = perform(&repo, unlock(&locked.locks[0], &locked.fingerprint, false)).unwrap();
    assert!(result.locks.is_empty());
    assert_eq!(server.state.lock().unwrap().unlocks, 1);
    assert_eq!(head_oid(&repo), head);
    assert!(status_snapshot(&repo).unwrap().staged.is_empty());
    assert_eq!(
        fs::read_to_string(repo.workdir().join("asset.bin")).unwrap(),
        "Original large-file content\n"
    );
}

#[test]
fn another_users_lock_requires_a_confirmed_forced_unlock() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    server.insert("asset.bin", "bob");
    let locks = perform(
        &repo,
        LfsAction::Locks {
            remote: "origin".into(),
        },
    )
    .unwrap();
    assert!(!locks.locks[0].ours);
    assert!(
        perform(&repo, unlock(&locks.locks[0], &locks.fingerprint, false))
            .unwrap_err()
            .to_string()
            .contains("another user")
    );
    let mut forced = unlock(&locks.locks[0], &locks.fingerprint, true);
    if let LfsAction::Unlock { confirmation, .. } = &mut forced {
        confirmation.clear();
    }
    assert!(perform(&repo, forced).is_err());
    assert_eq!(server.state.lock().unwrap().unlocks, 0);
    let result = perform(&repo, unlock(&locks.locks[0], &locks.fingerprint, true)).unwrap();
    assert!(result.locks.is_empty());
}

#[test]
fn regular_unlock_protects_local_modifications_even_when_addressed_by_id() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    perform(
        &repo,
        LfsAction::Lock {
            remote: "origin".into(),
            path: "asset.bin".into(),
        },
    )
    .unwrap();
    fs::write(repo.workdir().join("asset.bin"), "Keep this draft\n").unwrap();
    let locks = perform(
        &repo,
        LfsAction::Locks {
            remote: "origin".into(),
        },
    )
    .unwrap();
    let error = perform(&repo, unlock(&locks.locks[0], &locks.fingerprint, false)).unwrap_err();
    assert!(error.to_string().contains("local changes"));
    assert_eq!(server.state.lock().unwrap().unlocks, 0);
    perform(&repo, unlock(&locks.locks[0], &locks.fingerprint, true)).unwrap();
    assert_eq!(
        fs::read_to_string(repo.workdir().join("asset.bin")).unwrap(),
        "Keep this draft\n"
    );
}

#[test]
fn replaced_locks_and_invalid_paths_never_unlock_a_new_owner() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    let id = server.insert("asset.bin", "alice");
    let locks = perform(
        &repo,
        LfsAction::Locks {
            remote: "origin".into(),
        },
    )
    .unwrap();
    server.state.lock().unwrap().locks.remove(&id);
    server.insert("asset.bin", "bob");
    assert!(perform(&repo, unlock(&locks.locks[0], &locks.fingerprint, true)).is_err());
    assert_eq!(server.state.lock().unwrap().unlocks, 0);
    for path in ["../asset.bin", "/asset.bin", "asset.bin\n"] {
        assert!(checked_path(&repo, path).is_err());
    }
    assert!(perform(
        &repo,
        LfsAction::Lock {
            remote: "origin".into(),
            path: "missing.bin".into()
        }
    )
    .is_err());
}

#[test]
fn unsupported_servers_are_errors_instead_of_an_empty_successful_json_list() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    server.state.lock().unwrap().unavailable = true;
    assert!(perform(
        &repo,
        LfsAction::Locks {
            remote: "origin".into()
        }
    )
    .is_err());
}

#[test]
fn structured_lists_match_native_unicode_paths_and_owner_padding() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    server.insert("folder with spaces/model.bin", "alice");
    server.insert("caf\u{e9}/draft.bin", "b\u{e9}atrice");
    let locks = perform(
        &repo,
        LfsAction::Locks {
            remote: "origin".into(),
        },
    )
    .unwrap();
    assert_eq!(locks.locks.len(), 2);
    assert!(!locks.locks[0].ours);
    assert!(locks.locks[1].ours);
}

#[test]
fn lock_queries_can_cancel_a_server_that_never_replies() {
    let Some((_dir, repo, server)) = fixture() else {
        return;
    };
    let state = lfs_state(&repo).unwrap();
    server.state.lock().unwrap().hanging = true;
    let id = "lfs-lock-query-cancellation";
    let worker = thread::spawn(move || {
        with_cancel(Some(id), || {
            action(
                &repo,
                &state,
                &LfsAction::Locks {
                    remote: "origin".into(),
                },
                &mut |_| {},
            )
        })
    });
    let started = std::time::Instant::now();
    while !server.requested.load(Ordering::Relaxed)
        && !worker.is_finished()
        && started.elapsed() < Duration::from_secs(60)
    {
        thread::sleep(Duration::from_millis(5));
    }
    let requested = server.requested.load(Ordering::Relaxed);
    let cancelled = std::time::Instant::now();
    let cancellation_accepted = cancel_activity(id);
    let result = worker.join().unwrap();
    assert!(requested, "Lock query did not reach the server: {result:?}");
    assert!(cancellation_accepted);
    assert!(result.unwrap_err().is_cancelled());
    assert!(cancelled.elapsed() < Duration::from_secs(3));
}
