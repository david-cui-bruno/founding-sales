import {describe,expect,it} from 'vitest';
import {sourcingTimeZone} from '../../sourcing/admission.ts';

describe('deterministic sourcing timezone, not calling permission',()=>{
 it.each(['Dallas, TX','Duncanville','duncanville, tx','  Dallas , TX  '])('resolves exact supported municipality %s',locality=>{
  expect(sourcingTimeZone('TX',locality)).toBe('America/Chicago');
 });
 it('retains the actual Moriah service-area refusal without inventing an office city',()=>{
  expect(sourcingTimeZone('TX','Fort Worth area; exact office city not stated')).toBeNull();
 });
 it.each(['Dallas','Fort Worth','DFW','Arlington','Plano','Frisco','Denton','Irving','McKinney','Garland','Mesquite','Richardson','Lewisville','Carrollton','Allen','Grand Prairie','Austin','Houston','San Antonio'])('preserves supported Central lookup %s',locality=>{
  expect(sourcingTimeZone('TX',locality)).toBe('America/Chicago');
 });
 it.each(['El Paso','El Paso, TX',' el   paso '])('preserves Mountain lookup %s',locality=>{
  expect(sourcingTimeZone('TX',locality)).toBe('America/Denver');
 });
 it.each(['','Texas','Unknown','Cypress','Hudspeth County','Sierra Blanca','Dell City','Dallas / El Paso','Dallas; El Paso','Dallas-Fort Worth','Dallas area','Dallas County','Dallas, MA','Dallas TX','Dallas, TX, USA','Dallas123','Dall!as','Duncanville office','Fort Worth area; exact office city not stated'])('fails closed for unknown or non-city locality %s',locality=>{
  expect(sourcingTimeZone('TX',locality)).toBeNull();
 });
 it.each(['CA','NM','tx',''])('does not infer Texas from locality for region %s',region=>{
  expect(sourcingTimeZone(region,'Dallas, TX')).toBeNull();
 });
 it.each(['RI','MA'])('preserves existing single-zone state %s',region=>{
  expect(sourcingTimeZone(region,'')).toBe('America/New_York');
 });
});
