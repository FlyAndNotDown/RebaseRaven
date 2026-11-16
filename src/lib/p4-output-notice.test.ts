import { beforeEach, describe, expect, it } from "vitest";
import { setLanguagePreference } from "@/i18n";
import { p4ErrorNotice, p4SyncNotice } from "./p4-output-notice";

beforeEach(() => setLanguagePreference("en"));

describe("Perforce output notices", () => {
  it("summarizes skipped writable files without presenting attempted transfers as successes", () => {
    const output = Array.from({ length: 14 }, (_, index) => [
      `Can't clobber writable file C:\\work\\resource-${index}.json`,
      `//depot/resource-${index}.json#2 - updating C:\\work\\resource-${index}.json`,
    ].join("\r\n")).join("\r\n");
    expect(p4ErrorNotice(output)).toEqual({ kind: "warning", message: "Skipped 14 writable files" });
  });

  it("counts a repeated Windows file once while preserving distinct case-sensitive depot paths", () => {
    const output = [
      "Can't clobber writable file C:\\work\\file with spaces.json",
      "Can't clobber writable file c:/WORK/file with spaces.json",
      "//depot/A.txt#1 - must resolve #2 before submitting",
      "//depot/a.txt#1 - must resolve #2 before submitting",
      "//depot/a.txt#2 - must resolve #3 before submitting",
    ].join("\n");
    expect(p4ErrorNotice(output)).toEqual({ kind: "warning", message: "Skipped 1 writable file · 2 files need resolve" });
  });

  it("groups other actionable file states by reason", () => {
    const output = [
      "Can't overwrite modified file C:\\work\\a.txt",
      "//depot/b.txt#2 - can't update open file C:\\work\\b.txt",
      "//depot/c.txt#3 - is opened for edit and can't be deleted",
      "//other/... - file(s) not in client view.",
    ].join("\n");
    expect(p4ErrorNotice(output)).toEqual({
      kind: "warning",
      message: "Skipped 1 locally modified file · Skipped 2 opened files · Skipped 1 path outside view",
    });
  });

  it("keeps real failures as errors when they accompany skipped files", () => {
    const output = [
      "Can't clobber writable file C:\\work\\a.txt",
      "//depot/a.txt#2 - updating C:\\work\\a.txt",
      "TCP receive failed.",
      "Connection reset by peer.",
    ].join("\n");
    expect(p4ErrorNotice(output)).toEqual({ kind: "error", message: "TCP receive failed. · 1 more message · Skipped 1 writable file" });
  });

  it("preserves the cause of a native error after its generic heading", () => {
    expect(p4ErrorNotice("Perforce client error:\nConnect to server failed.\nConnection refused.")).toEqual({
      kind: "error", message: "Connect to server failed. · 2 more messages",
    });
  });

  it.each([
    "//depot/... - file(s) up-to-date.",
    "No file(s) to resolve.",
    "//depot/... - no file(s) to reconcile.",
    "No file(s) to revert.",
  ])("presents an unchanged state as information: %s", output => {
    expect(p4ErrorNotice(output)).toEqual({ kind: "info", message: "No changes needed" });
  });

  it("keeps unexpected diagnostics short even after a large sync", () => {
    const output = "//depot/a.txt#2 - replacing C:\\work\\a.txt\n".repeat(50_000)
      + "Transfer failed: " + "details ".repeat(1000) + "\n"
      + "Additional diagnostic\n".repeat(1000);
    const notice = p4ErrorNotice(output);
    expect(notice.kind).toBe("error");
    expect(notice.message).toMatch(/^Transfer failed:/);
    expect(notice.message).toContain("1000 more messages");
    expect(notice.message.length).toBeLessThan(220);
    expect(notice.message).not.toContain("//depot/");
  });

  it("localizes skipped file summaries and existing application errors", () => {
    setLanguagePreference("zh-CN");
    const notice = p4ErrorNotice("Can't clobber writable file C:\\work\\a.txt");
    expect(notice.kind).toBe("warning");
    expect(notice.message).toContain("1");
    expect(notice.message).not.toMatch(/Skipped|writable|p4\.|C:\\/);
    expect(p4ErrorNotice("Choose a file.").message).not.toBe("Choose a file.");
  });

  it("summarizes revision updates and warnings returned on stdout", () => {
    expect(p4SyncNotice("//depot/a.txt#2 - updating C:\\work\\a.txt")).toEqual({ kind: "success", message: "Updated 1 file." });
    expect(p4SyncNotice("//depot/a.txt#2 - must resolve #3 before submitting")).toEqual({ kind: "warning", message: "1 file needs resolve" });
    expect(p4SyncNotice("file(s) up-to-date.")).toEqual({ kind: "success", message: "Up to date" });
    expect(p4SyncNotice("warning: A transfer needs attention.")).toEqual({ kind: "warning", message: "A transfer needs attention." });
  });

  it("uses the final auto-resolve state while retaining other skipped-file warnings", () => {
    const output = "//depot/a.txt#2 - must resolve #3 before submitting";
    const resolved = { resolved: 1, remaining: 0, failed: false };
    expect(p4SyncNotice(output, resolved)).toEqual({ kind: "success", message: "Auto-resolved 1 files · 0 still need resolve" });
    expect(p4SyncNotice(`${output}\nCan't clobber writable file C:\\work\\b.txt`, resolved)).toEqual({
      kind: "warning", message: "Skipped 1 writable file · Auto-resolved 1 files · 0 still need resolve",
    });
    expect(p4SyncNotice(output, { resolved: 0, remaining: 1, failed: false }).kind).toBe("warning");
    expect(p4SyncNotice(output, { resolved: 0, remaining: 0, failed: true }).kind).toBe("warning");
  });

  it("does not silently downgrade an unrecognized failure", () => {
    expect(p4ErrorNotice("//depot/a.txt - no such file(s).")).toEqual({ kind: "error", message: "no such file(s)." });
    expect(p4ErrorNotice("").kind).toBe("error");
  });
});
