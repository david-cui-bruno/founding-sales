import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reservePrivateOutput, runOperatorPairing, type OperatorDependencies } from '../src/operatorPairing';

// Real OS filesystem and production WorkerAuth. Only AWS transport is fictional.
let root: string;
beforeEach(async () => { root = await mkdtemp(join(homedir(), '.fss-operator-test-')); await chmod(root, 0o700); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const args = (output: string) => ['--account','123456789012','--region','us-east-1','--table','worker-table',
  '--workspace','workspace-one','--expires','60','--scopes','commands:write,events:read','--output',output,'--execute'];

describe('operator private output on real filesystem', () => {
  it('writes exclusively with0600 mode, durable contents and no temporary files', async () => {
    const path = join(root, 'code'); const output = await reservePrivateOutput(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('');
    await output.save('x'.repeat(43)); await output.close();
    expect(await readFile(path, 'utf8')).toBe('x'.repeat(43) + '\n');
    expect(await readdir(root)).toEqual(['code']);
    await expect(reservePrivateOutput(path)).rejects.toThrow('output_unavailable');
    expect(await readFile(path, 'utf8')).toBe('x'.repeat(43) + '\n');
  });
  it('rejects a final symlink without changing its target', async () => {
    const target=join(root,'target'); await writeFile(target,'preserve',{mode:0o600});
    const link=join(root,'link'); await symlink(target,link);
    await expect(reservePrivateOutput(link)).rejects.toThrow('output_unavailable');
    expect(await readFile(target,'utf8')).toBe('preserve');
  });
  it('rejects an ancestor symlink and nonprivate parent before creating output', async () => {
    const actual=join(root,'actual'); await mkdir(actual,{mode:0o700});
    const link=join(root,'linked'); await symlink(actual,link);
    await expect(reservePrivateOutput(join(link,'code'))).rejects.toThrow('output_unavailable');
    expect(await readdir(actual)).toEqual([]);
    await chmod(actual,0o755);
    await expect(reservePrivateOutput(join(actual,'code'))).rejects.toThrow('output_unavailable');
    expect(await readdir(actual)).toEqual([]);
  });
  it('permits only one concurrent exclusive reservation', async () => {
    const path=join(root,'code');
    const attempts=await Promise.allSettled([reservePrivateOutput(path),reservePrivateOutput(path)]);
    expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    for(const entry of attempts) if(entry.status==='fulfilled') await entry.value.close();
    expect(await readFile(path,'utf8')).toBe('');
    expect(await readdir(root)).toEqual(['code']);
  });
  it('runs production issuance with real private storage and no exposed code', async () => {
    const sent: unknown[]=[]; const close=vi.fn();
    const deps:OperatorDependencies={reserveOutput:reservePrivateOutput,connect:async()=>({
      getCallerIdentity:async()=>({Account:'123456789012',Arn:'arn:aws:iam::123456789012:user/operator'}),
      describeTable:async()=>({TableName:'worker-table',TableArn:'arn:aws:dynamodb:us-east-1:123456789012:table/worker-table',TableStatus:'ACTIVE'}),
      dynamo:{send:async command=>{sent.push(command);return {$metadata:{}};}},close,
    })};
    const path=join(root,'code');const response=await runOperatorPairing(args(path),deps);
    expect(response.exitCode).toBe(0); const code=(await readFile(path,'utf8')).trim();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);expect((await lstat(path)).mode&0o777).toBe(0o600);
    expect(JSON.stringify(response)).not.toContain(code);expect(JSON.stringify(sent)).not.toContain(code);
    expect(sent).toHaveLength(1);expect(close).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual(['code']);
  });
});
