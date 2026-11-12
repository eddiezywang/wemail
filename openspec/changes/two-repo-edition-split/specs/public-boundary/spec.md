## ADDED Requirements

### Requirement: Internal identifiers are ratcheted to zero in the open tree

The open repo SHALL provide a machine gate (`check-public-boundary`) that
scans git-tracked text files for internal identifiers: the organization name,
internal hostnames, the internal registry, the internal brand, the banned
upstream name, and internal/private network addresses. The gate SHALL run as
part of `verify:pr`.

#### Scenario: New identifier introduced

- **WHEN** a change adds a deny-pattern match in a file, or adds matches to a
  file beyond its baseline count
- **THEN** the gate SHALL fail, listing file, line, rule, and matched text

#### Scenario: Identifier removed

- **WHEN** a change removes matches such that every file is at or below its
  baseline count
- **THEN** the gate SHALL pass and report the shrunk total against the
  baseline

### Requirement: Baseline regeneration is explicit and reviewable

The baseline file SHALL be regenerated only through an explicit flag, and the
resulting diff SHALL be reviewed. Lockfiles SHALL be excluded from scanning
because integrity hashes may coincidentally contain deny substrings.

#### Scenario: Growth is not silently absorbed

- **WHEN** a developer regenerates the baseline after adding a new internal
  reference instead of removing it
- **THEN** the baseline diff SHALL show the count increase for that file,
  making the regression visible in review
