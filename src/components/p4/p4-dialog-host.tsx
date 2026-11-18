import { P4ConnectionDialog } from "@/components/p4/p4-connection-dialog";
import { P4StreamDialog } from "@/components/p4/p4-stream-dialog";
import { P4WorkspaceScanDialog } from "@/components/p4/p4-workspace-scan-dialog";
import { P4LoginDialog } from "@/components/p4/p4-login-dialog";
import { P4SwitchDialog, P4SwitchUpdateDialog } from "@/components/p4/p4-switch-dialog";
import { P4IntegrationDialog } from "@/components/p4/p4-integration-dialog";
import { P4WorkspaceDialog } from "@/components/p4/p4-workspace-dialog";
import { useContext } from "react";
import { P4DialogContext } from "@/state/p4-dialogs";
import { useP4Pick } from "@/state/p4-context";

export function P4DialogHost() {
  const dialogs = useContext(P4DialogContext);
  const {connection, workspaceOpen} = useP4Pick(["connection", "workspaceOpen"]);
  if (!dialogs) return null;
  const {integration, stream, scan, switchStream, update, login} = dialogs;
  return <>
    <P4ConnectionDialog />
    {workspaceOpen && connection && <P4WorkspaceDialog key={JSON.stringify(connection)} />}
    {integration && <P4IntegrationDialog key={JSON.stringify([connection,integration.initial])} initial={integration.initial} onClose={integration.close} />}
    {stream && <P4StreamDialog key={JSON.stringify([connection,stream.initial])} initial={stream.initial} onClose={stream.close} />}
    {scan && <P4WorkspaceScanDialog key={scan.key} operation={scan.operation} scope={scan.scope} onClose={scan.close} />}
    {switchStream && <P4SwitchDialog key={JSON.stringify([connection,switchStream.target])} initialTarget={switchStream.target} onClose={switchStream.close} />}
    {update && <P4SwitchUpdateDialog stream={update.stream} disabled={update.disabled} onClose={update.close} onUpdate={update.apply} />}
    <P4LoginDialog open={login.open} client={login.client} port={login.port} onCancel={() => login.finish(null)} onSubmit={login.finish} />
  </>;
}
