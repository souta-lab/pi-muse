pi-muse
=======

This repository is a fork of Pi (https://github.com/earendil-works/pi).

License
-------

The source code in this repository is licensed under the MIT License. See LICENSE.
The upstream copyright notice (Copyright (c) 2025 Mario Zechner) is retained.

Third-party content not covered by the MIT License
--------------------------------------------------

packages/coding-agent/src/core/muse-system-prompt.ts contains the system prompt of
Meta's "Muse Code" terminal coding agent, extracted from the distributed CLI binary.
It is not authored by this project and is not covered by the MIT License. All rights
to that text remain with Meta. It is included solely for interoperability so that
Muse Spark can be driven by a compatible open harness.

If you are a rights holder and want it removed, or if you do not want to ship it,
delete that file or replace it with your own prompt (for example a custom
~/.pi/SYSTEM.md) — the harness works with any system prompt.

An extracted copy with provenance is mirrored at:
https://github.com/souta-lab/muse-code-system-prompt
