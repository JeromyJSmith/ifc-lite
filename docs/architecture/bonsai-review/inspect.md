# Contract inspection

Predecessor: spec.md. Reviewer: codex-bonsai-viewer. Verdict: pass for implementation.
The scope maps every requested behavior to existing capture and BCF interfaces,
an append-only browser store, official local image inference and explicit review.
Tests must exercise persistence/reopen, isolation, conflict rollback, request image
payloads and refusal cases. Live runtime and browser proof remain unperformed at
inspection time; documentation is not evidence that these behaviors ran.

Expansion inspection: the process schema constrains state transitions but cannot
authenticate a human or resolve an external artifact. Approval is therefore emitted
only by the existing visible native review path. The model receives no approval
tool. Browser-use and CadQuery are documented integration boundaries, not new
installed or qualified execution paths. Native IFC property changes do not repair
visible geometry merely by changing a property with a dimension-like name.
