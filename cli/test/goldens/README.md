# Agent-definition goldens

These fixtures pin byte compatibility with the retired `custom_agents` Python
renderers used during the skm cutover. The committed goldens are the test input;
normal development does not need the archived repository.

Regenerate them only when deliberately changing the compatibility contract:

```bash
CUSTOM_AGENTS_SRC=/path/to/custom_agents/src \
  python3 cli/test/goldens/generate.py
```

The generator imports pure renderer functions and writes only this golden tree.
Never run the archived repository's `shared-agents sync`; skm owns the live
placements and the two managers would corrupt ownership state.
