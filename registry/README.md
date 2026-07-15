# Agent Capability Registry

`agents.json` is the evidence-backed source of truth for global skill placement,
agent-definition rendering, gating, and read-graph safety. The data is temporal:
refresh evidence when an agent changes its discovery paths or invocation model.

## Main fields

- `directories`: global path templates and deprecation/additional notes.
- `agents.<id>.reads`: confirmed directories in discovery/precedence order.
- `maybeReads`: unconfirmed reads; treated as reads for deny guarantees and
  reported visibility.
- `ownDir`: target used for scoped placement.
- `firstParty`, `dialect`, `symlinks`, `addOnly`: rendering and placement policy.
- `agentDefDir`, `agentDefDialect`, `agentDefVia`: agent-definition delivery.
- `skillInvocation`: user invocation, model-invocation gate, probe version/date,
  and evidence used by gated placement and drift warnings.
- `evidence`: the source or probe supporting each capability decision.

Keep agent ids stable because catalogs, overlays, composed consumers, and state
all refer to them. Update the top-level `researched` date when evidence changes,
preserve uncertainty in `maybeReads`/notes, and never promote a path to confirmed
without a source or probe.

## Verification

```bash
cd cli
bun test test/registry.test.ts test/solver.test.ts
```

The TypeScript validator in `cli/src/registry.ts` is the executable schema.
