use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    connection: P4Connection,
    rows: BTreeMap<String, ZtagRecord>,
    client: String,
    mutations: Vec<Vec<String>>,
    acknowledge: bool,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_string_lossy().into_owned();
        let connection = P4Connection {
            root: root.clone(),
            port: "perforce.example:1666".into(),
            user: "alice".into(),
            client: "workspace".into(),
            charset: String::new(),
            stream: None,
            server: "example".into(),
        };
        let mut rows = BTreeMap::new();
        for name in ["closed.txt", "opened.txt"] {
            let local = directory.path().join(name);
            fs::write(&local, "Keep local contents\n").unwrap();
            let path = format!("//depot/{name}");
            let mut row: ZtagRecord = [
                ("depotFile", path.as_str()),
                ("clientFile", local.to_str().unwrap()),
                ("isMapped", ""),
                ("headType", "text"),
                ("headRev", "2"),
                ("haveRev", "1"),
                ("headChange", "8"),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
            if name == "opened.txt" {
                for (key, value) in [
                    ("action", "edit"),
                    ("actionOwner", "alice"),
                    ("type", "text"),
                    ("change", "77"),
                ] {
                    row.insert(key.into(), value.into());
                }
            }
            rows.insert(path, row);
        }
        Self { _directory: directory, connection, rows, client: format!("Client: workspace\nOwner: alice\nRoot: {root}\nView:\n\t//depot/... //workspace/...\n"), mutations: Vec::new(), acknowledge: true }
    }
    fn paths(&self) -> Vec<String> {
        self.rows.keys().cloned().collect()
    }
    fn run(&mut self, args: &[&str]) -> AppResult<String> {
        if args.first() == Some(&"client") {
            return Ok(self.client.clone());
        }
        if args.first() == Some(&"change") {
            return Ok("Status: pending\nUser: alice\nClient: workspace\n".into());
        }
        if args.get(1) == Some(&"fstat") {
            let path = args.last().unwrap();
            let row = self
                .rows
                .get(*path)
                .or_else(|| {
                    self.rows.values().find(|row| {
                        row.get("clientFile").is_some_and(|local| {
                            workspace_file_spec(&self.connection.root, local) == *path
                        })
                    })
                })
                .unwrap();
            return Ok(tagged(row));
        }
        assert!(matches!(args.get(1), Some(&"edit") | Some(&"reopen")));
        self.mutations
            .push(args.iter().map(|arg| arg.to_string()).collect());
        if !self.acknowledge {
            return Ok("File could not be reopened\n".into());
        }
        let mut output = String::new();
        for path in args.iter().filter(|value| value.starts_with("//")) {
            let row = self.rows.get_mut(*path).unwrap();
            row.insert("type".into(), "text+x".into());
            if args[1] == "edit" {
                let index = args.iter().position(|value| *value == "-c").unwrap();
                row.insert("change".into(), args[index + 1].into());
                row.insert("action".into(), "edit".into());
                row.insert("actionOwner".into(), "alice".into());
            }
            output.push_str(&format!("... depotFile {path}\n... type text+Cx\n\n"));
        }
        Ok(output)
    }
    fn properties(&mut self) -> P4FilePropertiesView {
        properties_with(&self.connection.clone(), &self.paths(), &mut |args| {
            self.run(args)
        })
        .unwrap()
    }
    fn apply(&mut self, request: &P4FileTypeRequest, fingerprint: &str) -> AppResult<()> {
        change_with(
            &self.connection.clone(),
            request,
            fingerprint,
            &mut |args| self.run(args),
        )
    }
}

fn tagged(row: &ZtagRecord) -> String {
    row.iter()
        .map(|(key, value)| format!("... {key} {value}\n"))
        .collect::<String>()
        + "\n"
}

fn request(fixture: &Fixture) -> P4FileTypeRequest {
    P4FileTypeRequest {
        paths: fixture.paths(),
        selected: fixture.paths(),
        file_type: "text+x".into(),
        change_id: "44".into(),
    }
}

#[test]
fn types_accept_native_modifiers_and_reject_conflicting_or_injected_values() {
    for value in [
        "text",
        "binary+l",
        "text+CxwmkoS16",
        "+x",
        "+S512",
        "unicode",
        "utf8",
        "utf16",
        "symlink",
        "ktext",
    ] {
        assert!(file_type(value).is_ok(), "{value}");
    }
    for value in [
        "",
        "+",
        "text+",
        "-t",
        "text +x",
        "text+CF",
        "text+kk",
        "text+koCk",
        "binary+S11",
        "binary+S0",
        "binary+S01",
        "binary+S1024",
        "text+x+x",
        "unknown",
        "text\n-c 4",
    ] {
        assert!(file_type(value).is_err(), "{value}");
    }
}

#[test]
fn batch_retyping_preserves_open_changelists_and_checks_out_only_closed_files() {
    let mut fixture = Fixture::new();
    let view = fixture.properties();
    let request = request(&fixture);
    fixture.apply(&request, &view.fingerprint).unwrap();
    assert_eq!(fixture.rows["//depot/opened.txt"]["change"], "77");
    assert_eq!(fixture.rows["//depot/closed.txt"]["change"], "44");
    assert_eq!(fixture.mutations.len(), 2);
    assert!(fixture.mutations[0].contains(&"//depot/closed.txt".into()));
    assert!(!fixture.mutations[0].contains(&"//depot/opened.txt".into()));
    assert!(!fixture.mutations[1].contains(&"-c".into()));
    for file in fixture.rows.values() {
        assert_eq!(
            fs::read_to_string(&file["clientFile"]).unwrap(),
            "Keep local contents\n"
        );
    }
}

#[test]
fn stale_metadata_mappings_local_edits_and_unselected_files_cannot_be_retyped() {
    for update in ["file", "mapping", "local"] {
        let mut fixture = Fixture::new();
        let view = fixture.properties();
        let request = request(&fixture);
        match update {
            "file" => {
                fixture
                    .rows
                    .get_mut("//depot/opened.txt")
                    .unwrap()
                    .insert("type".into(), "binary".into());
            }
            "mapping" => fixture.client.push_str("Options: allwrite\n"),
            _ => fs::write(
                &fixture.rows["//depot/opened.txt"]["clientFile"],
                "New local work after preview\n",
            )
            .unwrap(),
        }
        assert!(fixture.apply(&request, &view.fingerprint).is_err());
        assert!(fixture.mutations.is_empty());
    }
    let mut fixture = Fixture::new();
    let view = fixture.properties();
    let mut request = request(&fixture);
    request.selected = vec!["//depot/other.txt".into()];
    assert!(fixture.apply(&request, &view.fingerprint).is_err());
    assert!(fixture.mutations.is_empty());
}

#[test]
fn blocked_file_states_are_readable_but_cannot_mutate() {
    for (key, value, reason) in [
        ("action", "delete", "deleted"),
        ("actionOwner", "bob", "owner"),
        ("unresolved", "1", "unresolved"),
    ] {
        let mut fixture = Fixture::new();
        fixture
            .rows
            .get_mut("//depot/opened.txt")
            .unwrap()
            .insert(key.into(), value.into());
        let view = fixture.properties();
        assert_eq!(view.files[1].blocked, reason);
        let request = request(&fixture);
        assert!(fixture.apply(&request, &view.fingerprint).is_err());
        assert!(fixture.mutations.is_empty());
    }
    let mut fixture = Fixture::new();
    fixture
        .rows
        .get_mut("//depot/closed.txt")
        .unwrap()
        .remove("isMapped");
    let view = fixture.properties();
    assert_eq!(view.files[0].blocked, "unmapped");
}

#[test]
fn successful_exit_without_type_acknowledgement_does_not_report_success() {
    let mut fixture = Fixture::new();
    let view = fixture.properties();
    let request = request(&fixture);
    fixture.acknowledge = false;
    assert!(fixture.apply(&request, &view.fingerprint).is_err());
}

#[test]
fn path_and_selection_validation_precedes_any_server_request() {
    let fixture = Fixture::new();
    for path in [
        "//depot/...",
        "//depot/file#3",
        "//depot/*",
        "//depot/../file",
        "-c",
        "relative.txt",
    ] {
        assert!(
            properties_with(&fixture.connection, &[path.into()], &mut |_| panic!(
                "Unexpected request"
            ))
            .is_err()
        );
    }
    assert!(properties_with(&fixture.connection, &[], &mut |_| panic!(
        "Unexpected request"
    ))
    .is_err());
}

#[test]
fn native_storage_defaults_and_modifier_order_do_not_mask_type_or_flag_mismatches() {
    assert!(same_native_type("text+Dx", "text+x"));
    assert!(same_native_type("binary+Cxl", "binary+lx"));
    assert!(!same_native_type("text+Dx", "text+Cx"));
    assert!(!same_native_type("text+x", "binary+x"));
    assert!(!same_native_type("text+x", "text"));
    assert!(!same_native_type("", ""));
}
