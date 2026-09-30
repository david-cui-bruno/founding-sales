/**
 * The two vocabularies migration 0025's CHECKs repeat, re-exported for the test that
 * compares them with the database.
 *
 * The contract's copy is the one the desktop reads (14.2: the Mac may not import
 * `@fss/domain`); `MANUAL_MODE_ORIGINS` is the domain's, because it is a fact about
 * events rather than about a form. One import site, so `followUpVocabulary.test.ts`
 * reads like the comparison it is.
 */
export {
  ENROLLMENT_ORIGIN_KINDS,
  FOLLOW_UP_PERMISSION_KINDS,
  FOLLOW_UP_PERMISSION_SCOPES,
  FOLLOW_UP_PERMISSION_WINDOW_DAYS,
} from '@fss/contracts';
export { MANUAL_MODE_ORIGINS as MANUAL_MODE_ORIGINS_FOR_TESTS } from '../../../crm/events.ts';
