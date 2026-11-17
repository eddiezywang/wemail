# WeMail Support Runtime

This directory contains the source-of-truth implementation for the local
Hermes/WeCom support assistant. Runtime state is stored outside the repository
under `%LOCALAPPDATA%\hermes\wemail-support` so credentials, user identifiers,
cases, audit records, and unpublished knowledge are never committed.

The runtime provides:

- approved, module-scoped Agentic Search over published Markdown;
- hard role enforcement from the Hermes gateway user identity;
- support cases and support todos, separate from WeMail mail todos;
- knowledge draft, review, publish, version, and rollback records;
- audit records for every mutation;
- a deterministic `index.md` document map.

The Hermes plugin source lives in `hermes-plugin/`. Initial approved knowledge
lives in `knowledge-seed/`. `product-baseline.json` declares the current
released-product baseline used by those documents.

`facts/current-release.json` records high-risk product claims with source
assertions. The executable evaluation fails when a referenced setting, schema,
menu, or limit changes, forcing the corresponding knowledge to be reviewed
instead of allowing the bot to keep answering an old conclusion confidently.

## Local deployment

Run `./services/wemail-support/deploy.ps1` from the repository root and pass the
initial super administrator at deployment time; never store a real WeCom user
ID in the repository:

```powershell
.\services\wemail-support\deploy.ps1 `
  -SuperAdminUserId "<trusted-wecom-user-id>" `
  -SuperAdminName "<display-name>"
```

The script:

- installs the plugin and skill under `%LOCALAPPDATA%\hermes`;
- preserves any administrators already configured and ensures the initial
  super administrator remains present;
- synchronizes repository seed updates only while a runtime document still
  matches the previously deployed seed; reviewed runtime publications are
  never silently overwritten, and an unbaselined conflict stops deployment;
- enables the plugin, the WeCom toolset, and streaming in `config.yaml`;
- disables Hermes progressive tool disclosure for this dedicated support
  agent, so product questions call `wemail_support_*` directly instead of
  exposing `tool_search` / `tool_describe` bridge activity to users;
- suppresses WeCom tool-progress chrome while retaining native answer
  streaming, so knowledge retrieval and case operations remain internal;
- saves `config.yaml.wemail-support.bak` before changing Hermes configuration.

Publishing knowledge requires approval from an administrator other than the
draft creator or its latest editor, including when either is a super
administrator. Configure appropriately scoped reviewers before publishing;
if the creator and latest editor differ, a third administrator is needed.

The script checks for the Hermes configuration, Python executable, readable
metadata and unbaselined knowledge conflicts before copying files. Deployment
is not transactional: a later configuration error or incompatible patch can
leave earlier changes in place.
Review the error and backups before retrying.

Hermes Gateway must be restarted after deployment because user plugins are
loaded at process startup. Runtime acceptance is performed from a real WeCom
identity; a successful plugin listing alone does not prove message-level role,
case, todo, notification, or response behavior.
