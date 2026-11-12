# Windows Self-Signed Test Packaging Design

## Goal

Provide a repeatable Windows NSIS packaging path signed with a locally generated WeMail test certificate, without weakening or replacing the production release signing requirements.

## Certificate Layout

The repository tracks the certificate-generation script, the public `.cer` certificate, and usage documentation. The private `.pfx` certificate and its password are stored under `workspace/signing/private/`, which is ignored by Git. Other developers obtain the shared private certificate through a team secret store or private file transfer rather than source control.

The generated certificate uses the subject `CN=WeMail Test Publisher, O=WeMail Development, OU=Internal Testing`, RSA with SHA-256, and the Code Signing extended key usage. It is explicitly for development and internal testing; Windows machines must install the public certificate into their trusted stores before the signature is considered trusted.

## Commands

`npm run certificate:windows:test` creates or reuses the local certificate and writes an ignored environment file containing the local PFX path and password. `npm run package:windows:self-signed` ensures the certificate exists, loads the ignored environment, passes the PFX into the existing Docker/Wine packaging environment, and produces a signed NSIS installer.

The existing `npm run package:windows` remains an unsigned smoke-build command. The existing `npm run package:release:windows` continues to require a publicly trusted certificate, update feed URL, publisher configuration, and native Windows signature verification.

## Safety and Failure Handling

The generation command never prints the PFX password. It refuses to overwrite an existing private certificate unless explicitly removed first. Packaging fails when the PFX or ignored environment file is missing, when Docker is unavailable, or when signing fails. No production release variable is enabled by this test path, so the resulting installer cannot accidentally become a feed-enabled production update.

## Verification

Unit tests cover certificate paths, environment parsing, Docker path translation, and missing-secret failures without exposing real passwords. The implementation also verifies the generated public certificate contains the expected subject and Code Signing extended key usage, and confirms the PFX can be opened with the locally stored password.
