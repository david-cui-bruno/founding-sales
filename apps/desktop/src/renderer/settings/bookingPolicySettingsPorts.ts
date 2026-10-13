import {operations} from '../app/bridges.ts';
import type {OperationApi} from '../../shared/operations.ts';
import type {BookingPolicySettingsPorts} from './BookingPolicySettings.tsx';
export function createBookingPolicySettingsPorts(api:OperationApi|null):BookingPolicySettingsPorts {
  return {read:async()=>api===null?null:(await api.read('meetings.bookingPolicy',{})).view,change:async input=>api===null?{revision:null,reason:'not_signed_in'}:api.command('meetings.bookingPolicyChange',input)};
}
export const bookingPolicySettingsPorts:BookingPolicySettingsPorts={read:async()=>createBookingPolicySettingsPorts(operations()??null).read(),change:async input=>createBookingPolicySettingsPorts(operations()??null).change(input)};
