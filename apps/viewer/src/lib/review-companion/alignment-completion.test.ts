import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedAlignmentText} from './tools';
const hash='a'.repeat(64);
function result(){return {verified:true,geometryApplied:false,receiptRef:'receipt',verificationRef:'verification',check:{verified:true,kind:'edge-board-alignment',currentHash:hash},disposition:{saved:true,topicId:'issue',stage:'fixed',workflowRef:'workflow',diagnosis:'Existing repair verified.',evidenceRefs:['receipt','verification']},afterView:{saved:true,topicId:'issue',receiptRef:'receipt',sourceHash:hash,viewpointRef:'view'}};}
test('completion requires the native fixed outcome and source-bound after-view',()=>{
 assert.equal(recordedAlignmentText(result(),'issue'),'Existing repair verified.');
 for(const value of [null,{}, {...result(),verified:false},{...result(),afterView:{...result().afterView,saved:false}},{...result(),afterView:{...result().afterView,sourceHash:'b'.repeat(64)}},{...result(),disposition:{...result().disposition,stage:'needs-evidence'}},{...result(),disposition:{...result().disposition,evidenceRefs:['receipt']}}])assert.equal(recordedAlignmentText(value,'issue'),null);
 assert.equal(recordedAlignmentText(result(),'other'),null);
});
