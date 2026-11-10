import { useEffect, useState } from "react";
import { resolveGitAvatarProvider } from "@/lib/avatar";
import { authorAvatars } from "@/lib/avatars";
import { BuiltinAvatar } from "@/components/builtin-avatar";
import { cn } from "@/lib/utils";
import { useGitSelect } from "@/state/git-context";

export function AuthorAvatar({
  name,
  email,
  className,
  vcs = "git",
}: {
  name: string;
  email: string;
  className?: string;
  vcs?: "git" | "perforce";
}) {
  const prefs = useGitSelect((state) => state.prefs);
  const snapshot = useGitSelect((state) => state.snapshot);
  const provider = vcs === "perforce" ? prefs.p4AvatarProvider : resolveGitAvatarProvider(prefs.gitAvatarProvider, snapshot?.remotes ?? []);
  const repoPath = snapshot?.repo.path;
  const policy = JSON.stringify([prefs.gitAvatarProvider, prefs.httpProxy]);
  const key = `${policy}:${provider}:${email}`;
  const [remote, setRemote] = useState<{ key: string; data: string | null } | null>(null);
  useEffect(() => {
    if (vcs === "perforce") return;
    authorAvatars.configure(policy);
    if (provider === "builtin" || !repoPath) return;
    let current = true;
    void authorAvatars.get(provider, email, repoPath).then((data) => {
      if (current) setRemote({ key, data });
    });
    return () => { current = false; };
  }, [email, key, policy, provider, repoPath, vcs]);
  const image = remote?.key === key && provider !== "builtin" ? remote.data : null;
  if (image) {
    return <img src={image} alt="" aria-hidden className={cn("size-[18px] shrink-0 rounded-full object-cover", className)} onError={() => setRemote({ key, data: null })} />;
  }
  return <BuiltinAvatar name={name} email={email} className={className} />;
}
