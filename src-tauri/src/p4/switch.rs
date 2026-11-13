//! Switching changes the client spec only; updating files is a separate operation.
use super::history::exact_depot;
use super::parse::spec_field;
use super::review::run;
use super::workspace::P4Connection;
use crate::error::{AppError, AppResult};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SwitchRequest {
    pub target: String,
}

pub fn apply_switch(
    connection: &P4Connection,
    request: &P4SwitchRequest,
) -> AppResult<P4Connection> {
    switch_with(connection, request, |args| run(connection, args))
}

fn switch_with(
    connection: &P4Connection,
    request: &P4SwitchRequest,
    mut execute: impl FnMut(&[&str]) -> AppResult<String>,
) -> AppResult<P4Connection> {
    exact_depot(&request.target)?;
    let client = execute(&["client", "-o", &connection.client])?;
    let current = spec_field(&client, "Stream");
    if current.is_empty()
        || connection.stream.as_deref() != Some(current.as_str())
        || !spec_field(&client, "StreamAtChange").is_empty()
    {
        return Err(AppError::msg(
            "Refresh and choose a writable stream workspace.",
        ));
    }
    if current == request.target {
        return Err(AppError::msg("Choose a different stream."));
    }
    // Without -f, the server rejects opened files. Never shelve, revert, scan
    // offline changes, or sync implicitly as part of changing the stream.
    execute(&["client", "-s", "-S", &request.target, &connection.client])?;
    let mut next = connection.clone();
    next.stream = Some(request.target.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> P4Connection {
        P4Connection {
            root: String::new(),
            port: String::new(),
            user: "alice".into(),
            client: "workspace".into(),
            charset: String::new(),
            stream: Some("//project/main".into()),
            server: String::new(),
        }
    }

    #[test]
    fn switching_only_reads_and_changes_the_client_without_scanning_or_syncing() {
        let mut calls = Vec::new();
        let next = switch_with(
            &connection(),
            &P4SwitchRequest {
                target: "//project/dev".into(),
            },
            |args| {
                calls.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                Ok("Stream: //project/main\n".into())
            },
        )
        .unwrap();
        assert_eq!(next.stream.as_deref(), Some("//project/dev"));
        assert_eq!(
            calls,
            vec![
                vec!["client", "-o", "workspace"],
                vec!["client", "-s", "-S", "//project/dev", "workspace"],
            ]
        );
    }

    #[test]
    fn server_rejection_leaves_the_connection_unchanged_and_does_not_force_switching() {
        let current = connection();
        let mut calls = 0;
        assert!(switch_with(
            &current,
            &P4SwitchRequest {
                target: "//project/dev".into()
            },
            |args| {
                calls += 1;
                if args.contains(&"-s") {
                    Err(AppError::msg("Client has files opened."))
                } else {
                    Ok("Stream: //project/main\n".into())
                }
            }
        )
        .is_err());
        assert_eq!(calls, 2);
        assert_eq!(current.stream.as_deref(), Some("//project/main"));
    }
}
