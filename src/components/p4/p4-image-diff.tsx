import { useEffect, useState, useSyncExternalStore } from "react";
import { ImageComparison } from "@/components/image-diff";
import { createImageLoader, imageLoadKey } from "@/lib/image-load";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { p4Api } from "@/lib/p4";
import { useP4 } from "@/state/p4-context";
import type { P4Connection, P4ImageSource } from "@/types/p4";
import type { FileDiff } from "@/types/git";

export function P4ImageDiff({ source, refreshIdentity, captions }: { source: P4ImageSource; refreshIdentity: FileDiff; captions?: [string, string] }) {
  const { connection } = useP4();
  const scope = JSON.stringify(connection);
  const sourceKey = JSON.stringify(source);
  const key = imageLoadKey(scope, source);
  const [attempt, setAttempt] = useState(0);
  const [loader] = useState(() => createImageLoader<P4ImageSource>((scope, source) => p4Api.imagePair(JSON.parse(scope) as P4Connection, source), (error) => p4DisplayError(errorMessage(error))));
  const loaded = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  useEffect(() => {
    if (scope === "null") return;
    return loader.start(scope, JSON.parse(sourceKey) as P4ImageSource, refreshIdentity, attempt);
  }, [scope, sourceKey, loader, refreshIdentity, attempt]);
  const current = loaded.key === key && loaded.identity === refreshIdentity && loaded.attempt === attempt;
  return <ImageComparison identity={key} pair={loaded.key === key ? loaded.pair : null} busy={!current || loaded.busy} error={current ? loaded.error : null} onReload={() => setAttempt((value) => value + 1)} disabled={!connection} captions={captions} />;
}
