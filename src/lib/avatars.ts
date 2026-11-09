import { invoke } from "@tauri-apps/api/core";
import { createAvatarLoader } from "@/lib/avatar";

export const authorAvatars = createAvatarLoader((provider, email, repoPath) =>
  invoke<string | null>("get_author_avatar", { email, provider, repoPath }),
);
