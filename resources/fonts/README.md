# Bundled typefaces

Every TTF in this directory is licensed under SIL Open Font License 1.1.
The corresponding `*-OFL.txt` files retain the upstream copyright and licence.
`manifest.json` records upstream URLs, source checksums, static-instance axis
values, and bundled-file checksums. Instrument Serif, IBM Plex Sans and IBM Plex Mono are unmodified upstream
static faces. The Plex faces retain their reserved font names.

The other variable sources have been instantiated as static TTFs with
fontTools 4.66.1. Their OFL files declare no reserved font names. Static faces
use explicit family names so libass does not have to guess a weight. This is
build-time work; rendering requires neither fontTools nor a font download.

Libass uses this directory for both caption measurement and final rendering.
The recording renderer writes `render.log` next to the take so selected faces
can be inspected. The [shared theme registry](../../src/themes.ts) owns the
display and caption font selections for recording themes. Motion font
selection and coverage requirements are documented in [Motion renders](../../docs/motion.md).
