/** CLI test preload: keyring operations always use BYOKit's in-memory backend. */
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/@byokit/secrets/dist/keyring.js")) {
      const override = new URL("override.js", url).href;
      const errors = new URL("errors.js", url).href;
      return { format: "module", shortCircuit: true, source: `
        import { overrideStore } from ${JSON.stringify(override)};
        import { KeystoreError } from ${JSON.stringify(errors)};
        export const keyringEnv = extra => ({ ...extra });
        export function keyringStore() {
          if (process.env.TAKEONE_TEST_NO_KEYRING === '1') throw new KeystoreError('unavailable', 'fake missing keyring');
          if (process.env.TAKEONE_TEST_KEYRING_FAILURE === '1') return {
            get: async () => { throw new KeystoreError('failed', 'fake unavailable Secret Service'); },
            set: async () => { throw new KeystoreError('failed', 'fake unavailable Secret Service'); },
            delete: async () => { throw new KeystoreError('failed', 'fake unavailable Secret Service'); },
          };
          return overrideStore({});
        }
      ` };
    }
    return nextLoad(url, context);
  },
});
