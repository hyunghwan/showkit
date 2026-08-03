# Support

ShowKit is an early open-source project. The fastest way to get useful help is
to share a small public or synthetic reproduction and the exact command result.

## Where to ask

| Need | Channel |
| --- | --- |
| Usage question or reproducible bug | GitHub issue |
| Proposed product or API change | GitHub issue before a large pull request |
| Security vulnerability | GitHub private vulnerability reporting |
| Contribution help | The relevant pull request or issue |

Never put an unpatched vulnerability, credential, customer record, private
product capture, cookie, storage value, raw DOM, request body, or response body
in a public issue.

## Before opening a bug

Run these checks from the affected project:

```bash
node --version
npx showkit doctor --json
```

Include:

- the ShowKit version and Node.js version;
- the source route: static, verified browser session, or Playwright;
- the command, exit code, named error code, and recovery text;
- the operating system and relevant browser name;
- the smallest public or synthetic reproduction;
- whether the flow was captured, built, checked, previewed, or published.

Remove operation IDs, local filesystem paths, page content, and any value you
do not intend to publish. Do not attach `.showkit/` wholesale. A failed capture
should already leave only secret-free diagnostics, but review every file before
sharing it.

## Supported versions

ShowKit `0.1.x` supports Node.js 22 and 24. Browser-host, Playwright, schema, and
skill compatibility are listed in [`COMPATIBILITY.md`](COMPATIBILITY.md).

For vulnerabilities and the product trust boundary, read
[`SECURITY.md`](SECURITY.md).
