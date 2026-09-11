import { delegationCommandSchema, type ExecutionRepository } from '../../../../src/shared/contracts/delegationContract';
/** Authentication belongs to C2. This service is not an unauthenticated handler. */
export function createCommandService(repository: ExecutionRepository) {
  return { async submit(input: unknown) { return repository.applyCommand(delegationCommandSchema.parse(input)); } };
}
