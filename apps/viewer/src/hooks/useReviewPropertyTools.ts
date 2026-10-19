/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useMemo, useRef, useState } from 'react';
import { listFindings } from '@/lib/review-companion/storage';
import { createPropertyTools } from '@/lib/review-companion/property-tools';
import { createReviewPropertyBridge, type ReviewPropertyProposal } from '@/lib/review-companion/property-changes';
import type { ReviewFinding } from '@/lib/review-companion/types';

type Bridge = ReturnType<typeof createReviewPropertyBridge>;
export type Outcome = Awaited<ReturnType<Bridge['applyChanges']>>;

export interface ReviewPropertyLifecycle {
  preview?(proposal: ReviewPropertyProposal, recordId: string): Promise<unknown>;
  approve?(proposal: ReviewPropertyProposal, recordId: string): Promise<unknown>;
  applied?(proposal: ReviewPropertyProposal, result: Outcome, recordId: string): Promise<unknown>;
  undone?(proposal: ReviewPropertyProposal, result: Awaited<ReturnType<Bridge['undoChanges']>>, recordId: string): Promise<unknown>;
}

/** Agent proposes; the owner applies the concrete preview using the visible card. */
export function useReviewPropertyTools(scope: string, persist: (finding: ReviewFinding) => Promise<string>, provider: ReviewFinding['provider'], lifecycle: ReviewPropertyLifecycle = {}) {
  const live = useRef({ scope, persist, provider, lifecycle }); live.current = { scope, persist, provider, lifecycle };
  const [proposals, setProposals] = useState<ReviewPropertyProposal[]>([]);
  const [outcomes, setOutcomes] = useState<{ previewId: string; result: Outcome }[]>([]);
  const bridge = useMemo(() => createReviewPropertyBridge({
    findFinding: async id => (await listFindings(live.current.scope)).find(f => f.id === id),
  }), []);
  const record = async (findingId: string, value: unknown) => {
    const finding = (await listFindings(live.current.scope)).find(f => f.id === findingId);
    if (!finding) throw new Error('The original review finding is unavailable; retain the visible transaction result.');
    return live.current.persist({ ...finding, id: crypto.randomUUID(), kind: 'note', parentId: findingId,
      text: JSON.stringify(value), provider: live.current.provider, createdAt: new Date().toISOString() });
  };
  const preview = async (input: Parameters<Bridge['previewChanges']>[0]) => {
    const proposal = await bridge.previewChanges(input);
    // A durable preview exists before the agent or owner can act on its ID.
    const recordId = await record(proposal.findingId, { stage: 'property-preview', proposal });
    await live.current.lifecycle.preview?.(proposal, recordId);
    setProposals(rows => [...rows, proposal]);
    return { ...proposal, next: 'Owner must review the displayed before/after values and click Apply. An agent cannot approve its own proposal.' };
  };
  const undo = async (proposal: ReviewPropertyProposal, receiptId: string) => {
    const result = await bridge.undoChanges({ receiptId });
    const recordId = await record(proposal.findingId, { stage: 'property-undo', result });
    await live.current.lifecycle.undone?.(proposal, result, recordId); return result;
  };
  const actions = useRef({ preview, undo }); actions.current = { preview, undo };
  const tools = useMemo(() => createPropertyTools({
    readElement: bridge.readElement,
    previewChanges: input => actions.current.preview(input),
    applyChanges: async input => ({ applied: false, reason: 'owner-approval-required', previewId: input.previewId,
      next: 'Use the visible proposal card to review and apply these exact values.' }),
    undoChanges: async input => {
      const proposal = proposalsRef.current.find(p => outcomesRef.current.some(o => o.previewId === p.id && 'receipt' in o.result && o.result.receipt?.id === input.receiptId));
      if (!proposal) throw new Error('No linked review proposal exists for this undo receipt.');
      return actions.current.undo(proposal, input.receiptId);
    },
  }), [bridge]);
  const proposalsRef = useRef(proposals); proposalsRef.current = proposals;
  const outcomesRef = useRef(outcomes); outcomesRef.current = outcomes;
  return { tools, proposals, outcomes,
    refresh: async (proposal: ReviewPropertyProposal) => {
      const next = await preview({ findingId: proposal.findingId, batch: proposal.batch });
      setProposals(rows => rows.filter(p => p.id !== proposal.id)); return next;
    },
    apply: async (proposal: ReviewPropertyProposal) => {
      // This function is exposed only to the visible owner Apply button, never a model tool.
      const approvalId = await record(proposal.findingId, { stage: 'property-owner-approval', previewId: proposal.id, digest: proposal.preview.digest, method: 'native-review-click' });
      await live.current.lifecycle.approve?.(proposal, approvalId);
      const result = await bridge.applyChanges({ previewId: proposal.id });
      setOutcomes(rows => [...rows, { previewId: proposal.id, result }]);
      const recordId = await record(proposal.findingId, { stage: 'property-apply-readback', result });
      await live.current.lifecycle.applied?.(proposal, result, recordId);
      return result;
    },
    undo,
  };
}
