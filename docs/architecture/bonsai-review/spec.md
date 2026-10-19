# Review contract

Predecessor: intent.md. Owner: codex-bonsai-viewer. Baseline: 8cae63354.

Use the existing BCF frame capture and restore path. Persist append-only findings
and status events in an independent IndexedDB store, scoped by loaded model source
identity. Never evict findings. Failed writes remain visible and retryable.
Export/import must preserve screenshots, source identities and provenance; reject
conflicting IDs atomically. Reopening identical sources must recover the notes;
different source revisions must not silently reuse their element references.

Dictation starts only on an explicit button press and uses on-device speech
recognition, with supported language-pack installation. Capture context when speech
starts, before asynchronous transcription completes. Stop on panel close/unmount.
Typed notes remain available when speech recognition is unsupported.

Vision connects only to a loopback Bonsai server with verified vision modality.
Persist the submitted screenshot/context before inference. Suggestions remain
candidates, with actual returned provider/model recorded. Validate structured
responses, cap output, reject invented element references, and preserve raw model
output. Cancel requests on close; never execute model-generated code.
Optional monitoring is bounded, single-flight, and pauses while hidden.

Official references read 2026-10-19: PrismML-Eng/Bonsai-demo VISION.md;
PrismML-Eng/llama.cpp tools/server/README.md; MDN Using IndexedDB,
SpeechRecognition processLocally/available/install, StorageManager.persist.
The webml-community/ternary-bonsai-2-webgpu-kernels Space at 94320c9 is text-only
and has no declared source license. Do not copy its bundle or claim browser vision.

Owner expansion, 2026-10-19: provide visible bounded orbit/zoom and a search for
**up to five** grounded candidates. A suggested image point is normalized to its
saved screenshot; native GPU picking after exact source/view restoration alone
establishes the selected IFC element. A hit does not confirm the suspected defect.

The versioned JSON process schema is
`docs/architecture/review-companion-process.schema.json`. Runtime validation
replays immutable events; it rejects ungrounded binding, stale preview approval,
application without a human preview click, and verification without actual
matching readback. Artifact references remain distinct from proof of execution.
Model-generated notes carry their provider; activity/process records are labelled
as records rather than human dictation. Large records are chunked without loss.

The local AG-UI wire adapter emits lifecycle, tool arguments, actual tool results,
state and message events. Its durable sink applies backpressure before further
actions. Exporting these events is supported; no remote AG-UI server or Python CAD
adapter is asserted. Browser-use can bridge browser actions and a typed Python
CadQuery helper, subject to separate real-fixture qualification. The supplied
Repeatable MARPA IFCX Operations Method is a design reference, not an automatic
change in production geometry authority.

Property corrections use native expected-before previews and mutation permissions.
Only the visible owner Apply button approves a preview. The model tool cannot
approve itself. Effective data and exported IFC roundtrip checks are distinct
from dimension, geometry, engineering, source-authoring or publication acceptance.

Fast visible mode decouples deterministic camera movement from serial visual
inference. Camera transitions take 350 ms plus rendering/capture work; this is not
an image-inference speed claim. At most two captured images are queued/in flight,
at most twelve are captured per tour, and the visible route visits eight stops once. Navigation
can continue while an older frozen view is analysed; it then holds rather than repeating orbits; the UI labels that saved
view explicitly. Each captured image is persisted before enqueueing. User-added
interior/exterior stops come from actual captured viewpoints, never guessed room
coordinates. Stop/hide/unmount cancels movement and inference, retains captures,
and records interruption rather than successful review completion.
