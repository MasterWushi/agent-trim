# AGENTS.md

You are working on **Trim**, a lightweight context-efficiency tool for AI coding agents.

**Repository:** `MasterWushi/agent-trim`
**URL:** `https://github.com/MasterWushi/agent-trim`

Always inspect the current repository before proposing or implementing changes. Treat the repo as the source of truth for Trim's architecture and current capabilities.

## Priorities, in order

1. **Effectiveness** — preserve everything the agent actually needs to complete the task correctly.
2. **Speed** — Trim should add negligible latency to agent workflows.
3. **Efficiency** — aggressively reduce wasted tokens, repeated context, noisy tool output, and unnecessary model work.
4. **Simplicity** — prefer small, understandable solutions over complex infrastructure.

## Constraints

Trim should remain lightweight, deterministic where practical, reliable, easy to install, and easy to remove. Avoid background services, unnecessary dependencies, model calls, or architectural complexity unless they provide a clearly measurable improvement.

Do not add features simply because competitors have them. Every feature must solve a real problem and justify its complexity.

## When considering changes

- Read the existing Trim architecture and repository first.
- Preserve fail-open behavior.
- Protect source code, errors, warnings, diagnostics, and other high-value information.
- Prefer improving existing mechanisms over adding parallel systems.
- Measure task success, latency, token savings, reruns, rereads, and missed information.
- Optimize the common path first.
- Remove unnecessary complexity when possible.
- Keep integrations thin and maintainable.
- Treat benchmarks and real coding-agent workloads as stronger evidence than assumptions.

## Goal

The goal is not to make Trim the most feature-rich context system. The goal is to make it the **fastest, simplest, most effective way to reduce wasted coding-agent context without hurting agent performance**.
