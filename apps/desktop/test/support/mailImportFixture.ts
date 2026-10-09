import type {CrmMailImportHealth} from '@fss/contracts';
export const IMPORT_ID='33333333-3333-4333-8333-333333333333';
export function mailImportHealth():NonNullable<CrmMailImportHealth>{return {
 importId:IMPORT_ID,state:'partial',reason:null,generation:2,connectionState:'current',fromAt:'2026-07-10T00:00:00Z',toAt:'2026-10-08T00:00:00Z',historyAnchor:'100000000000000007',historyComplete:false,windowFrozen:true,totalSlices:90,completedSlices:12,coverageKind:'enumeration',bodyCoverage:'measured',
 metadataCoverage:{retainedUniqueMessages:'7',availableMetadataMessages:'4',refusedMetadataMessages:'1',confirmedMissingMessages:'1',deletedMetadataMessages:'1'},
 quotaAccounting:{scope:'callie_backfill_allocation',reservedUnits:'100000000000000000007',observedUnits:'70',unknownUnits:'30'},
 copyCoverage:{scope:'permitted_import_corpus',coverage:'partial',retainedCopiedBodies:'5',unavailableCopies:'1',pendingCaptures:'2',reviewRequiredMetadata:'1',uncapturedMetadata:'2',unresolvedMetadata:'2'},
 olderCopyReconciliation:{kind:'bounded_current_copy_traversal',coverage:'partial',visitedCopies:'12',refreshedCopies:'5',unresolvedCopies:'7',traversalExhausted:true},gapCoverage:null,
};}
