# Official Docs Container Runtime Installer Design

## Problem

The official documentation image currently builds the Astro site with
`public/downloads/WeMail-Setup.exe` in the build context. Astro copies that
file into `dist/downloads`, and the runtime stage copies the complete `dist`
tree into the final image. The installer is therefore embedded in every image.

The desired deployment keeps the download URL stable while leaving the
installer out of the image so an operator can copy the current installer into
an already-running container.

## Design

- Add `public/downloads/WeMail-Setup.exe` to `website/.dockerignore` so the
  installer never enters the Docker build context.
- Keep the existing site link `/downloads/WeMail-Setup.exe` unchanged.
- Remove Docker build-stage `npm run test` and `npm run check` commands. The
  image build installs locked dependencies and runs only the production site
  build.
- In the runtime stage, create `/app/dist/downloads` after copying `dist` and
  make it writable by the existing non-root `node` runtime user.
- Build the image as `wemail-docs:local` and run a container named
  `wemail-docs` with port mapping `4321:4321`.

After startup, the operator replaces the installer inside the container with:

```powershell
docker cp .\WeMail-Setup.exe wemail-docs:/app/dist/downloads/WeMail-Setup.exe
```

The copied installer lives only in that container's writable layer. Removing
and recreating the container requires copying the installer again.

## Verification

- Build the Docker image without running repository test commands.
- Inspect a temporary container and confirm
  `/app/dist/downloads/WeMail-Setup.exe` does not exist.
- Start `wemail-docs` and confirm its Docker health status and HTTP
  `/healthz` endpoint are healthy.
- Confirm the homepage is served and the installer URL returns 404 before the
  operator copies a file into the container.

## Operational Notes

The image contains no installer payload or installer-derived layer. Copying a
new installer does not require rebuilding or restarting the service; the
static server resolves files on each request.
