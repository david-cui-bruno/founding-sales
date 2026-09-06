import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

export class SecureParameterError extends Error {
  constructor(message: "Required secure parameter is unavailable" | "Secure parameter lookup failed") {
    super(message);
    this.name = "SecureParameterError";
  }
}

export async function loadSecureParameter(input: {
  client: Pick<SSMClient, "send">;
  parameterName: string;
  required: boolean;
}): Promise<string | null> {
  let value: string | undefined;
  try {
    const response = await input.client.send(
      new GetParameterCommand({
        Name: input.parameterName,
        WithDecryption: true,
      }),
    );
    value = response.Parameter?.Value;
  } catch {
    throw new SecureParameterError("Secure parameter lookup failed");
  }

  if (!value?.trim()) {
    if (input.required) {
      throw new SecureParameterError("Required secure parameter is unavailable");
    }
    return null;
  }
  return value;
}
