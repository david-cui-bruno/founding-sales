import type { z } from 'zod';
import { googleConnectionSelectorSchema, googleConsentOpenedSchema, googleConnectionStatusResultSchema, GoogleConnectionStatusFailure, selectedGooglePurpose, type RemoteGoogleConnectionsApi } from '../../shared/contracts/remoteGoogleConnectionsContract';
import { remoteGoogleGrantBeginSchema, remoteGoogleGrantDisclosureSchema, remoteGoogleGrantStatusSchema } from '../../shared/contracts/remoteGoogleGrantContract';
import { googleGrantDisclosure, personalGoogleGrantDisclosure } from '../../shared/contracts/googleGrantCapabilities';
import type { IpcClient } from '../ipcClient';

export function createRemoteGoogleConnectionsApi(client: IpcClient): RemoteGoogleConnectionsApi {
  const request = async <Q, R>(name: string, schema: z.ZodType<Q>, response: z.ZodType<R>, args: [Q]): Promise<R> => {
    if (args.length !== 1) throw Error('Google connection request requires one argument');
    return response.parse(await client.request(`outreach:google-connection-${name}`, schema, response, schema.parse(args[0])));
  };
  const status = async (name: 'status' | 'revoke', args: Parameters<RemoteGoogleConnectionsApi['status']>) => {
    const purpose = googleConnectionSelectorSchema.parse(args[0]).purpose;
    // Success keeps its shape. For a status read, one allowlisted worker reason arrives as a reply field and
    // leaves as the rejection message, which is all the context bridge preserves of an Error.
    const result = name === 'status' ? await request(name, googleConnectionSelectorSchema, googleConnectionStatusResultSchema, args)
      : await request(name, googleConnectionSelectorSchema, remoteGoogleGrantStatusSchema, args);
    if ('unavailable' in result) throw new GoogleConnectionStatusFailure(result.unavailable);
    if (result.grant && result.grant.purpose !== purpose) throw Error('Google connection purpose mismatch');
    if (name === 'revoke' && result.state !== 'revoked') throw Error('Google revocation outcome unverified');
    return result;
  };
  return {
    status: (...args) => status('status', args),
    revoke: (...args) => status('revoke', args),
    disclosure: async (...args) => {
      const purpose = googleConnectionSelectorSchema.parse(args[0]).purpose;
      const result = await request('disclosure', googleConnectionSelectorSchema, remoteGoogleGrantDisclosureSchema, args);
      const expected = purpose === 'personal_availability' ? personalGoogleGrantDisclosure : googleGrantDisclosure;
      if (result.version !== expected.version) throw Error('Google disclosure purpose mismatch');
      return result;
    },
    begin: async (...args) => {
      const purpose = selectedGooglePurpose(remoteGoogleGrantBeginSchema.parse(args[0]).purpose);
      const result = await request('begin', remoteGoogleGrantBeginSchema, googleConsentOpenedSchema, args);
      if (result.purpose !== purpose) throw Error('Google consent purpose mismatch');
      return result;
    },
  };
}
