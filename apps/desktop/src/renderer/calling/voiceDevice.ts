/**
 * The Twilio Voice SDK, behind the few calls the call view makes (slice C1).
 *
 * The Device connects with **only** `{ sessionId }`: the server's TwiML answer puts the
 * number in `<Dial>`, so no number is ever handed to the SDK, to Twilio's signalling from
 * this page, or to anything else in the renderer. The SDK is loaded when a call is first
 * placed, so the Today view does not pay for it and the component tests never load it;
 * they pass a factory of their own.
 */

export type VoiceCallEvent = 'ringing' | 'accept' | 'disconnect' | 'cancel' | 'reject' | 'error';

export interface VoiceCall {
  on(event: VoiceCallEvent, listener: (detail?: unknown) => void): void;
  mute(shouldMute: boolean): void;
  disconnect(): void;
}

export interface VoiceDevice {
  connect(params: { readonly sessionId: string }): Promise<VoiceCall>;
  destroy(): void;
}

export type VoiceDeviceFactory = (token: string) => Promise<VoiceDevice>;

/** The real one: `@twilio/voice-sdk`'s `Device`, bundled into renderer.js. */
export const twilioVoiceDevice: VoiceDeviceFactory = async token => {
  const { Device } = await import('@twilio/voice-sdk');
  const device = new Device(token, { logLevel: 'error' });
  return {
    connect: async ({ sessionId }) => {
      const call = await device.connect({ params: { sessionId } });
      return {
        on: (event, listener) => {
          call.on(event, listener);
        },
        mute: shouldMute => {
          call.mute(shouldMute);
        },
        disconnect: () => {
          call.disconnect();
        },
      };
    },
    destroy: () => {
      device.destroy();
    },
  };
};
