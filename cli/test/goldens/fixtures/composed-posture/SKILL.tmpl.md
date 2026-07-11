# Orchestrate — for {{consumer}}

This skill is built for **{{consumer}}**.

## Safety gate

Implementation runs happen only in a worktree, never the live checkout.
<!-- @posture sandboxed -->
Keep a structural read-only boundary and confirm before granting full access.
<!-- @end -->
<!-- @posture yolo -->
Bypass forms are permitted; the worktree is your only containment.
<!-- @end -->

## Delegate or not

{{consumer_gate}}

## Routing

{{routing_table}}

## Anti-recursion

Never spawn another orchestrator: {{provider_clis}}.
