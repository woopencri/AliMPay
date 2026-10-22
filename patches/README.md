# alipay-sdk 4.14.0: abortable V3 queries

The pinned SDK accepts a request timeout but does not forward an AbortSignal to
urllib. Add only the signal option and pass it through to the existing transport;
request signing, response signature verification and SDK error handling stay intact.
The patch includes the source, ESM and CommonJS builds and both declaration files.

Bun applies this patch through package.json patchedDependencies. Both Docker stages
must copy patches/ before bun install. On SDK upgrades, check whether upstream
already forwards the signal, and update or remove the patch accordingly.

Regression coverage in tests/alipay-timeout.test.ts uses a real local HTTP server
to verify cancellation before response headers and during a stalled response body,
as well as request signatures and acceptance/rejection of response signatures.
