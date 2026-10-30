# Vendored replication rules

`REPLICATE.md` in this directory is the measured-timeline replication procedure vendored unmodified from
another project. It is the rules document `takeone motion --reference <video> --measure` copies beside the
measurement it writes.

| | |
| --- | --- |
| Upstream repository | https://github.com/nexu-io/open-design (root licence: Apache License 2.0) |
| Upstream commit | `12d970eacc8971150e3c76470d2a9afe16dc2ed1` (2026-10-30) |
| Upstream path | `skills/motion-design/references/replicate.md` |
| Vendored as | `resources/motion/craft/REPLICATE.md` |
| SHA-256 | `1fc7656c70fde870d515fcef40b439d17f5b79bdab3a2c136816741ca8a95d43` |
| Licence text | Apache License 2.0, shipped in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md) |

The file is byte-for-byte upstream: it keeps its own text, including that project's commands, so its `od media
reference` and `od media compare` steps name tooling of that project. TakeOne's equivalents of the measuring
step are:

```
takeone motion --reference <video> --measure [--out DIR]     measure a film into facts.json, frames/, contact.jpg
takeone motion <inputs...> --reference <video>               plan as usual, cut on that film's measured beats
takeone motion <inputs...> --reference <facts.json>          the same, reusing an earlier measurement
```

Nothing else of that project is vendored: the measurement in `src/motion/reference.ts` is TakeOne's own code
in the shape of the ffmpeg invocations the project already uses, and its cut threshold is relative to the
reference film's own strongest change instead of a fixed one.
