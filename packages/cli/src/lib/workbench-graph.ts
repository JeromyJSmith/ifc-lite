/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build Marpa workbench graph JSON from a parsed IfcDataStore + RelationshipGraph.
 */
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';

const BUILDING_IFC_CLASSES = new Set([
  'IfcProject',
  'IfcSite',
  'IfcBuilding',
  'IfcBuildingStorey',
]);

const PROPERTY_IFC_CLASSES = new Set(['IfcPropertySet', 'IfcElementQuantity']);

const RELATIONSHIP_TYPE_NAMES: Record<number, string> = {
  [RelationshipType.ContainsElements]: 'IfcRelContainedInSpatialStructure',
  [RelationshipType.Aggregates]: 'IfcRelAggregates',
  [RelationshipType.DefinesByProperties]: 'IfcRelDefinesByProperties',
  [RelationshipType.DefinesByType]: 'IfcRelDefinesByType',
  [RelationshipType.AssociatesMaterial]: 'IfcRelAssociatesMaterial',
  [RelationshipType.AssociatesClassification]: 'IfcRelAssociatesClassification',
  [RelationshipType.AssociatesDocument]: 'IfcRelAssociatesDocument',
  [RelationshipType.VoidsElement]: 'IfcRelVoidsElement',
  [RelationshipType.FillsElement]: 'IfcRelFillsElement',
  [RelationshipType.ConnectsPathElements]: 'IfcRelConnectsPathElements',
  [RelationshipType.ConnectsElements]: 'IfcRelConnectsElements',
  [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
  [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
  [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
  [RelationshipType.ReferencedInSpatialStructure]: 'IfcRelReferencedInSpatialStructure',
};

export type WorkbenchGraphNode = {
  id: string;
  label: string;
  type: 'element' | 'relationship' | 'property' | 'building' | 'geometry';
  ifcType: string;
  expressId: number;
  isGraphVisible: boolean;
  properties: Record<string, unknown>;
};

export type WorkbenchGraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  type?: string;
  relationshipType?: string;
};

export type WorkbenchGraphPayload = {
  metadata: Record<string, unknown>;
  nodes: WorkbenchGraphNode[];
  edges: WorkbenchGraphEdge[];
};

function relationshipTypeName(type: number): string {
  return RELATIONSHIP_TYPE_NAMES[type] ?? 'IfcRelationship';
}

function classifyNodeType(ifcType: string): WorkbenchGraphNode['type'] {
  if (ifcType.startsWith('IfcRel')) return 'relationship';
  if (PROPERTY_IFC_CLASSES.has(ifcType)) return 'property';
  if (BUILDING_IFC_CLASSES.has(ifcType)) return 'building';
  return 'element';
}

function nodeId(expressId: number): string {
  return `node_${expressId}`;
}

function labelForEntity(store: IfcDataStore, expressId: number, ifcType: string): string {
  const name = store.entities.getName(expressId).trim();
  if (name) return name;
  const objectType = store.entities.getObjectType(expressId).trim();
  if (objectType) return objectType;
  return ifcType;
}

function buildNode(store: IfcDataStore, expressId: number): WorkbenchGraphNode {
  const ifcType = store.entities.getTypeName(expressId);
  const type = classifyNodeType(ifcType);
  const globalId = store.entities.getGlobalId(expressId);
  const name = store.entities.getName(expressId);
  const description = store.entities.getDescription(expressId);
  const objectType = store.entities.getObjectType(expressId);

  const properties: Record<string, unknown> = { expressID: expressId };
  if (globalId) properties.GlobalId = globalId;
  if (name) properties.Name = name;
  if (description) properties.Description = description;
  if (objectType) properties.ObjectType = objectType;

  return {
    id: nodeId(expressId),
    label: labelForEntity(store, expressId, ifcType),
    type,
    ifcType,
    expressId,
    isGraphVisible: type !== 'relationship',
    properties,
  };
}

export function buildWorkbenchGraphFromStore(
  store: IfcDataStore,
  options: {
    sourcePath?: string;
    parseMs?: number;
  } = {},
): WorkbenchGraphPayload {
  const { entities, relationships } = store;
  const nodeByExpressId = new Map<number, WorkbenchGraphNode>();

  for (let i = 0; i < entities.count; i++) {
    const expressId = entities.expressId[i]!;
    nodeByExpressId.set(expressId, buildNode(store, expressId));
  }

  const ensureNode = (expressId: number): WorkbenchGraphNode | undefined => {
    let node = nodeByExpressId.get(expressId);
    if (node) return node;
    if (!store.entityIndex.byId.get(expressId)) return undefined;
    node = buildNode(store, expressId);
    nodeByExpressId.set(expressId, node);
    return node;
  };

  const edges: WorkbenchGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let edgeIndex = 0;

  const addEdge = (edge: WorkbenchGraphEdge) => {
    const key = `${edge.source}|${edge.target}|${edge.label}|${edge.relationshipType ?? ''}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  const forward = relationships.forward;
  for (const [sourceId, offset] of forward.offsets) {
    const count = forward.counts.get(sourceId) ?? 0;
    for (let i = offset; i < offset + count; i++) {
      const targetId = forward.edgeTargets[i]!;
      const relType = forward.edgeTypes[i]!;
      const relationshipId = forward.edgeRelIds[i]!;
      const relClass = relationshipTypeName(relType);

      ensureNode(sourceId);
      ensureNode(targetId);
      ensureNode(relationshipId);

      if (!nodeByExpressId.has(sourceId) || !nodeByExpressId.has(relationshipId)) continue;

      addEdge({
        id: `edge_${edgeIndex++}_relating`,
        source: nodeId(sourceId),
        target: nodeId(relationshipId),
        label: 'relating',
        type: 'relationship_role',
        relationshipType: relClass,
      });

      if (!nodeByExpressId.has(targetId)) continue;

      addEdge({
        id: `edge_${edgeIndex++}_related_${targetId}`,
        source: nodeId(relationshipId),
        target: nodeId(targetId),
        label: 'related',
        type: 'relationship_role',
        relationshipType: relClass,
      });
    }
  }

  const nodes = [...nodeByExpressId.values()];
  const filename = options.sourcePath?.split('/').pop() ?? 'model.ifc';

  return {
    metadata: {
      sourceId: options.sourcePath ?? filename,
      source_id: options.sourcePath ?? filename,
      source: 'ifc-lite CLI RelationshipGraph',
      filename,
      format: 'IFC Graph Live Parse v1.0',
      graphSource: 'cli',
      schemaVersion: store.schemaVersion,
      parseMs: options.parseMs ?? store.parseTime,
      entityCount: store.entityCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      exportDate: new Date().toISOString(),
    },
    nodes,
    edges,
  };
}