import { localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localWorkflowTransitionSchema, localWorkflowReceiptSchema, type LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import type { IpcClient } from '../ipcClient';
export const createLocalWorkspaceApi = (client: IpcClient): LocalWorkspaceApi => ({
  get: () => client.requestNoInput('local-workspace:get', localWorkspaceSnapshotSchema),
  getCommitments: () => client.requestNoInput('local-workspace:get-commitments', localCommitmentsSnapshotSchema),
  transition: command => client.request('local-workspace:transition', localWorkflowTransitionSchema, localWorkflowReceiptSchema, command),
});
