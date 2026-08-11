## Result

Describe what a ShowKit user can now do.

## Safety boundary

- [ ] No credentials, customer data, private product captures, raw DOM, cookies,
      storage values, or authenticated network data are included.
- [ ] Capture still fails closed before persistence.
- [ ] No full-scene image fallback was added.
- [ ] The demo step count follows the flow and is not forced to five.

## Verification

- [ ] `pnpm security:scan`
- [ ] `pnpm audit:prod`
- [ ] `pnpm check`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm package:smoke`

List any additional browser, skill, or deterministic-output checks:
