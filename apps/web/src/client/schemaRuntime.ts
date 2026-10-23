import { z } from 'zod';

// Evaluate before presentation/schema imports. Even a caught eval capability
// probe emits a violation under the browser host's strict script-src policy.
z.config({ jitless: true });
