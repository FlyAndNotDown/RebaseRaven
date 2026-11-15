# Agent guide

## Before starting

- Read `AGENTS.local.md` at the repository root, if present. It contains
  developer-specific instructions and supplements this guide. Keep that file
  local; do not commit its contents or require it to build the project.
- Read `CONTRIBUTING.md` and `docs/development.md` before making changes.

## Project and contribution workflow

- Base contributions on `dev` and keep each change focused. Preserve existing
  uncommitted work and avoid destructive Git operations.
- Use English Conventional Commits.
- Do not change dependency versions, generated assets, or unrelated behavior
  without a reason tied to the task.

## Security and privacy

- Never commit or upload secrets, including API keys, private keys, and
  credentials, or private development-machine information to the repository.
  This includes personal paths, local environment names, computer account names,
  hostnames, IP addresses, and machine configuration.
- Apply these restrictions to code, fixtures, documentation, logs, screenshots,
  and commit messages. Use invented, portable test data and placeholders instead
  of real local values.
- Keep `AGENTS.local.md`, temporary output, and generated artifacts untracked.
  The shared repository must remain usable without a developer's private setup
  or service accounts.

## Architecture and code quality

- Prioritize clear, maintainable architecture over merely getting a feature to
  work. Never sacrifice code quality for speed or ship careless shortcuts.
- Refactor as needed throughout development to improve structure, remove
  duplication, and keep responsibilities clear. Keep refactoring focused and
  preserve behavior outside the intended change.
- React and TypeScript own the interface; Rust owns filesystem, process, and
  native access. Keep frontend command types aligned with the Rust commands.
- Preserve the behavior of the installed Git and Perforce command-line tools.
  Keep cancellation, asynchronous ownership, and loading bounded for large
  repositories.
- Use kebab-case for frontend files and snake_case for Rust modules.

## UI design

- Before starting UI design, review well-designed repositories and relevant,
  highly starred design skills. Use those references to guide layout and
  interaction decisions.
- Design around people's tasks and needs. Make workflows, visual hierarchy, and
  feedback clear and accessible.
- Reuse shared shadcn/ui controls, theme tokens, and interaction patterns.
  Prefer short labels, icons, and tooltips, and preserve accessible interactions.
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- Visually inspect the rendered UI in the running app or browser before
  considering a UI change complete. Check layout, spacing, contrast, and key
  interaction states; code review and automated checks alone are insufficient.

## Language and localization

- Keep code, comments, fixtures, and shared development documentation in English;
  put translations in the locale resources or localized documentation.
- Keep application translations in `src/i18n/locales/` and website translations
  in `site/src/locales/`, with English fallback.

## Validation

- Follow the checks in `docs/development.md` for the affected code. Changes across
  the frontend/native command boundary need both frontend and Rust validation.
- Keep tests beside the behavior they cover and avoid tests that merely repeat
  an implementation.
- Build the `rebaseraven` binary before Rust tests that exercise SSH askpass.
- Check documentation links and generated assets when changing them. Report
  what was checked and any platform or behavior that remains unverified.
