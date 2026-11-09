use super::*;

fn connection() -> P4Connection {
    P4Connection {
        root: String::new(),
        port: "perforce.example:1666".into(),
        user: "alice".into(),
        client: "project-dev".into(),
        charset: String::new(),
        stream: Some("//project/dev".into()),
        server: String::new(),
    }
}
fn work(opened: bool) -> P4StreamWork {
    let connection = connection();
    P4StreamWork {
        spec:super::super::stream_specs::parsed(&connection, "Stream: //project/dev\nName: Development\nOwner: alice\nParent: //project/main\nType: development\nParentView: inherit\nPaths:\n\tshare ...\n"),
        opened:opened.then(|| P4StreamOpen {change:"default".into(), base_change:"40".into()}),
        head_change:"42".into(), current_text:String::new(), base_text:String::new(), head_text:String::new(), diff:parse_single_diff("", "//project/dev"), unresolved:false, resolve_output:String::new(), fingerprint:"snapshot".into(),
    }
}
fn request(action: &str, mode: &str) -> P4StreamWorkRequest {
    P4StreamWorkRequest {
        action: action.into(),
        change: "default".into(),
        mode: mode.into(),
    }
}

#[test]
fn conversion_requires_a_closed_supported_stream_and_a_different_view() {
    let connection = connection();
    assert!(validate_request(
        &connection,
        &work(true),
        &request("parentview", "noinherit")
    )
    .is_err());
    assert!(
        validate_request(&connection, &work(false), &request("parentview", "inherit")).is_err()
    );
    assert!(validate_request(
        &connection,
        &work(false),
        &request("parentview", "noinherit")
    )
    .is_ok());
    let mut task = work(false);
    task.spec.edit.kind = "task".into();
    assert!(validate_request(&connection, &task, &request("parentview", "noinherit")).is_err());
    assert!(
        validate_request(&connection, &work(false), &request("parentview", "invalid")).is_err()
    );
}

#[test]
fn revert_and_resolve_require_the_opened_definition_and_real_conflicts() {
    let connection = connection();
    assert!(validate_request(&connection, &work(false), &request("revert", "")).is_err());
    assert!(validate_request(&connection, &work(true), &request("revert", "")).is_ok());
    assert!(validate_request(&connection, &work(true), &request("open", "")).is_err());
    assert!(validate_request(&connection, &work(true), &request("move", "")).is_err());
    assert!(validate_request(&connection, &work(true), &request("resolve", "merge")).is_err());
    let mut conflict = work(true);
    conflict.unresolved = true;
    for mode in ["safe", "merge", "yours", "theirs"] {
        assert!(validate_request(&connection, &conflict, &request("resolve", mode)).is_ok());
    }
    assert!(validate_request(&connection, &conflict, &request("resolve", "force")).is_err());
}

#[test]
fn conversion_preview_removes_status_lines_and_volatile_metadata_only() {
    let raw = "Converted stream spec //project/dev ParentView property to noinherit.\nStream:\t//project/dev\n\nUpdate:\t2025/01/01 12:00:00\nAccess:\t2025/01/01 12:01:00\nDescription:\n\t# Literal description\nParentView:\tnoinherit\nPaths:\n\tshare ... ## ancestor annotation\n";
    let actual = review_text(raw);
    assert!(actual.starts_with("Stream:"));
    assert!(!actual.contains("Converted stream"));
    assert!(!actual.contains("Access:"));
    assert!(!actual.contains("Update:"));
    assert!(actual.contains("\t# Literal description"));
    assert!(actual.contains("## ancestor annotation"));
}

#[test]
fn historical_creation_is_recognized_without_hiding_other_native_errors() {
    assert!(missing_revision(
        "No stream '//project/dev' existed at change 41"
    ));
    assert!(missing_revision("No such stream."));
    assert!(!missing_revision("Perforce password invalid or unset."));
    assert!(!missing_revision("No permission for operation on file(s)."));
}

#[test]
fn historical_creation_and_deletion_show_definition_fields_with_the_correct_direction() {
    let text = "# Help header\nStream: //project/dev\nAccess: yesterday\nUpdate: today\nName: Development\n";
    for deleted in [false, true] {
        let diff = definition_diff("//project/dev", text, deleted);
        assert_eq!(diff.lines.len(), 3);
        assert_eq!(diff.lines[1].content, "Stream: //project/dev");
        assert_eq!(diff.lines[2].content, "Name: Development");
        assert_eq!(diff.lines[1].kind, if deleted { "delete" } else { "add" });
        assert_eq!(diff.lines[1].old_lineno, deleted.then_some(1));
        assert_eq!(diff.lines[1].new_lineno, (!deleted).then_some(1));
    }
}

#[test]
fn restored_definition_requires_an_open_record_in_the_requested_changelist() {
    let restore = request("unshelve", "50");
    assert!(operation_applied(&restore, &work(true)));
    assert!(!operation_applied(&restore, &work(false)));
    let mut wrong = work(true);
    wrong.opened.as_mut().unwrap().change = "42".into();
    assert!(!operation_applied(&restore, &wrong));
}
