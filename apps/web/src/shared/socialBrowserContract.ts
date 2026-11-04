import {z} from 'zod';
import {
 socialFounderInputSaveSchema,commandIdSchema,
 socialFounderInputListInputSchema,socialFounderInputReadInputSchema,socialFounderInputSaveCommandSchema,
 socialFounderInputListSchema,socialFounderInputViewSchema,socialFounderInputSavedSchema,
 socialCalibrationReadInputSchema,socialCalibrationReadSchema,socialCalibrationFinishCommandSchema,socialCalibrationResultSchema,
 socialFounderReceiptInputSchema,socialFounderReceiptSchema,
 socialPublisherConnectionInputSchema,socialPublisherConnectionResultSchema,
} from '@fss/contracts';
import {socialPublishingReadinessInputSchema,socialPublishingReadinessSchema} from '@fss/contracts';
export const founderSaveBrowserInputSchema=z.discriminatedUnion('operation',[
 socialFounderInputSaveSchema.options[0].safeExtend({commandId:commandIdSchema}),
 socialFounderInputSaveSchema.options[1].safeExtend({commandId:commandIdSchema}),
 socialFounderInputSaveSchema.options[2].safeExtend({commandId:commandIdSchema}),
]);
export const calibrationFinishBrowserInputSchema=socialCalibrationFinishCommandSchema.omit({clientVersion:true});
export const socialCommandRefusalSchema=z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string().regex(/^[a-z_]{1,100}$/u)});
export function socialCommandResult<T extends z.ZodType>(result:T){return z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result}),socialCommandRefusalSchema]);}
export const founderSaveResultSchema=socialCommandResult(socialFounderInputSavedSchema);
export const calibrationFinishResultSchema=socialCommandResult(socialCalibrationResultSchema);
export const socialBrowserRequests:Readonly<Record<string,z.ZodType>>={
 '/social/inputs/list':socialFounderInputListInputSchema,
 '/social/publishing/readiness':socialPublishingReadinessInputSchema,
 '/social/inputs/read':socialFounderInputReadInputSchema,
 '/social/inputs/save':socialFounderInputSaveCommandSchema,
 '/social/calibration/read':socialCalibrationReadInputSchema,
 '/social/calibration/finish':socialCalibrationFinishCommandSchema,
 '/social/founder/receipt':socialFounderReceiptInputSchema,
 '/social/publisher/connection':socialPublisherConnectionInputSchema,
};
export const socialBrowserResponses:Readonly<Record<string,z.ZodType>>={
 '/social/inputs/list':socialFounderInputListSchema,
 '/social/publishing/readiness':socialPublishingReadinessSchema,
 '/social/inputs/read':z.strictObject({input:socialFounderInputViewSchema}),
 '/social/inputs/save':founderSaveResultSchema,
 '/social/calibration/read':socialCalibrationReadSchema,
 '/social/calibration/finish':calibrationFinishResultSchema,
 '/social/founder/receipt':socialFounderReceiptSchema,
 '/social/publisher/connection':socialPublisherConnectionResultSchema,
};
