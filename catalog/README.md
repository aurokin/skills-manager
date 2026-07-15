# Catalog

The catalog is the declarative input for the two upstream workflows. It is not
skm's ownership state.

## Files

- `global-specs.txt`: desired global upstream set for `skm upstream sync`.
- `families.tsv`: tab-separated family name and one-line description.
- `families/<name>.txt`: upstream specs deployed for that family.
- `family-coverage.json`: repositories audited after a real family deploy;
  `ignored` lists known upstream skills intentionally outside the family.
- `agent-scopes.json`: allow/deny placement for public local skills; absent
  skills are unscoped.
- `../upstream-coverage.json`: global repositories audited by upstream sync.

Spec lines use `owner/repo@skill-name` for one skill or `owner/repo` for every
skill discovered in that repository. Blank lines and `#` comments are ignored.
Every `families.tsv` name should have a matching `families/<name>.txt` file.

Machine-local additions, exclusions, preserves, and custom families belong in
the gitignored `.skills.local.json`, starting from `.skills.local.json.example`.
That file is separate from registered overlay roots.

## Verification

```bash
cd cli
bun test test/catalog.test.ts test/catalog-specs.test.ts
bun test test/deploy-resolve.test.ts test/upstream-sync.test.ts
```

Do not use a real `skm upstream sync` as a validation command; it mutates global
installs and has no dry-run mode.
