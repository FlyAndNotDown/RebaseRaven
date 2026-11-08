import { gitApi } from "@/lib/git";
import type { GitSignatureTarget, GitSignatureVerification } from "@/types/git";

export function startSignatureVerification(
  path: string,
  target: GitSignatureTarget,
  onResult: (result: GitSignatureVerification) => void,
  onError: (error: unknown) => void,
) {
  const id = crypto.randomUUID();
  let pending = true;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelNative = async () => {
    if (!pending) return;
    try {
      const acknowledged = await gitApi.cancelActivity(id);
      // Closing can precede registration on the native worker. Keep the same id.
      if (!acknowledged && pending) timer = setTimeout(() => void cancelNative(), 100);
    } catch { /* A closed native connection has no request left to cancel. */ }
  };
  void gitApi.verifySignature(path, target, id)
    .then(result => { if (!cancelled) onResult(result); })
    .catch((error: unknown) => { if (!cancelled) onError(error); })
    .finally(() => { pending = false; clearTimeout(timer); });
  return () => {
    if (cancelled) return;
    cancelled = true;
    void cancelNative();
  };
}
