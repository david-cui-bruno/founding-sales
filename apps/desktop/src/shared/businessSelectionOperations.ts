import { z } from 'zod';
import {businessSelectionReadSchema,businessSelectionStatusSchema,businessSelectionPayloadSchema,businessRuleReadSchema,businessRulePayloadSchema,businessRulesSchema} from '@fss/contracts';
export const BUSINESS_SELECTION_OPERATIONS={
 'crm.businessSelectionRead':{kind:'read',calls:[{method:'POST',path:'/crm/business/selection/read'}],input:businessSelectionReadSchema,output:businessSelectionStatusSchema,transform:'current account selection status without provider reads'},
 'crm.businessSelectionRequest':{kind:'command',calls:[{method:'POST',path:'/crm/business/selection/request'}],input:businessSelectionPayloadSchema,output:z.strictObject({status:z.literal('queued'),previewJobId:z.uuid(),captureAllowed:z.literal(false)}),transform:'one selected Gmail message metadata preview; no body acquisition'},
 'crm.businessRulesRead':{kind:'read',calls:[{method:'POST',path:'/crm/business/rules/read'}],input:businessRuleReadSchema,output:businessRulesSchema,transform:'account-scoped correspondent rules'},
 'crm.businessRuleSave':{kind:'command',calls:[{method:'POST',path:'/crm/business/rules/save'}],input:businessRulePayloadSchema,output:z.strictObject({revision:z.number().int().positive(),captureAllowed:z.literal(false)}),transform:'versioned rule edit or removal; no capture authority'},
} as const;
