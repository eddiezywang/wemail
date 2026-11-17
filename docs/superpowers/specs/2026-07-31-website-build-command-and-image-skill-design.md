# Website Build Command and Image Skill Design

## Goal

Provide one root npm command for building the official documentation website and one repository-local Skill for reproducibly building and exporting its Docker image.

## Website build command

Add `build:website` to the root `package.json`. It runs:

```text
npm --prefix website run build
```

The command assumes `website/node_modules` is already installed. It does not install dependencies or run tests.

## Repository Skill

Create `.agents/skills/wemail-docs-image-build/` with:

- `SKILL.md` for triggering, workflow, constraints, and expected output.
- `agents/openai.yaml` for UI metadata.
- `scripts/build-docs-image.ps1` for deterministic execution.

The script:

1. Resolves the repository root from its own location.
2. Uses a native Docker CLI when available, otherwise falls back to Docker inside the `Ubuntu` WSL distribution.
3. Builds `wemail-docs:local` from `website/`, using the npm mirror argument already supported by the Dockerfile.
4. Verifies that `/app/dist/downloads/WeMail-Setup.exe` is absent from the image.
5. Saves the image to a temporary archive, then atomically replaces `wemail-docs-local.tar` only after a successful export.
6. Prints the archive path, byte size, and SHA-256 digest.

The script accepts overrides for the image name, output path, WSL distribution, and npm registry. It does not start, replace, stop, or delete service containers.

## Safety and failure behavior

The existing `website/.dockerignore` remains the source of truth for excluding `public/downloads/WeMail-Setup.exe`. Any failed Docker command terminates the script with a nonzero exit code. A failed build or export preserves the previous archive. Temporary verification containers are automatically removed.

No `npm run test*` command is run unless the user explicitly requests it.

## Validation

Validate the Skill metadata with `quick_validate.py`. Exercise the PowerShell script against the current Docker environment, verify the resulting image and archive metadata, and run the website build command once. These checks are builds and static validation, not test-suite commands.
