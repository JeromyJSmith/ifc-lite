/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createBCFProject, createBCFTopic, type BCFTopic, type BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { reviewModels, reviewScope } from './context';
import { createReviewTool } from './tools';
import type { ReviewFinding } from './types';

const KIND = 'review.bcf.definition';
interface Definition { kind: typeof KIND; findingId: string; topicId: string; title: string; description: string; createdAt: string }
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function definition(row: ReviewFinding): Definition | null {
  if (!row.text.startsWith(`{"kind":"${KIND}"`)) return null;
  const d: unknown = JSON.parse(row.text);
  if (!d || typeof d !== 'object' || !('kind' in d) || d.kind !== KIND || !('findingId' in d) || typeof d.findingId !== 'string'
    || !('topicId' in d) || typeof d.topicId !== 'string' || !guid.test(d.topicId) || !('title' in d) || typeof d.title !== 'string' || !d.title.trim() || d.title.length > 200
    || !('description' in d) || typeof d.description !== 'string' || d.description.length > 20000 || !('createdAt' in d) || typeof d.createdAt !== 'string' || !Number.isFinite(Date.parse(d.createdAt))) throw new Error('Saved BCF definition is invalid; its original record is preserved.');
  return d as Definition;
}
/** IFCX prim paths are authoring IDs, never fabricated 22-character IFC GUIDs. */
export function reviewBcfViewpoint(viewpoint: BCFViewpoint): BCFViewpoint {
  const next = structuredClone(viewpoint);
  const components = [...(next.components?.selection ?? []), ...(next.components?.visibility?.exceptions ?? []), ...(next.components?.coloring?.flatMap(c => c.components) ?? [])];
  for (const component of components) if (component.ifcGuid && !/^[0-9A-Za-z_$]{22}$/.test(component.ifcGuid)) {
    component.authoringToolId = component.ifcGuid; component.originatingSystem = 'IFC-Lite IFCX'; delete component.ifcGuid;
  }
  return next;
}
function topicFrom(row: ReviewFinding, d: Definition): BCFTopic {
  const topic = createBCFTopic({ title: d.title, description: d.description, author: row.provider ? `Bonsai (${row.provider.model})` : 'IFC-Lite visual review',
    topicType: 'Issue', topicStatus: 'Open', labels: ['Bonsai', 'Possible issue', 'Needs review'] });
  topic.guid = d.topicId; topic.creationDate = d.createdAt;
  topic.viewpoints = [reviewBcfViewpoint(row.context.viewpoint)];
  topic.header = row.context.models.map(m => ({ filename: m.name, reference: `urn:ifc-lite:review-source:${encodeURIComponent(m.sourceIdentity)}` }));
  return topic;
}

/** Durable definitions precede native topic installation; receipts follow actual store readback. */
export function createReviewBcfBridge(options: { scope(): string; rows(): Promise<ReviewFinding[]>; persist(row: ReviewFinding): Promise<string> }) {
  let writing = false;
  async function install(row: ReviewFinding, d: Definition) {
    const state = useViewerStore.getState();
    const currentScope = await reviewScope(await reviewModels(state.models));
    if (currentScope !== row.context.scopeId || useViewerStore.getState().models !== state.models) throw new Error('Load the reviewed model revision before opening its BCF issue.');
    const topic = topicFrom(row, d), live = useViewerStore.getState();
    if (!live.bcfProject) live.setBcfProject(createBCFProject({ name: 'Bonsai visual review' }));
    const current = useViewerStore.getState();
    if (!current.bcfProject?.topics.has(topic.guid)) current.addTopic(topic);
    const saved = useViewerStore.getState().bcfProject?.topics.get(topic.guid);
    if (!saved || !saved.viewpoints.some(v => v.guid === topic.viewpoints[0].guid && v.snapshot === topic.viewpoints[0].snapshot)) throw new Error('The native BCF topic readback did not match its saved viewpoint.');
    useViewerStore.getState().setActiveTopic(topic.guid);
    return { topicId: saved.guid, title: saved.title, status: saved.topicStatus, viewpointId: topic.viewpoints[0].guid,
      definitionRef: row.id, contextElementCount: row.context.elements.length, hasSnapshot: !!topic.viewpoints[0].snapshot, findingId: d.findingId, saved: true,
      limitation: 'Possible issue for human review. Selected elements are surrounding context; this is not a confirmed defect or a model correction.' };
  }
  async function create(input: { findingId: string; title: string; description: string }) {
    if (!input.title.trim() || input.title.length > 200 || !input.description.trim() || input.description.length > 4000) throw new Error('BCF title or description is outside its limits.');
    if (writing) throw new Error('A BCF issue is already being saved.');
    writing = true;
    try {
      const rows = await options.rows();
      const existing = rows.map(row => ({ row, d: definition(row) })).find(item => item.d?.findingId === input.findingId);
      if (existing?.d) return install(existing.row, existing.d);
      const finding = rows.find(row => row.id === input.findingId && row.context.scopeId === options.scope());
      if (!finding || finding.kind !== 'candidate') throw new Error('Choose a saved visual candidate from this model review.');
      if (!finding.context.viewpoint.snapshot || !(finding.context.viewpoint.perspectiveCamera || finding.context.viewpoint.orthogonalCamera)) throw new Error('The finding needs its original screenshot and camera before becoming a BCF issue.');
      const createdAt = new Date().toISOString();
      const d: Definition = { kind: KIND, findingId: finding.id, topicId: crypto.randomUUID(), title: input.title,
        description: `Possible issue — needs human review.\n\nVisual observation:\n${finding.text}\n\nReview description:\n${input.description}\n\nThe selected elements are surrounding context, not a claim that each is defective. A missing piece or hole may have no selectable element.\n\nCaptured: ${finding.context.capturedAt}\nFinding: ${finding.id}\nModel revision: ${finding.context.models.map(m => `${m.name} @ ${m.sourceIdentity}`).join('; ')}`, createdAt };
      if (d.description.length > 20000) throw new Error('The BCF description exceeds its limit; the original observation remains saved.');
      const row: ReviewFinding = { ...structuredClone(finding), id: crypto.randomUUID(), parentId: finding.id, kind: 'note', text: JSON.stringify(d), createdAt };
      await options.persist(row);
      const result = await install(row, d);
      await options.persist({ ...row, id: crypto.randomUUID(), parentId: row.id, text: JSON.stringify({ kind: 'review.bcf.receipt', ...result, createdAt: new Date().toISOString() }) });
      return result;
    } finally { writing = false; }
  }
  async function list() {
    return (await options.rows()).flatMap(row => { const d = definition(row); return d ? [{ findingId: d.findingId, topicId: d.topicId, title: d.title, contextElementCount: row.context.elements.length, createdAt: d.createdAt }] : []; });
  }
  async function open(topicId: string) {
    for (const row of await options.rows()) { const d = definition(row); if (d?.topicId === topicId) return install(row, d); }
    throw new Error('No saved BCF issue has this topic ID.');
  }
  return { create, list, open };
}
export function createBcfReviewTools(bridge: ReturnType<typeof createReviewBcfBridge>) {
  const id = { type: 'string' as const, minLength: 1, maxLength: 200 };
  return [
    createReviewTool('review_create_bcf_issue', 'Create a durable local native BCF issue from a saved visual candidate. Preserve its screenshot, camera and selected surrounding context, including viewpoint-only holes or missing pieces. Describe visible evidence and uncertainty. Does not confirm a defect, change IFC values or publish to a remote server. Repeating the same finding returns its existing topic.',
      { findingId: id, title: id, description: { type: 'string', minLength: 1, maxLength: 4000 } }, false, input => bridge.create(input as { findingId: string; title: string; description: string })),
    createReviewTool('review_bcf_issues', 'List saved local BCF issues and their originating finding IDs.', {}, true, () => bridge.list()),
    createReviewTool('review_open_bcf_issue', 'Restore a saved BCF issue into the native local BCF project for review or standard BCF export. Does not publish or change its status.', { topicId: id }, false, input => bridge.open(input.topicId as string)),
  ];
}
