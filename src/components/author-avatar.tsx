import { useEffect, useState } from "react";
import { avatarColor, avatarInitial, avatarSeed, resolveGitAvatarProvider } from "@/lib/avatar";
import { authorAvatars } from "@/lib/avatars";
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
  const seed = avatarSeed(name, email);
  const initial = avatarInitial(seed);
  // Full-width glyphs sit slightly higher than Latin caps under the same baseline.
  const wide = (initial.codePointAt(0) ?? 0) >= 0x1100;
  if (image) {
    return <img src={image} alt="" aria-hidden className={cn("size-[18px] shrink-0 rounded-full object-cover", className)} onError={() => setRemote({ key, data: null })} />;
  }
  return (
    <svg
      aria-hidden
      viewBox="0 0 18 18"
      className={cn("size-[18px] shrink-0", className)}
    >
      <circle
        cx="9"
        cy="9"
        r="8.7"
        fill={avatarColor(seed)}
        stroke="rgb(255 255 255 / 0.16)"
        strokeWidth="0.6"
      />
      <text
        x="9"
        y={wide ? 9.35 : 9.1}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize="11"
        fontWeight="500"
        fontFamily="Geist Variable, ui-sans-serif, sans-serif"
      >
        {initial}
      </text>
    </svg>
  );
}
