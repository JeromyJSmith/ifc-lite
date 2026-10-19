/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveGeometrySource } from './geometry-sources';
import { patchIfcxGeometry } from './ifcx-geometry';
import { verifyGeometryCleanup } from './geometry-verification';
import { sha256Hex } from '@/utils/sourceContentHash';
import type { ReviewFinding } from './types';
async function setup() {
  const before = new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: [
    { path: 'mesh', attributes: { 'usd::usdgeom::mesh': { points:[[0,0,0],[1,0,0],[0,1,0],[2,0,0]],faceVertexIndices:[0,1,2,1,2,0,0,1,3] } } },
  ] })).buffer;
  const base: ReviewFinding = {schemaVersion:1,id:'base',kind:'note',text:'Original measured defect',createdAt:'2026-10-19T10:00:00Z',context:{scopeId:'original',models:[],elements:[],capturedAt:'2026-10-19T10:00:00Z',viewpoint:{guid:'view'}}};
  const rows: ReviewFinding[] = [];
  const source = await saveGeometrySource(before,base,async row => {rows.push(row);return row.id;});
  const repaired = patchIfcxGeometry(before,{kind:'remove_defective_faces',meshPath:'mesh'});
  const afterHash = await sha256Hex(repaired.correctedBuffer);
  const receipt: Record<string,unknown> = {operation:'remove_defective_faces',path:'mesh',beforeSource:source,beforeHash:source.hash,afterHash,before:repaired.before,after:repaired.after};
  return {before,rows,receipt,verification:{matches:true,afterHash},after:repaired.correctedBuffer};
}
test('independent verification reconstructs archived source and proves the exact retained geometry',async () => {
  const s=await setup(),result=await verifyGeometryCleanup(s.receipt,s.verification,s.rows,s.after);
  assert.equal(result.beforeFaceCount,3);assert.equal(result.afterFaceCount,1);assert.equal(result.removedFaceCount,2);
  assert.equal(result.afterHash,await sha256Hex(s.after));assert.equal(result.meshCount,1);
});
test('forged zero-defect summaries cannot qualify an unmodified or arbitrary source',async () => {
  const s=await setup(),fakeHash=await sha256Hex(s.before);
  await assert.rejects(verifyGeometryCleanup({...s.receipt,afterHash:fakeHash,after:{faceCount:1}}, {matches:true,afterHash:fakeHash},s.rows,s.before),/independently recomputed/);
  await assert.rejects(verifyGeometryCleanup({...s.receipt,after:{faceCount:999}},s.verification,s.rows,s.after),/face count differs/);
  await assert.rejects(verifyGeometryCleanup(s.receipt,s.verification,s.rows,s.before),/independently recomputed/);
});
test('missing or corrupted originals and unqualified operations cannot close issues',async () => {
  const s=await setup();
  await assert.rejects(verifyGeometryCleanup(s.receipt,s.verification,[],s.after),/manifest is missing/);
  const corrupt=structuredClone(s.rows),chunk=JSON.parse(corrupt[0].text);chunk.text=chunk.text.replace('mesh','evil');corrupt[0].text=JSON.stringify(chunk);
  await assert.rejects(verifyGeometryCleanup(s.receipt,s.verification,corrupt,s.after),/integrity/);
  await assert.rejects(verifyGeometryCleanup({...s.receipt,operation:'translate_mesh_local'},s.verification,s.rows,s.after),/no qualified issue-specific postcondition/);
  await assert.rejects(verifyGeometryCleanup(s.receipt,{...s.verification,matches:false},s.rows,s.after),/does not match/);
});

test('normalization verifies the exact wall body while preserving descendant geometry and metadata', async () => {
  const points = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[0.5,0,0]];
  const old = {points,faceVertexIndices:[0,2,4,4,2,1,0,1,3,1,2,3,2,0,3,0,4,1]};
  const replacement = {points:points.slice(0,4),faceVertexIndices:[0,2,1,0,1,3,1,2,3,2,0,3]};
  const before = new TextEncoder().encode(JSON.stringify({header:{ifcxVersion:'ifcx_alpha'},imports:[],schemas:{},data:[
    {path:'wall',attributes:{'usd::usdgeom::mesh':old,'bsi::ifc::prop::Name':'retain'},children:{detail:'detail'}},
    {path:'detail',attributes:{'usd::usdgeom::mesh':replacement}}
  ]})).buffer;
  const base = (await setup()).rows[0], rows:ReviewFinding[]=[];
  const stored = await saveGeometrySource(before,base,async row=>{rows.push(row);return row.id;});
  const patched = patchIfcxGeometry(before,{kind:'replace_mesh',meshPath:'wall',mesh:replacement});
  const afterHash = await sha256Hex(patched.correctedBuffer);
  const receipt = {operation:'replace_mesh',path:'wall',beforeSource:stored,beforeHash:stored.hash,afterHash,before:{faceCount:6},after:{faceCount:4}};
  const checked = await verifyGeometryCleanup(receipt,{matches:true,afterHash},rows,patched.correctedBuffer);
  assert.equal(checked.beforeFaceCount,6);assert.equal(checked.afterFaceCount,4);assert.equal(checked.solid?.verified,true);
  const altered = JSON.parse(new TextDecoder().decode(patched.correctedBuffer));
  altered.data[1].attributes['bsi::ifc::prop::Name']='unrelated edit';
  const bytes = new TextEncoder().encode(JSON.stringify(altered)).buffer, hash = await sha256Hex(bytes);
  await assert.rejects(verifyGeometryCleanup({...receipt,afterHash:hash},{matches:true,afterHash:hash},rows,bytes),/independently recomputed/);
});
