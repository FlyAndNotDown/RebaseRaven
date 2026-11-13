export type DesktopPlatform = "macos" | "windows" | "linux" | "other";

export function desktopPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
): DesktopPlatform {
  if (/mac|darwin/i.test(platform)) return "macos";
  if (/win/i.test(platform)) return "windows";
  if (/linux/i.test(platform)) return "linux";
  return "other";
}
