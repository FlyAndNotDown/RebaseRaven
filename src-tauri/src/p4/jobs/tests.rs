use super::*;

const SCHEMA: &str = "Fields:\n\t101 Job word 32 required\n\t102 State select 10 required\n\t103 Reporter word 32 required\n\t104 Modified date 20 always\n\t105 Details text 0 required\n\t106 Priority select 10 optional\n\t107 Notes bulk 0 optional\n\t108 CreatedBy word 32 once\n\nValues:\n\tState open/fixed/waiting\n\tPriority low/high\n\nPresets:\n\tState open,fix/fixed\n\nComments:\n\t# Details: Describe the work.\n";
const JOB: &str = "# Job form\n\nJob:\tjob001\n\nState:\topen\n\nReporter:\talice\n\nModified:\t2025/01/01 12:00:00\n\nDetails:\n\tFirst line\n\t\n\t    Indented text\n\t# Content, not a form comment\n\nNotes:\n\tKeep this\n\nCreatedBy:\talice\n\nHidden:\tretained\n";

fn connection() -> P4Connection {
    P4Connection {
        root: String::new(),
        port: "perforce.example:1666".into(),
        user: "alice".into(),
        client: "project-main".into(),
        charset: String::new(),
        stream: None,
        server: String::new(),
    }
}
fn edit() -> P4JobEdit {
    P4JobEdit {
        name: "job001".into(),
        values: BTreeMap::from([("Details".into(), "Changed\n\n    More\n# Literal".into())]),
        schema_fingerprint: String::new(),
    }
}
fn request() -> P4FixRequest {
    P4FixRequest {
        job: "job001".into(),
        change: "42".into(),
        status: "waiting".into(),
        remove: false,
    }
}
fn change() -> &'static str {
    "Change:\t42\nStatus:\tpending\nUser:\talice\nClient:\tproject-main\nJobs:\n\tjob001 waiting\n"
}
fn fix() -> &'static str {
    "... Job job001\n... Change 42\n... Status waiting\n... User alice\n... Client project-main\n"
}

#[test]
fn custom_schema_controls_fields_choices_help_and_read_only_values() {
    let definitions = fields(SCHEMA, JOB, false).unwrap();
    assert_eq!(
        definitions.iter().find(|f| f.code == 102).unwrap().name,
        "State"
    );
    let state = definitions.iter().find(|f| f.code == 102).unwrap();
    assert_eq!(state.choices, ["open", "fixed", "waiting"]);
    let details = definitions.iter().find(|f| f.code == 105).unwrap();
    assert_eq!(details.hint, "Describe the work.");
    assert_eq!(
        details.value,
        "First line\n\n    Indented text\n# Content, not a form comment"
    );
    assert!(definitions
        .iter()
        .filter(|f| matches!(f.code, 101 | 104 | 108))
        .all(|f| f.read_only));
    assert!(!fields(SCHEMA, JOB, true).unwrap()[0].read_only);
    assert_eq!(
        fields(
            SCHEMA,
            "Job:\tnew\nDetails:\n\t<enter description here>\n",
            true
        )
        .unwrap()
        .iter()
        .find(|f| f.code == 105)
        .unwrap()
        .value,
        ""
    );
}

#[test]
fn edits_preserve_untouched_and_hidden_fields_and_multiline_content() {
    let result = edited(SCHEMA, JOB, &edit(), false).unwrap();
    assert_eq!(value(&result, "Details"), edit().values["Details"]);
    for field in [
        "State",
        "Reporter",
        "Modified",
        "Notes",
        "CreatedBy",
        "Hidden",
    ] {
        assert_eq!(value(&result, field), value(JOB, field));
    }
    assert!(result.starts_with("# Job form\n"));
    assert_eq!(result.matches("Details:").count(), 1);
}

#[test]
fn rejects_read_only_changes_unknown_fields_invalid_select_and_form_injection() {
    for (key, value) in [
        ("Modified", "changed"),
        ("CreatedBy", "mallory"),
        ("Unknown", "value"),
        ("State", "invalid"),
        ("Reporter", "alice\nState: fixed"),
        ("Details", ""),
        ("Notes", "nul\0"),
    ] {
        let mut edit = edit();
        edit.values.insert(key.into(), value.into());
        assert!(edited(SCHEMA, JOB, &edit, false).is_err(), "{key}");
    }
    for name in ["-x", "a b", "a*", "a|b", "a+b", "a=b", "a\nJob:other"] {
        assert!(name_is_invalid(name));
    }
    assert!(name("job-001_fix.2").is_ok());
}
fn name_is_invalid(value: &str) -> bool {
    name(value).is_err()
}

#[test]
fn optional_fields_can_be_cleared_and_schema_errors_do_not_drop_fields() {
    let mut edit = edit();
    edit.values.insert("Priority".into(), String::new());
    edit.values.insert("Notes".into(), String::new());
    let result = edited(SCHEMA, JOB, &edit, false).unwrap();
    assert_eq!(value(&result, "Priority"), "");
    assert_eq!(value(&result, "Notes"), "");
    assert!(fields("Fields:\n\tbroken\n", JOB, false).is_err());
    assert!(fields("Fields:\n\t102 State select 10 required\n", JOB, false).is_err());
}

#[test]
fn fix_preview_distinguishes_pending_submitted_default_and_preserved_statuses() {
    let c = connection();
    let current = fix_preview(&c, &request(), SCHEMA, JOB, change(), fix()).unwrap();
    assert_eq!(current.change_status, "pending");
    assert_eq!(current.current_status, "open");
    assert_eq!(current.fix_status, "waiting");
    assert_eq!(current.existing_status.as_deref(), Some("waiting"));
    let mut request = request();
    request.status.clear();
    let default = fix_preview(&c, &request, SCHEMA, JOB, change(), "").unwrap();
    assert_eq!(default.fix_status, "fixed");
    request.status = "same".into();
    let submitted = change()
        .replace("pending", "submitted")
        .replace("alice", "bob");
    let kept = fix_preview(&c, &request, SCHEMA, JOB, &submitted, "").unwrap();
    assert_eq!(kept.fix_status, "same");
    assert_eq!(kept.change_status, "submitted");
    request.remove = true;
    request.status = "retired-status".into();
    let removed = fix_preview(&c, &request, SCHEMA, JOB, change(), fix()).unwrap();
    assert_eq!(removed.fix_status, "open");
    assert!(fix_preview(&c, &request, SCHEMA, JOB, change(), "").is_err());
}

#[test]
fn fix_preview_rejects_foreign_pending_default_and_invalid_status() {
    let c = connection();
    for spec in [
        change().replace("alice", "bob"),
        change().replace("project-main", "other-client"),
        change().replace("pending", "new"),
    ] {
        assert!(fix_preview(&c, &request(), SCHEMA, JOB, &spec, "").is_err());
    }
    let mut request = request();
    request.change = "default".into();
    assert!(fix_preview(&c, &request, SCHEMA, JOB, change(), "").is_err());
    request.change = "42".into();
    request.status = "invalid".into();
    assert!(fix_preview(&c, &request, SCHEMA, JOB, change(), "").is_err());
}

#[test]
fn fingerprints_cover_job_schema_connection_change_links_and_action() {
    let c = connection();
    let request = request();
    let original = fix_preview(&c, &request, SCHEMA, JOB, change(), fix())
        .unwrap()
        .fingerprint;
    let mut other = c.clone();
    other.port = "other.example:1666".into();
    let mut action = request.clone();
    action.status = "same".into();
    for fingerprint in [
        fix_preview(&other, &request, SCHEMA, JOB, change(), fix())
            .unwrap()
            .fingerprint,
        fix_preview(
            &c,
            &request,
            &(SCHEMA.to_string() + "\n"),
            JOB,
            change(),
            fix(),
        )
        .unwrap()
        .fingerprint,
        fix_preview(
            &c,
            &request,
            SCHEMA,
            &JOB.replace("First line", "New content"),
            change(),
            fix(),
        )
        .unwrap()
        .fingerprint,
        fix_preview(
            &c,
            &request,
            SCHEMA,
            JOB,
            &(change().to_string() + "Description:\tChanged\n"),
            fix(),
        )
        .unwrap()
        .fingerprint,
        fix_preview(&c, &request, SCHEMA, JOB, change(), "")
            .unwrap()
            .fingerprint,
        fix_preview(&c, &action, SCHEMA, JOB, change(), fix())
            .unwrap()
            .fingerprint,
    ] {
        assert_ne!(original, fingerprint);
    }
}

#[test]
fn a_successful_exit_without_deleting_the_job_is_still_a_failure() {
    assert!(deleted_result(
        true,
        "job001 has 1 fixes associated with it and can't be deleted."
    )
    .is_err());
    assert!(deleted_result(true, "").is_err());
    assert!(deleted_result(false, "Job job001 deleted.").is_ok());
}

#[test]
fn association_readback_checks_status_changes_and_refused_unlinks() {
    let preview = fix_preview(&connection(), &request(), SCHEMA, JOB, change(), fix()).unwrap();
    assert!(verify_fix_effect(&preview, fix()).is_ok());
    assert!(verify_fix_effect(&preview, &fix().replace("waiting", "fixed")).is_err());
    assert!(verify_fix_effect(&preview, "").is_err());
    let mut removing = preview;
    removing.request.remove = true;
    assert!(verify_fix_effect(&removing, fix()).is_err());
    assert!(verify_fix_effect(&removing, "").is_ok());
}
