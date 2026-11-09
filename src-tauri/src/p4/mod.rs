mod clean;
mod cli;
pub use clean::{apply_clean, preview_clean, P4CleanPreview, P4CleanRequest};
mod client;
pub use client::{save_workspace, workspace_settings, P4WorkspaceEdit, P4WorkspaceSettings};
mod external;
mod history;
mod images;
pub use external::external_file_pair;
mod integration;
pub use history::{annotate, compare_files, P4BlameLine, P4CompareRequest, P4Comparison};
pub use images::{image_pair, P4FileSource};
pub use integration::{
    apply_integration, preview_integration, P4IntegrationPreview, P4IntegrationRequest,
};
mod operations;
mod parse;
mod review;
mod shelves;
mod specs;
pub use specs::{
    apply_label_tag, delete_spec, label_files, list_specs, preview_label_tag, read_spec, save_spec,
    P4LabelFiles, P4LabelTagPreview, P4LabelTagRequest, P4Spec, P4SpecEdit, P4SpecKind, P4SpecPage,
};
mod stream_work;
pub use stream_work::{
    apply_stream_work, preview_stream_work, stream_change_diff, stream_work, P4StreamDiffRequest,
    P4StreamWork, P4StreamWorkPreview, P4StreamWorkRequest,
};
mod stream_specs;
mod streams;
pub use stream_specs::{
    delete_stream_spec, new_stream_spec, read_stream_spec, save_stream_spec, P4StreamSetup,
    P4StreamSpec, P4StreamSpecEdit,
};
mod switch;
pub use review::{apply_reconcile, preview_reconcile, P4ReconcilePreview};
pub use shelves::{list_shelves, preview_unshelve, restore_shelf, shelf_detail, P4UnshelveRequest};
pub use streams::{apply_stream, preview_stream, P4StreamPreview, P4StreamRequest};
pub use switch::{apply_switch, preview_switch, P4SwitchOutcome, P4SwitchPreview, P4SwitchRequest};
mod workspace;

pub use cli::{active_p4, check_p4_executable, p4_on_path, prepare_p4_prefs, set_p4_executable};
pub use operations::{
    apply_integrate, apply_undo, preview_integrate, preview_undo, P4IntegrateRequest,
    P4OperationPreview, P4UndoRequest,
};
pub use parse::normalize_charset;
pub use workspace::{
    cancel_depot_search, check_connection, create_workspace, delete_change, delete_shelf, describe,
    detect_repository, file_action, filelog, get_revision, list_depot, list_depot_dirs, list_dir,
    list_streams, list_user_clients, list_users, listing_status, locate, login,
    manual_resolve_apply, manual_resolve_external, manual_resolve_view, move_file, new_change,
    open_workspace, opened_diff, prepare_client, refresh_pending, reopen, resolve_accept,
    resolve_view, revert, revert_unchanged, revision_diff, revision_targets, save_change,
    search_depot, search_files, search_submitted, shelf_diff, shelve, submit, submitted, sync,
    unshelve, P4Auth, P4ChangePage, P4Changelist, P4CheckedConnection, P4Connection,
    P4CreateRequest, P4DepotEntry, P4Describe, P4DirEntry, P4EntryStatus, P4FileSearch,
    P4GetRevision, P4HistoryCursor, P4Location, P4ManualResolve, P4Open, P4ResolveView,
    P4RevisionPage, P4StreamOption, RepoDetection,
};
