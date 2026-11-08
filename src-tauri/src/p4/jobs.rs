//! Jobs use the server's form definition; fixes retain their submit status.
use std::collections::{hash_map::DefaultHasher, BTreeMap};
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

use super::cli;
use super::client::block;
use super::parse::{parse_ztag, spec_field};
use super::review::{number, run};
use super::workspace::{env_for, P4Connection};
use crate::error::{AppError, AppResult};

const STALE: &str = "The job or its field definition changed. Reload it before saving or deleting.";
const FIX_STALE: &str = "The job, changelist, or fix changed. Preview the association again.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4JobField {
    code: u32,
    name: String,
    kind: String,
    required: bool,
    read_only: bool,
    choices: Vec<String>,
    hint: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Job {
    name: String,
    fields: Vec<P4JobField>,
    schema_fingerprint: String,
    fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4JobEdit {
    name: String,
    values: BTreeMap<String, String>,
    schema_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4JobSummary {
    name: String,
    status: String,
    user: String,
    description: String,
}

#[derive(Debug, Serialize)]
pub struct P4JobPage {
    items: Vec<P4JobSummary>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct P4Fix {
    job: String,
    change: String,
    status: String,
    user: String,
    client: String,
}

#[derive(Debug, Serialize)]
pub struct P4FixPage {
    items: Vec<P4Fix>,
    truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
pub struct P4FixRequest {
    pub job: String,
    pub change: String,
    pub status: String,
    pub remove: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4FixPreview {
    request: P4FixRequest,
    change_status: String,
    current_status: String,
    fix_status: String,
    existing_status: Option<String>,
    fingerprint: String,
}

fn name(value: &str) -> AppResult<&str> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('-')
        || value.contains([
            '@', '#', '*', '%', ',', '/', '\\', '"', '=', '<', '>', '!', '|', '&', '(', ')', '+',
            '\'',
        ])
        || value.contains("...")
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(AppError::msg(
            "Enter one job name without wildcards or search operators.",
        ));
    }
    Ok(value)
}

fn hash(connection: &P4Connection, parts: &[&str]) -> String {
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.charset,
        parts,
    )
        .hash(&mut hash);
    format!("{:016x}", hash.finish())
}

// Only the form's indentation is removed; blank lines and content indentation survive.
fn value(spec: &str, field: &str) -> String {
    let prefix = format!("{field}:");
    let mut lines = spec.lines().skip_while(|line| !line.starts_with(&prefix));
    let Some(header) = lines.next() else {
        return String::new();
    };
    let inline = header[prefix.len()..].trim();
    if !inline.is_empty() {
        return inline.to_string();
    }
    let mut values: Vec<_> = lines
        .take_while(|line| line.is_empty() || line.starts_with(char::is_whitespace))
        .map(|line| line.strip_prefix('\t').unwrap_or(line).to_string())
        .collect();
    while values.last().is_some_and(String::is_empty) {
        values.pop();
    }
    values.join("\n")
}

fn set_value(spec: &str, field: &str, content: &str, multiline: bool) -> String {
    let prefix = format!("{field}:");
    let mut result = String::new();
    let mut skipping = false;
    for line in spec.lines() {
        if line.starts_with(&prefix) {
            skipping = true;
            continue;
        }
        if skipping && !line.is_empty() && !line.starts_with(char::is_whitespace) {
            skipping = false;
        }
        if !skipping {
            result.push_str(line);
            result.push('\n');
        }
    }
    result.push_str(&prefix);
    if multiline {
        result.push('\n');
        for line in content.lines() {
            result.push('\t');
            result.push_str(line);
            result.push('\n');
        }
    } else {
        result.push('\t');
        result.push_str(content);
        result.push('\n');
    }
    result.push('\n');
    result
}

fn fields(schema: &str, spec: &str, creating: bool) -> AppResult<Vec<P4JobField>> {
    let choices = block(schema, "Values");
    let comment_text = value(schema, "Comments");
    let comments: Vec<_> = comment_text.lines().collect();
    let mut result = Vec::new();
    for row in block(schema, "Fields") {
        let parts: Vec<_> = row.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(AppError::msg(
                "The server returned an invalid job field definition.",
            ));
        }
        let code: u32 = parts[0]
            .parse()
            .map_err(|_| AppError::msg("Invalid job field code."))?;
        let name = parts[1];
        let kind = parts[2];
        let prefix = format!("{name}:");
        let hint = comments
            .iter()
            .find_map(|line| {
                line.trim_start_matches('#')
                    .trim()
                    .strip_prefix(&prefix)
                    .map(|v| v.trim().to_string())
            })
            .unwrap_or_default();
        let values = choices
            .iter()
            .find_map(|line| {
                let (field, list) = line.split_once(char::is_whitespace)?;
                (field == name).then(|| list.trim().split('/').map(String::from).collect())
            })
            .unwrap_or_default();
        let raw = value(spec, name);
        result.push(P4JobField {
            code,
            name: name.into(),
            kind: kind.into(),
            required: parts[4] == "required",
            read_only: matches!(parts[4], "once" | "always")
                || code == 101 && !creating
                || !matches!(kind, "word" | "date" | "select" | "line" | "text" | "bulk"),
            choices: values,
            hint,
            value: if creating && raw == "<enter description here>" {
                String::new()
            } else {
                raw
            },
        });
    }
    if !result
        .iter()
        .any(|field| field.code == 101 && field.name == "Job")
    {
        return Err(AppError::msg(
            "The server's job definition has no Job field.",
        ));
    }
    Ok(result)
}

fn exists(connection: &P4Connection, job: &str) -> AppResult<bool> {
    name(job)?;
    let filter = format!("Job={job}");
    Ok(
        parse_ztag(&run(connection, &["-ztag", "jobs", "-e", &filter])?)
            .iter()
            .any(|row| row.get("Job").is_some_and(|v| v == job)),
    )
}

fn existing(connection: &P4Connection, job: &str) -> AppResult<String> {
    if !exists(connection, job)? {
        return Err(AppError::msg("The selected job no longer exists."));
    }
    run(connection, &["job", "-o", job])
}

fn parsed(connection: &P4Connection, schema: &str, spec: &str, creating: bool) -> AppResult<P4Job> {
    Ok(P4Job {
        name: spec_field(spec, "Job"),
        fields: fields(schema, spec, creating)?,
        schema_fingerprint: hash(connection, &[schema]),
        fingerprint: hash(connection, &[schema, spec]),
    })
}

pub fn read_job(connection: &P4Connection, job: Option<&str>) -> AppResult<P4Job> {
    let schema = run(connection, &["jobspec", "-o"])?;
    let spec = match job {
        Some(job) => existing(connection, job)?,
        None => run(connection, &["job", "-o"])?,
    };
    parsed(connection, &schema, &spec, job.is_none())
}

pub fn list_jobs(connection: &P4Connection, query: &str) -> AppResult<P4JobPage> {
    if query.len() > 4096 || query.chars().any(char::is_control) {
        return Err(AppError::msg("Enter a single-line job search expression."));
    }
    let schema = run(connection, &["jobspec", "-o"])?;
    let fields = fields(&schema, "", true)?;
    let mut args = vec!["-ztag", "jobs", "-l", "-r", "-m", "201"];
    if !query.trim().is_empty() {
        args.extend(["-e", query.trim()]);
    }
    let mut items: Vec<_> = parse_ztag(&run(connection, &args)?)
        .iter()
        .filter_map(|row| {
            let get = |code| {
                fields
                    .iter()
                    .find(|f| f.code == code)
                    .and_then(|f| row.get(&f.name))
                    .cloned()
                    .unwrap_or_default()
            };
            Some(P4JobSummary {
                name: row.get("Job")?.clone(),
                status: get(102),
                user: get(103),
                description: get(105),
            })
        })
        .collect();
    let truncated = items.len() > 200;
    items.truncate(200);
    Ok(P4JobPage { items, truncated })
}

fn edited(schema: &str, spec: &str, edit: &P4JobEdit, creating: bool) -> AppResult<String> {
    name(&edit.name)?;
    let fields = fields(schema, spec, creating)?;
    if edit.values.keys().any(|key| {
        !fields
            .iter()
            .any(|field| &field.name == key && field.code != 101)
    }) {
        return Err(AppError::msg(
            "The job form contains an unknown field. Reload it.",
        ));
    }
    let mut result = spec.to_string();
    for field in &fields {
        let requested = if field.code == 101 {
            Some(&edit.name)
        } else {
            edit.values.get(&field.name)
        };
        let Some(content) = requested else {
            continue;
        };
        if field.read_only {
            if content != &field.value {
                return Err(AppError::msg("A read-only job field cannot be changed."));
            }
            continue;
        }
        let multiline = matches!(field.kind.as_str(), "text" | "bulk");
        if content.len() > 1_048_576
            || content
                .chars()
                .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
            || !multiline && content.contains(['\n', '\r', '\t'])
            || field.kind == "word" && content.chars().any(char::is_whitespace)
            || field.required && content.trim().is_empty()
            || field.kind == "select" && !content.is_empty() && !field.choices.contains(content)
        {
            return Err(AppError::msg(format!(
                "Enter a valid value for {}.",
                field.name
            )));
        }
        result = set_value(&result, &field.name, content, multiline);
    }
    Ok(result)
}

pub fn save_job(
    connection: &P4Connection,
    edit: &P4JobEdit,
    fingerprint: Option<&str>,
) -> AppResult<P4Job> {
    let schema = run(connection, &["jobspec", "-o"])?;
    if hash(connection, &[&schema]) != edit.schema_fingerprint {
        return Err(AppError::msg(STALE));
    }
    let spec = if let Some(expected) = fingerprint {
        let spec = existing(connection, &edit.name)?;
        if hash(connection, &[&schema, &spec]) != expected {
            return Err(AppError::msg(STALE));
        }
        spec
    } else {
        if edit.name != "new" && exists(connection, &edit.name)? {
            return Err(AppError::msg(
                "This job already exists. Choose another name.",
            ));
        }
        run(connection, &["job", "-o"])?
    };
    let spec = edited(&schema, &spec, edit, fingerprint.is_none())?;
    let output = cli::run_p4_ok(&env_for(connection), &["job", "-i"], Some(&spec))?;
    let job = if edit.name == "new" {
        output
            .lines()
            .find_map(|line| {
                line.strip_prefix("Job ")
                    .and_then(|rest| rest.split_whitespace().next())
            })
            .ok_or_else(|| AppError::msg("The server did not return the created job name."))?
    } else {
        &edit.name
    };
    read_job(connection, Some(job))
}

pub fn delete_job(connection: &P4Connection, job: &str, fingerprint: &str) -> AppResult<()> {
    let current = read_job(connection, Some(job))?;
    if current.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    if !job_fixes(connection, job, "")?.items.is_empty() {
        return Err(AppError::msg(
            "Remove the job's changelist links before deleting it.",
        ));
    }
    // Some refusals are informational messages with a successful exit code.
    let output = run(connection, &["job", "-d", job])?;
    deleted_result(exists(connection, job)?, &output)?;
    Ok(())
}

fn deleted_result(still_exists: bool, output: &str) -> AppResult<()> {
    if still_exists {
        return Err(AppError::msg(if output.trim().is_empty() {
            "The job was not deleted."
        } else {
            output.trim()
        }));
    }
    Ok(())
}

pub fn job_fixes(connection: &P4Connection, job: &str, change: &str) -> AppResult<P4FixPage> {
    if job.is_empty() == change.is_empty() {
        return Err(AppError::msg("Choose one job or changelist."));
    }
    let mut args = vec!["-ztag", "fixes", "-m", "201"];
    let id;
    if !job.is_empty() {
        name(job)?;
        args.extend(["-j", job]);
    } else {
        id = number(change)?;
        args.extend(["-c", &id]);
    }
    let mut items: Vec<_> = parse_ztag(&run(connection, &args)?)
        .iter()
        .filter_map(|row| {
            let get = |key| row.get(key).cloned().unwrap_or_default();
            Some(P4Fix {
                job: row.get("Job")?.clone(),
                change: get("Change"),
                status: get("Status"),
                user: get("User"),
                client: get("Client"),
            })
        })
        .collect();
    let truncated = items.len() > 200;
    items.truncate(200);
    Ok(P4FixPage { items, truncated })
}

pub fn preview_job_fix(
    connection: &P4Connection,
    request: &P4FixRequest,
) -> AppResult<P4FixPreview> {
    name(&request.job)?;
    let id = number(&request.change)?;
    let schema = run(connection, &["jobspec", "-o"])?;
    let job = existing(connection, &request.job)?;
    let change = run(connection, &["change", "-s", "-o", &id])?;
    let fixes = run(
        connection,
        &["-ztag", "fixes", "-c", &id, "-j", &request.job],
    )?;
    fix_preview(connection, request, &schema, &job, &change, &fixes)
}

fn fix_preview(
    connection: &P4Connection,
    request: &P4FixRequest,
    schema: &str,
    job: &str,
    change: &str,
    fixes: &str,
) -> AppResult<P4FixPreview> {
    let id = number(&request.change)?;
    let fields = fields(schema, job, false)?;
    let status = fields.iter().find(|field| field.code == 102);
    if !request.remove
        && !request.status.is_empty()
        && request.status != "same"
        && !status.is_some_and(|field| field.choices.contains(&request.status))
    {
        return Err(AppError::msg(
            "Choose a fix status from the server's job definition.",
        ));
    }
    let change_status = spec_field(change, "Status");
    if change_status == "pending" {
        if spec_field(change, "User") != connection.user
            || spec_field(change, "Client") != connection.client
        {
            return Err(AppError::msg(
                "Choose your own pending changelist in this workspace.",
            ));
        }
    } else if change_status != "submitted" {
        return Err(AppError::msg("Choose a pending or submitted changelist."));
    }
    let existing_status = parse_ztag(fixes)
        .iter()
        .find(|row| row.get("Job") == Some(&request.job) && row.get("Change") == Some(&id))
        .map(|row| row.get("Status").cloned().unwrap_or_default());
    if request.remove && existing_status.is_none() {
        return Err(AppError::msg(
            "This job is no longer linked to the changelist.",
        ));
    }
    let default = status
        .map(|field| {
            block(schema, "Presets")
                .iter()
                .find_map(|line| {
                    let (key, v) = line.split_once(char::is_whitespace)?;
                    (key == field.name)
                        .then(|| v.split_once(",fix/").map(|(_, v)| v.to_string()))
                        .flatten()
                })
                .unwrap_or_else(|| "closed".into())
        })
        .unwrap_or_default();
    let current_status = status.map(|field| field.value.clone()).unwrap_or_default();
    let fix_status = if request.remove {
        current_status.clone()
    } else if request.status.is_empty() {
        default
    } else {
        request.status.clone()
    };
    let request_key =
        serde_json::to_string(request).map_err(|error| AppError::msg(error.to_string()))?;
    let fingerprint = hash(connection, &[schema, job, change, fixes, &request_key]);
    Ok(P4FixPreview {
        request: request.clone(),
        change_status,
        current_status,
        fix_status,
        existing_status,
        fingerprint,
    })
}

pub fn apply_job_fix(
    connection: &P4Connection,
    request: &P4FixRequest,
    fingerprint: &str,
) -> AppResult<()> {
    let preview = preview_job_fix(connection, request)?;
    if preview.fingerprint != fingerprint {
        return Err(AppError::msg(FIX_STALE));
    }
    let mut args = vec!["fix", "-c", &request.change];
    if request.remove {
        args.push("-d");
    } else if !request.status.is_empty() {
        args.extend(["-s", &request.status]);
    }
    args.push(&request.job);
    run(connection, &args)?;
    let id = number(&request.change)?;
    let fixes = run(
        connection,
        &["-ztag", "fixes", "-c", &id, "-j", &request.job],
    )?;
    verify_fix_effect(&preview, &fixes)?;

    Ok(())
}

fn verify_fix_effect(preview: &P4FixPreview, fixes: &str) -> AppResult<()> {
    let id = number(&preview.request.change)?;
    let records = parse_ztag(fixes);
    let actual = records
        .iter()
        .find(|row| row.get("Job") == Some(&preview.request.job) && row.get("Change") == Some(&id));
    let valid = if preview.request.remove {
        actual.is_none()
    } else {
        actual.is_some_and(|row| {
            preview.fix_status.is_empty() || row.get("Status") == Some(&preview.fix_status)
        })
    };
    if !valid {
        return Err(AppError::msg("The job association was not updated."));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
