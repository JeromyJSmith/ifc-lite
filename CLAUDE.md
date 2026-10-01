# Claude Code Guidelines for ifc-lite

See [AGENTS.md](./AGENTS.md) for the full agent guidelines used by all AI assistants in this project.

## Before you build (Jero's standing rules, 2026-09-30)

These apply in every MARPA repo, submodules and companion repos included. The home copy is `AGENTS.md` in marpa-desk.

- **Read the database first.** The Pixeltable store is the runtime: walk the catalog and see what already exists before you build, and delete what does not need to be there.
- **Adopt before build.** Before building any system-level tool, research existing open-source solutions and say what you found. Custom code is only the glue between adopted parts. Adopt maximally: take the full functionality of the tools you choose, every capability we could need, because unused capability costs little. Never a "minimal v1".
- **Latest versions.** Use the newest releases of dependencies, pre-releases included. When a bump breaks something, fix our code instead of pinning back.
- **Decide, don't ask (Jero, 2026-10-01).** Nobody waits on Jero for decisions. Choose what is best for the mission and the codebase; nothing is "optional": if it helps the goal, build it and wire it in to be used. When a decision crosses lanes, the leads consult each other and agree, then act and report the decision and its reason. What still goes to Jero: physical or credential actions, the approvals the rules of record require (Vectorworks writes, the write-back preview -> approve -> apply path), and running the finish-line ultra review.

