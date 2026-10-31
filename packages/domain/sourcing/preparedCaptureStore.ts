// Prepared-only batches preserve each existing fresh read phase and per-run
// source authority. This stable import also serves exact prepared detail reads.
export {withPreparedCaptureSnapshots} from './preparedCaptureBatch.ts';
