/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { edgePrismComponents, verifyEdgePrismAlignment } from './edge-prism-verification';
import { patchIfcxGeometry } from './ifcx-geometry';
import { sha256Hex } from '@/utils/sourceContentHash';
const inwardFaces=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7];
const faces=inwardFaces.flatMap((_,i)=>i%3===0?[inwardFaces[i],inwardFaces[i+2],inwardFaces[i+1]]:[]);
const points=(x:number)=>[[x,0,0],[x+2,0,0],[x+2,.03,0],[x,.03,0],[x,0,-.2],[x+2,0,-.2],[x+2,.03,-.2],[x,.03,-.2]];
async function fixture(){
 const before=new TextEncoder().encode(JSON.stringify({header:{ifcxVersion:'ifcx_alpha'},data:[
 {path:'board',attributes:{'bsi::ifc::class':{code:'IfcCovering'},'usd::usdgeom::mesh':{points:points(.1),faceVertexIndices:faces}}},
 {path:'roof',attributes:{'bsi::ifc::class':{code:'IfcRoof'},'usd::usdgeom::mesh':{points:[[0,0,0],[2,0,0],[0,1,0]],faceVertexIndices:[0,1,2]}}},
 ]})).buffer;
 const applied=patchIfcxGeometry(before,{kind:'replace_mesh',meshPath:'board',mesh:{points:points(0),faceVertexIndices:faces}}).correctedBuffer;
 return {before,applied,receipt:{operation:'replace_mesh',path:'board',beforeHash:await sha256Hex(before),afterHash:await sha256Hex(applied)},criteria:[{pointOffset:0,referencePath:'roof',referencePointIndices:[0,1]}]};
}
test('qualifies a complete moved edge board and rejects stale source or missing coverage',async()=>{
 const f=await fixture();
 const checked=await verifyEdgePrismAlignment(f.receipt,f.before,f.applied,f.applied,f.criteria);
 assert.equal(checked.movedVertexCount,8);assert.equal(checked.checks.length,1);assert.ok(checked.checks[0].solid.afterVolume>0);
 await assert.rejects(verifyEdgePrismAlignment(f.receipt,f.before,f.applied,f.before,f.criteria),/differs/);
 await assert.rejects(verifyEdgePrismAlignment({...f.receipt,beforeHash:'wrong'},f.before,f.applied,f.applied,f.criteria),/sources/);
 await assert.rejects(verifyEdgePrismAlignment(f.receipt,f.before,f.applied,f.applied,[{...f.criteria[0],pointOffset:1}]),/out-of-range/);
});
test('criteria reject ambiguous, fractional and self-paired reference definitions',()=>{
 for(const value of [[],Array(33).fill({}),[{pointOffset:.5,referencePath:'roof',referencePointIndices:[0,1]}],[{pointOffset:0,referencePath:'roof',referencePointIndices:[1,1]}],[{pointOffset:0,referencePath:'roof',referencePointIndices:[0,1],extra:true}]])assert.throws(()=>edgePrismComponents(value));
});
