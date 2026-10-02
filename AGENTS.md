# Development instructions

Pirs is a fork of the Bluesky PDS distribution (`upstream` remote) carrying an experimental plugin bridge and a hook-point spec. Apply unslop to prose.

Keep Pirs code in `service/pirs/` and `docs/`. Change upstream files only where a hook requires it, and keep each such change small enough to survive `git merge upstream/main`. Do not edit `UPSTREAM-README.md`.

Plugin code must never run in the PDS process or receive signing keys, rotation keys, the admin password or the account database. Host-side work belongs in a separate process.

The verification gate is `pnpm smoke` in `service/`. It uses a temporary data directory and generated secrets; do not point it at a real PDS data directory or a public PLC directory. Never commit environment files.

`docs/spec/hook-points.md` section 8 records what has actually been run. Update it when a hook gains or loses evidence, and do not describe a hook as supported on the strength of a design alone.

This repository is separate from Prichal. Do not import Prichal code, and do not change Prichal's deployment to use Pirs without an explicit decision.
