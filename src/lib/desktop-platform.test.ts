import { expect, it } from "vitest";
import { desktopPlatform } from "./desktop-platform";

it.each([
  ["Win32", "windows"], ["Win64", "windows"],
  ["MacIntel", "macos"], ["Darwin", "macos"],
  ["Linux x86_64", "linux"], ["Linux aarch64", "linux"],
  ["", "other"], ["Unknown", "other"],
])("classifies %s without inventing a Linux platform", (platform, expected) => {
  expect(desktopPlatform(platform)).toBe(expected);
});
