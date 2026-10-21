import {z} from 'zod';
import {addFirmCommandSchema,addFirmResultSchema,sourcingUrlSchema} from '@fss/contracts';
import {discoveryResearchFirmLinkInputSchema,discoveryResearchFirmLinkSavedSchema} from '@fss/contracts';
import {discoveryPromotionInputSchema,qualificationReadSchema,discoveryPromotionSavedSchema,uuid} from '@fss/contracts';
import type {Operation} from './operations.ts';

export const sourcingDiscoveryPromotionOperations={
 'sourcing.discoveryCreateResearchFirm':{
  kind:'command',calls:[{method:'POST',path:'/crm/firms/add'}],input:addFirmCommandSchema.pick({commandId:true,firm:true}).extend({firm:z.strictObject({name:addFirmCommandSchema.shape.firm.shape.name.min(1),website:sourcingUrlSchema})}),output:z.object({result:addFirmResultSchema.nullable(),reason:z.string().nullable()}),transform:'Explicit ordinary Add firm command, no contact, route, time-zone inference or qualification claim',
 },
 'sourcing.discoveryLinkResearchFirm':{
  kind:'command',calls:[{method:'POST',path:'/sourcing/candidates/discovery/link-research-firm-v1'}],input:discoveryResearchFirmLinkInputSchema.extend({commandId:uuid}),output:z.object({result:discoveryResearchFirmLinkSavedSchema.nullable(),reason:z.string().nullable()}),transform:'Link explicit ordinary owner-created CRM research draft, no admission or outreach',
 },
 'sourcing.discoveryResearchFirmRead':{
  kind:'read',calls:[{method:'POST',path:'/sourcing/candidates/discovery/research-firm-read-v1'}],input:qualificationReadSchema,output:z.object({view:discoveryResearchFirmLinkSavedSchema.nullable(),reason:z.string().nullable()}),transform:'Rehydrate only current source and current owner research draft link',
 },
 'sourcing.discoveryPrepare':{
  kind:'command',calls:[{method:'POST',path:'/sourcing/candidates/discovery/prepare-v1'}],
  input:discoveryPromotionInputSchema.extend({commandId:uuid}),output:z.object({result:discoveryPromotionSavedSchema.nullable(),reason:z.string().nullable()}),
  transform:'Explicit human seed preparation for existing qualification, no Keep, research, admission or outreach',
 },
 'sourcing.discoveryPreparationRead':{
  kind:'read',calls:[{method:'POST',path:'/sourcing/candidates/discovery/preparation-read-v1'}],
  input:qualificationReadSchema,output:z.object({view:discoveryPromotionSavedSchema.nullable(),reason:z.string().nullable()}),
  transform:'Read current raw-to-normal candidate preparation under current source and owner access',
 },
} as const satisfies Readonly<Record<string,Operation>>;
