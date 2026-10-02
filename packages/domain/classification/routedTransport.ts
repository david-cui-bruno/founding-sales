import type { AnthropicMessagesTransport } from './anthropicClient.ts';
import { DIRECT_ROUTE, bedrockModelRoute, type ModelRoute, type ModelTransportKind } from './modelTransport.ts';

/**
 * One transport over two (slice BR1, review BR1R finding 1): each request goes where its
 * model's route says — `modelTransport.ts`'s `ModelRoute`, the same function the reservation
 * code asks before it reserves, so the `provider_key`, the price and the transport that
 * carries the request are always one decision.
 *
 * A request whose model has no route is refused here, before any socket, as a refusal the
 * paid-call pattern settles at 0. The reservation code never reserves for such a model, so
 * this is the backstop rather than the rule.
 */
export interface RoutedTransport extends AnthropicMessagesTransport {
  readonly route: ModelRoute;
}

export class UnroutedModelError extends Error {
  readonly status = null;
  readonly refusedBeforeGeneration = true;
  readonly error = { error: { type: 'model_unrouted' } } as const;
  constructor() {
    super('no transport for this model');
    this.name = 'UnroutedModelError';
  }
}

export function routedTransport(input: {
  readonly route: ModelRoute;
  readonly bedrock: AnthropicMessagesTransport | null;
  readonly anthropic: AnthropicMessagesTransport | null;
  /** Called with the model id and the transport chosen, for the worker's log. Never request text. */
  readonly onRoute?: ((model: string, transport: ModelTransportKind) => void) | undefined;
}): RoutedTransport {
  const pick = (model: string): AnthropicMessagesTransport => {
    const kind = input.route(model);
    const chosen = kind === 'bedrock' ? input.bedrock : kind === 'anthropic' ? input.anthropic : null;
    if (kind === null || chosen === null) throw new UnroutedModelError();
    input.onRoute?.(model, kind);
    return chosen;
  };
  return {
    // The kind of the deployment's preferred transport, for the startup line.
    kind: input.bedrock !== null ? 'bedrock' : 'anthropic',
    route: input.route,
    create: async request => await pick(request.model).create(request),
    countTokens: async request => await pick(request.model).countTokens(request),
  };
}

/** The route a transport implies: its own when routed, else every model through its one kind. */
export function routeOfTransport(transport: AnthropicMessagesTransport): ModelRoute {
  const routed = (transport as Partial<RoutedTransport>).route;
  if (typeof routed === 'function') return routed;
  return (transport.kind ?? 'anthropic') === 'anthropic' ? DIRECT_ROUTE : bedrockModelRoute({ directAvailable: false });
}
