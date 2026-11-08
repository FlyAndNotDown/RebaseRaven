use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitSigningMode {
    #[default]
    Default,
    Sign,
    Unsigned,
}

impl GitSigningMode {
    pub(super) fn commit_flag(self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::Sign => Some("--gpg-sign"),
            Self::Unsigned => Some("--no-gpg-sign"),
        }
    }

    pub(super) fn tag_flag(self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::Sign => Some("--sign"),
            Self::Unsigned => Some("--no-sign"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CommitOptions {
    pub signing: GitSigningMode,
    pub signoff: bool,
}
