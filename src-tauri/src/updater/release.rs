use reqwest::{header::ACCEPT, Client};
use serde::Deserialize;
use serde_json::Value;
use tauri_plugin_updater::{Update, Updater};

use super::{operation_error, HttpPolicy};

const RELEASES_API: &str = "https://api.github.com/repos/FlyAndNotDown/RebaseRaven/releases";
const DOWNLOADS: &str = "https://github.com/FlyAndNotDown/RebaseRaven/releases/download";
const MAX_METADATA_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
    browser_download_url: String,
    state: String,
    size: u64,
}

fn stable_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 10
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

impl Release {
    fn validate(&self, version: Option<&str>) -> Result<(), String> {
        let tag_version = self.tag_name.strip_prefix('v').unwrap_or("");
        if self.draft
            || self.prerelease
            || !stable_version(tag_version)
            || version.is_some_and(|version| version != tag_version)
        {
            return Err("The public release does not match the requested update.".to_string());
        }
        Ok(())
    }

    fn asset_url(&self, name: &str) -> Result<String, String> {
        let expected = format!("{DOWNLOADS}/{}/{name}", self.tag_name);
        let mut matches = self.assets.iter().filter(|asset| asset.name == name);
        let asset = matches
            .next()
            .filter(|asset| {
                asset.id > 0
                    && asset.size > 0
                    && asset.state == "uploaded"
                    && asset.browser_download_url == expected
            })
            .ok_or("The public release is missing a complete update package.")?;
        if matches.next().is_some() {
            return Err("The public release contains duplicate update packages.".to_string());
        }
        Ok(format!("{RELEASES_API}/assets/{}", asset.id))
    }
}

fn client(policy: &HttpPolicy) -> Result<Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    policy
        .apply(Client::builder())
        .user_agent(concat!("RebaseRaven/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|error| operation_error("Could not initialize the update connection.", &error))
}

async fn read_json(client: &Client, url: &str, accept: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .header(ACCEPT, accept)
        .send()
        .await
        .map_err(|error| operation_error("Could not contact the update service.", &error))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Err("No public update release is available at this address. Check the GitHub release and retry.".to_string());
    }
    if matches!(status.as_u16(), 403 | 429) {
        return Err(
            "GitHub is limiting update requests. Wait a few minutes and try again.".to_string(),
        );
    }
    let mut response = response
        .error_for_status()
        .map_err(|error| operation_error("The update service returned an error.", &error))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| operation_error("Could not read the update information.", &error))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_METADATA_BYTES {
            return Err("The update information exceeds the size limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The update service returned invalid release information.".to_string())
}

async fn release(client: &Client, suffix: &str) -> Result<Release, String> {
    serde_json::from_value(
        read_json(
            client,
            &format!("{RELEASES_API}/{suffix}"),
            "application/vnd.github+json",
        )
        .await?,
    )
    .map_err(|_| "The update service returned invalid release information.".to_string())
}

// GitHub's release download route can fail while its public asset API remains available.
// Restoring through the plugin keeps target selection, version comparison and signature checks.
pub(super) async fn check(
    updater: &Updater,
    policy: &HttpPolicy,
) -> Result<Option<Update>, String> {
    let client = client(policy)?;
    let release = release(&client, "latest").await?;
    release.validate(None)?;
    let manifest = read_json(
        &client,
        &release.asset_url("latest.json")?,
        "application/octet-stream",
    )
    .await?;
    if manifest.get("version").and_then(Value::as_str) != release.tag_name.strip_prefix('v') {
        return Err("The update manifest does not match its public release.".to_string());
    }
    updater
        .restore_update(manifest)
        .map_err(|error| super::check_error(&error))
}

pub(super) async fn download_url(update: &Update, policy: &HttpPolicy) -> Result<url::Url, String> {
    if !stable_version(&update.version) || !super::release_download_url(&update.download_url) {
        return Err("The selected update has an invalid release address.".to_string());
    }
    let client = client(policy)?;
    // Pin the fallback to the already reviewed version, even if a newer release appeared.
    let release = release(&client, &format!("tags/v{}", update.version)).await?;
    release.validate(Some(&update.version))?;
    let name = update
        .download_url
        .path_segments()
        .and_then(Iterator::last)
        .ok_or("The selected update has an invalid package address.")?;
    if update.download_url.as_str() != format!("{DOWNLOADS}/{}/{name}", release.tag_name) {
        return Err("The selected package does not match the reviewed release.".to_string());
    }
    url::Url::parse(&release.asset_url(name)?)
        .map_err(|_| "The selected update has an invalid package address.".to_string())
}

pub(super) fn retryable(error: &tauri_plugin_updater::Error) -> bool {
    matches!(
        error,
        tauri_plugin_updater::Error::ReleaseNotFound
            | tauri_plugin_updater::Error::Reqwest(_)
            | tauri_plugin_updater::Error::Network(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Release {
        serde_json::from_value(serde_json::json!({
            "tag_name":"v0.2.0", "draft":false, "prerelease":false,
            "assets":[{"id":42,"name":"latest.json","size":512,"state":"uploaded",
                "browser_download_url":format!("{DOWNLOADS}/v0.2.0/latest.json")}]
        }))
        .unwrap()
    }

    #[test]
    fn api_assets_must_belong_to_the_complete_reviewed_public_release() {
        let mut release = fixture();
        assert!(release.validate(Some("0.2.0")).is_ok());
        assert_eq!(
            release.asset_url("latest.json").unwrap(),
            format!("{RELEASES_API}/assets/42")
        );
        assert!(release.validate(Some("0.1.0")).is_err());
        release.draft = true;
        assert!(release.validate(None).is_err());
        release.draft = false;
        release.prerelease = true;
        assert!(release.validate(None).is_err());
        for version in ["", "0.2", "0.2.0/other", "0.2.0-rc.1", "00.2.0"] {
            assert!(!stable_version(version));
        }
        let mut release = fixture();
        release.assets[0].browser_download_url = "https://example.com/latest.json".to_string();
        assert!(release.asset_url("latest.json").is_err());
        let mut release = fixture();
        release.assets[0].size = 0;
        assert!(release.asset_url("latest.json").is_err());
        let mut release = fixture();
        release.assets.push(fixture().assets.remove(0));
        assert!(release.asset_url("latest.json").is_err());
    }

    #[test]
    fn signature_failures_never_retry_a_different_download_route() {
        use tauri_plugin_updater::Error;
        assert!(retryable(&Error::ReleaseNotFound));
        assert!(retryable(&Error::Network("HTTP 504".to_string())));
        assert!(!retryable(&Error::MissingSignedVersion));
        assert!(!retryable(&Error::SignedVersionMismatch {
            signed: "0.1.0".to_string(),
            announced: "0.2.0".to_string()
        }));
        assert!(!retryable(&Error::TargetNotFound("fixture".to_string())));
    }

    #[test]
    fn metadata_reads_are_bounded() {
        use crate::network::tests::HttpFixture;
        tauri::async_runtime::block_on(async {
            let fixture = HttpFixture::new(&"x".repeat(MAX_METADATA_BYTES + 1));
            let client = client(&HttpPolicy::Direct).unwrap();
            assert!(read_json(&client, &fixture.url, "application/json")
                .await
                .unwrap_err()
                .contains("size limit"));
        });
    }

    #[test]
    fn server_failures_are_distinguished_from_missing_releases_and_rate_limits() {
        use crate::network::tests::HttpFixture;
        tauri::async_runtime::block_on(async {
            let client = client(&HttpPolicy::Direct).unwrap();
            for (status, expected) in [
                ("504 Gateway Timeout", "504"),
                ("404 Not Found", "No public update release"),
                ("429 Too Many Requests", "limiting update requests"),
            ] {
                let fixture = HttpFixture::with_status("unavailable", status);
                let error = read_json(&client, &fixture.url, "application/json")
                    .await
                    .unwrap_err();
                assert!(error.contains(expected), "{error}");
                if status.starts_with("504") {
                    assert!(!error.contains("No public update release"));
                }
            }
        });
    }

    #[test]
    fn restored_asset_downloads_still_require_valid_bytes_and_the_signed_version() {
        use crate::network::tests::HttpFixture;
        use base64::Engine;
        use tauri_plugin_updater::UpdaterExt;

        // Public throwaway vectors from the updater plugin's offline tests; the payload is `test`.
        let encode = |value: &str| base64::engine::general_purpose::STANDARD.encode(value);
        let public_key = encode("untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe");
        let signature = encode("untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==");
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = "1.0.0".parse().unwrap();
        context.config_mut().plugins.0.insert("updater".to_string(), serde_json::json!({
                "pubkey": public_key, "requireSignedVersion": true, "dangerousInsecureTransportProtocol": true,
                "endpoints": ["https://example.test/update"],
        }));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .target("fixture")
            .no_proxy()
            .build()
            .unwrap();
        let mut manifest = serde_json::json!({"version":"2.0.0", "platforms":{"fixture":{
            "url":format!("{DOWNLOADS}/v2.0.0/package"), "signature":signature,
        }}});
        let mut update = updater.restore_update(manifest.clone()).unwrap().unwrap();
        assert!(update.verify(b"corrupt").is_err());
        tauri::async_runtime::block_on(async {
            let fixture = HttpFixture::new("test");
            update.download_url = fixture.url.parse().unwrap();
            assert_eq!(update.download(|_, _| {}, || {}).await.unwrap(), b"test");
        });
        manifest["version"] = "3.0.0".into();
        let other_version = updater.restore_update(manifest).unwrap().unwrap();
        assert!(matches!(
            other_version.verify(b"test"),
            Err(tauri_plugin_updater::Error::SignedVersionMismatch { .. })
        ));
    }
}
