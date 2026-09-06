import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { loadSecureParameter } from "../src/secureParameter";

function clientReturning(value: string | undefined) {
  return {
    send: vi.fn(async (_command: unknown) => ({
      Parameter: value === undefined ? undefined : { Value: value },
    })),
  };
}

describe("loadSecureParameter", () => {
  it("requests encrypted parameter values by exact identifier", async () => {
    const client = clientReturning("resolved-value");

    await expect(
      loadSecureParameter({ client, parameterName: "/callie-sourcing/example", required: true }),
    ).resolves.toBe("resolved-value");

    expect(client.send).toHaveBeenCalledOnce();
    const command = client.send.mock.calls[0]![0] as GetParameterCommand;
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect(command.input).toEqual({
      Name: "/callie-sourcing/example",
      WithDecryption: true,
    });
  });

  it("fails closed with a sanitized fixed error for missing required values", async () => {
    const parameterName = "/callie-sourcing/private-name";
    const client = clientReturning(undefined);

    const failure = await loadSecureParameter({ client, parameterName, required: true }).then(
      () => undefined,
      (error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "SecureParameterError",
      message: "Required secure parameter is unavailable",
    });
    expect(JSON.stringify(failure)).not.toContain(parameterName);
  });

  it("treats empty and whitespace-only required values as unavailable", async () => {
    for (const value of ["", "  \n "]) {
      await expect(
        loadSecureParameter({
          client: clientReturning(value),
          parameterName: "/callie-sourcing/example",
          required: true,
        }),
      ).rejects.toMatchObject({ name: "SecureParameterError" });
    }
  });

  it("returns null for missing or empty optional values", async () => {
    for (const value of [undefined, "", "   "]) {
      await expect(
        loadSecureParameter({
          client: clientReturning(value),
          parameterName: "/callie-sourcing/example",
          required: false,
        }),
      ).resolves.toBeNull();
    }
  });

  it("returns null only for an optional ParameterNotFound provider rejection", async () => {
    const notFound = Object.assign(new Error("private parameter identifier"), {
      name: "ParameterNotFound",
    });
    const client = { send: vi.fn(async () => Promise.reject(notFound)) };

    await expect(
      loadSecureParameter({
        client,
        parameterName: "/callie-sourcing/ntfy-topic",
        required: false,
      }),
    ).resolves.toBeNull();
  });

  it("keeps non-not-found optional lookup failures sanitized and fail closed", async () => {
    for (const name of ["AccessDeniedException", "ThrottlingException", "KMSInvalidStateException"]) {
      const client = {
        send: vi.fn(async () =>
          Promise.reject(Object.assign(new Error("private provider detail"), { name })),
        ),
      };
      await expect(
        loadSecureParameter({
          client,
          parameterName: "/callie-sourcing/ntfy-topic",
          required: false,
        }),
      ).rejects.toMatchObject({
        name: "SecureParameterError",
        message: "Secure parameter lookup failed",
      });
    }
  });

  it("sanitizes provider failures and never caches across calls", async () => {
    const privateDetail = "private@example.test secret-token";
    const client = {
      send: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error(privateDetail), { privateDetail }))
        .mockResolvedValueOnce({ Parameter: { Value: "fresh-value" } }),
    };

    const first = await loadSecureParameter({
      client,
      parameterName: "/callie-sourcing/example",
      required: true,
    }).then(() => undefined, (error) => error);
    expect(first).toMatchObject({
      name: "SecureParameterError",
      message: "Secure parameter lookup failed",
    });
    expect(JSON.stringify(first)).not.toContain(privateDetail);

    await expect(
      loadSecureParameter({
        client,
        parameterName: "/callie-sourcing/example",
        required: true,
      }),
    ).resolves.toBe("fresh-value");
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});
