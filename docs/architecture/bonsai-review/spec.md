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

For a close inspection after opening a BCF viewpoint, `viewer_rotate_at`
anchors a 350 ms turn to a current normalized viewport point on the issue or
its surroundings. The canonical presented frame supplies visibility and clipping;
CPU surface intersection must agree with native GPU element picking. Blank or
mismatched hits, cancellation before movement, and a camera changed during picking
are rejected without moving. The orbit derives its angles from the actual eye
offset around that surface, preserving radius and projection scale. The returned
pivot, radius and native element identify what moved; they do not verify a defect.
`viewer_rotate` continues to mean rotation around the existing camera target.


## Selected-region BCF mission

The owner initiates a review with **Describe & log BCF issue** after framing the
concern and optionally selecting surrounding elements. Readiness is explicit;
no background observation is required. The mission captures the image and full
surrounding selection before inference, asks for one possible issue, then saves a
native local BCF topic and durable definition/readback receipt. No finding means
an observation log, without fabricating an issue. Human corrections remain manual.
A hole or missing piece may have no selected element. Selected neighbors are
context, not a claim that each is faulty. BCF uses IFCX AuthoringToolId for prim
paths; native viewpoint restoration resolves it only against a unique loaded
IFCX model. Issues retain screenshot, camera, source fingerprint and uncertainty.

The shared registry exposes review_create_bcf_issue, review_bcf_issues and
review_open_bcf_issue through document.modelContext when available and the same
local Bonsai executor otherwise. These are local BCF operations, not remote
publication. Definitions are written to append-only review storage before topic
installation; receipts follow actual native readback. Existing projects are
merged into, never replaced. Repeated creation for the same finding is idempotent.
