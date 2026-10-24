# Releasing

One version number covers everything: the Go module, `@clevix/flow` and
`@clevix/protocol`.

## Make a release

1. Set the new version in all four places:
   - `packages/flow/package.json` (`version`)
   - `packages/protocol/package.json` (`version`)
   - `packages/flow/src/version.ts` (`SDK_VERSION`)
   - `flow.go` (`Version`)
2. Merge that to `main`.
3. Tag `main` and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

The tag starts `.github/workflows/release.yml`. It runs the checks, checks that
the four versions match the tag, and makes the GitHub release with
`clevix-flow-X.Y.Z.tgz` and `clevix-protocol-X.Y.Z.tgz`. Go needs no file: `go get`
reads the tag.

To build the files without releasing (needs Bun and Node, like the checks):

```bash
scripts/release.sh 0.2.0 /tmp/release
```

If the workflow fails before the release is made, delete the tag
(`git push origin :refs/tags/v0.2.0`), fix the problem, and tag again. Once a
release is out, never move or delete its tag: the Go proxy has cached it and apps
may pin it. Ship the fix as a new version.

## Working with the engine

The engine (the private clevix-worker repo) pins a release of this repo:

- `@clevix/protocol` and `@clevix/flow` as `.tgz` URLs in its `package.json` files
- the Go module in its conformance app's `go.mod`

So a change that touches both sides, like a new key format, goes in two steps:

1. Change the SDKs, the protocol, `testdata/vectors.json` and the docs here.
   Merge and release.
2. In clevix-worker, bump the pins to the new version in the same PR as the
   engine change. Its conformance suite then runs the new SDKs against the new
   engine.

To try unreleased SDK code with the engine before step 1 is released, clone this
repo next to clevix-worker (so it is at `../flow-sdk`) and follow "Use a local
flow-sdk" in clevix-worker's README.

Apps should only move to a release once the engine they talk to supports it.
