import type { ReactNode } from "react";

export function IconBadge({ children }: { children: ReactNode }) {
  return <span className="absolute -right-1 -bottom-1 rounded-full bg-background leading-none">{children}</span>;
}
