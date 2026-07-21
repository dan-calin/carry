# Contributing to Carry

Bug reports, focused pull requests, documentation fixes, and test improvements
are welcome. Carry is a preview and changes to synchronization or cryptography
need especially careful review.

## Development setup

Use Windows x64 with Node.js 22 or newer, stable Rust, and the Visual C++ desktop
build tools.

```powershell
npm ci --ignore-scripts
node .\scripts\prepare-native.js
npm run test:all
npm run test:tauri
```

Run `npm run build:windows` before submitting packaging or installer changes.
The package is intentionally marked private: releases are distributed as
GitHub assets, not through the npm registry.

## Pull requests

- Keep changes scoped and explain the user-visible behavior.
- Add a regression test for bug fixes and security boundaries.
- Do not weaken authentication, integrity checks, path validation, or resource
  limits to make a test pass.
- Do not commit `.carry`, `.shared-memory`, logs, build output, real invitations,
  device identifiers, or project data.
- Discuss new production dependencies before adding them.

By contributing, you agree that your contribution is licensed under the MIT
license in this repository. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
