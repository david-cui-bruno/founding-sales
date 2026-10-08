import {operations} from '../app/bridges.ts';
import type {BookingCapacityPorts} from './BookingCapacity.tsx';

/** Both views read through the closed, authenticated operation registry. */
export const bookingCapacityPorts:BookingCapacityPorts={read:async()=>{const api=operations();return api===undefined?{capacity:null}:await api.read('meetings.bookingCapacity',{});}};
