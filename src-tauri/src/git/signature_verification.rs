use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum GitSignatureTarget {
    Commit(String),
    Tag(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitSignatureStatus {
    Verified,
    Untrusted,
    ExpiredSignature,
    ExpiredKey,
    Revoked,
    Invalid,
    Failed,
    Unsigned,
    Lightweight,
    Changed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSignatureVerification {
    pub oid: String,
    pub status: GitSignatureStatus,
    pub output: String,
    pub truncated: bool,
}

/// Verifies the immutable object, never a peeled tag or a replacement commit.
pub fn verify_signature(
    repo: &Repository,
    target: &GitSignatureTarget,
) -> AppResult<GitSignatureVerification> {
    let root = workdir(repo)?;
    let reference = match target {
        GitSignatureTarget::Commit(oid) => {
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(AppError::msg("Choose one commit from history."));
            }
            oid.clone()
        }
        GitSignatureTarget::Tag(name) => {
            let reference = format!("refs/tags/{name}");
            run_git_stdout(root, &["check-ref-format", &reference])?;
            reference
        }
    };
    let oid = signature_object_id(root, &reference)?;
    let kind = signature_git_stdout(root, &["cat-file", "-t", &oid])?;
    let kind = String::from_utf8_lossy(&kind);
    let kind = kind.trim();
    if matches!(target, GitSignatureTarget::Commit(_)) && kind != "commit" {
        return Err(AppError::msg("The selected object is not a commit."));
    }
    let mut verification = GitSignatureVerification {
        oid,
        status: GitSignatureStatus::Unsigned,
        output: String::new(),
        truncated: false,
    };
    if matches!(target, GitSignatureTarget::Tag(_)) && kind != "tag" {
        verification.status = GitSignatureStatus::Lightweight;
    } else {
        let size = signature_git_stdout(root, &["cat-file", "-s", &verification.oid])?;
        let size = String::from_utf8_lossy(&size)
            .trim()
            .parse::<u64>()
            .map_err(|_| AppError::msg("Git returned an invalid object size."))?;
        if size > MAX_TEXT_BYTES {
            return Err(AppError::msg(
                "The selected object is too large to verify here.",
            ));
        }
        let raw = signature_git_stdout(root, &["cat-file", kind, &verification.oid])?;
        if let Some(signature) = object_signature(kind, &raw) {
            let verb = if kind == "tag" {
                "verify-tag"
            } else {
                "verify-commit"
            };
            let oid = verification.oid.clone();
            let result = run_git_ok_progress(
                root,
                &["--no-replace-objects", verb, "--raw", &oid],
                |line| append_verification_output(&mut verification, line),
            );
            if let Err(error) = &result {
                if error.is_cancelled() {
                    return Err(AppError::cancelled());
                }
                if verification.output.is_empty() {
                    append_verification_output(&mut verification, &error.to_string());
                }
            }
            verification.status = signature_status(result.is_ok(), signature, &verification.output);
        }
    }
    if matches!(target, GitSignatureTarget::Tag(_)) {
        // A tag can be replaced or deleted by another process during verification.
        if signature_object_id(root, &reference).ok().as_deref() != Some(&verification.oid) {
            verification.status = GitSignatureStatus::Changed;
        }
    }
    Ok(verification)
}

fn signature_git_stdout(root: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    let mut command = vec!["--no-replace-objects"];
    command.extend_from_slice(args);
    run_git_stdout(root, &command)
}

fn signature_object_id(root: &Path, reference: &str) -> AppResult<String> {
    let output = signature_git_stdout(
        root,
        &["rev-parse", "--verify", "--end-of-options", reference],
    )?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

fn object_signature<'a>(kind: &str, raw: &'a [u8]) -> Option<&'a [u8]> {
    if kind == "commit" {
        raw.split(|byte| *byte == b'\n')
            .take_while(|line| !line.is_empty())
            .find_map(|line| {
                line.strip_prefix(b"gpgsig ")
                    .or_else(|| line.strip_prefix(b"gpgsig-sha256 "))
            })
    } else {
        raw.split(|byte| *byte == b'\n').find(|line| {
            [
                b"-----BEGIN PGP SIGNATURE-----".as_slice(),
                b"-----BEGIN PGP MESSAGE-----",
                b"-----BEGIN SIGNED MESSAGE-----",
                b"-----BEGIN SSH SIGNATURE-----",
            ]
            .iter()
            .any(|marker| line.starts_with(marker))
        })
    }
}

fn append_verification_output(verification: &mut GitSignatureVerification, line: &str) {
    const LIMIT: usize = 64 * 1024;
    let remaining = LIMIT.saturating_sub(verification.output.len());
    if line.len() + 1 > remaining {
        verification.truncated = true;
        return;
    }
    verification.output.push_str(line);
    verification.output.push('\n');
}

fn signature_status(success: bool, signature: &[u8], output: &str) -> GitSignatureStatus {
    use GitSignatureStatus::*;
    // SSH verification uses Git's configured allowed signers and revocation list.
    if signature.starts_with(b"-----BEGIN SSH SIGNATURE-----") {
        return if success { Verified } else { Failed };
    }
    let statuses: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix("[GNUPG:] "))
        .filter_map(|line| line.split_ascii_whitespace().next())
        .collect();
    let has = |value| statuses.contains(&value);
    let signatures = statuses
        .iter()
        .filter(|status| {
            matches!(
                **status,
                "GOODSIG" | "BADSIG" | "ERRSIG" | "EXPSIG" | "EXPKEYSIG" | "REVKEYSIG"
            )
        })
        .count();
    if signatures != 1 {
        return Failed;
    }
    if has("BADSIG") {
        return Invalid;
    }
    if has("REVKEYSIG") {
        return Revoked;
    }
    if has("EXPKEYSIG") {
        return ExpiredKey;
    }
    if has("EXPSIG") {
        return ExpiredSignature;
    }
    if !success || !has("GOODSIG") || !has("VALIDSIG") {
        return Failed;
    }
    if has("TRUST_FULLY") || has("TRUST_ULTIMATE") {
        Verified
    } else {
        Untrusted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_respects_native_status_trust_and_failure() {
        let pgp = b"-----BEGIN PGP SIGNATURE-----";
        let good = "[GNUPG:] GOODSIG key Example\n[GNUPG:] VALIDSIG fingerprint\n";
        assert_eq!(
            signature_status(true, pgp, &format!("{good}[GNUPG:] TRUST_FULLY 0 pgp\n")),
            GitSignatureStatus::Verified
        );
        assert_eq!(
            signature_status(true, pgp, &format!("{good}[GNUPG:] TRUST_ULTIMATE\n")),
            GitSignatureStatus::Verified
        );
        for trust in [
            "",
            "[GNUPG:] TRUST_UNDEFINED\n",
            "[GNUPG:] TRUST_MARGINAL 0 pgp\n",
            "[GNUPG:] TRUST_NEVER\n",
        ] {
            assert_eq!(
                signature_status(true, pgp, &format!("{good}{trust}")),
                GitSignatureStatus::Untrusted
            );
        }
        for (status, expected) in [
            ("BADSIG", GitSignatureStatus::Invalid),
            ("REVKEYSIG", GitSignatureStatus::Revoked),
            ("EXPKEYSIG", GitSignatureStatus::ExpiredKey),
            ("EXPSIG", GitSignatureStatus::ExpiredSignature),
            ("ERRSIG", GitSignatureStatus::Failed),
        ] {
            assert_eq!(
                signature_status(false, pgp, &format!("[GNUPG:] {status} key Example\n")),
                expected
            );
        }
        for output in [
            good.to_string(),
            format!("{good}[GNUPG:] GOODSIG second Example\n"),
            "GOODSIG spoofed\nTRUST_FULLY\n".into(),
            "".into(),
        ] {
            assert_eq!(
                signature_status(false, pgp, &output),
                GitSignatureStatus::Failed
            );
        }
        assert_eq!(
            signature_status(
                true,
                pgp,
                "[GNUPG:] GOODSIG key Example\n[GNUPG:] TRUST_FULLY\n"
            ),
            GitSignatureStatus::Failed
        );
        assert_eq!(
            signature_status(true, b"-----BEGIN SSH SIGNATURE-----", ""),
            GitSignatureStatus::Verified
        );
        assert_eq!(
            signature_status(
                false,
                b"-----BEGIN SSH SIGNATURE-----",
                "Good signature without principal"
            ),
            GitSignatureStatus::Failed
        );
    }
}
