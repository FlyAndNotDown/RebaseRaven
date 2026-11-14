# Agent guide

Read `AGENTS.local.md` at the repository root, if present, before starting work.
It contains developer-specific instructions and supplements this guide. Keep
that file local; do not commit its contents or require it to build the project.

## Project and contribution workflow

- Read `CONTRIBUTING.md` and `docs/development.md` before making changes.
- Base contributions on `dev` and keep each change focused. Preserve existing
  uncommitted work and avoid destructive Git operations.
- Use English Conventional Commits. Keep code, comments, fixtures, and shared
  development documentation in English; put translations in the locale resources
  or localized documentation.
- Keep credentials, personal paths, private hosts, machine configuration, and
  generated artifacts out of tracked files. Use invented, portable test data.
- Do not change dependency versions, generated assets, or unrelated behavior
  without a reason tied to the task.

## Implementation conventions

- React and TypeScript own the interface; Rust owns filesystem, process, and
  native access. Keep frontend command types aligned with the Rust commands.
- Preserve the behavior of the installed Git and Perforce command-line tools.
  Keep cancellation, asynchronous ownership, and loading bounded for large
  repositories.
- Reuse shared shadcn/ui controls, theme tokens, and interaction patterns.
  Prefer short labels, icons, and tooltips, and preserve accessible interactions.
- Use kebab-case for frontend files and snake_case for Rust modules. Keep tests
  beside the behavior they cover and avoid tests that merely repeat an
  implementation.
- Keep application translations in `src/i18n/locales/` and website translations
  in `site/src/locales/`, with English fallback.

## Validation

- Follow the checks in `docs/development.md` for the affected code. Changes across
  the frontend/native command boundary need both frontend and Rust validation.
- Build the `rebaseraven` binary before Rust tests that exercise SSH askpass.
- Check documentation links and generated assets when changing them. Report
  what was checked and any platform or behavior that remains unverified.
- Keep `AGENTS.local.md` and temporary output untracked. The shared repository
  must remain usable without a developer's private setup or service accounts.
